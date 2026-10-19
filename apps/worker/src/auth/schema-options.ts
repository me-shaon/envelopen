// The parts of the Better Auth configuration that decide the database schema. The
// runtime instance (better-auth.ts) and the schema generator config (auth.config.ts)
// both use them, so the committed migration matches what the Worker queries.
//
// Better Auth owns its tables. Their names start with `auth_`, so they do not mix with
// the app's `users` table (KTD5). Their columns keep the Better Auth names (camelCase).
// They are global tables (KTD4): none has a workspace_id.

export const AUTH_TABLES = {
  user: "auth_user",
  session: "auth_session",
  account: "auth_account",
  verification: "auth_verification",
  passkey: "auth_passkey",
} as const;

export const authSchemaOptions = {
  user: { modelName: AUTH_TABLES.user },
  session: { modelName: AUTH_TABLES.session },
  account: { modelName: AUTH_TABLES.account },
  verification: { modelName: AUTH_TABLES.verification },
} as const;

export const passkeySchemaOptions = {
  passkey: { modelName: AUTH_TABLES.passkey },
} as const;
