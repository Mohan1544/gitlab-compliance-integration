import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { HttpResponse, HttpTransport } from "./gitlab.js";
import { Store } from "./store.js";
import type { Run } from "./types.js";

const project = (id: number, emptyRepo = false) => ({
  id, name: `Project ${id}`, web_url: `https://gitlab.com/example/${id}`,
  visibility: "private", empty_repo: emptyRepo, default_branch: "main",
});

function transport(options: { failRules?: boolean; changedForcePush?: boolean } = {}): HttpTransport {
  return {
    async send(url): Promise<HttpResponse> {
      const path = `${url.pathname}${url.search}`;
      if (path === "/api/v4/projects/1") return { status: 200, headers: {}, body: project(1) };
      if (path === "/api/v4/projects/2") return { status: 200, headers: {}, body: project(2) };
      if (path === "/api/v4/projects/3") return { status: 200, headers: {}, body: project(3, true) };
      if (path === "/api/v4/projects/1/repository/branches/main") return { status: 200, headers: {}, body: { name: "main", protected: true } };
      if (path === "/api/v4/projects/2/repository/branches/main") return { status: 200, headers: {}, body: { name: "main", protected: false } };
      if (path === "/api/v4/projects/3/repository/branches?per_page=100") return { status: 200, headers: {}, body: [] };
      if (path === "/api/v4/projects/1/protected_branches?per_page=100") {
        if (options.failRules) return { status: 503, headers: {} };
        return { status: 200, headers: {}, body: [{ name: "main", allow_force_push: options.changedForcePush ?? false,
          code_owner_approval_required: false, push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }] }] };
      }
      if (path === "/api/v4/projects/2/protected_branches?per_page=100") return { status: 200, headers: {}, body: [] };
      throw new Error(`Unexpected mock path: ${path}`);
    },
  };
}

async function waitForRun(app: ReturnType<typeof createApp>, id: number): Promise<Run> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/runs/${id}` });
    const run = response.json<Run>();
    if (!["queued", "running"].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach a terminal state");
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("collection API", () => {
  it("saves IDs, collects protected/unprotected/empty, and compares a changed rule", async () => {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    const app = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    cleanup.push(() => app.close());
    expect((await app.inject({ method: "PUT", url: "/api/selection", payload: { projectIds: [1, 1] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/selection", payload: { projectIds: [1, 2, 3] } })).statusCode).toBe(200);
    const first = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    const completed = await waitForRun(app, first.id);
    expect(completed.state).toBe("completed");
    expect(completed.projects?.map((item) => item.evidence?.classification)).toEqual(["protected", "unprotected", "empty"]);
    expect(completed.projects?.[2]?.evidence?.project.reportedDefaultBranch).toBe("main");
    expect(completed.projects?.[2]?.evidence?.branch).toBeUndefined();
    expect(completed.projects?.[2]?.reads?.find((read) => read.source === "branches")?.state).toBe("confirmed_absent");

    await app.close();
    cleanup.pop();
    const changedApp = createApp({ store, token: "mock-token", transport: transport({ changedForcePush: true }), sleep: async () => {} });
    cleanup.push(() => changedApp.close());
    const second = (await changedApp.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    await waitForRun(changedApp, second.id);
    const comparison = (await changedApp.inject({ method: "GET", url: `/api/runs/${second.id}/changes` })).json<{
      comparisons: { projectId: number; baselineRunId?: number; changes?: { field: string }[] }[];
    }>();
    expect(comparison.comparisons[0]?.baselineRunId).toBe(first.id);
    expect(comparison.comparisons[0]?.changes?.map((change) => change.field)).toContain("allow_force_push");
  });

  it("preserves prior evidence during a partial rule failure and later recovers", async () => {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    store.saveSelection([1, 2]);
    let app = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    const first = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    await waitForRun(app, first.id);
    await app.close();
    app = createApp({ store, token: "mock-token", transport: transport({ failRules: true }), sleep: async () => {} });
    const second = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    const partial = await waitForRun(app, second.id);
    expect(partial.state).toBe("partial");
    expect(partial.projects?.[0]?.state).toBe("partial");
    expect(partial.projects?.[0]?.evidence?.branch?.protected).toBe(true);
    expect(partial.projects?.[0]?.lastGood?.runId).toBe(first.id);
    expect(partial.projects?.[0]?.reads?.find((read) => read.source === "protected_branches")?.attempts).toBe(3);
    const changes = (await app.inject({ method: "GET", url: `/api/runs/${second.id}/changes` })).json<{
      comparisons: { status: string; baselineRunId: number; changes: unknown[]; notCompared: string[] }[];
    }>();
    // The unreadable rules are not compared (and not reported as removed); the observed protected flag still is.
    expect(changes.comparisons[0]).toMatchObject({ status: "partially_compared", baselineRunId: first.id, changes: [],
      notCompared: ["protection_rules"] });
    await app.close();
    app = createApp({ store, token: "mock-token", transport: transport({ changedForcePush: true }), sleep: async () => {} });
    cleanup.push(() => app.close());
    const third = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    await waitForRun(app, third.id);
    const recovery = (await app.inject({ method: "GET", url: `/api/runs/${third.id}/changes` })).json<{
      comparisons: { baselineRunId?: number }[];
    }>();
    expect(recovery.comparisons[0]?.baselineRunId).toBe(first.id);
  });

  it("rejects a second start while a run is active and names the active run", async () => {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    store.saveSelection([1]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = transport();
    const app = createApp({ store, token: "mock-token", sleep: async () => {},
      transport: { async send(url, token, timeoutMs) { await gate; return inner.send(url, token, timeoutMs); } } });
    cleanup.push(() => app.close());
    const first = await app.inject({ method: "POST", url: "/api/runs" });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: "POST", url: "/api/runs" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "run_already_active", activeRunId: first.json<Run>().id });
    expect((await app.inject({ method: "GET", url: "/api/runs/active" })).json<{ run: Run }>().run.id).toBe(first.json<Run>().id);
    const midRun = (await app.inject({ method: "GET", url: `/api/runs/${first.json<Run>().id}/changes` })).json<{ comparisons: { status: string }[] }>();
    expect(midRun.comparisons.map((comparison) => comparison.status)).toEqual(["in_progress"]);
    release();
    expect((await waitForRun(app, first.json<Run>().id)).state).toBe("completed");
    expect((await app.inject({ method: "POST", url: "/api/runs" })).statusCode).toBe(202);
  });

  it("refuses to start without a saved selection or a configured token", async () => {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    const app = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    cleanup.push(() => app.close());
    expect((await app.inject({ method: "POST", url: "/api/runs" })).statusCode).toBe(400);
    const tokenless = createApp({ store, transport: transport() });
    cleanup.push(() => tokenless.close());
    store.saveSelection([1]);
    expect((await tokenless.inject({ method: "POST", url: "/api/runs" })).json()).toEqual({ error: "gitlab_token_not_configured" });
    expect(store.listRuns()).toEqual([]);
  });

  it("keeps completed runs, their requested IDs and source reads across a server restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitlab-evidence-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "evidence.sqlite");
    let store = new Store(path);
    store.saveSelection([1, 3]);
    const app = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    const run = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    await waitForRun(app, run.id);
    await app.close();
    store.saveSelection([2]);
    store.close();

    store = new Store(path);
    cleanup.push(() => store.close());
    store.interruptActiveRuns();
    const reloaded = store.getRun(run.id);
    expect(reloaded).toMatchObject({ state: "completed", requestedProjectIds: [1, 3] });
    expect(reloaded?.projects?.map((item) => item.evidence?.classification)).toEqual(["protected", "empty"]);
    expect(reloaded?.projects?.[0]?.reads?.map((read) => read.source)).toEqual(["project", "branches", "default_branch", "protected_branches"]);
    expect(store.getSelection()).toEqual([2]);
  });

  it("keeps evidence observed before a server stop and compares it as partial after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gitlab-evidence-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "evidence.sqlite");
    let store = new Store(path);
    store.saveSelection([1]);
    let app = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    const baseline = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    await waitForRun(app, baseline.id);
    await app.close();

    // The protected-rules read never answers, standing in for a process that stops mid-project.
    const inner = transport();
    const stalled: HttpTransport = { async send(url, token, timeoutMs) {
      if (url.pathname.endsWith("/protected_branches")) return new Promise<HttpResponse>(() => {});
      return inner.send(url, token, timeoutMs);
    } };
    app = createApp({ store, token: "mock-token", transport: stalled, sleep: async () => {} });
    const stopped = (await app.inject({ method: "POST", url: "/api/runs" })).json<Run>();
    for (let attempt = 0; attempt < 100 && !store.getRun(stopped.id)?.projects?.[0]?.evidence?.branch; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    store.close();

    store = new Store(path);
    cleanup.push(() => store.close());
    store.interruptActiveRuns();
    const restarted = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    cleanup.push(() => restarted.close());
    const run = (await restarted.inject({ method: "GET", url: `/api/runs/${stopped.id}` })).json<Run>();
    expect(run.state).toBe("interrupted");
    expect(run.projects?.[0]).toMatchObject({ state: "interrupted", errorCode: "server_interrupted",
      evidence: { classification: "protected", branch: { name: "main", protected: true } } });
    expect(run.projects?.[0]?.evidence?.rules).toBeUndefined();
    expect(run.projects?.[0]?.lastGood?.runId).toBe(baseline.id);
    const changes = (await restarted.inject({ method: "GET", url: `/api/runs/${stopped.id}/changes` })).json<{
      comparisons: { status: string; baselineRunId: number; changes: unknown[]; notCompared: string[] }[];
    }>();
    expect(changes.comparisons[0]).toMatchObject({ status: "partially_compared", baselineRunId: baseline.id, changes: [],
      notCompared: ["protection_rules"] });
  });

  it("refuses foreign Host headers and cross-site state changes, and allows the local UI", async () => {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    store.saveSelection([1]);
    const app = createApp({ store, token: "mock-token", transport: transport(), sleep: async () => {} });
    cleanup.push(() => app.close());

    // DNS rebinding: a page on attacker.example resolving to 127.0.0.1 sends its own hostname.
    const rebound = await app.inject({ method: "GET", url: "/api/selection", headers: { host: "attacker.example:3001" } });
    expect(rebound.statusCode).toBe(403);
    expect(rebound.json()).toEqual({ error: "forbidden_host" });
    expect(rebound.body).not.toContain("projectIds");

    // Cross-site form or fetch from another site: no run may start and the selection must not change.
    for (const origin of ["https://attacker.example", "null"]) {
      const crossSite = await app.inject({ method: "POST", url: "/api/runs", headers: { host: "127.0.0.1:3001", origin, "content-type": "text/plain" } });
      expect(crossSite.statusCode).toBe(403);
      expect(crossSite.json()).toEqual({ error: "forbidden_origin" });
    }
    const crossSiteSave = await app.inject({ method: "PUT", url: "/api/selection", headers: { host: "127.0.0.1:3001", origin: "https://attacker.example" }, payload: { projectIds: [2] } });
    expect(crossSiteSave.statusCode).toBe(403);
    expect(store.listRuns()).toEqual([]);
    expect(store.getSelection()).toEqual([1]);

    // The local UI through the Vite proxy (loopback Host and Origin, any port) keeps working.
    for (const host of ["127.0.0.1:5173", "localhost:3001", "[::1]:5173"]) {
      expect((await app.inject({ method: "GET", url: "/api/health", headers: { host } })).statusCode).toBe(200);
    }
    const local = await app.inject({ method: "PUT", url: "/api/selection", headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }, payload: { projectIds: [3] } });
    expect(local.statusCode).toBe(200);
    expect(store.getSelection()).toEqual([3]);
  });

  it("does not let a second server interrupt a run owned by a live server", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitlab-evidence-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "evidence.sqlite");
    const first = new Store(path);
    cleanup.push(() => first.close());
    expect(first.recoverOnStartup("first", 1111, () => true)).toEqual({ acquired: true });
    const run = first.createRun([17]);
    first.markRunRunning(run.id);
    first.markProjectRunning(run.id, 17);

    const second = new Store(path);
    cleanup.push(() => second.close());
    expect(second.recoverOnStartup("second", 2222, (pid) => pid === 1111)).toEqual({ acquired: false, holderPid: 1111 });
    expect(second.getRun(run.id)?.state).toBe("running");
    expect(second.getRun(run.id)?.projects?.[0]?.state).toBe("running");
    expect(first.renewLease("first")).toBe(true);

    // Once the owner's process is gone, the next server takes over and recovers its abandoned run.
    expect(second.recoverOnStartup("second", 2222, () => false)).toEqual({ acquired: true });
    expect(second.getRun(run.id)?.state).toBe("interrupted");
    expect(first.renewLease("first")).toBe(false);
  });

  it("takes over a lease that has expired even if its process id is still in use", () => {
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    expect(store.recoverOnStartup("hung", 1111, () => true)).toEqual({ acquired: true });
    expect(store.recoverOnStartup("next", 2222, () => true, 0)).toEqual({ acquired: true });
    expect(store.renewLease("hung")).toBe(false);
  });

  it("upgrades a version 1 database to version 2 without losing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitlab-evidence-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "evidence.sqlite");
    let store = new Store(path);
    store.saveSelection([5, 6]);
    const run = store.createRun([5]);
    store.db.exec("DROP TABLE server_lease; PRAGMA user_version = 1;");
    store.close();
    store = new Store(path);
    cleanup.push(() => store.close());
    expect((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    expect(store.getSelection()).toEqual([5, 6]);
    expect(store.getRun(run.id)?.requestedProjectIds).toEqual([5]);
    expect(store.recoverOnStartup("owner", 1, () => true)).toEqual({ acquired: true });
  });

  it("persists selection and marks unfinished work interrupted after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitlab-evidence-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "evidence.sqlite");
    let store = new Store(path);
    store.saveSelection([17]);
    const run = store.createRun([17]);
    store.markRunRunning(run.id);
    store.markProjectRunning(run.id, 17);
    store.close();
    store = new Store(path);
    cleanup.push(() => store.close());
    store.interruptActiveRuns();
    expect(store.getSelection()).toEqual([17]);
    expect(store.getRun(run.id)?.state).toBe("interrupted");
    expect(store.getRun(run.id)?.projects?.[0]?.state).toBe("interrupted");
    expect(store.createRun([17]).state).toBe("queued");
  });
});
