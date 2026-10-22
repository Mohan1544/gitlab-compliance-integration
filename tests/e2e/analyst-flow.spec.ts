import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ID_RULE = "Enter 1–20 unique positive numeric project IDs, separated by commas or spaces.";

async function saveIds(page: Page, ids: string) {
  await page.getByRole("textbox", { name: "Numeric GitLab project IDs" }).fill(ids);
  await page.getByRole("button", { name: "Save selection" }).click();
  await expect(page.getByText(`Saved: ${ids}.`, { exact: false })).toBeVisible();
}

async function collect(page: Page, expected: string) {
  await page.getByRole("button", { name: "Start collection" }).click();
  await expect(page.getByTestId("run-state")).toHaveText(/queued|running/);
  await expect(page.getByTestId("run-state")).toHaveText(expected, { timeout: 30_000 });
}

// Starts a process and waits until `readyUrl` answers, for tests that must stop and restart the API.
async function startProcess(args: string[], env: Record<string, string>, readyUrl: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: "ignore" });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(readyUrl)).ok) return child; } catch { /* not listening yet */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  child.kill("SIGKILL");
  throw new Error(`Process did not become ready: ${readyUrl}`);
}

// Kills a process abruptly and waits for it to exit, so its open files (e.g. SQLite) are released.
async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 10_000))]);
}

// The mock API delays every GitLab response (MOCK_GITLAB_DELAY_MS in playwright.config.ts), so each run
// stays active long enough to refresh the browser mid-collection.
test.describe.serial("analyst collection flow", () => {
  test("successful collection reconnects after a mid-run refresh and shows protected, unprotected, and empty repositories", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Mock demo · no GitLab access")).toBeVisible();
    await expect(page.getByText("Saved: 101, 102, 103")).toBeVisible();
    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByTestId("run-state")).toHaveText(/queued|running/);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Run 1" }).first()).toBeVisible();
    await expect(page.getByTestId("run-state")).toHaveText(/queued|running/);
    await expect(page.getByRole("button", { name: "Start collection" })).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("A collection is running");

    await expect(page.getByTestId("run-state")).toHaveText("completed");
    await expect(page.getByRole("button", { name: "Start collection" })).toBeEnabled();
    await expect(page.getByTestId("project-101").getByText("Protected", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("project-101").getByText("main (exact default-branch rule)")).toBeVisible();
    await expect(page.getByTestId("project-102").getByText("Unprotected", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("project-103").getByText("No actual branch exists.", { exact: false })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("run-state")).toHaveText("completed");
    await expect(page.getByText("No earlier complete baseline is available.").first()).toBeVisible();
  });

  test("partial failure preserves last-good evidence and recovery compares to the first complete run", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByRole("heading", { name: "Run 2" }).first()).toBeVisible();
    await expect(page.getByTestId("run-state")).toHaveText("partial");
    const failed = page.getByTestId("project-101");
    await expect(failed.getByText("Latest attempt: provider unavailable", { exact: false })).toBeVisible();
    await expect(failed.getByText("Protection rules were not collected in this attempt. Access restrictions are unknown, not absent.")).toBeVisible();
    await expect(failed.getByText("Last complete evidence · Run 1")).toBeVisible();
    await expect(page.getByText("Partial evidence against run 1", { exact: false })).toBeVisible();
    await expect(page.getByText("Not compared (not observed): protection rules.")).toBeVisible();

    // Recovery: the analyst starts a new run once GitLab is available again.
    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByRole("heading", { name: "Run 3" }).first()).toBeVisible();
    await expect(page.getByTestId("run-state")).toHaveText("completed");
    await expect(page.getByText("Against run 1", { exact: false }).first()).toBeVisible();
    const change = page.locator(".comparison li").filter({ hasText: "allow force push" });
    await expect(change).toContainText("rule main (exact)");
    await expect(change.locator(".diff-before")).toContainText("Before · Run 1");
    await expect(change.locator(".diff-before dd")).toHaveText("No");
    await expect(change.locator(".diff-after")).toContainText("After · Run 3");
    await expect(change.locator(".diff-after dd")).toHaveText("Yes");
    await page.getByRole("region", { name: "Changes", exact: true }).screenshot({ path: testInfo.outputPath("comparison-diff.png") });
  });

  test("labels stale evidence and older runs", async ({ page }) => {
    await page.clock.setFixedTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Run 3" }).first()).toBeVisible();
    await expect(page.getByTestId("project-101").getByText("Stale · older than 7 days")).toBeVisible();

    await page.getByRole("button", { name: /Run 1/ }).click();
    await expect(page.getByRole("heading", { name: "Run 1" }).first()).toBeVisible();
    await expect(page.getByText("You are viewing an older run. Run 3 is newer; open it for the latest outcome.")).toBeVisible();
  });

  test("requires saving edited IDs and preserves the original selection of earlier runs", async ({ page }) => {
    await page.goto("/");
    const start = page.getByRole("button", { name: "Start collection" });
    await expect(start).toBeEnabled();
    await page.getByRole("textbox", { name: "Numeric GitLab project IDs" }).fill("101");
    await expect(page.getByRole("status")).toHaveText("You have unsaved changes. Save selection before starting a collection.");
    await expect(start).toBeDisabled();
    await expect(page.getByText("Saved: 101, 102, 103", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Save selection" }).click();
    await expect(start).toBeEnabled();
    await expect(page.getByText("You have unsaved changes.", { exact: false })).toHaveCount(0);
    await start.click();
    await expect(page.getByRole("heading", { name: "Run 4", exact: true })).toBeVisible();
    await expect(page.getByTestId("run-state")).toHaveText("completed");
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.getByTestId("project-101")).toBeVisible();

    const latest = await page.request.get("/api/runs/4");
    expect((await latest.json()).requestedProjectIds).toEqual([101]);
    const original = await page.request.get("/api/runs/1");
    expect((await original.json()).requestedProjectIds).toEqual([101, 102, 103]);
  });

  // MANUAL_TESTING.md scenario 1
  test("rejects invalid or duplicate IDs without changing the saved selection or creating a run", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Saved: 101.", { exact: false })).toBeVisible();
    const runsBefore = (await (await page.request.get("/api/runs")).json()).runs.length;
    for (const invalid of ["abc", "101, 101", "", "-1"]) {
      await page.getByRole("textbox", { name: "Numeric GitLab project IDs" }).fill(invalid);
      await page.getByRole("button", { name: "Save selection" }).click();
      await expect(page.getByRole("alert")).toHaveText(ID_RULE);
      await expect(page.getByText("Saved: 101.", { exact: false })).toBeVisible();
    }
    expect((await (await page.request.get("/api/selection")).json()).projectIds).toEqual([101]);
    expect((await (await page.request.get("/api/runs")).json()).runs).toHaveLength(runsBefore);
  });

  // MANUAL_TESTING.md scenario 5
  test("a project that cannot be read fails with 404 guidance and no retries", async ({ page }) => {
    await page.goto("/");
    await saveIds(page, "999");
    await collect(page, "failed");
    const card = page.getByTestId("project-999");
    await expect(card.getByText("Latest attempt: not found or inaccessible.", { exact: false })).toBeVisible();
    await expect(card.getByText("GitLab may return 404 for either condition", { exact: false })).toBeVisible();
    await expect(card.getByText("No evidence was collected for this project in this run.")).toBeVisible();
    await expect(card.getByText("No earlier complete evidence exists for this project.")).toBeVisible();
    await card.getByText("Source reads and provenance").click();
    const read = card.locator(".source-list li").first();
    await expect(read).toContainText("HTTP 404");
    await expect(read).not.toContainText("attempts");
    await expect(page.getByRole("button", { name: /^Run 1\b/ })).toBeVisible();
  });

  // MANUAL_TESTING.md scenario 6
  test("a run with one readable and one unreadable project is partial and keeps both outcomes", async ({ page }) => {
    await page.goto("/");
    await saveIds(page, "102, 999");
    await collect(page, "partial");
    await expect(page.locator(".project-card")).toHaveCount(2);
    await expect(page.getByTestId("project-102").locator("header .badge")).toHaveText("complete");
    await expect(page.getByTestId("project-102").getByText("Unprotected", { exact: true })).toBeVisible();
    await expect(page.getByTestId("project-999").locator("header .badge")).toHaveText("failed");
    await expect(page.getByTestId("project-999").getByText("Latest attempt: not found or inaccessible.", { exact: false })).toBeVisible();
  });

  // Review finding: a slow refresh that started before the analyst picked another run must not switch the view back.
  test("a delayed refresh cannot override the run the analyst selected", async ({ page }) => {
    await page.goto("/");
    await saveIds(page, "101, 102, 103");
    // Run details for every run except run 1 arrive 1.5 s late, so refreshes started before the click land after it.
    await page.route(/\/api\/runs\/\d+(\/changes)?$/, async (route) => {
      if (!/\/api\/runs\/1(\/changes)?$/.test(new URL(route.request().url()).pathname)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
      }
      await route.continue();
    });
    const started = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Start collection" }).click();
    expect((await started).status()).toBe(202);

    await page.evaluate(() => {
      const heading = document.getElementById("run-title")!;
      const seen: string[] = [];
      (window as unknown as { seenHeadings: string[] }).seenHeadings = seen;
      new MutationObserver(() => seen.push(heading.textContent ?? "")).observe(heading, { childList: true, characterData: true, subtree: true });
    });
    await page.getByRole("button", { name: /^Run 1\b/ }).click();
    await expect(page.getByRole("heading", { name: "Run 1", exact: true })).toBeVisible();
    await page.waitForTimeout(4000);
    const seen = await page.evaluate(() => (window as unknown as { seenHeadings: string[] }).seenHeadings);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["Run 1"]));

    await page.unroute(/\/api\/runs\/\d+(\/changes)?$/);
    await expect.poll(async () => (await (await page.request.get("/api/runs/active")).json()).run, { timeout: 30_000 }).toBeNull();
  });

  // A refresh that read the selection before a save must not overwrite the saved selection when it lands late.
  test("a delayed refresh cannot overwrite a selection saved after it started", async ({ page }) => {
    // Every selection read that starts before the save returns the old selection 1.5 s late.
    let saveSent = false;
    const staleReads: Promise<void>[] = [];
    await page.route(/\/api\/selection$/, async (route) => {
      if (route.request().method() === "PUT") saveSent = true;
      if (route.request().method() !== "GET" || saveSent) {
        await route.continue();
        return;
      }
      const delivered = (async () => {
        const stale = await route.fetch();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
        await route.fulfill({ response: stale });
      })();
      staleReads.push(delivered);
      await delivered;
    });
    await page.goto("/");
    await page.getByRole("textbox", { name: "Numeric GitLab project IDs" }).fill("102");
    await page.getByRole("button", { name: "Save selection" }).click();
    expect(staleReads.length).toBeGreaterThan(0);
    await Promise.all(staleReads);
    await expect(page.getByText("Saved: 102.", { exact: false })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByText("Saved: 102.", { exact: false })).toBeVisible();
    await expect(page.getByText("You have unsaved changes.", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start collection" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: /^Run \d+$/ }).first()).toBeVisible();
    expect((await (await page.request.get("/api/selection")).json()).projectIds).toEqual([102]);
    await page.unroute(/\/api\/selection$/);
  });
});

// MANUAL_TESTING.md scenario 9, plus an abrupt stop mid-run. This test owns its API and UI processes so it can
// restart the API; it uses separate ports and a fresh database.
test("a restart keeps selection and history, and a run stopped mid-collection becomes interrupted", async ({ page }) => {
  test.setTimeout(120_000);
  const apiPort = 3111;
  const webPort = 5281;
  const dataDir = mkdtempSync(join(tmpdir(), "zania-restart-test-"));
  const apiEnv = { MOCK_GITLAB_SCENARIO: "partial-recovery", MOCK_GITLAB_DELAY_MS: "600", DATA_DIR: dataDir, SERVER_PORT: String(apiPort) };
  const startApi = () => startProcess([resolve("apps/server/dist/main.js")], apiEnv, `http://127.0.0.1:${apiPort}/api/health`);
  let api = await startApi();
  const web = await startProcess([resolve("node_modules/vite/bin/vite.js"), "apps/web", "--host", "127.0.0.1", "--port", String(webPort),
    "--strictPort", "--config", "apps/web/vite.config.ts"], { API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` }, `http://127.0.0.1:${webPort}/`);
  try {
    await page.goto(`http://127.0.0.1:${webPort}/`);
    await collect(page, "completed");

    // Scenario 9: stop and restart the API; the saved selection and completed run survive.
    await killAndWait(api);
    api = await startApi();
    await page.reload();
    await expect(page.getByText("Saved: 101, 102, 103.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run 1", exact: true })).toBeVisible();
    await expect(page.getByTestId("run-state")).toHaveText("completed");

    // Abrupt stop while run 2 is collecting: after restart it is interrupted, not running forever.
    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByTestId("run-state")).toHaveText("running");
    await killAndWait(api);
    api = await startApi();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Run 2", exact: true })).toBeVisible();
    await expect(page.getByTestId("run-state")).toHaveText("interrupted");
    await expect(page.getByText("Latest attempt: server interrupted. The server stopped during collection; start a new run.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Start collection" })).toBeEnabled();

    // Recovery: a new run can start and complete.
    await collect(page, "completed");
    await expect(page.getByRole("heading", { name: "Run 3", exact: true })).toBeVisible();
  } finally {
    await killAndWait(api);
    await killAndWait(web);
    // Best-effort: Windows can hold file locks briefly after exit; a leftover temp folder must not fail the test.
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* ignored */ }
  }
});
