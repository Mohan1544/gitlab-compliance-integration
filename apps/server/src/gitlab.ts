import type { AccessLevelFact, BranchFact, ProjectFact, RuleFact, SourceName } from "./types.js";
import type { Store } from "./store.js";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HttpTransport {
  send(url: URL, token: string, timeoutMs: number): Promise<HttpResponse>;
}

export class FetchTransport implements HttpTransport {
  async send(url: URL, token: string, timeoutMs: number): Promise<HttpResponse> {
    const response = await fetch(url, {
      method: "GET",
      headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: response.ok ? await response.json() as unknown : undefined,
    };
  }
}

export type ReadResult<T> =
  | { ok: true; value: T; headers: Record<string, string> }
  | { ok: false; errorCode: string; httpStatus?: number };

export type Parser<T> = (value: unknown) => T;

const API_BASE = new URL("https://gitlab.com/api/v4/");
const REQUEST_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 30_000;
const MAX_ATTEMPTS = 3;

export class GitLabClient {
  constructor(
    private readonly token: string,
    private readonly transport: HttpTransport,
    private readonly store: Store,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async get<T>(runId: number, projectId: number, source: SourceName, sequence: number,
    pathOrUrl: string, parse: Parser<T>): Promise<ReadResult<T>> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let url: URL;
    try {
      url = this.safeUrl(pathOrUrl, projectId);
    } catch {
      this.store.recordRead({ runId, projectId, source, sequence, endpoint: "invalid_next_link", state: "unreadable",
        attempts: 0, startedAt, finishedAt: new Date().toISOString(), errorCode: "unsafe_pagination_link" });
      return { ok: false, errorCode: "unsafe_pagination_link" };
    }

    let lastStatus: number | undefined;
    let errorCode = "network_error";
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      let response: HttpResponse;
      try {
        response = await this.transport.send(url, this.token, REQUEST_TIMEOUT_MS);
      } catch (error) {
        errorCode = error instanceof SyntaxError ? "malformed_response" :
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network_error";
        if (errorCode === "malformed_response" || !this.canRetry(startedMs, attempt, 0)) break;
        await this.sleep(this.retryDelay(attempt));
        continue;
      }

      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        try {
          const value = parse(response.body);
          this.store.recordRead({ runId, projectId, source, sequence, endpoint: `${url.pathname}${url.search}`,
            state: Array.isArray(value) && value.length === 0 ? "confirmed_absent" : "observed",
            httpStatus: response.status, attempts, startedAt, finishedAt: new Date().toISOString(), response: value });
          return { ok: true, value, headers: response.headers };
        } catch {
          errorCode = "malformed_response";
          break;
        }
      }

      errorCode = classifyStatus(response.status);
      if (!isRetryable(response.status)) break;
      const delay = this.retryAfter(response.headers["retry-after"]) ?? this.retryDelay(attempt);
      if (!this.canRetry(startedMs, attempt, delay)) break;
      await this.sleep(delay);
    }

    this.store.recordRead({ runId, projectId, source, sequence, endpoint: `${url.pathname}${url.search}`,
      state: "unreadable", httpStatus: lastStatus, attempts, startedAt, finishedAt: new Date().toISOString(), errorCode });
    return { ok: false, errorCode, httpStatus: lastStatus };
  }

  notApplicable(runId: number, projectId: number, source: SourceName, reason: string): void {
    const now = new Date().toISOString();
    this.store.recordRead({ runId, projectId, source, sequence: 1, endpoint: reason, state: "not_applicable",
      attempts: 0, startedAt: now, finishedAt: now });
  }

  private safeUrl(pathOrUrl: string, projectId: number): URL {
    const url = new URL(pathOrUrl, API_BASE);
    const projectPrefix = `/api/v4/projects/${projectId}`;
    if (url.protocol !== "https:" || url.host !== "gitlab.com" || url.username || url.password ||
      (url.pathname !== projectPrefix && !url.pathname.startsWith(`${projectPrefix}/`))) {
      throw new Error("Unsafe GitLab URL");
    }
    return url;
  }

  private retryDelay(attempt: number): number {
    return Math.min(2_000, 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
  }

  private retryAfter(header: string | undefined): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }

  private canRetry(startedMs: number, attempt: number, delay: number): boolean {
    return attempt < MAX_ATTEMPTS && Date.now() - startedMs + delay + REQUEST_TIMEOUT_MS <= TOTAL_BUDGET_MS;
  }
}

export function classifyStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found_or_inaccessible";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status >= 300 && status < 400) return "unexpected_redirect";
  return "http_error";
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid provider shape");
  return value as Record<string, unknown>;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Invalid provider shape");
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error("Invalid provider shape");
  return value as number;
}

function accessLevels(value: unknown): AccessLevelFact[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid provider shape");
  return value.map((item) => {
    const row = object(item);
    const description = row.access_level_description;
    if (description !== undefined && description !== null && typeof description !== "string") throw new Error("Invalid provider shape");
    return {
      accessLevel: optionalNumber(row, "access_level"),
      accessLevelDescription: typeof description === "string" ? description : undefined,
      userId: optionalNumber(row, "user_id"),
      groupId: optionalNumber(row, "group_id"),
      deployKeyId: optionalNumber(row, "deploy_key_id"),
    };
  });
}

export function parseProject(value: unknown): ProjectFact {
  const row = object(value);
  if (!Number.isSafeInteger(row.id) || typeof row.name !== "string" || typeof row.web_url !== "string" ||
    typeof row.visibility !== "string" || typeof row.empty_repo !== "boolean" ||
    !(typeof row.default_branch === "string" || row.default_branch === null)) throw new Error("Invalid project shape");
  return { id: row.id as number, name: row.name, webUrl: row.web_url, visibility: row.visibility,
    emptyRepo: row.empty_repo, reportedDefaultBranch: row.default_branch };
}

export function parseBranch(value: unknown): BranchFact {
  const row = object(value);
  if (typeof row.name !== "string" || typeof row.protected !== "boolean") throw new Error("Invalid branch shape");
  return { name: row.name, protected: row.protected };
}

export function parseBranchNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid branches shape");
  return value.map((item) => {
    const row = object(item);
    if (typeof row.name !== "string") throw new Error("Invalid branches shape");
    return row.name;
  });
}

export function parseRules(value: unknown): RuleFact[] {
  if (!Array.isArray(value)) throw new Error("Invalid rules shape");
  return value.map((item) => {
    const row = object(item);
    if (typeof row.name !== "string") throw new Error("Invalid rule shape");
    return {
      name: row.name,
      allowForcePush: optionalBoolean(row, "allow_force_push"),
      codeOwnerApprovalRequired: optionalBoolean(row, "code_owner_approval_required"),
      pushAccessLevels: accessLevels(row.push_access_levels),
      mergeAccessLevels: accessLevels(row.merge_access_levels),
      unprotectAccessLevels: accessLevels(row.unprotect_access_levels),
    };
  });
}

export function nextPage(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i);
    if (match) return match[1] ?? null;
  }
  return null;
}
