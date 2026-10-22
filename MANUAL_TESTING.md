# Manual testing guide

Use this guide to understand the messages and check the application yourself. The scenarios below use mocked GitLab responses through the real backend collector and database. They do not call GitLab or change your token.

## Latest reported result

On October 22, 2026, the candidate reported completing the manual scenarios in this guide successfully. This records the candidate's manual testing report; the scenario checkboxes below remain a reusable checklist for future sessions. The separate live GitLab setting-change demonstration was completed the same day (runs 6–10); see [Live demonstration evidence](README.md#live-demonstration-evidence).

## Automated and recorded coverage

Every scenario below also has an automated browser test in [tests/e2e/analyst-flow.spec.ts](tests/e2e/analyst-flow.spec.ts) that runs the real backend with mocked GitLab HTTP, and appears in the [mock demo video](https://mohan1544.github.io/gitlab-compliance-integration/demo/) ([download](docs/demo/mock/mock-demo.webm)).

| # | Scenario | Automated browser test | Video | Screenshot |
| --- | --- | --- | --- | --- |
| 1 | Invalid input and duplicate IDs | *rejects invalid or duplicate IDs without changing the saved selection or creating a run* | Part 2 | [mock-10](docs/demo/mock/mock-10-invalid-input.png) |
| 2 | First collection: successful baseline | *successful collection reconnects after a mid-run refresh…* | Part 1 | [mock-04](docs/demo/mock/mock-04-run1-complete.png) |
| 3 | Partial failure with older evidence | *partial failure preserves last-good evidence…* | Part 1 | [mock-06](docs/demo/mock/mock-06-run2-partial-project-card.png), [mock-07](docs/demo/mock/mock-07-run2-partial-comparison.png) |
| 4 | Recovery and a setting change | *partial failure preserves last-good evidence and recovery compares to the first complete run* | Part 1 | [mock-08](docs/demo/mock/mock-08-run3-recovery-comparison.png) |
| 5 | Total collection failure (`999`) | *a project that cannot be read fails with 404 guidance and no retries* | Part 2 | [mock-11](docs/demo/mock/mock-11-total-failure-card.png) |
| 6 | One good project and one failed project | *a run with one readable and one unreadable project is partial and keeps both outcomes* | Part 2 | [mock-12](docs/demo/mock/mock-12-mixed-run.png) |
| 7 | Unsaved selection and preserved history | *requires saving edited IDs and preserves the original selection of earlier runs* | Part 2 | [mock-13](docs/demo/mock/mock-13-unsaved-selection.png), [mock-14](docs/demo/mock/mock-14-history-preserved.png) |
| 8 | Refresh while collection is running | *successful collection reconnects after a mid-run refresh…* | Part 1 | [mock-03](docs/demo/mock/mock-03-run1-reconnected-after-refresh.png) |
| 9 | Stop and restart without losing history | *a restart keeps selection and history, and a run stopped mid-collection becomes interrupted* | Part 2 | [mock-15](docs/demo/mock/mock-15-after-restart.png) |
| — | Abrupt stop mid-run (see below) | Same test as scenario 9 | Part 2 | [mock-16](docs/demo/mock/mock-16-interrupted-run.png) |

## Start a separate test session

1. Leave the frontend running in its terminal (`npm run dev:web`).
2. In the backend terminal, press **Ctrl+C** and wait until the process stops. If a collection was running, normal shutdown waits for it to finish.
3. In that same PowerShell terminal, go to the application folder and run:

```powershell
Set-Location D:\Companies\GitLabComplianceIntegration
$env:MOCK_GITLAB_SCENARIO = "partial-recovery"
$env:MOCK_GITLAB_DELAY_MS = "600"
$env:DATA_DIR = Join-Path (Get-Location) ("data\manual-test-" + (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
npm run dev:server
```

Use Node 24, as for the normal application. The timestamp creates a new test database without deleting any existing data.

4. Refresh `http://127.0.0.1:5173`.
5. Confirm the top of the page says **Mock demo · no GitLab access**. The selection should be `101, 102, 103`, and history should be empty.

Your real run history is still in `data/evidence.sqlite`. This session uses the separate directory created above, so the real runs will not appear while you are in this test session.

Mock project identities:

| ID | Simulated project |
| --- | --- |
| `101` | Initialized project with protected `main` |
| `102` | Initialized project with unprotected `main` |
| `103` | Empty repository whose metadata still reports `main` |
| `999` | Missing or inaccessible project; mock API returns HTTP 404 |

Always click **Save selection** after editing IDs, then check the **Saved:** line before starting a run.

## Test in this order

The first three collections form the failure/recovery demonstration. Do them before changing the selection. Invalid-input checks do not create runs and can be tried first.

### 1. Invalid input and duplicate IDs

- Enter `abc` and click **Save selection**.
- Repeat with `101, 101`.
- Also try an empty field or `-1`.
- Expected message: **Enter 1–20 unique positive numeric project IDs, separated by commas or spaces.**
- The saved selection should remain `101, 102, 103`. No run should be created.
- Restore the input to `101, 102, 103` before continuing.

### 2. First collection: successful baseline

- Confirm the saved IDs are `101, 102, 103` and click **Start collection** once.
- Run 1 should finish **completed**, with all three project outcomes **complete**.
- Project 101 should show protected `main` and **Force push: No**.
- Project 102 should show unprotected `main` with no visible protection rules.
- Project 103 should show an empty repository and no actual branch.
- The comparison should say **First complete observation; no baseline yet.**

Record: [ ] Pass [ ] Issue found

### 3. Second collection: partial failure with older evidence

- Keep the same saved IDs and click **Start collection** again.
- Run 2 should finish **partial**.
- Project 101 should be **partial**; projects 102 and 103 should remain **complete**.
- Project 101 should show **Latest attempt: provider unavailable** and guidance to start a new run after recovery.
- Its branch should still show **Protected**, because that particular API read succeeded.
- It should say **Protection rules were not collected in this attempt. Access restrictions are unknown, not absent.**
- It should show **Last complete evidence · Run 1**, clearly labelled as older evidence.
- Expand **Source reads and provenance**. The protected-branches read should show **unreadable**, **HTTP 503**, and **3 attempts**.
- The comparison should list **protection rules** as not compared. It must not report the failed read as a removed protection rule.

Record: [ ] Pass [ ] Issue found

### 4. Third collection: recovery and an actual setting change

- Keep the same IDs and start another collection.
- Run 3 should finish **completed**.
- Project 101 should now show **Force push: Yes**.
- Its comparison should use **Run 1** as the baseline, skipping the partial project observation in Run 2.
- The change should show **allow force push**, **rule main (exact)**, and **No → Yes**.
- Projects 102 and 103 may use Run 2 as their baselines because their individual project observations in that run were complete.

Record: [ ] Pass [ ] Issue found

### 5. Fourth collection: total collection failure

- Enter `999`, click **Save selection**, and confirm **Saved: 999**.
- Start the collection.
- Run 4 and its one project should finish **failed**.
- Expected error: **Latest attempt: not found or inaccessible**.
- Guidance should explain checking the ID and token visibility; GitLab can use 404 for either condition.
- The card should say **No evidence was collected for this project in this run** and **No earlier complete evidence exists for this project**.
- The source read should show **HTTP 404** without a retry count. Permanent 404 errors are not retried.
- Older successful runs should still be available in History.

Record: [ ] Pass [ ] Issue found

### 6. Fifth collection: one good project and one failed project

- Save `102, 999` and start a collection.
- Run 5 should finish **partial**.
- Project 102 should be **complete**, with its unprotected branch evidence.
- Project 999 should be **failed**, with the same 404 guidance.
- Both requested IDs must appear. A failed project must not disappear from the result.

Record: [ ] Pass [ ] Issue found

### 7. Unsaved selection and preserved history

- Edit the field to `102` without saving.
- Expected: **You have unsaved changes. Save selection before starting a collection.** The Start button should be disabled.
- Click **Save selection**, then start a collection.
- The new run should contain only project 102.
- Open Run 1: it should still contain its original three projects. Editing the selection must not rewrite an earlier run.

Record: [ ] Pass [ ] Issue found

### 8. Refresh while collection is running

- With saved ID `102`, start another collection and refresh the page immediately.
- The app should reconnect to the active run and finish without another click on Start.
- While the run is active, Start should be disabled and the UI should say **A collection is running**.
- After completion, Start should become available again.
- The 600 ms delay configured above makes this easier to observe.

Record: [ ] Pass [ ] Issue found

### 9. Stop and restart without losing history

- Wait until collection finishes.
- Stop the backend with Ctrl+C, then restart it using `npm run dev:server` in the **same terminal**, retaining the test environment variables.
- Refresh the page. The same mock selection and run history should remain.
- The mocked failure cycle is based on persisted run IDs: runs 1/4/7/... use the success phase, 2/5/8/... fail project 101's protection-rule read, and 3/6/9/... use the recovery phase. A phase affects project 101 only if it is selected.

Record: [ ] Pass [ ] Issue found

## Tests that require a different setup

- **Abrupt backend interruption:** normal Ctrl+C is a graceful shutdown and may finish the active run, so it does not produce an interrupted outcome. The browser test for scenario 9 kills the API process mid-run instead, restarts it, and checks the run is marked `interrupted` with its observed evidence kept; Part 2 of the mock video shows the same.
- **401, 403, 429, timeout and malformed provider response:** automated tests cover these at the GitLab boundary. The current manual mock mode does not offer selectors for them. Do not edit or revoke the real token just to manufacture these failures.
- **Real GitLab setting change:** perform this later in live mode, following the seed guide. The mock change above is simulated and is not a substitute for the required live demonstration.

## Return to your real projects

Stop the mock backend with Ctrl+C, then run these commands in its terminal:

```powershell
Remove-Item Env:\MOCK_GITLAB_SCENARIO -ErrorAction SilentlyContinue
Remove-Item Env:\MOCK_GITLAB_DELAY_MS -ErrorAction SilentlyContinue
Remove-Item Env:\DATA_DIR -ErrorAction SilentlyContinue
npm run dev:server
```

Refresh the dashboard. The mock banner should be gone and your real saved selection and history should return. The frontend can stay running throughout the switch.

## Record a problem

For an unexpected result, record the mode (mock/live), run number, saved project IDs, action taken, expected result, actual result, and a screenshot. Expand source reads when the issue concerns a failed collection. Never include a token in the screenshot or notes.
