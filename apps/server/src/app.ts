import Fastify from "fastify";
import { Collector } from "./collector.js";
import { compareEvidence } from "./comparison.js";
import { FetchTransport, GitLabClient, type HttpTransport } from "./gitlab.js";
import { ActiveRunError, Store } from "./store.js";

function positiveId(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function selectionIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const ids = value.map(positiveId);
  if (ids.some((id) => id === null)) return null;
  const valid = ids as number[];
  return new Set(valid).size === valid.length ? valid : null;
}

export function createApp(options: { store: Store; token?: string; transport?: HttpTransport;
  sleep?: (milliseconds: number) => Promise<void>; mode?: "live" | "mock" }) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const { store } = options;
  const collector = new Collector(store, new GitLabClient(options.token ?? "", options.transport ?? new FetchTransport(), store, options.sleep));
  let activeCollection: Promise<void> | null = null;

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error &&
      typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(statusCode).send({ error: statusCode < 500 ? "invalid_request" : "internal_error" });
  });
  app.addHook("onClose", async () => { await activeCollection; });

  app.get("/api/health", async () => ({ status: "ok", gitlabConfigured: Boolean(options.token), mode: options.mode ?? "live" }));
  app.get("/api/selection", async () => ({ projectIds: store.getSelection() }));
  app.put("/api/selection", async (request, reply) => {
    const body = request.body as { projectIds?: unknown } | null;
    const ids = selectionIds(body?.projectIds);
    if (!ids) return reply.code(400).send({ error: "invalid_project_ids", detail: "Provide 1-20 unique positive numeric IDs." });
    store.saveSelection(ids);
    return { projectIds: ids };
  });

  app.post("/api/runs", async (_request, reply) => {
    if (!options.token) return reply.code(503).send({ error: "gitlab_token_not_configured" });
    const ids = store.getSelection();
    if (!selectionIds(ids)) return reply.code(400).send({ error: "selection_required" });
    try {
      const run = store.createRun(ids);
      activeCollection = new Promise<void>((resolve) => {
        setImmediate(() => {
          void collector.execute(run.id).catch(() => {
            store.interruptActiveRuns();
          }).finally(resolve);
        });
      });
      return reply.code(202).send(run);
    } catch (error) {
      if (error instanceof ActiveRunError) return reply.code(409).send({ error: "run_already_active", activeRunId: error.activeRunId });
      throw error;
    }
  });

  app.get("/api/runs/active", async () => ({ run: store.getActiveRun() }));
  app.get("/api/runs", async () => ({ runs: store.listRuns() }));
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const id = positiveId(request.params.id);
    if (!id) return reply.code(400).send({ error: "invalid_run_id" });
    const run = store.getRun(id);
    return run ?? reply.code(404).send({ error: "run_not_found" });
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/changes", async (request, reply) => {
    const id = positiveId(request.params.id);
    if (!id) return reply.code(400).send({ error: "invalid_run_id" });
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    return { runId: id, comparisons: run.projects?.map((project) => {
      const baseline = store.getLastComplete(project.requestedProjectId, id);
      // A project still being collected has no outcome yet, even if some evidence is already checkpointed.
      if (project.state === "pending" || project.state === "running") {
        return { projectId: project.requestedProjectId, status: "in_progress",
          baselineRunId: baseline?.runId ?? null, baselineFinishedAt: baseline?.finishedAt ?? null };
      }
      if (!project.evidence) {
        return { projectId: project.requestedProjectId, status: "not_comparable", reason: "no_current_evidence",
          baselineRunId: baseline?.runId ?? null, baselineFinishedAt: baseline?.finishedAt ?? null };
      }
      if (!baseline) return { projectId: project.requestedProjectId, status: "no_baseline", changes: [] };
      // Partial evidence is compared only on the facts it actually observed; the rest is listed as not compared.
      const { changes, notCompared } = compareEvidence(baseline.evidence, project.evidence);
      return { projectId: project.requestedProjectId, status: project.state === "complete" ? "compared" : "partially_compared",
        baselineRunId: baseline.runId, baselineFinishedAt: baseline.finishedAt, currentFinishedAt: project.finishedAt,
        changes, notCompared };
    }) };
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id/history", async (request, reply) => {
    const id = positiveId(request.params.id);
    return id ? { projectId: id, observations: store.getProjectHistory(id) } :
      reply.code(400).send({ error: "invalid_project_id" });
  });
  return app;
}
