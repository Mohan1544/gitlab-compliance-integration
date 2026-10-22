# Zania GitLab compliance integration: assessment plan

Status: implementation and demo artifacts are present. The React UI, Fastify API, SQLite persistence, collector, comparisons, mocked recovery demo, and automated tests are implemented. Live runs 11-13 record the baseline, force-push change, and restoration, with screenshots and video linked in the README. Follow-up fixes address process ownership, terminal outcomes, unknown comparison fields, and persistence-error attribution. Local verification covers 53 server tests, 10 browser tests, and the production build. CI is configured; remote execution of this revision, final sharing with the assessors, and a recorded manual accessibility review remain outstanding.

## Source and scope

- Source: `D:/Companies/zania-gitlab-integration-assessment.pdf` (two-page take-home assessment supplied by the candidate).
- Build a **local full-stack application** using React + TypeScript, a Node.js backend, and persistent local storage (SQLite is sufficient). No starter code is provided.
- Use real GitLab.com APIs. The application must be **read-only toward GitLab**. A person may create test projects and change a protection setting in GitLab for the required demo; the application itself must not do so.
- One local user and one server-configured personal access token are in scope.
- Explicitly out of scope: sign-in, multi-tenancy, OAuth onboarding, cloud deployment, scheduling, source-code collection, compliance scoring, effective-user permission calculations, separate group-policy traversal, and paid-tier features.
- Quality bar: build this local assignment with production-minded correctness, security, recovery, observability, and tests, while respecting the stated scope.

## Requirement checklist

### Test environment

- [x] Candidate reports a free personal GitLab.com account; do not use employer or Zania credentials.
- [x] Seed three **synthetic** projects: initialized + protected default branch; initialized + unprotected default branch; empty repository with no actual branches or commits. All three states were checked through live API calls.
- [x] Candidate reports a personal access token with `read_api`; it is provided server-side as `GITLAB_TOKEN`. Read-only API calls succeeded, but the token scope itself was not independently inspected.
- [x] Record reproducible seed steps and the three numeric project IDs without including the token. Verify the actual GitLab responses for all three states before relying on fixtures.

### Collection and evidence

- [x] Save a selection of numeric project IDs, reject invalid/duplicate IDs, and capture that selection in each run.
- [x] Collect each project's stable ID, name, URL, visibility, default branch, and GitLab-reported protection status.
- [x] Collect default-branch protection configuration sufficiently to explain push, merge, unprotect, force-push, and code-owner restrictions **where the API returns those fields**.
- [x] Store collection time, source endpoint/reference, field-level availability, errors, and an outcome for **every requested project**.
- [x] Preserve usable partial evidence, previous successful evidence, and the exact requested set in historical runs.
- [x] Explain API coverage and limits honestly, especially wildcard/inherited rules and the fact that project-level rules do not prove effective permissions for individual users.

### Analyst experience

- [x] Let the analyst save project IDs, start an asynchronous run, and see run and per-project progress.
- [x] Restore an active run after browser refresh; keep the UI usable while it executes.
- [x] Show current outcome separately from last successful evidence, with its age and next action for failed/incomplete/empty states.
- [x] Browse immutable past runs, their requested IDs, observed evidence, and failures.
- [x] Show meaningful protection changes and identify each comparison's baseline run and collection time.
- [ ] Complete a manual accessibility review of the implemented semantic controls, labels, and status messages.

### Reliability, verification, delivery

- [x] Define bounded retries, timeouts, concurrency, interruption recovery, and repeated-run behavior.
- [x] Persist saved configuration and completed runs across browser refresh and server restart; never leave interrupted work marked running forever.
- [x] Test collection, errors, persistence, recovery, and comparisons with mocked GitLab HTTP responses; tests need no credentials or GitLab access.
- [x] Add automated browser tests for successful collection and partial failure, both exercising the real backend collection logic with mocked GitLab HTTP.
- [x] Provide a reproducible mocked partial-failure demo, including the recovery action. Do not create real outages or rate-limit traffic.
- [x] Use the UI for a live demonstration: collect all three real projects, change one protection setting **manually in GitLab**, collect again, and show the difference. Include screenshots or a short recording.
  - Existing live runs 11-13 show the baseline, changed force-push setting, and restoration. Screenshots and video are checked into `docs/demo/live/` and linked in the README, which records their sanitization review. Follow-up verification did not re-record the demo or independently repeat that review.
- [x] Prepare a runnable repository and README with Node version; exact install, storage setup, run, and test commands; placeholder config; seed instructions; API/permission choices; design and data model; assumptions, limitations, production changes; demos; and AI use plus verification.
- [ ] Share the final reviewed revision with the assessors. The repository has an origin configured; this follow-up does not publish or submit it.

## Implemented API collection policy

These choices are based on GitLab documentation and were checked against real responses from the seeded projects. A live run through the new collector completed for all three projects; the manual two-run UI demonstration is still required.

| Step | GitLab.com endpoint | Evidence / decision |
| --- | --- | --- |
| 1 | `GET /api/v4/projects/:id` | Identity, URL, visibility, `default_branch`, `empty_repo`. Store the returned ID and endpoint URL without the token. |
| 2 | `GET /api/v4/projects/:id/repository/branches/:branch` | For a non-empty project with a default branch, use GitLab's `protected` boolean as the reported status. URL-encode the branch name. |
| 3 | `GET /api/v4/projects/:id/protected_branches` | Collect all pages of visible protection rules, including exact and wildcard names and returned access-level fields. Retain rules as reported and show which appear applicable to the default branch; avoid claiming a fully calculated effective permission set. |

- If the project response confirms `empty_repo: true`, check the repository branch list and record **not applicable: empty repository** when no branch exists. A real GitLab.com response from this test environment reported `default_branch: "main"` even though `empty_repo: true` and the branch GET returned `404`; do not treat the project field alone as proof that a branch exists, and do not call it unprotected.
- If a branch or rules request fails, record **unknown/unreadable** for the affected evidence. A branch `404` after a non-empty project response is an error/inconsistency to investigate, not proof of absence. A project `404` may also mean no access.
- A successful protected-rule list with no applicable rule supports “no visible project rule”; use the branch endpoint's `protected` boolean for the authoritative reported branch state. If it reports protected but configuration cannot be explained from visible rules, show **protected, configuration incomplete**.
- GitLab can evaluate several matching rules, including wildcards and group rules; most permissive access generally applies while code-owner approval is more restrictive. We will retain source rules and state the limitation rather than invent effective-user access. The assignment excludes separate group-policy traversal.
- Capture per-endpoint fetch times and HTTP status/error category, with safe message text. Do not persist request headers, token, or full error bodies that may contain sensitive content.
- Follow GitLab's pagination `Link` response for protected rules, validating that every next URL remains on `gitlab.com` under `/api/v4` before forwarding the token. A short page is not proof that pagination ended. [REST pagination](https://docs.gitlab.com/api/rest/#pagination).
- The three requests are not an atomic GitLab snapshot. If the default branch changes or disappears between reads, preserve the facts already read, mark the observation inconsistent/incomplete, and suggest a new collection; do not infer a posture change from the mismatch.

## Evidence and outcome semantics

- Model each requested fact as **observed**, **confirmed absent/not applicable**, or **unknown/unreadable**. A successful empty rule list is different from an endpoint failure. A field omitted by the provider is different from an explicit `false` or `[]`.
- An empty repository is a **complete, not-applicable** branch-protection observation only when the project reports `empty_repo: true` and the branch list confirms no actual branches. If those reads disagree, mark it incomplete.
- A project outcome is **complete** when all required evidence for its state is readable, **partial** when some useful evidence is readable but a required step fails, and **failed** when the project itself cannot be read. Persist an outcome for every requested ID, including IDs that never start because a run is interrupted.
- A run is **completed** when every project is complete, **partial** when at least one project yields useful evidence but some projects are partial/failed, and **failed** when no requested project yields useful evidence. `interrupted` is distinct from those terminal collection outcomes.
- Show **last successful evidence** with its collection time whenever the newest attempt is partial, failed, or interrupted. Label it “older evidence” and show its age. The UI also labels evidence older than seven days as stale; this is a documented display policy, not a GitLab or assessment requirement. If there is no last-successful observation, show unknown with a retry or access-check action.
- Distinguish authentication failure (`401`), authorization/visibility failure (`403` or possible `404`), transient failure (`429`, `5xx`, timeout), and malformed response in stored status and analyst-facing next actions. Do not expose raw provider bodies.

Official references: [Projects API](https://docs.gitlab.com/api/projects/), [Branches API](https://docs.gitlab.com/api/branches/), [Protected branches API](https://docs.gitlab.com/api/protected_branches/), [Protection rule behavior](https://docs.gitlab.com/user/project/repository/branches/protection_rules/), [REST authentication and rate limits](https://docs.gitlab.com/api/rest/authentication/).

## Implementation decisions

These are our engineering choices, not requirements stated by the assessment. The application and automated tests are implemented. `DESIGN.md` records the detailed architecture and its invariants; `README.md` contains exact setup and test commands.

- **Runtime and tooling:** Node.js 24 LTS, npm workspaces, Vite + React + TypeScript client, and Fastify + TypeScript server. Pin actual dependency versions in a lockfile during scaffolding. The machine's system Node.js 20.11.0 is end-of-life and below current Vite's minimum; a bundled Node.js 24.19.0 runtime is available for implementation. [Node release status](https://nodejs.org/en/about/previous-releases/), [Vite requirements](https://vite.dev/guide/).
- **Architecture:** one local HTTP server and a server-side run worker in the same process; SQLite via Node 24's built-in `node:sqlite` with explicit migrations. Keep GitLab HTTP access behind an injectable transport so tests and the mocked demo exercise the same collection logic. The built-in API is a release candidate, so pin Node 24 and test storage/restart behavior.
- **Storage model:** `selection` (saved ordered project IDs); `runs` (requested IDs snapshot, state and times); `run_projects` (one row per requested ID, evidence, state, times and safe error); `source_reads` (per-request/page selected evidence, status and provenance). Transactions protect migration, run creation, and finalization.
- **Run lifecycle:** queued -> running -> completed/partial/failed/interrupted. A second start request returns a conflict with the active run ID. Startup takes an OS-held lock on the data directory before opening or recovering it. A live owner blocks a second server; the lock is released when the owner exits for any reason, so a crash never blocks the next start. Terminal outcomes reject late completion writes. A new run is the recovery path.
- **Execution:** process projects independently with small bounded concurrency. Apply request timeout and bounded exponential backoff with jitter for network errors, `429`, and transient `5xx`; honor a valid `Retry-After`. Do not retry indefinitely. Treat auth/permission/invalid-ID failures as terminal for that project. Make repeated requests safe by using GitLab `GET` only.
- **Local API:** read/update saved IDs, start run, get active run, list runs, get run details and comparison. Poll progress from the client; on reload, request active run and current history. No browser request goes directly to GitLab. Implemented routes are listed in `DESIGN.md`.
- **UI:** one dashboard for saved IDs, run button, live per-project progress and latest outcomes; project detail for current/last-good evidence and sources; history/comparison view showing changed values, baseline, and uncertainty.
- **Tests:** Vitest for collection, persistence, recovery, and comparison logic; Playwright for the two required browser paths. Browser tests launch the real backend with an injected mock GitLab HTTP transport and no token. A clearly labeled mock scenario provides the reproducible partial-failure demo.
- **Security:** token loaded from server environment only; bind local server to loopback; validate numeric IDs; sanitize logs and API errors; `.gitignore` local env, SQLite data, and demo secrets; no write-capable GitLab routes or token-bearing browser state.
- **Production-minded operation:** explicit startup DB migration, graceful shutdown, bounded resource use, persisted safe error codes and deterministic recovery. Runtime logging is currently minimal; structured operational logging remains a hardening item. The README distinguishes this local design from changes needed for a deployed multi-user service.

## Implemented comparison policy

- Compare each project's new **complete, readable protection observation** with its most recent prior **complete, readable observation**; show both run IDs and timestamps. A failed or partial run does not silently replace that baseline.
- A partial current observation compares only its successfully observed facts against that complete baseline; the UI lists the remaining facts as not compared.
- Meaningful changes: default-branch name, GitLab `protected` status, and normalized applicable protection-rule settings (push/merge/unprotect access entries, force push, code-owner approval, and returned rule names/inheritance markers). Sort access entries so response order alone is not a change; ignore provider-generated record IDs and collection timestamps.
- Distinguish **posture change** from **collection change**. Unknown, unreadable, or missing data is a collection problem, never a confirmed protection removal. Show “no comparable baseline” where appropriate.
- If a project changes from empty to initialized, or the default branch changes, display that transition explicitly. Confirm during implementation how the comparison view handles newly applicable rules.

## Test and demo matrix

| Case | Expected assertion |
| --- | --- |
| Protected, unprotected, empty seeded responses | Correct tri-state status, configuration detail, and empty-state message. Include GitLab's observed case `empty_repo: true`, `default_branch: "main"`, and repository branches `[]`; never call that an existing or unprotected branch. |
| One project `403`/`404` or malformed response | Every requested ID has an outcome; prior good evidence remains visible; no false unprotected claim. |
| Protected branch readable, rules request fails | Preserve the protected status, mark configuration incomplete, and suggest retry/access check. |
| `429` with `Retry-After`, transient `5xx`, network timeout | Bounded retry then success or visible failure; no endless active run. |
| Process restart during a run | Previous run becomes interrupted and visible; new run can start. |
| Two collections with a changed rule, reordered access entries, or partial second run | Real setting change appears with baseline; reordering does not; incomplete data does not become a posture change. |
| Browser success and partial-failure scenarios | Real backend worker + mocked GitLab HTTP, progress/history display, refresh/recovery path. |
| Provider field omitted versus explicit `false`/`[]` | Preserve unknown/unsupported versus observed values; never invent an access rule or posture change. |
| Rule pagination and an API-state race | Follow safe next links; record an inconsistent observation when the default branch changes between calls. |
| Newest run failed after an older success | Display latest failure and older evidence with its age; identify the older run and give a recovery action. |

Mocked demo idea: configure a documented local mock mode or test fixture so one selected project's protected-rules request returns `503` while the other projects succeed; show partial result and last-good evidence; then remove the failure and start another run to show recovery. Ensure this mode is clearly labeled and cannot accidentally use the real token.

Live demo change: after the first collection, manually toggle **Allowed to force push** on the protected test project's `main` branch in GitLab, collect again, and show `allow_force_push: false -> true` with the first run as baseline. This is a meaningful, API-visible change supported by [GitLab's protected-branch controls](https://docs.gitlab.com/user/project/repository/branches/protected/#allow-force-push). Restore the original setting after capturing the demo; never have the application perform the change.

## Delivery progress

1. **Done:** verify the three GitLab API states and document the empty-repository `default_branch` discrepancy.
2. **Done:** Node 24/npm workspace, Vite client, Fastify server, SQLite migration, persistent selection, and setup commands.
3. **Done:** GitLab client and asynchronous collector with per-step provenance, bounded retries, one-active-run enforcement, interruption recovery, and mocked tests.
4. **Done:** selection, progress, evidence detail, last-good evidence, history, comparisons, and refresh reconnection.
5. **Done:** Playwright success, partial-failure/recovery, and stale-evidence tests; repeatable isolated mock demo.
6. **Done:** live UI baseline/change/restoration demonstration, saved screenshots and recordings, repository setup, and README delivery details.
7. **Done locally:** follow-up regression fixes, documentation reconciliation, 53 server tests, 10 browser tests, and production build. CI configuration is present in the working tree.
8. **Remaining:** recorded manual accessibility review, first remote CI run for this revision, and final sharing with the assessors.

## Resolved planning choices

- [x] Use `D:/Companies/GitLabComplianceIntegration` for the implementation and submission. The repository has committed history and a GitHub origin; follow-up fixes require final publication/sharing by the candidate.
- [x] Candidate reports a new personal GitLab.com account and all three synthetic projects. Live GitLab.com API responses verified protected `main` (`protected: true`, rule visible), unprotected `main` (`protected: false`, no protected rules), and an empty repository (`empty_repo: true`, branches `[]`). The empty project's project-level `default_branch` field nevertheless says `main`; treat that as configured metadata, not an existing branch. Follow `GITLAB_SEED_GUIDE.md` for the local read-only verification command. Do **not** send the token in chat.
- [x] Standardize on Node.js 24 LTS and npm workspaces. Use the available bundled Node 24 runtime for development; document Node 24 installation for reviewers.
- [x] Use sanitized screenshots for the live two-run demonstration; a recording is optional if screenshots prove the flow clearly.
- [x] Use the most recent prior complete observation for the same project as the comparison baseline; start a fresh run to recover from a failed or interrupted one. Verify these policies in tests and the demo.

## Planning integrity

Required items above come from the supplied assessment. Architecture, schema, UI, retry, comparison, staleness, and mock-demo details are engineering choices. Current local verification on October 22, 2026 covers 53 server tests, 10 browser tests, and the production build. Existing artifacts document the three live seed states and the UI baseline/change/restoration flow. Follow-up tests use synthetic responses and temporary databases; no live GitLab settings were changed. Manual accessibility verification and remote CI are not claimed complete.
