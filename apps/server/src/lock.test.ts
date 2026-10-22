import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DataDirectoryLock } from "./lock.js";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length > 0) cleanup.pop()?.(); });

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "gitlab-evidence-lock-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return join(directory, "evidence.sqlite.lock");
}

describe("data directory lock", () => {
  it("allows one holder at a time and is free again once released", () => {
    const path = lockPath();
    const first = DataDirectoryLock.acquire(path);
    expect(first).not.toBeNull();
    expect(DataDirectoryLock.acquire(path)).toBeNull();
    first?.release();
    const next = DataDirectoryLock.acquire(path);
    expect(next).not.toBeNull();
    next?.release();
  });

  // The property a process-ID lease cannot give: ownership ends exactly when the holder process ends, however it
  // ends, so a crashed server never blocks the next start and a reused process ID is irrelevant.
  it("is held against other processes and released by the OS when the holder is killed", async () => {
    const path = lockPath();
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "lock.ts")).href;
    const holder = spawn(process.execPath, ["--input-type=module", "-e",
      `import { DataDirectoryLock } from ${JSON.stringify(moduleUrl)};
       const lock = DataDirectoryLock.acquire(${JSON.stringify(path)});
       console.log(lock ? "holding" : "refused");
       setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const status = await new Promise<string>((resolveStatus, reject) => {
        holder.stdout.once("data", (data: Buffer) => resolveStatus(String(data).trim()));
        holder.once("exit", (code) => reject(new Error(`holder exited early with ${code}`)));
      });
      expect(status).toBe("holding");
      expect(DataDirectoryLock.acquire(path)).toBeNull();
    } finally {
      const exited = new Promise((resolveExit) => holder.once("exit", resolveExit));
      holder.kill("SIGKILL");
      await exited;
    }
    const after = DataDirectoryLock.acquire(path);
    expect(after).not.toBeNull();
    after?.release();
  });
});
