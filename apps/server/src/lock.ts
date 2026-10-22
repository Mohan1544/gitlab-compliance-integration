import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;

// Exclusive ownership of a data directory, held by the operating system for as long as this process keeps the
// lock file open. SQLite in EXCLUSIVE locking mode keeps its file lock after the first write until the connection
// closes, and the OS releases it when the process exits for any reason (graceful stop, crash, or kill). A second
// server therefore cannot acquire it while the first is alive, even if that one is paused, and a dead server can
// never block startup: there is no process ID to be reused and no heartbeat to expire.
export class DataDirectoryLock {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // Returns null if another live process holds the lock; throws on any other storage error.
  static acquire(path: string): DataDirectoryLock | null {
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = DELETE;");
      // The write takes the exclusive file lock, which EXCLUSIVE mode then holds until close(). The row is
      // informational only; another process cannot read it while the lock is held.
      db.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, acquired_at TEXT NOT NULL); DELETE FROM owner;");
      db.prepare("INSERT INTO owner (pid, acquired_at) VALUES (?, ?)").run(process.pid, new Date().toISOString());
      db.exec("COMMIT");
      return new DataDirectoryLock(db);
    } catch (error) {
      db.close();
      if ((error as { errcode?: number }).errcode === SQLITE_BUSY) return null;
      throw error;
    }
  }

  release(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
