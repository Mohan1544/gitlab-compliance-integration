export interface ProjectFact {
  id: number;
  name: string;
  webUrl: string;
  visibility: string;
  emptyRepo: boolean;
  reportedDefaultBranch: string | null;
}

export interface Evidence {
  project: ProjectFact;
  branch?: { name: string; protected: boolean };
  branchNames?: string[];
  rules?: { name: string; allowForcePush?: boolean; codeOwnerApprovalRequired?: boolean;
    pushAccessLevels?: unknown[]; mergeAccessLevels?: unknown[]; unprotectAccessLevels?: unknown[] }[];
  applicableRules?: { name: string; match: "exact" | "wildcard" }[];
  coverageWarnings?: ("protected_without_visible_rule" | "unprotected_but_rule_matches")[];
  classification?: "empty" | "protected" | "unprotected";
}

export interface SourceRead {
  id: number;
  source: string;
  endpoint: string;
  state: string;
  httpStatus?: number;
  attempts: number;
  finishedAt: string;
  errorCode?: string;
}

export interface RunProject {
  requestedProjectId: number;
  state: string;
  evidence: Evidence | null;
  errorCode: string | null;
  finishedAt: string | null;
  lastGood?: { runId: number; finishedAt: string; evidence: Evidence } | null;
  reads?: SourceRead[];
}

export interface Run {
  id: number;
  requestedProjectIds: number[];
  state: string;
  createdAt: string;
  finishedAt: string | null;
  projects?: RunProject[];
}

export interface Comparison {
  projectId: number;
  status: "compared" | "partially_compared" | "not_comparable" | "no_baseline" | "in_progress";
  reason?: string;
  baselineRunId?: number | null;
  baselineFinishedAt?: string | null;
  currentFinishedAt?: string | null;
  changes?: { field: string; rule?: string; before: unknown; after: unknown }[];
  notCompared?: string[];
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json() as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${response.status}`);
  return body;
}
