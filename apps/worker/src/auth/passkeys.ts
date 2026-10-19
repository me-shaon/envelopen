import { passkey } from "@better-auth/passkey";
import type { AuthContext } from "better-auth";
import { APIError } from "better-auth/api";
import { PBKDF2_MAX_ITERATIONS } from "./pbkdf2-hasher";
import { passkeySchemaOptions } from "./schema-options";

// Passkeys (KTD7). The Better Auth passkey plugin is always installed. Passkey mode is
// the login method when the PBKDF2 count that fits the CPU budget is below the Workers
// maximum: a weaker password hash is then not the only defense.
//
// Without a session, a passkey can be registered only with an enrollment token. The
// first-run screen creates one for the new owner, and setup-token recovery creates one
// to replace a lost passkey. The browser passes it as the `context` of the WebAuthn
// registration, through the plugin's own endpoints:
//
//   GET  /api/auth/passkey/generate-register-options?context=<token>
//   POST /api/auth/passkey/verify-registration   { response, createSession: true }

export type LoginMode = "password" | "passkey";

export function loginModeFor(iterations: number): LoginMode {
  return iterations < PBKDF2_MAX_ITERATIONS ? "passkey" : "password";
}

/** Setup enrolls the first passkey. Recovery replaces every passkey of the owner. */
export type EnrollmentPurpose = "setup" | "recovery";

export const PASSKEY_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const IDENTIFIER_PREFIX = "passkey-enrollment:";

interface EnrollmentValue {
  userId: string;
  purpose: EnrollmentPurpose;
}

async function identifierFor(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return IDENTIFIER_PREFIX + hex;
}

function parseValue(value: string): EnrollmentValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<EnrollmentValue>;
    if (typeof parsed.userId !== "string") return null;
    if (parsed.purpose !== "setup" && parsed.purpose !== "recovery") return null;
    return { userId: parsed.userId, purpose: parsed.purpose };
  } catch {
    return null;
  }
}

/**
 * Creates a single-use enrollment token for a user. The database keeps only its
 * SHA-256 hash, in the Better Auth verification table.
 */
export async function createPasskeyEnrollment(
  context: Pick<AuthContext, "internalAdapter">,
  userId: string,
  purpose: EnrollmentPurpose,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = now + PASSKEY_ENROLLMENT_TTL_MS;
  const identifier = await identifierFor(token);
  // One open enrollment per user is enough. A new one replaces the older ones.
  await context.internalAdapter.createVerificationValue({
    identifier,
    value: JSON.stringify({ userId, purpose } satisfies EnrollmentValue),
    expiresAt: new Date(expiresAt),
  });
  return { token, expiresAt };
}

/** Reads an enrollment without using it up. Returns null when it is unknown or expired. */
export async function findPasskeyEnrollment(
  context: Pick<AuthContext, "internalAdapter">,
  token: string,
  now = Date.now(),
): Promise<EnrollmentValue | null> {
  const row = await context.internalAdapter.findVerificationValue(await identifierFor(token));
  // The adapter returns a Date. A raw value is read the same way.
  if (!row || new Date(row.expiresAt).getTime() <= now) return null;
  return parseValue(row.value);
}

/** Uses up an enrollment. Only the first caller gets the value. */
export async function consumePasskeyEnrollment(
  context: Pick<AuthContext, "internalAdapter">,
  token: string,
): Promise<EnrollmentValue | null> {
  const row = await context.internalAdapter.consumeVerificationValue(await identifierFor(token));
  return row ? parseValue(row.value) : null;
}

/** The passkey plugin for one app origin. */
export function createPasskeyPlugin(origin: string) {
  return passkey({
    rpID: new URL(origin).hostname,
    rpName: "Envelopen",
    origin,
    schema: passkeySchemaOptions,
    registration: {
      // Registration without a session needs an enrollment token (resolveUser).
      requireSession: false,
      async resolveUser({ ctx, context }) {
        if (!context) throw new APIError("UNAUTHORIZED", { message: "Sign in first." });
        const enrollment = await findPasskeyEnrollment(ctx.context, context);
        if (!enrollment) {
          throw new APIError("UNAUTHORIZED", {
            message: "The passkey enrollment link expired. Start again.",
          });
        }
        const user = await ctx.context.internalAdapter.findUserById(enrollment.userId);
        if (!user) throw new APIError("UNAUTHORIZED", { message: "Unknown user." });
        return { id: user.id, name: user.email, displayName: user.name };
      },
      async afterVerification({ ctx, context, user }) {
        // A registration from a signed-in session has no context. Nothing to do.
        if (!context) return;
        const enrollment = await consumePasskeyEnrollment(ctx.context, context);
        if (!enrollment || enrollment.userId !== user.id) {
          throw new APIError("UNAUTHORIZED", {
            message: "The passkey enrollment link expired. Start again.",
          });
        }
        if (enrollment.purpose === "recovery") {
          // The old passkeys may be lost or stolen: the new passkey replaces them,
          // and every existing session ends.
          await ctx.context.adapter.deleteMany({
            model: "passkey",
            where: [{ field: "userId", value: user.id }],
          });
          await ctx.context.internalAdapter.deleteUserSessions(user.id);
        }
        return { userId: user.id };
      },
    },
  });
}
