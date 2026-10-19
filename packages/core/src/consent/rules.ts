import type { ConsentBasis } from "@envelopen/db";
import type { Principal } from "../principal";

// Consent rules (R16, R73). Consent history is append-only: every change adds a row
// to consent_events, and no service updates or deletes those rows.
//
// An API key (REST or MCP) cannot change a basis from `unknown` to a stronger basis.
// Only the owner can record that the workspace may now email the contact. Every other
// change is allowed, because it either keeps or lowers what the workspace may send.

export type ConsentDecision = "unchanged" | "apply" | "blocked";

export function consentDecision(
  principal: Principal,
  current: ConsentBasis,
  requested: ConsentBasis | undefined,
): ConsentDecision {
  if (requested === undefined || requested === current) return "unchanged";
  if (current === "unknown" && principal.actorType === "api_key") return "blocked";
  return "apply";
}

/** The warning code that an upsert returns when it kept a basis of `unknown`. */
export const CONSENT_UPGRADE_BLOCKED = "consent_upgrade_blocked";
