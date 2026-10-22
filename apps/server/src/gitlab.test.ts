import { afterEach, describe, expect, it } from "vitest";
import { GitLabClient, nextPage, parseProject, parseRules, type HttpResponse, type HttpTransport } from "./gitlab.js";
import { Store } from "./store.js";

const project = { id: 1, name: "p", web_url: "https://gitlab.com/example/p", visibility: "private", empty_repo: false, default_branch: "main" };

const stores: Store[] = [];
afterEach(() => { while (stores.length > 0) stores.pop()?.close(); });

// Replays scripted responses (or thrown errors) in order and records what the client asked for.
function scripted(steps: (HttpResponse | Error)[]) {
  const calls: string[] = [];
  const transport: HttpTransport = {
    async send(url) {
      calls.push(`${url.pathname}${url.search}`);
      const step = steps.shift();
      if (!step) throw new Error("No scripted response left");
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { transport, calls };
}

function setup(steps: (HttpResponse | Error)[]) {
  const store = new Store(":memory:");
  stores.push(store);
  const run = store.createRun([1]);
  const sleeps: number[] = [];
  const { transport, calls } = scripted(steps);
  const client = new GitLabClient("secret", transport, store, async (milliseconds) => { sleeps.push(milliseconds); });
  const reads = () => store.getRun(run.id)?.projects?.[0]?.reads ?? [];
  return { client, runId: run.id, sleeps, calls, reads };
}

const timeoutError = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

describe("GitLab boundary", () => {
  it("does not forward the token to an external pagination URL", async () => {
    const { client, runId, calls, reads } = setup([]);
    const result = await client.get(runId, 1, "protected_branches", 1,
      "https://attacker.example/api/v4/projects/1/protected_branches", parseRules);
    expect(result).toEqual({ ok: false, errorCode: "unsafe_pagination_link" });
    expect(calls).toEqual([]);
    expect(reads()[0]).toMatchObject({ state: "unreadable", errorCode: "unsafe_pagination_link", attempts: 0 });
  });

  it("does not follow a pagination link to another project on gitlab.com", async () => {
    const { client, runId, calls } = setup([]);
    const result = await client.get(runId, 1, "protected_branches", 2,
      "https://gitlab.com/api/v4/projects/12/protected_branches?page=2", parseRules);
    expect(result).toMatchObject({ ok: false, errorCode: "unsafe_pagination_link" });
    expect(calls).toEqual([]);
  });

  it("parses the next GitLab page without inferring an end from page length", () => {
    expect(nextPage('<https://gitlab.com/api/v4/projects/1/protected_branches?page=2>; rel="next", <https://gitlab.com/api/v4/projects/1/protected_branches?page=5>; rel="last"'))
      .toContain("page=2");
    expect(nextPage('<https://gitlab.com/api/v4/projects/1/protected_branches?page=5>; rel="last"')).toBeNull();
    expect(nextPage(undefined)).toBeNull();
  });

  it("honours Retry-After on 429 and records the successful read with its attempt count", async () => {
    const { client, runId, sleeps, reads } = setup([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200, headers: {}, body: project },
    ]);
    const result = await client.get(runId, 1, "project", 1, "projects/1", parseProject);
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([2000]);
    expect(reads()[0]).toMatchObject({ state: "observed", httpStatus: 200, attempts: 2 });
  });

  it("stops instead of waiting when Retry-After exceeds the request budget", async () => {
    const { client, runId, sleeps, reads } = setup([{ status: 429, headers: { "retry-after": "120" } }]);
    const result = await client.get(runId, 1, "project", 1, "projects/1", parseProject);
    expect(result).toEqual({ ok: false, errorCode: "rate_limited", httpStatus: 429 });
    expect(sleeps).toEqual([]);
    expect(reads()[0]).toMatchObject({ state: "unreadable", errorCode: "rate_limited", attempts: 1 });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found_or_inaccessible"],
    [302, "unexpected_redirect"],
    [422, "http_error"],
  ])("does not retry a permanent %i response and classifies it as %s", async (status, errorCode) => {
    const { client, runId, calls, reads } = setup([{ status, headers: {} }]);
    const result = await client.get(runId, 1, "project", 1, "projects/1", parseProject);
    expect(result).toEqual({ ok: false, errorCode, httpStatus: status });
    expect(calls).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ state: "unreadable", errorCode, httpStatus: status, attempts: 1 });
  });

  it("retries transient 5xx responses with bounded attempts", async () => {
    const { client, runId, calls, sleeps } = setup([{ status: 502, headers: {} }, { status: 503, headers: {} }, { status: 500, headers: {} }]);
    const result = await client.get(runId, 1, "project", 1, "projects/1", parseProject);
    expect(result).toEqual({ ok: false, errorCode: "provider_unavailable", httpStatus: 500 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("retries timeouts and reports a timeout when every attempt times out", async () => {
    const { client, runId, calls, reads } = setup([timeoutError(), timeoutError(), timeoutError()]);
    const result = await client.get(runId, 1, "project", 1, "projects/1", parseProject);
    expect(result).toEqual({ ok: false, errorCode: "timeout", httpStatus: undefined });
    expect(calls).toHaveLength(3);
    expect(reads()[0]).toMatchObject({ state: "unreadable", errorCode: "timeout", attempts: 3 });
  });

  it("recovers from a transient network error", async () => {
    const { client, runId, reads } = setup([new TypeError("fetch failed"), { status: 200, headers: {}, body: project }]);
    expect((await client.get(runId, 1, "project", 1, "projects/1", parseProject)).ok).toBe(true);
    expect(reads()[0]).toMatchObject({ state: "observed", attempts: 2 });
  });

  it("treats an unexpected response shape as unreadable without retrying or storing the value", async () => {
    const { client, runId, calls, reads } = setup([{ status: 200, headers: {}, body: { ...project, empty_repo: "no" } }]);
    const result = await client.get(runId, 1, "project", 1, "projects/1", parseProject);
    expect(result).toMatchObject({ ok: false, errorCode: "malformed_response" });
    expect(calls).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ state: "unreadable", errorCode: "malformed_response" });
    expect(reads()[0]?.response).toBeUndefined();
  });

  it("records an empty list as a confirmed absence, not as unreadable", async () => {
    const { client, runId, reads } = setup([{ status: 200, headers: {}, body: [] }]);
    expect(await client.get(runId, 1, "protected_branches", 1, "projects/1/protected_branches", parseRules)).toMatchObject({ ok: true, value: [] });
    expect(reads()[0]).toMatchObject({ state: "confirmed_absent" });
  });
});
