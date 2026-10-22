import { GitLabClient, nextPage, parseBranch, parseBranchNames, parseProject, parseRules, type ReadResult } from "./gitlab.js";
import { applicableRules } from "./rules.js";
import type { Store } from "./store.js";
import type { CoverageWarning, Evidence, RuleFact } from "./types.js";

const MAX_RULE_PAGES = 20;

export class Collector {
  constructor(private readonly store: Store, private readonly gitlab: GitLabClient) {}

  async execute(runId: number): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run || run.state !== "queued") return;
    this.store.markRunRunning(runId);
    const queue = [...run.requestedProjectIds];
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length > 0) {
        const projectId = queue.shift();
        if (projectId === undefined) return;
        try {
          await this.collectProject(runId, projectId);
        } catch {
          this.store.failProjectKeepingEvidence(runId, projectId, "unexpected_collection_error");
        }
      }
    });
    await Promise.all(workers);
    this.store.finishRun(runId);
  }

  private async collectProject(runId: number, projectId: number): Promise<void> {
    this.store.markProjectRunning(runId, projectId);
    const prefix = `projects/${projectId}`;
    const project = await this.gitlab.get(runId, projectId, "project", 1, prefix, parseProject);
    if (!project.ok) {
      this.store.finishProject(runId, projectId, "failed", null, project.errorCode);
      return;
    }
    if (project.value.id !== projectId) {
      this.store.finishProject(runId, projectId, "failed", null, "project_id_mismatch");
      return;
    }
    const evidence: Evidence = { project: project.value };
    this.store.saveProjectEvidence(runId, projectId, evidence);

    if (project.value.emptyRepo) {
      const branches = await this.gitlab.get(runId, projectId, "branches", 1,
        `${prefix}/repository/branches?per_page=100`, parseBranchNames);
      this.gitlab.notApplicable(runId, projectId, "default_branch", "empty_repository");
      this.gitlab.notApplicable(runId, projectId, "protected_branches", "empty_repository");
      if (!branches.ok) {
        this.store.finishProject(runId, projectId, "partial", evidence, branches.errorCode);
        return;
      }
      evidence.branchNames = branches.value;
      if (branches.value.length !== 0) {
        this.store.finishProject(runId, projectId, "partial", evidence, "empty_repo_branch_mismatch");
        return;
      }
      evidence.classification = "empty";
      this.store.finishProject(runId, projectId, "complete", evidence, null);
      return;
    }

    this.gitlab.notApplicable(runId, projectId, "branches", "nonempty_repository");
    const defaultBranch = project.value.reportedDefaultBranch;
    if (!defaultBranch) {
      this.store.finishProject(runId, projectId, "partial", evidence, "missing_default_branch");
      return;
    }
    const branch = await this.gitlab.get(runId, projectId, "default_branch", 1,
      `${prefix}/repository/branches/${encodeURIComponent(defaultBranch)}`, parseBranch);
    if (!branch.ok) {
      this.store.finishProject(runId, projectId, "partial", evidence, branch.errorCode);
      return;
    }
    if (branch.value.name !== defaultBranch) {
      this.store.finishProject(runId, projectId, "partial", evidence, "default_branch_mismatch");
      return;
    }
    evidence.branch = branch.value;
    evidence.classification = branch.value.protected ? "protected" : "unprotected";
    this.store.saveProjectEvidence(runId, projectId, evidence);

    const rules: RuleFact[] = [];
    let next: string | null = `${prefix}/protected_branches?per_page=100`;
    for (let page = 1; next !== null && page <= MAX_RULE_PAGES; page += 1) {
      const result: ReadResult<RuleFact[]> = await this.gitlab.get(runId, projectId, "protected_branches", page, next, parseRules);
      if (!result.ok) {
        this.store.finishProject(runId, projectId, "partial", evidence, result.errorCode);
        return;
      }
      rules.push(...result.value);
      next = nextPage(result.headers.link);
      if (!next && result.headers["x-next-page"] && /^\d+$/.test(result.headers["x-next-page"])) {
        next = `${prefix}/protected_branches?per_page=100&page=${result.headers["x-next-page"]}`;
      }
      if (!next && result.value.length === 100) {
        next = `${prefix}/protected_branches?per_page=100&page=${page + 1}`;
      }
    }
    if (next !== null) {
      this.store.finishProject(runId, projectId, "partial", evidence, "pagination_limit");
      return;
    }
    evidence.rules = rules;
    evidence.applicableRules = applicableRules(rules, defaultBranch).map(({ rule, match }) => ({ name: rule.name, match }));
    // Every read succeeded, so these are coverage limits of project-level rules (e.g. group-level protection,
    // which is out of scope), not collection failures. The project stays complete and usable as a baseline.
    const warnings: CoverageWarning[] = [];
    if (branch.value.protected && evidence.applicableRules.length === 0) warnings.push("protected_without_visible_rule");
    if (!branch.value.protected && evidence.applicableRules.length > 0) warnings.push("unprotected_but_rule_matches");
    if (warnings.length > 0) evidence.coverageWarnings = warnings;
    this.store.finishProject(runId, projectId, "complete", evidence, null);
  }
}
