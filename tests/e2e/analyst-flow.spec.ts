import { expect, test } from "@playwright/test";

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
    await expect(page.getByText("First complete observation; no baseline yet.").first()).toBeVisible();
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
});
