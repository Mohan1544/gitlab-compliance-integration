import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const dataDir = mkdtempSync(join(tmpdir(), "zania-browser-test-"));
process.once("exit", () => rmSync(dataDir, { recursive: true, force: true }));
const reuseExisting = process.env.PLAYWRIGHT_USE_EXISTING_MOCK === "1";
// Default: Playwright's bundled Chromium (install once with `npx playwright install chromium`).
// Set PLAYWRIGHT_CHANNEL=chrome to use an installed Google Chrome instead.
const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5273", browserName: "chromium", channel, headless: true },
  webServer: [
    { command: "node apps/server/dist/main.js", url: "http://127.0.0.1:3101/api/health", reuseExistingServer: reuseExisting,
      env: { MOCK_GITLAB_SCENARIO: "partial-recovery", MOCK_GITLAB_DELAY_MS: "600", DATA_DIR: dataDir, SERVER_PORT: "3101" }, timeout: 30_000 },
    { command: "node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 5273 --strictPort --config apps/web/vite.config.ts",
      url: "http://127.0.0.1:5273", env: { API_PROXY_TARGET: "http://127.0.0.1:3101" }, reuseExistingServer: reuseExisting, timeout: 30_000 },
  ],
});
