import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { MockGitLabTransport } from "./mock-gitlab.js";
import { DataDirectoryLock } from "./lock.js";
import { Store } from "./store.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const envPath = resolve(root, ".env");
const mockMode = process.env.MOCK_GITLAB_SCENARIO === "partial-recovery";
if (!mockMode && existsSync(envPath)) process.loadEnvFile(envPath);

const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, mockMode ? "data/mock" : "data");
mkdirSync(dataDir, { recursive: true });

// Own the data directory before opening, migrating or recovering it: a second server started by mistake must
// not mark the first server's active run as interrupted. The OS releases the lock when this process exits.
const lock = DataDirectoryLock.acquire(resolve(dataDir, "evidence.sqlite.lock"));
if (!lock) {
  console.error(`Another server is already running with the data directory ${dataDir}. ` +
    "Stop that server (Ctrl+C in its terminal), or set a different DATA_DIR.");
  process.exit(1);
}
const store = new Store(resolve(dataDir, "evidence.sqlite"));
store.interruptActiveRuns();
if (mockMode && store.getSelection().length === 0) store.saveSelection([101, 102, 103]);
const mockDelayMs = Number(process.env.MOCK_GITLAB_DELAY_MS ?? 0);
if (!Number.isInteger(mockDelayMs) || mockDelayMs < 0 || mockDelayMs > 10_000) throw new Error("Invalid MOCK_GITLAB_DELAY_MS");
const app = createApp({ store, token: mockMode ? "mock-only" : process.env.GITLAB_TOKEN,
  transport: mockMode ? new MockGitLabTransport(store, mockDelayMs) : undefined, mode: mockMode ? "mock" : "live",
  sleep: mockMode ? async () => {} : undefined });
const port = Number(process.env.SERVER_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SERVER_PORT");

const shutdown = async () => {
  await app.close();
  store.close();
  lock.release();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  await shutdown();
  throw error;
}
console.log(`Local API listening at http://127.0.0.1:${port}`);
