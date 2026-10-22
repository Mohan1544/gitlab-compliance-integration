# GitLab.com test environment setup

Status: the candidate reports that a personal GitLab.com account and the `zania-group` namespace (`https://gitlab.com/zania-group`) have been created. Live GitLab.com API calls verified all three seeded project states. Keep all repository content synthetic. The assessment requires the application to be read-only toward GitLab; these are **manual setup/demo actions by the candidate**, outside the application.

## 1. Create a free personal account

1. Go to [GitLab.com](https://gitlab.com/) and select its sign-up option. Use your own email and account details. Complete any verification GitLab requests; its [identity-verification documentation](https://docs.gitlab.com/security/identity_verification/) says email verification is required and additional checks may apply.
2. Stay on the free tier. The assessment does not require employer credentials, Zania access, or paid GitLab features.
3. Do not send your password, verification codes, or future token in chat or put them in the repository.

## 2. Create three synthetic projects

GitLab's [blank-project instructions](https://docs.gitlab.com/user/project/) use **Create new > New project/repository > Create blank project**. Choose a namespace you control (your personal namespace or your own group) and use it for all three projects. Use clearly synthetic names such as `zania-demo-protected`, `zania-demo-unprotected`, and `zania-demo-empty`. Private visibility is a reasonable default; record the actual visibility selected. Avoid real company data. If using a group, check for any group-level branch rules when verifying protection.

| Project | During creation | Verify afterward |
| --- | --- | --- |
| Protected | Check **Initialize repository with a README**. | A default branch exists and GitLab reports it protected. GitLab says default branches are protected by default, but verify the actual project. |
| Unprotected | Check **Initialize repository with a README**. | A default branch exists. In **Settings > Repository > Branch rules**, remove its protection, then verify GitLab reports the branch unprotected. Do not merely broaden push access on a still-protected rule. |
| Empty | Leave **Initialize repository with a README** unchecked. | No commits and no default branch. Do not add a file or README later. |

GitLab documents [default branch protection and branch rules](https://docs.gitlab.com/user/project/repository/branches/protected/). Its UI may change; use the branch's displayed protection state as an initial check, then verify with read-only API responses before recording the fixture as correct. If the default branch is still protected after changing a rule, inspect all matching rules rather than assuming the change worked.

Record only non-secret identifiers here after creation:

| State | Project URL | Numeric project ID | Actual default branch | Verified API state |
| --- | --- | --- | --- | --- |
| Protected | `https://gitlab.com/zania-group/zania-demo-protected` | `87937359` | `main` | Live API: `protected: true`, `main` rule visible |
| Unprotected | `https://gitlab.com/zania-group/zania-demo-unprotected` | `87937442` | `main` | Live API: `protected: false`, no protected rules |
| Empty | `https://gitlab.com/zania-group/zania-demo-empty` | `87937501` | No actual branch; project metadata says `main` | Live API: `empty_repo: true`, repository branch list `[]`; branch GET returned `404` |

These synthetic URLs and IDs are not credentials. Before public submission, decide whether to keep them in the guide or replace them with placeholders; private project paths may still reveal the account or group name.

## 3. Create a read-only API token

Follow GitLab's [personal access token instructions](https://docs.gitlab.com/user/profile/personal_access_tokens/): avatar > **Edit profile** > **Access > Personal access tokens** > **Generate token > Legacy token**. Give it a descriptive name and short expiry suitable for the assignment. Select **`read_api` only**; GitLab defines it as read access to the API in its [scope reference](https://docs.gitlab.com/security/tokens/access_token_scopes/). Do not select the broader `api` scope.

GitLab shows the token value once. Save it in a password manager or another private location. Supply it only to the local server through `GITLAB_TOKEN`. This folder contains a placeholder `.env.example`; the real `.env` file is ignored by Git. Never paste the token into chat, screenshots, commands captured in shell history, client code, logs, or the submission.

## 4. Verify read-only responses before implementation assumptions

After the projects and token exist, we will inspect sanitized results from these **GET** endpoints for each numeric project ID:

1. `GET https://gitlab.com/api/v4/projects/:id` - ID, name, URL, visibility, `empty_repo`, and `default_branch`.
2. For initialized projects only, `GET https://gitlab.com/api/v4/projects/:id/repository/branches/:branch` - GitLab-reported `protected` status. URL-encode the branch name.
3. `GET https://gitlab.com/api/v4/projects/:id/protected_branches` - protection rules and their access settings. Account for pagination if needed.

The token belongs in the request's `PRIVATE-TOKEN` header, never in the URL. After creating it, copy `.env.example` to `.env`, replace `replace-me` with the token, and adjust the project paths if your actual names differ. Run `node --env-file=.env scripts/verify-gitlab.mjs` from this folder. The script prints selected fields and safe HTTP error codes, never headers or the token. It uses only `GET` requests to `gitlab.com`. Do not infer that an unreadable rule means there is no rule. Do not paste the full verification output in public; project URLs and access-level details may still be private.

Official API references: [Projects](https://docs.gitlab.com/api/projects/), [Branches](https://docs.gitlab.com/api/branches/), [Protected branches](https://docs.gitlab.com/api/protected_branches/).

## 5. Preserve the required live demo

Once the application is built: collect all three projects through its UI; manually toggle **Allowed to force push** on the protected project's `main` branch in GitLab; collect again; show the `false -> true` comparison against the first run. Restore the original setting after capturing sanitized screenshots or a short recording. Keep the empty project empty throughout. The app itself must remain read-only toward GitLab.

## Current checkpoint

- [x] Personal GitLab.com account created (reported by candidate; verification status not independently checked).
- [x] Three projects created with the intended states and verified through live API responses. The empty project's configured `default_branch` field says `main`, but no actual branch exists.
- [x] Numeric project IDs recorded in this guide.
- [x] `read_api` token created and stored privately (candidate reported completion; token value and scope were not inspected).
- [x] Actual API responses checked; selected, sanitized observations are recorded in this guide. Dedicated mocked HTTP test fixtures remain part of implementation.
