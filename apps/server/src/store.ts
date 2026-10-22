import { DatabaseSync } from "node:sqlite";
import type { Evidence, ProjectState, Run, RunProject, RunState, SourceRead, SourceReadInput } from "./types.js";

interface RunRow {
  id: number;
  requested_ids_json: string;
  state: RunState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ProjectRow {
  requested_project_id: number;
  state: ProjectState;
  returned_project_id: number | null;
  evidence_json: string | null;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface ReadRow {
  id: number;
  run_id: number;
  requested_project_id: number;
  source: SourceReadInput["source"];
  request_sequence: number;
  endpoint: string;
  state: SourceReadInput["state"];
  http_status: number | null;
  attempts: number;
  started_at: string;
  finished_at: string;
  response_json: string | null;
  error_code: string | null;
}

export class ActiveRunError extends Error {
  constructor(readonly activeRunId: number) {
    super("A collection is already active");
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 1) throw new Error(`Unsupported database schema version ${version}`);
    if (version === 1) return;
    this.transaction(() => this.db.exec(`
      CREATE TABLE selection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO selection (id, project_ids_json, updated_at) VALUES (1, '[]', CURRENT_TIMESTAMP);
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_ids_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX one_active_run ON runs ((1)) WHERE state IN ('queued', 'running');
      CREATE TABLE run_projects (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        requested_project_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        returned_project_id INTEGER,
        evidence_json TEXT,
        error_code TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, requested_project_id)
      );
      CREATE TABLE source_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        requested_project_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        request_sequence INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        state TEXT NOT NULL,
        http_status INTEGER,
        attempts INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        response_json TEXT,
        error_code TEXT,
        UNIQUE (run_id, requested_project_id, source, request_sequence),
        FOREIGN KEY (run_id, requested_project_id) REFERENCES run_projects(run_id, requested_project_id)
      );
      PRAGMA user_version = 1;
    `));
  }

  getSelection(): number[] {
    const row = this.db.prepare("SELECT project_ids_json FROM selection WHERE id = 1").get() as { project_ids_json: string };
    return JSON.parse(row.project_ids_json) as number[];
  }

  saveSelection(ids: number[]): void {
    this.db.prepare("UPDATE selection SET project_ids_json = ?, updated_at = ? WHERE id = 1")
      .run(JSON.stringify(ids), new Date().toISOString());
  }

  createRun(ids: number[]): Run {
    return this.transaction(() => {
      const active = this.getActiveRun();
      if (active) throw new ActiveRunError(active.id);
      const now = new Date().toISOString();
      const result = this.db.prepare("INSERT INTO runs (requested_ids_json, state, created_at) VALUES (?, 'queued', ?)")
        .run(JSON.stringify(ids), now);
      const id = Number(result.lastInsertRowid);
      const insertProject = this.db.prepare("INSERT INTO run_projects (run_id, requested_project_id, state) VALUES (?, ?, 'pending')");
      for (const projectId of ids) insertProject.run(id, projectId);
      return { id, requestedProjectIds: ids, state: "queued" as const, createdAt: now, startedAt: null, finishedAt: null };
    });
  }

  markRunRunning(runId: number): void {
    this.db.prepare("UPDATE runs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'")
      .run(new Date().toISOString(), runId);
  }

  markProjectRunning(runId: number, projectId: number): void {
    this.db.prepare("UPDATE run_projects SET state = 'running', started_at = ? WHERE run_id = ? AND requested_project_id = ?")
      .run(new Date().toISOString(), runId, projectId);
  }

  recordRead(read: SourceReadInput): void {
    this.db.prepare(`INSERT INTO source_reads
      (run_id, requested_project_id, source, request_sequence, endpoint, state, http_status, attempts, started_at, finished_at, response_json, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      read.runId, read.projectId, read.source, read.sequence, read.endpoint, read.state,
      read.httpStatus ?? null, read.attempts, read.startedAt, read.finishedAt,
      read.response === undefined ? null : JSON.stringify(read.response), read.errorCode ?? null,
    );
  }

  // Checkpoints evidence while a project is still running, so a server stop keeps what was already observed.
  // Only touches a running row: a finished outcome is never overwritten by a late checkpoint.
  saveProjectEvidence(runId: number, projectId: number, evidence: Evidence): void {
    this.db.prepare(`UPDATE run_projects SET returned_project_id = ?, evidence_json = ?
      WHERE run_id = ? AND requested_project_id = ? AND state = 'running'`).run(
      evidence.project.id, JSON.stringify(evidence), runId, projectId,
    );
  }

  finishProject(runId: number, projectId: number, state: ProjectState, evidence: Evidence | null, errorCode: string | null): void {
    this.db.prepare(`UPDATE run_projects SET state = ?, returned_project_id = ?, evidence_json = ?, error_code = ?, finished_at = ?
      WHERE run_id = ? AND requested_project_id = ?`).run(
      state, evidence?.project.id ?? null, evidence ? JSON.stringify(evidence) : null,
      errorCode, new Date().toISOString(), runId, projectId,
    );
  }

  finishRun(runId: number): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT state FROM run_projects WHERE run_id = ?").all(runId) as { state: ProjectState }[];
      const state: RunState = rows.every((row) => row.state === "complete")
        ? "completed"
        : rows.some((row) => row.state === "complete" || row.state === "partial") ? "partial" : "failed";
      this.db.prepare("UPDATE runs SET state = ?, finished_at = ? WHERE id = ?")
        .run(state, new Date().toISOString(), runId);
    });
  }

  interruptActiveRuns(): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE run_projects SET state = 'interrupted', error_code = 'server_interrupted', finished_at = ? WHERE state IN ('pending', 'running')")
        .run(now);
      this.db.prepare("UPDATE runs SET state = 'interrupted', finished_at = ? WHERE state IN ('queued', 'running')")
        .run(now);
    });
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getActiveRun(): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE state IN ('queued', 'running') LIMIT 1").get() as RunRow | undefined;
    return row ? this.mapRun(row) : null;
  }

  listRuns(): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 100").all() as unknown as RunRow[]).map((row) => this.mapRun(row));
  }

  getRun(runId: number): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) return null;
    const run = this.mapRun(row);
    run.projects = (this.db.prepare("SELECT * FROM run_projects WHERE run_id = ? ORDER BY rowid").all(runId) as unknown as ProjectRow[])
      .map((project) => {
        const mapped = this.mapProject(project);
        mapped.reads = (this.db.prepare("SELECT * FROM source_reads WHERE run_id = ? AND requested_project_id = ? ORDER BY id")
          .all(runId, mapped.requestedProjectId) as unknown as ReadRow[]).map((read) => this.mapRead(read));
        mapped.lastGood = this.getLastComplete(mapped.requestedProjectId, runId);
        return mapped;
      });
    return run;
  }

  getLastComplete(projectId: number, beforeRunId: number): { runId: number; finishedAt: string; evidence: Evidence } | null {
    const row = this.db.prepare(`SELECT run_id, finished_at, evidence_json FROM run_projects
      WHERE requested_project_id = ? AND run_id < ? AND state = 'complete' ORDER BY run_id DESC LIMIT 1`)
      .get(projectId, beforeRunId) as { run_id: number; finished_at: string; evidence_json: string } | undefined;
    return row ? { runId: row.run_id, finishedAt: row.finished_at, evidence: JSON.parse(row.evidence_json) as Evidence } : null;
  }

  getProjectHistory(projectId: number): { runId: number; state: ProjectState; finishedAt: string | null; evidence: Evidence | null; errorCode: string | null }[] {
    const rows = this.db.prepare(`SELECT run_id, state, finished_at, evidence_json, error_code FROM run_projects
      WHERE requested_project_id = ? ORDER BY run_id DESC LIMIT 100`).all(projectId) as
      { run_id: number; state: ProjectState; finished_at: string | null; evidence_json: string | null; error_code: string | null }[];
    return rows.map((row) => ({ runId: row.run_id, state: row.state, finishedAt: row.finished_at,
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) as Evidence : null, errorCode: row.error_code }));
  }

  private mapRun(row: RunRow): Run {
    return { id: row.id, requestedProjectIds: JSON.parse(row.requested_ids_json) as number[], state: row.state,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at };
  }

  private mapProject(row: ProjectRow): RunProject {
    return { requestedProjectId: row.requested_project_id, state: row.state,
      returnedProjectId: row.returned_project_id, evidence: row.evidence_json ? JSON.parse(row.evidence_json) as Evidence : null,
      errorCode: row.error_code, startedAt: row.started_at, finishedAt: row.finished_at };
  }

  private mapRead(row: ReadRow): SourceRead {
    return { id: row.id, runId: row.run_id, projectId: row.requested_project_id, source: row.source,
      sequence: row.request_sequence, endpoint: row.endpoint, state: row.state, httpStatus: row.http_status ?? undefined,
      attempts: row.attempts, startedAt: row.started_at, finishedAt: row.finished_at,
      response: row.response_json ? JSON.parse(row.response_json) as unknown : undefined, errorCode: row.error_code ?? undefined };
  }
}
