import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Comparison, type Evidence, type Run, type RunProject } from "./api";

const activeStates = new Set(["queued", "running"]);

// Evidence older than this is labelled stale. A local analyst tool has no schedule, so a fixed, visible
// threshold is clearer than an inferred one; it is a display policy and never changes stored evidence.
const STALE_AFTER_DAYS = 7;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

const LEVEL_NAMES: Record<number, string> = { 0: "No one", 30: "Developers + Maintainers", 40: "Maintainers", 60: "Admins" };

function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function relativeAge(milliseconds: number): string {
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(milliseconds / 60_000);
  if (Math.abs(minutes) < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

function valueText(value: unknown): string {
  if (value === undefined) return "not returned";
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.map(valueText).join(", ") : "none";
  return JSON.stringify(value);
}

function levelsText(levels: unknown[] | undefined): string {
  if (levels === undefined) return "not returned";
  if (levels.length === 0) return "none";
  return levels.map((entry) => {
    const level = entry as { accessLevel?: number; accessLevelDescription?: string; userId?: number; groupId?: number; deployKeyId?: number };
    if (level.userId !== undefined) return `user ${level.userId}${level.accessLevelDescription ? ` (${level.accessLevelDescription})` : ""}`;
    if (level.groupId !== undefined) return `group ${level.groupId}${level.accessLevelDescription ? ` (${level.accessLevelDescription})` : ""}`;
    if (level.deployKeyId !== undefined) return `deploy key ${level.deployKeyId}`;
    if (level.accessLevel !== undefined) return level.accessLevelDescription ?? LEVEL_NAMES[level.accessLevel] ?? `access level ${level.accessLevel}`;
    return "unspecified entry";
  }).join(", ");
}

function statusLabel(state: string): string {
  return state.replaceAll("_", " ");
}

function nextAction(errorCode: string): string {
  switch (errorCode) {
    case "unauthorized": return "Check that the server token is valid and has read_api scope.";
    case "forbidden": return "Check that the token can read this private project.";
    case "not_found_or_inaccessible": return "Check the ID and token visibility; GitLab may return 404 for either condition.";
    case "rate_limited": return "Wait for the provider's retry window, then start a new run.";
    case "timeout":
    case "network_error":
    case "provider_unavailable": return "GitLab or the network was unavailable; start a new run after recovery.";
    case "malformed_response": return "The provider response did not match expected fields; inspect the source status before retrying.";
    case "server_interrupted": return "The server stopped during collection; start a new run.";
    case "pagination_limit": return "The project has more protection rules than this tool reads; inspect them in GitLab.";
    case "default_branch_mismatch":
    case "empty_repo_branch_mismatch": return "GitLab changed while it was being read; start a new run.";
    default: return "Review source reads and start a new run after correcting the issue.";
  }
}

const coverageText: Record<NonNullable<Evidence["coverageWarnings"]>[number], string> = {
  protected_without_visible_rule: "GitLab reports this branch as protected, but no visible project rule matches it. The protection may come from a group-level rule, which this tool does not read; its access restrictions are unexplained, not absent.",
  unprotected_but_rule_matches: "GitLab reports this branch as unprotected even though a visible rule matches it. Verify the branch settings in GitLab.",
};

function Freshness({ label, finishedAt }: { label: string; finishedAt: string | null | undefined }) {
  if (!finishedAt) return null;
  const age = Date.now() - Date.parse(finishedAt);
  return <p className="freshness">{label} {when(finishedAt)} ({relativeAge(age)})
    {age > STALE_AFTER_MS && <> <span className="badge stale">Stale · older than {STALE_AFTER_DAYS} days</span></>}</p>;
}

function EvidencePanel({ evidence }: { evidence: Evidence }) {
  const branchName = evidence.branch?.name;
  // Evidence stored before wildcard matching existed has no applicableRules; fall back to exact-name matching.
  const applicable = evidence.applicableRules ??
    (evidence.rules ?? []).filter((rule) => rule.name === branchName).map((rule) => ({ name: rule.name, match: "exact" as const }));
  const matchFor = (name: string) => applicable.find((rule) => rule.name === name)?.match;
  return <div className="evidence">
    <div className="fact-grid">
      <div><span>Project</span><strong>{evidence.project.name}</strong></div>
      <div><span>Visibility</span><strong>{evidence.project.visibility}</strong></div>
      <div><span>Observed state</span><strong>{evidence.classification ? statusLabel(evidence.classification) : "Incomplete"}</strong></div>
      <div><span>Reported default branch</span><strong>{evidence.project.reportedDefaultBranch ?? "none"}</strong></div>
      <div><span>Actual branch</span><strong>{branchName ?? (evidence.classification === "empty" ? "none (empty repository)" : "unknown (not collected)")}</strong></div>
      <div><span>GitLab URL</span><strong><a href={evidence.project.webUrl} target="_blank" rel="noreferrer">{evidence.project.webUrl}</a></strong></div>
    </div>
    {evidence.branch && <p className="detail-line">GitLab branch protection: <strong>{evidence.branch.protected ? "Protected" : "Unprotected"}</strong></p>}
    {evidence.classification === "empty" && <p className="notice">No actual branch exists. The project metadata's default-branch name is not treated as branch evidence.</p>}
    {evidence.coverageWarnings?.map((warning) => <p className="notice warning" key={warning}>{coverageText[warning]}</p>)}
    {evidence.branch && !evidence.rules && <p className="notice warning">Protection rules were not collected in this attempt. Access restrictions are unknown, not absent.</p>}
    {evidence.rules && <div className="rules">
      <h4>Visible protection rules</h4>
      <p>{evidence.rules.length} returned; {applicable.length} appl{applicable.length === 1 ? "ies" : "y"} to the default branch. Group-level rules are not read.</p>
      {evidence.rules.map((rule, index) => {
        const match = matchFor(rule.name);
        return <div className="rule" key={`${rule.name}-${index}`}>
          <strong>{rule.name} {match === "exact" ? "(exact default-branch rule)" : match === "wildcard" ? `(wildcard rule matching ${branchName})` : `(does not apply to ${branchName ?? "the default branch"})`}</strong>
          <span>Force push: {valueText(rule.allowForcePush)}</span>
          <span>Code owner approval: {valueText(rule.codeOwnerApprovalRequired)}</span>
          <span>Push: {levelsText(rule.pushAccessLevels)}</span>
          <span>Merge: {levelsText(rule.mergeAccessLevels)}</span>
          <span>Unprotect: {levelsText(rule.unprotectAccessLevels)}</span>
        </div>;
      })}
    </div>}
  </div>;
}

function ProjectCard({ project }: { project: RunProject }) {
  const name = project.evidence?.project.name ?? project.lastGood?.evidence.project.name;
  const finished = project.state !== "pending" && project.state !== "running";
  return <article className="project-card" data-testid={`project-${project.requestedProjectId}`}>
    <header><h3>Project {project.requestedProjectId}{name && <span className="muted"> · {name}</span>}</h3><span className={`badge ${project.state}`}>{statusLabel(project.state)}</span></header>
    {project.errorCode && <p className="error">Latest attempt: {statusLabel(project.errorCode)}. {nextAction(project.errorCode)}</p>}
    {project.evidence && <>
      <Freshness label={project.state === "complete" ? "Collected" : "Partially collected"} finishedAt={project.finishedAt} />
      <EvidencePanel evidence={project.evidence} />
    </>}
    {!project.evidence && finished &&
      <p className="notice warning">No evidence was collected for this project in this run.</p>}
    {project.state !== "complete" && project.lastGood && <section className="last-good">
      <h4>Last complete evidence · Run {project.lastGood.runId}</h4>
      <Freshness label="Collected" finishedAt={project.lastGood.finishedAt} />
      <p>This is older evidence, not the latest attempt.</p>
      <EvidencePanel evidence={project.lastGood.evidence} />
    </section>}
    {project.state !== "complete" && !project.lastGood && finished &&
      <p className="muted">No earlier complete evidence exists for this project.</p>}
    <details className="source-list"><summary>Source reads and provenance</summary>
      {project.reads?.length ? <ul>{project.reads.map((read) => <li key={read.id}>
        <strong>{statusLabel(read.source)}</strong> · {statusLabel(read.state)} · {read.endpoint} · {when(read.finishedAt)}
        {read.httpStatus ? ` · HTTP ${read.httpStatus}` : ""}{read.errorCode ? ` · ${statusLabel(read.errorCode)}` : ""}
        {read.attempts > 1 ? ` · ${read.attempts} attempts` : ""}
      </li>)}</ul> : <p>No reads recorded yet.</p>}
    </details>
  </article>;
}

function ComparisonView({ comparison, currentRunId }: { comparison: Comparison; currentRunId: number }) {
  const changes = comparison.changes ?? [];
  return <div className="comparison">
    <h3>Project {comparison.projectId}</h3>
    {comparison.status === "in_progress" && <p>Collection in progress; changes appear when this project finishes.</p>}
    {comparison.status === "no_baseline" && <p>First complete observation; no baseline yet.</p>}
    {comparison.status === "not_comparable" && <p>No evidence was collected in this attempt. No posture change is inferred.{comparison.baselineRunId ? ` Last complete run: ${comparison.baselineRunId}.` : ""}</p>}
    {comparison.status === "partially_compared" && <p>Partial evidence against run {comparison.baselineRunId} ({when(comparison.baselineFinishedAt)}). Only facts observed in this attempt are compared.</p>}
    {comparison.status === "compared" && <p>Against run {comparison.baselineRunId} ({when(comparison.baselineFinishedAt)}).</p>}
    {(comparison.status === "compared" || comparison.status === "partially_compared") && <>
      {changes.length ? <><p className="change-count">{changes.length} changed {changes.length === 1 ? "setting" : "settings"}</p><ul className="diff-list">{changes.map((change) => <li className="diff-card" key={`${change.rule ?? ""}:${change.field}`}>
        <strong>{statusLabel(change.field)}</strong>{change.rule && <em> · rule {change.rule}</em>}
        <dl className="diff-values">
          <div className="diff-before"><dt>Before · Run {comparison.baselineRunId}</dt><dd>{valueText(change.before)}</dd></div>
          <div className="diff-after"><dt>After · Run {currentRunId}</dt><dd>{valueText(change.after)}</dd></div>
        </dl>
      </li>)}</ul></> : <p>No changes in compared facts.</p>}
      {comparison.notCompared?.length ? <p className="muted">Not compared (not observed): {comparison.notCompared.map(statusLabel).join(", ")}.</p> : null}
    </>}
  </div>;
}

export default function App() {
  const [idsInput, setIdsInput] = useState("");
  const [savedIds, setSavedIds] = useState<number[]>([]);
  const [history, setHistory] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [configured, setConfigured] = useState(false);
  const [mode, setMode] = useState<"live" | "mock">("live");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The run the analyst asked to see, updated synchronously on click, and a counter that orders refreshes.
  // A refresh only applies its result if no newer refresh has started, so a slow poll that began before the
  // analyst picked another run can never switch the view back.
  const viewedRunId = useRef<number | null>(null);
  const latestRefresh = useRef(0);

  const refresh = useCallback(async (runId?: number | null) => {
    const request = ++latestRefresh.current;
    if (runId != null) viewedRunId.current = runId;
    const [selection, runs, active, health] = await Promise.all([
      api<{ projectIds: number[] }>("/api/selection"),
      api<{ runs: Run[] }>("/api/runs"),
      api<{ run: Run | null }>("/api/runs/active"),
      api<{ gitlabConfigured: boolean; mode: "live" | "mock" }>("/api/health"),
    ]);
    if (request !== latestRefresh.current) return;
    setSavedIds(selection.projectIds);
    setIdsInput((previous) => previous || selection.projectIds.join(", "));
    setHistory(runs.runs);
    setConfigured(health.gitlabConfigured);
    setMode(health.mode);
    const chosen = viewedRunId.current ?? active.run?.id ?? runs.runs[0]?.id ?? null;
    if (chosen !== null) {
      const [detail, changes] = await Promise.all([
        api<Run>(`/api/runs/${chosen}`),
        api<{ comparisons: Comparison[] }>(`/api/runs/${chosen}/changes`),
      ]);
      if (request !== latestRefresh.current) return;
      viewedRunId.current = chosen;
      setSelectedRunId(chosen);
      setRun(detail);
      setComparisons(changes.comparisons);
    }
  }, []);

  const active = history.some((item) => activeStates.has(item.state));
  // Poll while any run is active, even if the analyst is viewing an older run, so history and the
  // Start button stay accurate. After a browser refresh the first load reattaches to the active run.
  const polling = active || (run !== null && activeStates.has(run.state));

  useEffect(() => { void refresh().catch((reason: Error) => setError(reason.message)); }, [refresh]);
  useEffect(() => {
    if (!polling) return;
    // Skip a tick while the previous poll is still in flight; otherwise slow responses would keep superseding
    // each other and the view would never update. Analyst actions still supersede an in-flight poll.
    let pollInFlight = false;
    const timer = window.setInterval(() => {
      if (pollInFlight) return;
      pollInFlight = true;
      void refresh().catch((reason: Error) => setError(reason.message)).finally(() => { pollInFlight = false; });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [polling, refresh]);

  async function saveSelection() {
    setError("");
    const parts = idsInput.split(/[\s,]+/).filter(Boolean);
    const ids = parts.map(Number);
    if (parts.length === 0 || parts.length > 20 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
      setError("Enter 1–20 unique positive numeric project IDs, separated by commas or spaces.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/selection", { method: "PUT", body: JSON.stringify({ projectIds: ids }) });
      setSavedIds(ids);
      setIdsInput(ids.join(", "));
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }

  async function startRun() {
    setError("");
    setBusy(true);
    try {
      const started = await api<Run>("/api/runs", { method: "POST" });
      await refresh(started.id);
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }

  async function chooseRun(id: number) {
    setError("");
    try { await refresh(id); } catch (reason) { setError((reason as Error).message); }
  }

  const latestRunId = history[0]?.id ?? null;
  const editedIds = idsInput.split(/[\s,]+/).filter(Boolean).map(Number);
  const selectionChanged = JSON.stringify(editedIds) !== JSON.stringify(savedIds);
  return <div className="shell">
    <header className="topbar"><div><span className="eyebrow">READ-ONLY · LOCAL ANALYST TOOL</span><h1>GitLab Evidence</h1><p>Collect defensible branch-protection evidence, not guesses.</p></div><span className="top-pill">{mode === "mock" ? "Mock demo · no GitLab access" : configured ? "GitLab token configured" : "GitLab token missing"}</span></header>
    <main>
      {mode === "mock" && <div className="notice mock-banner">Mock demonstration, repeating every three runs: the first succeeds, the second has a protected-rule failure, the third recovers with a changed force-push setting. No real GitLab calls are made.</div>}
      <section className="panel selection" aria-labelledby="selection-title">
        <div className="section-head"><div><span className="eyebrow">01 · CONFIGURE</span><h2 id="selection-title">Project selection</h2></div><span className="muted">Saved locally in SQLite</span></div>
        <label htmlFor="project-ids">Numeric GitLab project IDs</label>
        <div className="input-row"><input id="project-ids" value={idsInput} onChange={(event) => setIdsInput(event.target.value)} placeholder="87937359, 87937442, 87937501" /><button onClick={() => void saveSelection()} disabled={busy}>Save selection</button></div>
        <p className="helper">Saved: {savedIds.length ? savedIds.join(", ") : "none"}. New collections use these saved IDs; past runs keep their original selection.</p>
        {selectionChanged && <p className="notice" role="status">You have unsaved changes. Save selection before starting a collection.</p>}
        <button className="primary" onClick={() => void startRun()} disabled={busy || active || selectionChanged || savedIds.length === 0 || !configured}>Start collection</button>
        {active && <p className="helper" role="status">A collection is running. Progress updates automatically, including after a page refresh.</p>}
        {!configured && <p className="notice">Set <code>GITLAB_TOKEN</code> in the server's local environment to enable live collection.</p>}
      </section>

      {error && <div className="alert" role="alert">{error}</div>}

      <div className="content-grid">
        <section className="panel" aria-labelledby="run-title">
          <div className="section-head"><div><span className="eyebrow">02 · INSPECT</span><h2 id="run-title">{run ? `Run ${run.id}` : "No run yet"}</h2></div>{run && <span className={`badge ${run.state}`} data-testid="run-state">{statusLabel(run.state)}</span>}</div>
          {run ? <>
            {latestRunId !== null && run.id !== latestRunId && <p className="notice warning">You are viewing an older run. Run {latestRunId} is newer; open it for the latest outcome.</p>}
            <p className="muted">Requested IDs: {run.requestedProjectIds.join(", ")} · Started {when(run.createdAt)} · Finished {when(run.finishedAt)}</p>
            <div className="project-list">{run.projects?.map((project) => <ProjectCard key={project.requestedProjectId} project={project} />)}</div>
          </> : <p>Save project IDs and start a collection to see evidence here.</p>}
        </section>
        <aside className="sidebar">
          <section className="panel" aria-labelledby="history-title"><span className="eyebrow">03 · REVISIT</span><h2 id="history-title">History</h2>
            {history.length ? <ul className="history-list">{history.map((item) => <li key={item.id}><button className={selectedRunId === item.id ? "selected" : ""} aria-current={selectedRunId === item.id ? "true" : undefined} onClick={() => void chooseRun(item.id)}>
              <strong>Run {item.id}</strong><span>{statusLabel(item.state)} · {when(item.createdAt)}</span>
            </button></li>)}</ul> : <p className="muted">No historical runs.</p>}
          </section>
          {run && <section className="panel" aria-labelledby="changes-title"><span className="eyebrow">04 · COMPARE</span><h2 id="changes-title">Changes</h2>
            {comparisons.map((comparison) => <ComparisonView key={comparison.projectId} comparison={comparison} currentRunId={run.id} />)}
          </section>}
        </aside>
      </div>
    </main>
    <footer>Only the local server calls GitLab. Evidence can be incomplete; inspect source reads before drawing conclusions.</footer>
  </div>;
}
