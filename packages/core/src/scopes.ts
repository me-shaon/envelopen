// Scopes from the plan's "API key scopes" table. The service layer checks them (KTD10).

/** Scopes that an API key can carry. */
export const API_KEY_SCOPES = [
  "contacts:read",
  "contacts:write",
  "contacts:export",
  "contacts:delete",
  "lists:write",
  "templates:write",
  "campaigns:read",
  "campaigns:write",
  "campaigns:send",
  "stats:read",
] as const;

/**
 * Scopes that only the owner's session has. No API key can carry them. They cover what
 * the plan keeps away from keys: workspace management, provider connections, the policy
 * warning, API keys, setup, and the audit log.
 */
export const SESSION_ONLY_SCOPES = ["workspace:admin"] as const;

export const ALL_SCOPES = [...API_KEY_SCOPES, ...SESSION_ONLY_SCOPES] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export type SessionOnlyScope = (typeof SESSION_ONLY_SCOPES)[number];
export type Scope = (typeof ALL_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Readonly<Record<Scope, string>> = {
  "contacts:read": "Read contacts, tags, and list membership.",
  "contacts:write": "Upsert contacts, tags, and list membership. No consent upgrade from unknown.",
  "contacts:export": "Export contacts.",
  "contacts:delete": "Erase contacts.",
  "lists:write": "Manage lists, tags, and custom fields.",
  "templates:write": "Manage templates.",
  "campaigns:read": "Read campaign drafts, previews, and checklists.",
  "campaigns:write": "Edit campaign drafts and send test emails.",
  "campaigns:send": "Prepare and confirm sends. Pause, resume, cancel, retry, or skip batches.",
  "stats:read":
    "Read campaign stats, usage, suppressions, and read-only provider and domain status.",
  "workspace:admin":
    "Owner session only. Workspace management, provider connections, API keys, and the audit log.",
};

const API_KEY_SCOPE_SET: ReadonlySet<string> = new Set(API_KEY_SCOPES);
const ALL_SCOPE_SET: ReadonlySet<string> = new Set(ALL_SCOPES);

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && API_KEY_SCOPE_SET.has(value);
}

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && ALL_SCOPE_SET.has(value);
}

const AGENT_READ_ONLY: readonly ApiKeyScope[] = ["contacts:read", "campaigns:read", "stats:read"];
const AGENT_EDITOR: readonly ApiKeyScope[] = [
  ...AGENT_READ_ONLY,
  "contacts:write",
  "lists:write",
  "templates:write",
  "campaigns:write",
];

/**
 * Scope presets for new API keys (U4 shows them). Send stays out of every preset
 * except "Agent sender", so a default agent key cannot send.
 */
export const API_KEY_PRESETS = {
  enrollment_sync: { label: "Enrollment sync", scopes: ["contacts:write"] },
  agent_read_only: { label: "Agent read-only", scopes: AGENT_READ_ONLY },
  agent_editor: { label: "Agent editor", scopes: AGENT_EDITOR },
  agent_sender: { label: "Agent sender", scopes: [...AGENT_EDITOR, "campaigns:send"] },
} as const satisfies Record<string, { label: string; scopes: readonly ApiKeyScope[] }>;
