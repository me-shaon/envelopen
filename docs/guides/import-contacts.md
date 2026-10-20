# Import contacts

This guide explains how to import contacts from a CSV file, how to suppress addresses, and how to export contacts.

## Before you start

- Sign in as the owner. Select the workspace that gets the contacts.
- Know why you may email these contacts. Envelopen needs one consent basis for each import.
- Optional: create the lists for the contacts. Open **Contacts**, then **Lists**, enter a name in **New list**, and select **Create**.
- Prepare the CSV file:

| Rule | Value |
|---|---|
| Encoding | UTF-8. A byte order mark is accepted. |
| Header row | Required. The first row names the columns. |
| Separator | Comma, semicolon, or tab. Envelopen detects it. |
| Quotes | Standard CSV quotes (RFC 4180). A quoted field can hold separators, quotes (`""`), and line breaks. |
| File size | At most 5 MB. Split a larger file. |
| Columns | At most 100. |
| Row length | At most 64 KB for one row. |
| Rows | At most 100,000 data rows in one file. One import reads 1,000 chunks of 100 rows. |
| Email column | Required. One column must hold the email address. |

An example file:

```csv
email,first_name,last_name,course
ana.silva@example.com,Ana,Silva,Intro to Data
chen@example.com,"Li, Jr.",Chen,Intro to Data
```

## Steps

### Upload the file

1. Open **Contacts**, then select **Import CSV**. (An empty workspace shows **Import a CSV**.) The **Import contacts** page opens.
2. Select **Choose a CSV file**, and pick the file.
3. Envelopen stores the file in R2 and shows the first rows. Nothing is imported yet.

If no import starts, Envelopen deletes the uploaded file after 24 hours.

### Map the columns

1. In **Map the columns**, find each column of the file.
2. In **Import as**, select a target for each column:
   - **Email address**: exactly one column.
   - **First name** and **Last name**: optional. Envelopen keeps the first 100 characters.
   - **Custom field: `<key>`**: stores the value as a custom contact field. The key comes from the column name.
   - **Skip this column**: Envelopen ignores the column.
3. Select **Continue**.

Envelopen trims and lowercases each address before the import.

### Set the consent basis, tags, and lists

1. Under **Why may you email these contacts?**, select one consent basis. It is required.

   | Basis | Use it when |
   |---|---|
   | **Existing customer** | The contacts bought from you or used your service. For example, the students of a course. |
   | **Explicit opt-in** | The contacts asked for your emails, for example through a signup form. |
   | **Unknown** | You do not know. These contacts get only a re-permission campaign. |

2. Optional: in **Tags**, enter tag names separated by commas. Envelopen creates missing tags. The limit is 20 tags.
3. Optional: under **Add to lists**, select the lists. The limit is 20 lists.
4. Select **Preview the import**.

Envelopen stores the basis on each new contact, with the import as the source and the date. It does not lower the basis of an existing contact. If an existing contact has the basis **Unknown**, an import by the owner raises it to the basis that you selected. An import through an API key cannot raise **Unknown**.

### Check the preview

The preview reads the whole file. It writes nothing to the contacts. It shows these counts:

| Count | Meaning |
|---|---|
| **New contacts** | Addresses that are not in the workspace. |
| **Updated** | Addresses that are in the workspace. Envelopen updates the names and adds the tags and lists. |
| **Skipped, unsubscribed** | Contacts that unsubscribed. The import does not subscribe them again. |
| **Skipped, suppressed** | Addresses on the suppression list. |
| **Invalid rows** | Rows with no address or with an address that is not valid. |
| **Duplicates in the file** | Later rows with an address that an earlier row has. |

The preview also estimates the D1 rows that the import writes. Workers Free allows 100,000 rows written each day. If the import reaches the limit, it waits until 00:00 UTC and continues. See [Cloudflare Workers platform](cloudflare-platform.md#d1-rows-written-per-day).

1. Read the counts.
2. If a count is wrong, select **Change settings**, and correct the mapping or the settings.
3. Select **Import N contacts**.

### Finish the import

1. Wait for **Import complete**. The page shows the progress while the import runs.
2. If rows were not imported, select **Download the error file**. The file has the columns `row`, `email`, and `reason`.
3. Select **View contacts**.

Only one import runs at a time in a workspace. Envelopen deletes the uploaded CSV when the import ends. It deletes the error file 24 hours after the import ends.

The reasons in the error file:

| Reason | Meaning |
|---|---|
| No email address | The email cell is empty. |
| Not a valid email address | The address cannot be parsed. |
| Duplicate of an earlier row | An earlier row has the same address. |
| Suppressed | The address is on the suppression list. |
| Unsubscribed | The contact unsubscribed earlier. |

### Suppress addresses

A suppressed address gets no campaign email. Hard bounces and complaints suppress an address automatically. Three soft bounces in 30 days also suppress it.

1. Open **Contacts**, then **Suppression list**.
2. In **Block addresses**, enter the addresses. The limit is 100 addresses at a time.
3. Select **Suppress N addresses**.

An address that is suppressed already keeps its first reason. A contact with a suppressed address stays in the workspace with the status **Suppressed**. Envelopen stores a keyed hash of each suppressed address, so a later import or API call skips it. Only the owner can remove a suppression.

### Export contacts

1. Open **Contacts**.
2. Optional: filter the list, for example with **Status**.
3. Select **Export**.
4. In the dialog, select **Create export**.
5. Select **Download CSV**.

The export holds the contacts that match the filters. Its columns are `email`, `first_name`, `last_name`, `status`, `consent_basis`, `consent_source`, `consent_at`, `source`, `tags`, `lists_subscribed`, `lists_unsubscribed`, `unsubscribed_at`, `created_at`, and one column for each custom field. A cell that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return gets a leading quote, so spreadsheets show it as text. The download link works for 24 hours. Then Envelopen deletes the file.

### Import through the API

The REST API has the same steps: `POST /api/imports`, `POST /api/imports/{id}/preview`, and `POST /api/imports/{id}/start`. The API key needs the `contacts:write` scope. To add contacts one at a time, for example from a course platform, use a key with the **Enrollment sync** preset and `POST /api/contacts`. MCP does not offer CSV import in v1.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "The file is larger than 5 MB." | The file is too large. | Split the file into smaller files, and import each one. |
| "The file has no header row." | The first row is empty. | Add a header row that names the columns. |
| "The file has more than 100 columns." | Too many columns. | Remove the columns that you do not need. |
| "Choose the column that holds the email address." | No column is mapped to **Email address**. | Map one column to **Email address**. |
| "Only one column can be the email address." | Two columns are mapped to **Email address**. | Map one of them to **Skip this column**. |
| "Another import is running. Wait until it ends." | One import runs at a time. | Wait until the other import ends. |
| "A row is longer than 64 KB." | One row is too long, often from a missing closing quote. | Fix the quotes in the file. |
| The upload expired. | No import started within 24 hours. | Upload the file again. |
| The import waits until 00:00 UTC. | The D1 daily write limit on Workers Free. | Wait for the reset, or upgrade to Workers Paid. |
| A contact did not get the new consent basis. | Envelopen does not lower a basis, and an API key cannot raise **Unknown**. | Open the contact, and select **Record consent**. |

## Related guides

- [Cloudflare Workers platform](cloudflare-platform.md)
- [Cloudflare D1](database-d1.md)
- [Send a test email](test-send.md)
- [Connect an MCP client](mcp.md)
