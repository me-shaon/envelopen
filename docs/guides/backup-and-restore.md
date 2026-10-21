# Back up and restore

This guide explains Envelopen backups: what they hold, where they go, and how to restore one into a new deployment. It also explains when to use D1 Time Travel instead.

## What a backup holds

An Envelopen backup is a copy of all data of the deployment, for every workspace. It holds the contacts, lists, tags, consent history, templates, campaigns, events, stats, users, API keys, provider connections, settings, and the audit log.

A backup does not hold these tables:

| Table | Why it is not in the backup |
|---|---|
| Sessions (`auth_session`) | A restore signs every user out. The owner signs in again after the restore. |
| Backup runs (`backup_runs`) | The backup history belongs to the old deployment. |
| Restore runs (`restore_runs`, `restore_tables`) | The restore history belongs to the old deployment. |
| Key derivations (`key_derivations`) | These rows are short-lived and hold sealed secrets. |

A backup also holds the deployment secrets `SIGNING_KEY`, `SIGNING_KEYS_RETIRED`, and `ENCRYPTION_KEY`. After a restore, old unsubscribe links still work, and the suppression list still matches old addresses.

Each backup is encrypted. Only the backup passphrase opens it. The backup reads rows up to the highest row of each table at the start of the run. Rows that arrive during the run are not in the backup.

### Erased contacts

When you erase a contact, older backups still hold the personal data of that contact. Retention deletes those backups when they pass the retention period. Downloaded `.envbak` files stay until you delete them. Keep this in mind for a data deletion request.

## Before you start

- Sign in as the owner. Only the owner session can manage backups. An API key and MCP cannot.
- Have a password manager ready for the passphrase.
- Optional: prepare an S3-compatible bucket for a second copy. See [Add an S3-compatible copy](#add-an-s3-compatible-copy).

Backups apply to the whole deployment, not to one workspace. The settings are in **Settings** > **Backups**.

## Set the passphrase

Backups stay off until you set a passphrase.

1. Open **Settings**, and go to **Backups**.
2. In **Passphrase**, type a passphrase of at least 12 characters.
3. Type it again in **Repeat the passphrase**.
4. Select **Set the passphrase**.
5. If Envelopen asks you to sign in again, sign in. Each backup action needs a sign-in from the last 10 minutes.
6. Store the passphrase in a password manager.

Envelopen then prepares the backup key from the passphrase. This takes a few seconds. While it runs, the card shows "Preparing the backup key from the passphrase". When the key is ready, the card shows **Set on** and the date.

Envelopen keeps only a public key. Nobody can recover a lost passphrase. A backup without its passphrase cannot be restored.

To change the passphrase, select **Change the passphrase**. Backups made before the change still need the old passphrase. Keep the old passphrase until retention deletes those backups.

## Where backups go

Each backup goes to the R2 bucket of the deployment (`envelopen-files`), under `backups/<backup-id>/`. A backup is a folder with an encrypted chunk for each 1,000 rows and a `manifest.json` file.

R2 is in the same Cloudflare account as the deployment. If you lose the account, you lose these backups too. For a copy outside the account, add an S3-compatible copy, or download backups.

### Add an S3-compatible copy

Envelopen can copy each backup to an S3-compatible store, for example AWS S3, Backblaze B2, or an R2 bucket in another Cloudflare account. The copy uses path-style URLs.

On the side of the store:

1. Create a bucket for Envelopen backups only.
2. Create an access key that can use only this bucket.
3. Give the key only the permissions `PutObject` and `DeleteObject` on the `backups/` prefix. Envelopen does not read, list, or upload in parts.
4. Do not give the key permission to read objects or to change the bucket.
5. Copy the endpoint, the region, the bucket name, the access key id, and the secret access key.

On AWS, the policy of the key can look like this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket>/backups/*"
    }
  ]
}
```

On R2 in another account, create an API token with **Object Read & Write** for that bucket only. R2 tokens cannot be write-only.

In Envelopen:

1. Open **Settings** > **Backups**, and go to **Copy to S3**.
2. Select **Add a destination**.
3. Fill in **Endpoint**, **Region**, **Bucket**, **Access key id**, and **Secret access key**. For R2, the region is `auto`.
4. Select **Save the destination**.

Envelopen stores the secret access key encrypted. It never shows the key again. To change the store, select **Change the destination**. To stop the copy, select **Remove**. Each change writes an audit event.

If the S3 copy fails and R2 succeeds, the run shows as partial. The backup in R2 is complete.

## Schedule and retention

Envelopen backs up every day at 02:23 UTC. To turn this off, clear **Back up every day** in **Schedule and retention**, and select **Save the schedule**.

To back up at once, select **Back up now** in the **Backups** card. The run continues in the background, and the list shows its progress.

**Keep backups for (days)** sets the retention period. The default is 14 days, and the range is 1 to 365. Each day, retention deletes older backups from R2 and from the S3 copy. The newest backup in R2 always stays, even when it is older than the period.

The status card shows the last successful backup, the last run, the destinations, and the next daily backup.

## The read budget

A backup reads every row of D1. Workers Free allows 5,000,000 rows read per day. Backups use at most 2,000,000 of these each UTC day, over all runs. The rest stays for the admin app, the public pages, and sends.

When a backup reaches the budget, it waits until a few minutes after 00:00 UTC. Then it continues from where it stopped. A large backup on Workers Free can take more than one day.

One backup holds at most about 1,000,000 rows. Workflows on Workers Free allow 1,024 steps for each run, and each chunk is one step. A larger database fails with "The database has too many rows for one backup."

When D1 is at its daily limit, the daily backup does not start.

## When a backup fails

If the last backup failed, a banner shows on every page of the admin app. It shows the time of the failed run and of the last successful backup. Select **Open the backup settings** to read the error. The banner goes away when a backup succeeds.

If the S3 copy failed, the banner says that the backup reached R2 but its S3 copy failed.

## Download a backup

1. Open **Settings** > **Backups**.
2. In the list of backups, find the backup, and select **Download**.
3. If Envelopen asks you to sign in again, sign in.
4. Save the `.envbak` file in a safe place.

A download is one encrypted `.envbak` file. The download link works for 15 minutes. Each download writes an audit event. The file is encrypted, but it holds the personal data of your contacts. Store it like you store other personal data.

## Restore a backup

A restore works only on a new deployment, before an owner exists. It never overwrites data. To restore, deploy Envelopen again, and restore from the first-run screen.

### Before you restore

- Deploy a new Envelopen. See [Deploy](../../README.md#deploy). The new deployment can have new secrets.
- Use the same Envelopen version as the backup, or a newer one. A restore refuses a backup from a newer version.
- Have the backup passphrase.
- Have the backup. Use one of these sources:
  - A `.envbak` file of at most 95 MB.
  - A backup folder in the R2 bucket of the new deployment. This is the case when you deploy again in the same Cloudflare account and bucket.

If the `.envbak` file is larger than 95 MB, copy the backup folder `backups/<backup-id>/` into the R2 bucket of the new deployment instead. You can copy it from the old R2 bucket or from the S3 copy with an S3 tool such as `rclone`. Keep the same path.

### Steps

1. Open `/setup` on the new deployment.
2. Type the `SETUP_TOKEN` secret in **Setup token**, and select **Check the deployment**.
3. When every check passes, select **Restore a backup**.
4. Under **Backup**, select the source:
   - **Upload a file**: select the `.envbak` file in **Backup file**.
   - **A backup in this deployment's R2 bucket**: select the backup by its date.
5. Type the passphrase in **Backup passphrase**.
6. Select **Start the restore**.

Envelopen checks the passphrase first. This takes a few seconds. A wrong passphrase stops the restore before any write. After five wrong passphrases in one hour, restore is locked for the rest of the hour.

The restore then writes the backup chunk by chunk. The screen shows the progress for each table. You can close the page. The restore continues. To see the progress again, open `/setup` and type the setup token.

### A restore on Workers Free

Workers Free allows 100,000 rows written to D1 each day. A restore keeps 10,000 of these for the deployment. When the restore reaches its budget, the screen shows "Waiting for the reset" and the time it continues. The restore continues after 00:00 UTC from the last chunk that it wrote. **Estimate on Free** shows the number of days.

### After the restore

1. When the screen shows **Restore complete**, select **Go to sign in**.
2. Sign in with the email and password of the old owner. No session is in the backup.
3. If the deployment has a new hostname, sign in with the password. A passkey works only on the hostname where you added it.
4. In your email provider, export the suppression list and the unsubscribe list.
5. In each workspace, open **Contacts** > **Suppression list**, and add these addresses. See [Suppress addresses](import-contacts.md#suppress-addresses).
6. Open **Settings** > **Backups**. The notice **Campaign sends wait for you** shows the age of the backup.
7. Select **I checked. Allow sends**.

Campaign sends stay blocked until you do step 7. A backup does not hold the unsubscribes that came after it. Steps 4 and 5 make sure that you do not email these people again.

The completion screen can show skipped orphan rows. These rows pointed at rows that changed during the backup. The restore leaves them out.

If the restore stops, the screen shows the step that failed. Select **Try again** to start the restore of the same backup again. The rows that went in stay, and the restore continues from there.

## D1 Time Travel or an Envelopen backup

Cloudflare D1 has its own point-in-time restore, Time Travel. Time Travel and Envelopen backups do different jobs.

| | D1 Time Travel | Envelopen backup |
|---|---|---|
| How far back | 7 days on Workers Free, 30 days on Workers Paid | The retention period, 1 to 365 days |
| Where it lives | Inside the same Cloudflare account | R2, an optional S3-compatible store, and downloaded files |
| Restores into | The same database, which it overwrites | A new, empty deployment, in any account |
| Precision | Any minute in the window | The time of each backup |
| Needs | Wrangler and access to the account | The passphrase |

Use D1 Time Travel when:

- A mistake or a failed update damaged the data in the last days.
- The Cloudflare account and the database still exist.

To restore with Time Travel, run this command. Replace `<database-name>` with the `database_name` of the `DB` binding in `wrangler.jsonc`:

```sh
npx wrangler d1 time-travel restore <database-name> --timestamp=<unix-time>
```

The restore overwrites the database. Data that arrived after that time is lost.

Use an Envelopen backup when:

- You lost the Cloudflare account, or the database.
- You move Envelopen to another account.
- You need data older than the Time Travel window.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "No passphrase yet. Backups are off." | No passphrase is set. | Set a passphrase. See [Set the passphrase](#set-the-passphrase). |
| "The key preparation failed." | The key derivation stopped. | Set the passphrase again. |
| Envelopen asks you to sign in again. | Backup actions need a sign-in from the last 10 minutes. | Sign in with the password or the passkey, and do the action again. |
| A backup shows as partial. | The S3 copy failed. The R2 backup is complete. | Read the S3 error in the list. Check the endpoint, the bucket, and the key permissions. |
| A backup runs for more than one day. | The backup reached its daily read budget. | Wait. The backup continues after 00:00 UTC. |
| "The database has too many rows for one backup." | The database has more than about 1,000,000 rows. | Use D1 Time Travel and `wrangler d1 export` for this database. |
| The download link does not work. | The link works for 15 minutes. | Select **Download** again. |
| "This deployment has an owner. Restore only works before setup." | The owner already exists. | Deploy a new, empty Envelopen, and restore there. |
| "This deployment already holds data." | The database is not empty. | Restore into a new deployment with a new D1 database. |
| "The passphrase is not correct" | The passphrase does not open the backup. | Use the passphrase that was set when the backup was made. |
| "Restore is locked after too many wrong passphrases." | Five wrong passphrases in one hour. | Wait one hour, and try again. |
| The file is larger than one upload. | The `.envbak` file is larger than 95 MB. | Copy the backup folder into the R2 bucket of the new deployment, and select the R2 source. |
| "The backup comes from a newer Envelopen." | The new deployment runs an older version. | Update the new deployment, and try again. |
| "The bucket holds no backup." | No folder exists under `backups/` in the R2 bucket. | Upload the `.envbak` file, or copy the backup folder into the bucket. |
| Campaigns do not send after a restore. | Sends wait for the age confirmation. | Suppress the addresses from the provider lists, then select **I checked. Allow sends** in **Settings** > **Backups**. |
| A passkey does not work after a restore. | The new deployment has another hostname. | Sign in with the password, and add a new passkey. |

## Related guides

- [Update Envelopen](updating.md)
- [Cloudflare D1](database-d1.md)
- [Cloudflare Workers platform](cloudflare-platform.md)
- [Import contacts](import-contacts.md)

## Sources

- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)
- [Amazon S3 actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html)

Last checked: 2026-10-21
