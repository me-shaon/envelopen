# Brand and templates

This guide explains how to set up the brand kit, how to start a template from the gallery, and how to build an email in the block builder.

## Before you start

- Sign in as the owner.
- Get your logo as a PNG, JPEG, GIF, or WebP file of 1 MB or less. SVG is not accepted.
- Get the postal address of your business. You cannot confirm a campaign without it.
- Get the full `https://` addresses of your social profiles.

## Steps

### Set up the brand kit

1. Open **Brand** in the sidebar.
2. Type the **Brand name**. If you leave it empty, Envelopen uses the workspace name.
3. Select **Upload logo**, and select the file.
4. Set the **Primary color** and the **Accent color**. Use the picker or type a hex color, for example `#4a3c77`.
5. Select the **Font**.
6. Type the **Footer text**, for example why people get your emails.
7. Type the **Postal address**.
8. Under **Social links**, type the full `https://` address of each profile that you want in your emails.
9. Select **Save brand**.

The preview on the right shows a sample email with the values as you type them, before the save.

The fields and their rules:

| Field | Rule |
|---|---|
| **Brand name** | Up to 100 characters. The brand header block shows it. |
| **Logo** | PNG, JPEG, GIF, or WebP, up to 1 MB. Envelopen reads the type from the file content, not from the file name. |
| **Primary color** | A hex color. Buttons, links, and the brand name use it. |
| **Accent color** | A hex color. A second color for buttons and highlights. |
| **Font** | One font from a fixed list of web-safe fonts. |
| **Footer text** | Up to 500 characters. The brand footer block shows it. |
| **Postal address** | Up to 300 characters. Required to confirm a campaign. The brand footer block shows it. |
| **Social links** | Full `https://` addresses for Website, X, LinkedIn, Instagram, Facebook, YouTube, and GitHub. |

The font list: System sans-serif, Helvetica, Arial, Verdana, Tahoma, Trebuchet MS, Georgia, Times New Roman, Palatino, and Courier New. Web fonts are not available, because many mail apps do not load them.

### Logo rules

- A new upload becomes the logo at once. You do not need to select **Save brand**.
- To change the logo, select **Replace logo**. To remove it, select **Remove**.
- Envelopen never deletes a logo file. Sent emails and confirmed campaigns load the logo from its URL, so the old file stays available.
- The logo URL is `/b/<workspace id>/<hash>.<ext>` on your deployment. The response has the stored image type and `X-Content-Type-Options: nosniff`.
- Backups hold the logo files. A restored deployment serves them again.

### Which brand an email uses

| Email | Brand that it uses |
|---|---|
| Template preview, draft campaign, and test send | The live brand kit. A change shows at once. |
| Confirmed campaign | A snapshot of the brand kit at the time of confirm. Later changes to the kit do not change it. |
| Welcome email | The live brand kit at the time of each send. |

A confirmed campaign keeps its logo, colors, font, footer, postal address, and social links. To send a campaign with a new brand, change the kit before you confirm the campaign.

### Postal address and the send checklist

The send checklist has the check **Postal address**. If the brand kit has no postal address, the check fails and you cannot confirm the campaign. Select **Add the postal address in Brand**, add the address, and check the send again. Many anti-spam laws (for example CAN-SPAM) ask for a postal address in each marketing email.

### Brand tokens

A template uses brand tokens. Envelopen replaces each token with the value of the brand kit (or of the campaign snapshot) when it renders the email. The builder adds the tokens for you. In an HTML or Markdown template, type them yourself.

| Token | Value |
|---|---|
| `{{ brand.name }}` | The brand name. |
| `{{ brand.logo_url }}` | The absolute URL of the logo. |
| `{{ brand.color_primary }}` | The primary color. |
| `{{ brand.color_accent }}` | The accent color. |
| `{{ brand.color_on_primary }}` | A text color for the primary color as background: white, dark, or black, with a contrast of 4.5:1 or more. |
| `{{ brand.color_on_accent }}` | A text color for the accent color as background, with a contrast of 4.5:1 or more. |
| `{{ brand.color_primary_text }}` | The primary color for text on white. If the primary color is too light (below 4.5:1), this is a dark text color. |
| `{{ brand.font }}` | The font stack of the font. |
| `{{ brand.footer }}` | The footer text. |
| `{{ brand.address }}` | The postal address. |
| `{{ brand.social.website }}` | The website link. The other networks are `x`, `linkedin`, `instagram`, `facebook`, `youtube`, and `github`. |

A token can have a fallback, for example `{{ brand.name | default: "Our team" }}`. In HTML, Envelopen removes a logo image when there is no logo, and a social link that has no URL.

### Start a template from the gallery

1. Open **Templates**, and select **New template**.
2. In **Start a template**, select a category, or type in **Search templates**.
3. Select a template. The editor opens with its blocks.
4. Change the name, the subject, and the content.
5. Select **Save**.

Each card shows a live preview with your brand kit and the sample name "Ada". To start with an empty email, select **Blank**. Blank has a heading, a paragraph, and the footer.

The gallery has ten templates:

| Template | Category |
|---|---|
| Newsletter | Newsletters |
| Announcement | Announcements |
| Welcome email | Onboarding |
| Product update | Announcements |
| Event invite | Events |
| Weekly digest | Newsletters |
| Plain letter | Newsletters |
| Sale | Promotions |
| Survey | Feedback |
| Re-engagement | Feedback |

The starter email of a welcome series (**Use the starter email**) is the **Welcome email** template. See [Welcome series](welcome-series.md).

### Build an email with blocks

The editor has three parts on a wide screen: the block library on the left, the canvas in the middle, and the **Settings** panel on the right.

To add a block:

1. Select a block in the canvas. The new block goes after it.
2. In the block library, select the block or the section. You can also drag it onto the canvas.

To find a block, type in **Search blocks**. The library has three groups:

- **Blocks**: Text, Heading, Image, Button, Divider, Spacer, Panel, Columns, Social links, Footer, Brand header, Brand footer, and Raw HTML.
- **Sections**: Hero, Text and image, Feature list, Call to action, and Footer. A section is a group of blocks that is ready to use.
- **Saved blocks**: the blocks that you saved in this workspace.

To move a block:

1. Drag the block by its handle on the left side of the block.
2. Alternatively, select the block and press Alt+Shift+Up or Alt+Shift+Down.
3. Alternatively, select **Move up** or **Move down** in the toolbar.

To change a block, select it and use the **Settings** panel. The panel shows the settings of the selected block, for example the link, colors, and alignment of a button. A color setting can use **Brand primary**, **Brand accent**, or a color that you type. A text color can also use **Readable on primary** or **Readable on accent**.

To set the columns of a section:

1. Select a block in the section.
2. In **Settings**, under **Columns**, select 1, 2, or 3.

If you select fewer columns, the content of a removed column moves into the last column. On a phone, the columns show one below the other.

The **Panel** block is a colored box for a headline, text, and a button. Its settings are **Background**, **Padding**, and alignment. The text color follows the background, so the text stays easy to read.

To set the font of the email, use **Email font**. The brand font follows the brand kit.

### Check the email on desktop and mobile

1. Under **Canvas width**, select **Desktop** (600 px) or **Mobile** (375 px).
2. To see the rendered email, select **Preview**.
3. Select **Edit** to go back to the builder.

On a narrow screen, the block library opens as a sheet from the left edge. Select **Add block** in the toolbar, then tap a block to add it after the selected block. Drag is not available in the sheet.

### Save a block

1. Select the block in the canvas.
2. In the block library, select **Save as block**.
3. Type the **Name**, and select **Save block**.

The block shows under **Saved blocks** in every template of the workspace. A template keeps its own copy of the block. If you change or delete a saved block, templates that use it do not change. To delete a saved block, open **Templates** and use the **Saved blocks** table.

## Known issues

- On a narrow screen, stacked columns keep an indent of 12 px on one side. The indent is the gap between columns on a wide screen.
- In the canvas, a **Raw HTML** block shows its code, not the rendered result. To see the result, select **Preview** or send a test.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| "The logo is larger than 1 MB." | The file is too large. | Make the file smaller, and upload it again. |
| The upload of the logo fails. | The file is not PNG, JPEG, GIF, or WebP, or its content does not match its name. SVG always fails. | Export the logo as PNG, and upload it again. |
| The send checklist fails on **Postal address**. | The brand kit has no postal address. | Add the **Postal address** in **Brand**, select **Save brand**, and check the send again. |
| A sent campaign shows the old logo or colors. | The campaign keeps the brand of its confirm time. | Change the brand kit before you confirm the next campaign. |
| A social icon is not in the email. | The brand kit has no link for that network. | Add the `https://` link under **Social links**, and select **Save brand**. |
| A social link is refused. | The link does not start with `https://`. | Type the full `https://` address. |
| A button label is dark on a dark color. | The button uses a fixed text color, not the brand token. | Set the button **Text** color to **Readable on primary** or **Readable on accent**. |

## Related guides

- [Send a test email](test-send.md)
- [Welcome series](welcome-series.md)
- [Back up and restore](backup-and-restore.md)
- [Release checklist](release-checklist.md)

Last checked: 2026-10-22
