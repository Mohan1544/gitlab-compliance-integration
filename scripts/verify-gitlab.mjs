const token = process.env.GITLAB_TOKEN;
const projectPaths = (process.env.GITLAB_PROJECT_PATHS ?? "")
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean);

if (!token || token === "replace-me" || projectPaths.length !== 3) {
  console.error("Set GITLAB_TOKEN and exactly three GITLAB_PROJECT_PATHS in .env.");
  process.exit(1);
}

async function getJson(apiPath) {
  try {
    const response = await fetch(`https://gitlab.com/api/v4${apiPath}`, {
      headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }

    return { value: await response.json() };
  } catch (error) {
    return { error: error?.name ?? "RequestError" };
  }
}

async function getProtectedRules(projectId) {
  const rules = [];

  for (let page = 1; page <= 20; page += 1) {
    const result = await getJson(
      `/projects/${projectId}/protected_branches?per_page=100&page=${page}`,
    );

    if (result.error) {
      return { error: result.error };
    }

    if (!Array.isArray(result.value)) {
      return { error: "Unexpected protected-branches response" };
    }

    rules.push(...result.value);
    if (result.value.length < 100) {
      return { value: rules };
    }
  }

  return { error: "Protected-branches pagination exceeded 20 pages" };
}

function summarizeAccessLevels(levels) {
  if (!Array.isArray(levels)) {
    return null;
  }

  return levels.map((level) => ({
    access_level: level.access_level ?? null,
    access_level_description: level.access_level_description ?? null,
    user_id: level.user_id ?? null,
    group_id: level.group_id ?? null,
    deploy_key_id: level.deploy_key_id ?? null,
  }));
}

async function verifyProject(projectPath) {
  const projectResult = await getJson(`/projects/${encodeURIComponent(projectPath)}`);
  if (projectResult.error) {
    return { requested_path: projectPath, project_error: projectResult.error };
  }

  const project = projectResult.value;
  if (!Number.isInteger(project.id) || typeof project.empty_repo !== "boolean") {
    return { requested_path: projectPath, project_error: "Unexpected project response" };
  }

  const summary = {
    requested_path: projectPath,
    id: project.id,
    name: project.name,
    web_url: project.web_url,
    visibility: project.visibility,
    empty_repo: project.empty_repo,
    project_default_branch_field: project.default_branch,
  };

  if (project.empty_repo) {
    const branchesResult = await getJson(
      `/projects/${project.id}/repository/branches?per_page=100&page=1`,
    );
    summary.repository_branches = branchesResult.error
      ? { error: branchesResult.error }
      : Array.isArray(branchesResult.value)
        ? branchesResult.value.map((branch) => branch.name)
        : { error: "Unexpected branches response" };
    summary.branch_status = Array.isArray(summary.repository_branches)
      ? summary.repository_branches.length === 0
        ? "No repository branches"
        : "Branches returned despite empty_repo"
      : "Branch list unreadable";
    return summary;
  }

  if (!project.default_branch) {
    return { ...summary, branch_status: "Non-empty project without default branch" };
  }

  const branchResult = await getJson(
    `/projects/${project.id}/repository/branches/${encodeURIComponent(project.default_branch)}`,
  );
  summary.branch_protected = branchResult.error
    ? { error: branchResult.error }
    : branchResult.value.protected;

  const rulesResult = await getProtectedRules(project.id);
  summary.protection_rules = rulesResult.error
    ? { error: rulesResult.error }
    : rulesResult.value.map((rule) => ({
        name: rule.name,
        inherited: rule.inherited ?? null,
        allow_force_push: rule.allow_force_push ?? null,
        code_owner_approval_required: rule.code_owner_approval_required ?? null,
        push_access_levels: summarizeAccessLevels(rule.push_access_levels),
        merge_access_levels: summarizeAccessLevels(rule.merge_access_levels),
        unprotect_access_levels: summarizeAccessLevels(rule.unprotect_access_levels),
      }));

  return summary;
}

const results = [];
for (const projectPath of projectPaths) {
  results.push(await verifyProject(projectPath));
}

console.log(JSON.stringify(results, null, 2));
