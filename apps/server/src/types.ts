export type SourceName = "project" | "branches" | "default_branch" | "protected_branches";
export type SourceState = "observed" | "confirmed_absent" | "not_applicable" | "unreadable";
export type ProjectState = "pending" | "running" | "complete" | "partial" | "failed" | "interrupted";
export type RunState = "queued" | "running" | "completed" | "partial" | "failed" | "interrupted";

export interface ProjectFact {
  id: number;
  name: string;
  webUrl: string;
  visibility: string;
  emptyRepo: boolean;
  reportedDefaultBranch: string | null;
}

export interface BranchFact {
  name: string;
  protected: boolean;
}

export interface AccessLevelFact {
  accessLevel?: number;
  accessLevelDescription?: string;
  userId?: number;
  groupId?: number;
  deployKeyId?: number;
}

export interface RuleFact {
  name: string;
  allowForcePush?: boolean;
  codeOwnerApprovalRequired?: boolean;
  pushAccessLevels?: AccessLevelFact[];
  mergeAccessLevels?: AccessLevelFact[];
  unprotectAccessLevels?: AccessLevelFact[];
}

export interface Evidence {
  project: ProjectFact;
  branch?: BranchFact;
  branchNames?: string[];
  rules?: RuleFact[];
  applicableRules?: { name: string; match: "exact" | "wildcard" }[];
  coverageWarnings?: CoverageWarning[];
  classification?: "empty" | "protected" | "unprotected";
}

export type CoverageWarning = "protected_without_visible_rule" | "unprotected_but_rule_matches";

export interface SourceReadInput {
  runId: number;
  projectId: number;
  source: SourceName;
  sequence: number;
  endpoint: string;
  state: SourceState;
  httpStatus?: number;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  response?: unknown;
  errorCode?: string;
}

export interface SourceRead extends SourceReadInput {
  id: number;
}

export interface RunProject {
  requestedProjectId: number;
  state: ProjectState;
  returnedProjectId: number | null;
  evidence: Evidence | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastGood?: { runId: number; finishedAt: string; evidence: Evidence } | null;
  reads?: SourceRead[];
}

export interface Run {
  id: number;
  requestedProjectIds: number[];
  state: RunState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  projects?: RunProject[];
}
