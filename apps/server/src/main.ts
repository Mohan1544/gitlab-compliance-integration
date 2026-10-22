import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { MockGitLabTransport } from "./mock-gitlab.js";
import { Store } from "./store.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const envPath = resolve(root, ".env");
const mockMode = process.env.MOCK_GITLAB_SCENARIO === "partial-recovery";
if (!mockMode && existsSync(envPath)) process.loadEnvFile(envPath);

const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(root, mockMode ? "data/mock" : "data");
mkdirSync(dataDir, { recursive: true });
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
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

await app.listen({ host: "127.0.0.1", port });
console.log(`Local API listening at http://127.0.0.1:${port}`);
