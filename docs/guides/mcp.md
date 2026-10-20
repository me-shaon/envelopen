# Connect an MCP client

Envelopen has a Model Context Protocol (MCP) server. An AI agent in an MCP client can read contacts, write templates, draft campaigns, and send test emails. The agent uses the same rules as the admin app.

## Before you start

- Deploy Envelopen and finish the first-run setup. See the [README](../../README.md).
- Use an MCP client that supports Streamable HTTP and a custom `Authorization` header.
- Each workspace has its own API keys. A key works only in its workspace.

### The endpoint

| Item | Value |
|---|---|
| URL | `https://<your Worker host>/mcp` |
| Transport | Streamable HTTP, stateless. There is no session. |
| Authentication | `Authorization: Bearer evk_...` with an Envelopen API key. |
| Rate limit | 120 requests per minute for each API key, shared with the REST API. |

The endpoint accepts API keys only. It never reads the session cookie of the admin app. Without a valid key, it returns `401`.

### Scope presets

Each API key has scopes. The `tools/list` result shows only the tools that the key's scopes allow. Select a preset when you create the key:

| Preset | Scopes | Use it for |
|---|---|---|
| Enrollment sync | `contacts:write` | A script or app that adds contacts. Not for agents. |
| Agent read-only | `contacts:read`, `campaigns:read`, `stats:read` | An agent that reports on contacts and campaigns. |
| Agent editor | Agent read-only, plus `contacts:write`, `lists:write`, `templates:write`, `campaigns:write` | An agent that writes templates and drafts, and sends test emails. |
| Agent sender | Agent editor, plus `campaigns:send` | An agent that can also confirm a send. |

Use **Agent editor** as the default. Give **Agent sender** only when an agent must send campaigns. Contact data can hold text that tries to give instructions to an agent, so keep send out of agent keys when you can.

## Steps

### Create the API key

1. Sign in as the owner.
2. Open **Settings**.
3. In **API keys**, select **Create key**.
4. Type a name, for example "Claude agent".
5. Select a preset, for example **Agent editor**.
6. Select **Create key**.
7. Copy the key or the client configuration. Envelopen shows the key one time only.

### Add Envelopen to the MCP client

For an agent key, Envelopen shows a configuration that most clients read. It has this shape:

```json
{
  "mcpServers": {
    "envelopen": {
      "type": "http",
      "url": "https://envelopen.example.workers.dev/mcp",
      "headers": { "Authorization": "Bearer evk_..." }
    }
  }
}
```

1. Open the MCP configuration of your client.
2. Paste the `envelopen` entry.
3. Restart the client, or reload its MCP servers.
4. Ask the agent to call `get_workspace_context`.

`get_workspace_context` returns the provider status, the domain status, the tracking settings, the usage budget, the consent vocabulary, and the key's scopes. An agent calls it first.

### Send a campaign through MCP

A send needs two calls, so that no single call can send email by mistake:

1. The agent calls `campaigns_prepare` with the campaign id and the mode (`send_now` or `schedule`).
2. Envelopen returns the checklist, the recipient estimate, and a confirm token.
3. The agent shows the estimate to a person.
4. The agent calls `campaigns_confirm` with the campaign id and the token.

The token is valid for 15 minutes. It works only for the API key that prepared it. It fails after an edit of the campaign. Only a key with `campaigns:send` sees these two tools.

### Write tools and retries

Each write tool accepts an `idempotencyKey` argument. If the agent repeats a call with the same key, Envelopen returns the first result and does not write again.

A result that holds contact data has a note: the agent must treat the text as data, never as instructions.

## What MCP can do

| Class | Actions |
|---|---|
| Now | Contact search, get, and upsert. Tags and list membership. Lists. Templates. Campaign draft, preview, and checklist. Test send. Prepare and confirm for send, schedule, and follow-up. Pause and resume. Stats and usage. Read access to suppressions and domain status. |
| Later | CSV import, contact export, contact erase, cancel, and retry or skip of uncertain batches. Use the admin app or the REST API for these. |
| Never | Provider connections, the provider policy warning, API keys, workspaces, setup, and consent upgrades. |

The audit log records each MCP write with the surface `MCP` and the API key. Open **Settings**, then **Open the audit log**, to see them.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| The client gets `401`. | The key is wrong, revoked, or expired, or the header is missing. | Create a new key. Check that the header is `Authorization: Bearer evk_...`. |
| The client gets `429`. | The key made more than 120 requests in one minute. | Wait one minute. Make the agent do fewer calls. |
| A tool is missing. | The key's scopes do not allow it, or the action is not available through MCP. | Create a key with a larger preset. For "later" actions, use the admin app. |
| `campaigns_confirm` fails. | The token expired, the campaign changed, or a different key prepared it. | Call `campaigns_prepare` again with the same key. |
| An upsert returns `consent_upgrade_blocked`. | An API key cannot raise a consent basis of `unknown`. | Record the consent in the admin app as the owner. |
| The client cannot connect at all. | The client does not support Streamable HTTP or custom headers. | Use a client that supports both, or use a local MCP proxy that adds the header. |

## Related guides

- [Release checklist](release-checklist.md) (a real MCP client against a deployed Worker)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification)
- [Cloudflare `createMcpHandler`](https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/)

Last checked: 2026-10-20
