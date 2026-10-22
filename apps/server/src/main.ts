import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { MockGitLabTransport } from "./mock-gitlab.js";
import { LEASE_RENEW_MS, Store } from "./store.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const envPath = resolve(root, ".env");
const mockMode = process.env.MOCK_GITLAB_SCENARIO === "partial-recovery";
if (!mockMode && existsSync(envPath)) process.loadEnvFile(envPath);

const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, mockMode ? "data/mock" : "data");
mkdirSync(dataDir, { recursive: true });
const store = new Store(resolve(dataDir, "evidence.sqlite"));

// Claim the data directory before recovering: a second server started by mistake must not mark the first
// server's active run as interrupted.
const owner = randomUUID();
const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const claim = store.recoverOnStartup(owner, process.pid, isAlive);
if (!claim.acquired) {
  console.error(`Another server process (PID ${claim.holderPid}) is using ${dataDir}. Stop it, or set a different DATA_DIR.`);
  store.close();
  process.exit(1);
}
const heartbeat = setInterval(() => {
  if (!store.renewLease(owner)) {
    console.error("Another server process took over this data directory; stopping to avoid two writers.");
    process.exit(1);
  }
}, LEASE_RENEW_MS);
heartbeat.unref();
if (mockMode && store.getSelection().length === 0) store.saveSelection([101, 102, 103]);
const mockDelayMs = Number(process.env.MOCK_GITLAB_DELAY_MS ?? 0);
if (!Number.isInteger(mockDelayMs) || mockDelayMs < 0 || mockDelayMs > 10_000) throw new Error("Invalid MOCK_GITLAB_DELAY_MS");
const app = createApp({ store, token: mockMode ? "mock-only" : process.env.GITLAB_TOKEN,
  transport: mockMode ? new MockGitLabTransport(store, mockDelayMs) : undefined, mode: mockMode ? "mock" : "live",
  sleep: mockMode ? async () => {} : undefined });
const port = Number(process.env.SERVER_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SERVER_PORT");

const shutdown = async () => {
  clearInterval(heartbeat);
  await app.close();
  store.releaseLease(owner);
  store.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

await app.listen({ host: "127.0.0.1", port });
console.log(`Local API listening at http://127.0.0.1:${port}`);
