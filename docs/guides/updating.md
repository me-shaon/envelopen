# Update Envelopen

This guide explains how a deployment gets new Envelopen releases. It also shows how to update by hand, how to back up the database, and how to roll back.

## How updates work

The Deploy to Cloudflare button copies the Envelopen repository into your GitHub or GitLab account. The copy is not a fork, and it does not share the history of the Envelopen repository. Workers Builds watches the production branch of the copy (usually `main`). Each push to that branch builds Envelopen and deploys it. The deploy command runs the `deploy` script of `package.json`. The script applies the new D1 migrations, and then deploys the Worker.

The copy is different from the Envelopen repository in these ways:

- It has no `.github` folder. So it does not have the update workflow until you add it. See [Add the update workflow](#add-the-update-workflow).
- `package.json` has your Worker name and the version `0.0.0`. Envelopen keeps its version in `apps/worker/src/version.ts` instead.
- `wrangler.jsonc` has your Worker name and the IDs and names of your resources.

When you add the workflow **Envelopen updates** (`.github/workflows/envelopen-update.yml`), it does these steps each Monday:

1. It reads the latest release of `me-shaon/envelopen`. It uses releases only, never the `main` branch.
2. It compares the release with `ENVELOPEN_VERSION` in your `apps/worker/src/version.ts`. If the release is not newer, the workflow stops. A copy of v0.5.0 or older has no usable version. For such a copy, the workflow finds the release tag with the fewest changed lines.
3. It gets the files of the new release and of the release that you have now.
4. It runs `scripts/update/apply-release.mjs`. The script applies the changes of the release to your files.
5. It commits the result to your default branch, or it opens a pull request. Workers Builds then deploys the update.

The script follows these rules:

- If the release changed a file and you did not, the script takes the release version.
- If the release deleted a file and you did not change it, the script deletes it.
- If you changed a file and the release did not, your version stays.
- Files that you added stay.
- A file in `.github` that your copy does not have is not added again. The Deploy button leaves out `.github`.
- `package.json` keeps your `name` and `version` lines.
- `wrangler.jsonc` gets a merge. The release gives the structure, the comments, and the new bindings. Your copy keeps its Worker name, `account_id`, routes and custom domains, the resource IDs and names of each binding, the vars that you changed, and the bindings that you added.

The workflow does nothing in the `me-shaon/envelopen` repository itself.

## Learn about a new release

Envelopen tells you about new releases in these ways:

- **In the app.** Open **Settings** > **Updates**. The section shows the version that runs and the newest release on GitHub. Select **Check now** to ask GitHub at once. Once a day, at 06:17 UTC, Envelopen asks GitHub for the newest release of `me-shaon/envelopen`. It sends no workspace data. To stop the daily check, clear **Check for new versions every day** in the same section.
- **In your repository.** The update workflow applies each new release, or it opens a pull request. See [Add the update workflow](#add-the-update-workflow).
- **On GitHub.** On the [Envelopen repository](https://github.com/me-shaon/envelopen), select **Watch** > **Custom** > **Releases**. GitHub then sends you an email for each release.

## Before you start

- Make sure that your repository is on GitHub. The workflow is a GitHub Actions workflow. On GitLab, use [Update by hand](#update-by-hand).
- Read the release notes of each new version on the [releases page](https://github.com/me-shaon/envelopen/releases). Do the steps under **Manual steps** and **Breaking** yourself.
- Back up before each update. Select **Back up now** in **Settings** > **Backups**, and wait until the backup succeeds. See [Back up and restore](backup-and-restore.md).
- Before a release that adds a D1 migration, also export the database. See [Back up the database](#back-up-the-database).

## Add the update workflow

Do this one time, after the first deploy. The Deploy button does not copy the `.github` folder, so you add the workflow file yourself. A fork already has the file. For a fork, go to [Turn on the update workflow](#turn-on-the-update-workflow).

1. Open [`.github/workflows/envelopen-update.yml`](https://github.com/me-shaon/envelopen/blob/main/.github/workflows/envelopen-update.yml) in the Envelopen repository. Select **Copy raw file**.
2. In your repository, select **Add file** > **Create new file**.
3. Type the name `.github/workflows/envelopen-update.yml`, and paste the contents.
4. Select **Commit changes**. Workers Builds deploys the commit. Nothing in the app changes.
5. Do the steps in [Turn on the update workflow](#turn-on-the-update-workflow).

## Turn on the update workflow

1. Open your repository on GitHub, and select **Actions**.
2. If GitHub asks, select **I understand my workflows, go ahead and enable them**.
3. In the list of workflows, select **Envelopen updates**.
4. If the workflow shows as disabled, select **Enable workflow**.
5. Select **Run workflow**, and then select **Run workflow** again to start a first run.
6. Open the run, and read the job summary. It shows your version and the latest version.

To let the workflow open pull requests, also do these steps:

1. Open **Settings** > **Actions** > **General**.
2. Under **Workflow permissions**, select **Allow GitHub Actions to create and approve pull requests**.
3. Select **Save**.

## Choose the update mode

The repository variable `ENVELOPEN_UPDATE_MODE` sets the mode:

| Value | What the workflow does |
|---|---|
| `sync` (default) | It commits the update to your default branch. Workers Builds deploys it at once. |
| `pr` | It pushes the branch `envelopen-update/vX.Y.Z` and opens a pull request. Workers Builds deploys the update after you merge the pull request. |

To set the mode:

1. Open **Settings** > **Secrets and variables** > **Actions**.
2. Select the **Variables** tab, and select **New repository variable**.
3. Type `ENVELOPEN_UPDATE_MODE` as the name, and `sync` or `pr` as the value.
4. Select **Add variable**.

To use a different mode for one run, start the workflow with **Run workflow**, and select the mode in the list.

### Turn off preview builds

Do these steps before you use the `pr` mode. The workflow can also open a pull request in the `sync` mode, for example when you changed the same files as the release.

By default, Workers Builds makes a preview build of each push to a branch that is not your production branch (a non-production branch). The update branch `envelopen-update/vX.Y.Z` is such a branch. For a deployment from the Deploy button, this preview build fails, and the pull request shows a failed check. The failed check does not mean that the update is bad. A preview build never deploys the update.

1. Open the Cloudflare dashboard, and select **Workers & Pages**.
2. Select your Worker, and then select **Settings** > **Build** > **Branch control**.
3. Clear **Enable Preview Builds**.
4. Select **Save**.

Workers Builds then builds only the production branch. The update deploys when you merge the pull request, as before.

## Add the update token (optional)

GitHub does not let a workflow change files in `.github/workflows` with its default token (`GITHUB_TOKEN`). If a release changes a workflow file, the workflow cannot update it without a separate token. The workflow then applies all other files and opens an issue. The issue lists the workflow files and links to the release version of each file.

To let the workflow update these files too, add a token:

1. On GitHub, open **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens**.
2. Select **Generate new token**.
3. Under **Repository access**, select **Only select repositories**, and select your Envelopen repository.
4. Under **Permissions**, set **Contents**, **Pull requests**, and **Workflows** to **Read and write**.
5. Select **Generate token**, and copy the token.
6. In your repository, open **Settings** > **Secrets and variables** > **Actions**.
7. Select **New repository secret**. Type `ENVELOPEN_UPDATE_TOKEN` as the name, and paste the token.
8. Select **Add secret**.

A fine-grained token has an expiry date. Make a new token before the old one expires.

## When you changed the same files

The workflow compares your files with the files of the release that you have now. If you changed a file and the release changed it too, the workflow does not overwrite your change silently:

- It uses the `pr` mode for that run, even when `ENVELOPEN_UPDATE_MODE` is `sync`.
- The pull request uses the release version of each of these files. Its description lists the files.
- Read the diff of each listed file. Add your changes again if you still need them, and then merge the pull request.

The workflow also uses the `pr` mode when it cannot find the release that you have now. Without that release, it cannot see your changes.

To keep updates automatic, keep your own changes small. Put your own files in new paths, and set values in `wrangler.jsonc` instead of in the code.

## Update by hand

Use these steps on GitLab, or when the workflow cannot run. Replace `v0.2.0` with the new release, and `v0.1.0` with `ENVELOPEN_VERSION` in your `apps/worker/src/version.ts`. In a copy of v0.5.0 or older, `version.ts` has no version. Use the release that you deployed first, or the release that you last updated to.

1. Open a terminal in your copy of the repository.
2. Add the Envelopen repository as a remote:

   ```sh
   git remote add upstream https://github.com/me-shaon/envelopen.git
   ```

3. Get the two releases:

   ```sh
   git fetch --no-tags upstream tag v0.2.0 tag v0.1.0
   ```

4. Extract the files of each release into a folder outside the repository:

   ```sh
   mkdir -p ../envelopen-new ../envelopen-base
   git archive v0.2.0 | tar -x -C ../envelopen-new
   git archive v0.1.0 | tar -x -C ../envelopen-base
   ```

5. See what the update changes:

   ```sh
   node ../envelopen-new/scripts/update/apply-release.mjs --upstream ../envelopen-new --base ../envelopen-base --current . --dry-run
   ```

6. Apply the update. Remove `--dry-run` from the command in step 5, and run it again.
7. Read the changes with `git diff`. Check each file in the **Conflicts** list.
8. Commit the changes: `git add -A`, then `git commit -m "Update Envelopen to v0.2.0"`.
9. Push the commit: `git push`. Workers Builds deploys the update.

## Deploy from a computer

If Workers Builds is not connected to your repository, deploy from a computer:

1. Install the dependencies: `pnpm install`.
2. Sign in to Cloudflare: `npx wrangler login`.
3. Deploy: `pnpm run deploy`. The command applies the new D1 migrations, and then deploys the Worker.

## Back up the database

A D1 migration changes the database. Back up the database before an update that adds a migration. The release notes and the files in `packages/db/migrations` show the new migrations.

First, make an Envelopen backup with **Back up now** in **Settings** > **Backups**. See [Back up and restore](backup-and-restore.md). Then export the database for a quick restore into the same account:

1. Find the `database_name` of the `DB` binding in your `wrangler.jsonc`.
2. Export the database. Replace `<database-name>` with that name:

   ```sh
   npx wrangler d1 export <database-name> --remote --output=envelopen-backup.sql
   ```

3. Keep the file in a safe place. It holds the personal data of your contacts.

## Roll back an update

To go back to the earlier code:

1. Open the Cloudflare dashboard, and select **Workers & Pages**.
2. Select your Worker, and then select **Deployments**.
3. Find the version before the update. Select the menu on its right, and select **Rollback**.

A rollback changes only the code and the configuration of the Worker. It does not change the D1 database. If the update applied a D1 migration, the migration stays. The older code can then fail on the new schema. A rollback is also blocked when the update added a Durable Object migration.

To undo a D1 migration, restore the database to a time before the update with D1 Time Travel. Workers Free keeps 7 days, and Workers Paid keeps 30 days:

```sh
npx wrangler d1 time-travel restore DB --timestamp=<unix-time-before-the-update>
```

The restore overwrites the database. Data that arrived after that time is lost. You can also import your export into a new database, or restore an Envelopen backup into a new deployment. See [Back up and restore](backup-and-restore.md).

A rollback in the dashboard does not change your repository. The next push to the production branch deploys the newest code again. To stay on the old release, revert the update commit in your repository.

## Fork instead of the Deploy button

If you forked `me-shaon/envelopen` on GitHub instead of using the Deploy button, your fork shares the history of the Envelopen repository. You can then use **Sync fork**:

1. Open your fork on GitHub.
2. Select **Sync fork**, and then **Update branch**.

**Sync fork** brings in the `main` branch, which can hold changes that are not in a release yet. For releases only, use the update workflow in your fork. GitHub turns off scheduled workflows in a fork, so turn on **Envelopen updates** in the **Actions** tab first.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The workflow never runs. | Actions or the workflow is off. GitHub also turns off scheduled workflows after 60 days without activity in a public repository. | Turn on the workflow. See [Turn on the update workflow](#turn-on-the-update-workflow). |
| The run fails with "Run this workflow on the default branch". | A manual run started from another branch. | Select the default branch in **Run workflow**. |
| "Could not open the pull request." | GitHub Actions may not create pull requests. | Select **Allow GitHub Actions to create and approve pull requests** in **Settings** > **Actions** > **General**. |
| The push to the default branch fails. | A branch protection rule blocks the push. | Set `ENVELOPEN_UPDATE_MODE` to `pr`. |
| The push fails with "refusing to allow a GitHub App to create or update workflow". | The release changes a workflow file, and the token has no **Workflows** permission. | Give the token **Workflows** write access, or remove the secret. |
| An issue asks you to update the workflow files. | The release changes a file in `.github/workflows`, and no update token is set. | Copy each linked file into your repository, or add `ENVELOPEN_UPDATE_TOKEN`. |
| Each update opens a pull request. | You changed files that each release changes too, for example `pnpm-lock.yaml`. | Move your changes out of those files, or merge each pull request. |
| The pull request of an update shows a failed Workers Builds check. | Workers Builds makes a preview build of the update branch, and that build fails. | Turn off preview builds. See [Turn off preview builds](#turn-off-preview-builds). Then merge the pull request. |
| The Workers Builds deploy fails after an update. | A new binding, secret, or manual step is missing. | Read **Manual steps** in the release notes. Read the build log in **Workers & Pages** > your Worker > **Deployments**. |
| The job summary says that Envelopen is up to date, but a new release exists. | `ENVELOPEN_VERSION` in `apps/worker/src/version.ts` is not the release that you have. | Set `ENVELOPEN_VERSION` to the release that your files match, and run the workflow again. |
| There is no **Envelopen updates** workflow in **Actions**. | The Deploy button does not copy `.github`. | Add the workflow file. See [Add the update workflow](#add-the-update-workflow). |

## Related guides

- [README](../../README.md)
- [Cloudflare Workers platform](cloudflare-platform.md)
- [Cloudflare D1](database-d1.md)
- [Back up and restore](backup-and-restore.md)
- [Release checklist](release-checklist.md)

## Sources

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/configuration/deploy-button/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Builds: build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)

Last checked: 2026-11-10
