import { afterEach, describe, expect, it } from "vitest";
import { Collector } from "./collector.js";
import { GitLabClient, type HttpResponse, type HttpTransport } from "./gitlab.js";
import { Store } from "./store.js";

const project = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, name: `Project ${id}`, web_url: `https://gitlab.com/example/${id}`,
  visibility: "private", empty_repo: false, default_branch: "main", ...overrides,
});
const ok = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, body });
const rule = (name: string) => ({ name, allow_force_push: false, push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }] });

const stores: Store[] = [];
afterEach(() => { while (stores.length > 0) stores.pop()?.close(); });

// Routes are keyed by path + query, matching the documented GitLab REST endpoints the collector calls.
async function collect(projectId: number, routes: Record<string, HttpResponse | ((calls: number) => HttpResponse)>) {
  const store = new Store(":memory:");
  stores.push(store);
  const counts = new Map<string, number>();
  const transport: HttpTransport = {
    async send(url) {
      const path = `${url.pathname}${url.search}`;
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      const route = routes[path];
      if (!route) throw new Error(`Unexpected mock path: ${path}`);
      return typeof route === "function" ? route(count) : route;
    },
  };
  const run = store.createRun([projectId]);
  await new Collector(store, new GitLabClient("mock-token", transport, store, async () => {})).execute(run.id);
  const result = store.getRun(run.id)!;
  return { run: result, project: result.projects![0]!, counts };
}

const base = "/api/v4/projects/1";

describe("collector", () => {
  it("keeps checkpointed evidence when an unexpected error stops a project", async () => {
    // A storage failure while recording the rules read stands in for any unexpected error after some facts were saved.
    class FailingStore extends Store {
      override recordRead(read: Parameters<Store["recordRead"]>[0]): void {
        if (read.source === "protected_branches") throw new Error("disk full");
        super.recordRead(read);
      }
    }
    const store = new FailingStore(":memory:");
    stores.push(store);
    const transport: HttpTransport = { async send(url) {
      const path = `${url.pathname}${url.search}`;
      if (path === base) return ok(project(1));
      if (path === `${base}/repository/branches/main`) return ok({ name: "main", protected: true });
      return ok([rule("main")]);
    } };
    const run = store.createRun([1]);
    await new Collector(store, new GitLabClient("mock-token", transport, store, async () => {})).execute(run.id);
    const outcome = store.getRun(run.id)!.projects![0]!;
    expect(outcome).toMatchObject({ state: "partial", errorCode: "unexpected_collection_error" });
    expect(outcome.evidence?.branch).toEqual({ name: "main", protected: true });
    expect(outcome.evidence?.classification).toBe("protected");
    expect(store.getRun(run.id)?.state).toBe("partial");
  });

  it("fails a project with no evidence when an unexpected error happens before anything is saved", async () => {
    class FailingStore extends Store {
      override recordRead(): void { throw new Error("disk full"); }
    }
    const store = new FailingStore(":memory:");
    stores.push(store);
    const run = store.createRun([1]);
    await new Collector(store, new GitLabClient("mock-token", { async send() { return ok(project(1)); } }, store, async () => {})).execute(run.id);
    expect(store.getRun(run.id)!.projects![0]).toMatchObject({ state: "failed", errorCode: "unexpected_collection_error", evidence: null });
  });

  it("follows Link pagination across protected-branch pages and keeps every page's provenance", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "main", protected: true }),
      [`${base}/protected_branches?per_page=100`]: ok([rule("release/*")],
        { link: `<https://gitlab.com${base}/protected_branches?per_page=100&page=2>; rel="next"` }),
      [`${base}/protected_branches?per_page=100&page=2`]: ok([rule("main")]),
    });
    expect(outcome.state).toBe("complete");
    expect(outcome.evidence?.rules?.map((item) => item.name)).toEqual(["release/*", "main"]);
    expect(outcome.evidence?.applicableRules).toEqual([{ name: "main", match: "exact" }]);
    expect(outcome.reads?.filter((read) => read.source === "protected_branches").map((read) => read.sequence)).toEqual([1, 2]);
  });

  it("requests another page when a full page arrives without pagination headers", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => rule(`feature-${index}`));
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "main", protected: true }),
      [`${base}/protected_branches?per_page=100`]: ok(fullPage),
      [`${base}/protected_branches?per_page=100&page=2`]: ok([rule("main")]),
    });
    expect(outcome.state).toBe("complete");
    expect(outcome.evidence?.rules).toHaveLength(101);
  });

  it("marks the project partial instead of truncating silently when the page cap is reached", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "main", protected: true }),
      ...Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
        index === 0 ? `${base}/protected_branches?per_page=100` : `${base}/protected_branches?per_page=100&page=${index + 1}`,
        ok([rule(`r${index}`)], { link: `<https://gitlab.com${base}/protected_branches?per_page=100&page=${index + 2}>; rel="next"` }),
      ])),
    });
    expect(outcome).toMatchObject({ state: "partial", errorCode: "pagination_limit" });
    expect(outcome.evidence?.rules).toBeUndefined();
  });

  it("explains protection that comes from a wildcard rule", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "main", protected: true }),
      [`${base}/protected_branches?per_page=100`]: ok([rule("ma*"), rule("release/*")]),
    });
    expect(outcome.state).toBe("complete");
    expect(outcome.evidence?.applicableRules).toEqual([{ name: "ma*", match: "wildcard" }]);
    expect(outcome.evidence?.coverageWarnings).toBeUndefined();
  });

  it("flags GitLab-reported protection that no visible project rule explains, without calling it a failure", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "main", protected: true }),
      [`${base}/protected_branches?per_page=100`]: ok([rule("release/*")]),
    });
    expect(outcome).toMatchObject({ state: "complete", errorCode: null });
    expect(outcome.evidence?.classification).toBe("protected");
    expect(outcome.evidence?.coverageWarnings).toEqual(["protected_without_visible_rule"]);
  });

  it("never classifies a branch it could not read as unprotected", async () => {
    const { project: outcome, run } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: { status: 404, headers: {} },
    });
    expect(outcome).toMatchObject({ state: "partial", errorCode: "not_found_or_inaccessible" });
    expect(outcome.evidence?.project.id).toBe(1);
    expect(outcome.evidence?.classification).toBeUndefined();
    expect(outcome.evidence?.branch).toBeUndefined();
    expect(run.state).toBe("partial");
  });

  it("marks a default branch renamed between reads as partial", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "trunk", protected: true }),
    });
    expect(outcome).toMatchObject({ state: "partial", errorCode: "default_branch_mismatch" });
    expect(outcome.evidence?.classification).toBeUndefined();
  });

  it("does not call a repository empty when GitLab says empty but branches exist", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1, { empty_repo: true })),
      [`${base}/repository/branches?per_page=100`]: ok([{ name: "main" }]),
    });
    expect(outcome).toMatchObject({ state: "partial", errorCode: "empty_repo_branch_mismatch" });
    expect(outcome.evidence?.classification).toBeUndefined();
  });

  it("fails the project and the run when project identity cannot be read", async () => {
    const { project: outcome, run } = await collect(1, { [base]: { status: 404, headers: {} } });
    expect(outcome).toMatchObject({ state: "failed", errorCode: "not_found_or_inaccessible", evidence: null });
    expect(run.state).toBe("failed");
    expect(run.finishedAt).not.toBeNull();
  });

  it("rejects a response for a different project than the one requested", async () => {
    const { project: outcome } = await collect(1, { [base]: ok(project(2)) });
    expect(outcome).toMatchObject({ state: "failed", errorCode: "project_id_mismatch", evidence: null });
  });

  it("keeps the protected flag when the rules read fails", async () => {
    const { project: outcome } = await collect(1, {
      [base]: ok(project(1)),
      [`${base}/repository/branches/main`]: ok({ name: "main", protected: false }),
      [`${base}/protected_branches?per_page=100`]: { status: 403, headers: {} },
    });
    expect(outcome).toMatchObject({ state: "partial", errorCode: "forbidden" });
    expect(outcome.evidence?.branch).toEqual({ name: "main", protected: false });
    expect(outcome.evidence?.rules).toBeUndefined();
  });
});
