import type { HttpResponse, HttpTransport } from "./gitlab.js";
import type { Store } from "./store.js";

const mockProject = (id: number, name: string, emptyRepo: boolean) => ({
  id, name, web_url: `https://gitlab.com/example/${name}`, visibility: "private",
  empty_repo: emptyRepo, default_branch: "main",
});

// Deterministic demo scenario that repeats every three runs: success, protected-rule failure, recovery with a
// changed force-push setting. The phase is derived from the persisted run ID, so restarting the server does not
// reset the scenario part-way through.
export function mockPhase(runId: number): 1 | 2 | 3 {
  return (((runId - 1) % 3) + 1) as 1 | 2 | 3;
}

export class MockGitLabTransport implements HttpTransport {
  constructor(private readonly store: Store, private readonly delayMs = 0) {}

  async send(url: URL): Promise<HttpResponse> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const path = `${url.pathname}${url.search}`;
    const phase = mockPhase(this.store.getActiveRun()?.id ?? 1);
    const response = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body });
    if (path === "/api/v4/projects/101") return response(mockProject(101, "mock-protected", false));
    if (path === "/api/v4/projects/102") return response(mockProject(102, "mock-unprotected", false));
    if (path === "/api/v4/projects/103") return response(mockProject(103, "mock-empty", true));
    if (path === "/api/v4/projects/101/repository/branches/main") return response({ name: "main", protected: true });
    if (path === "/api/v4/projects/102/repository/branches/main") return response({ name: "main", protected: false });
    if (path === "/api/v4/projects/103/repository/branches?per_page=100") return response([]);
    if (path === "/api/v4/projects/101/protected_branches?per_page=100") {
      if (phase === 2) return { status: 503, headers: {} };
      return response([{ name: "main", allow_force_push: phase === 3, code_owner_approval_required: false,
        push_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }],
        merge_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }] }]);
    }
    if (path === "/api/v4/projects/102/protected_branches?per_page=100") return response([]);
    return { status: 404, headers: {} };
  }
}
