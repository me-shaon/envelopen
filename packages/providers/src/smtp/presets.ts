import type { ProviderPreset } from "../types";

// The presets of the SMTP adapter (U18, R25, R26, R29). A preset fixes the host, the
// port, and the TLS mode, and carries the default daily cap, the policy warning, and
// the webhook. The limits come from the providers' own pages (checked 2026-10-22):
//
// - Gmail: 500 recipients per day for a personal account.
//   https://support.google.com/mail/answer/22839
// - Google Workspace: 2,000 messages per day per user.
//   https://support.google.com/a/answer/166852
// - Brevo: the free plan sends 300 emails per day.
//   https://www.brevo.com/pricing/
//
// The cap is stored with the connection. U19 enforces it.

export type SmtpPresetId = "gmail" | "workspace" | "brevo" | "custom";

export const SMTP_PRESET_IDS: readonly SmtpPresetId[] = ["gmail", "workspace", "brevo", "custom"];

export const GMAIL_DAILY_CAP = 500;
export const WORKSPACE_DAILY_CAP = 2_000;
export const BREVO_FREE_DAILY_CAP = 300;

const GOOGLE_APP_PASSWORDS = "https://myaccount.google.com/apppasswords";
const GOOGLE_APP_PASSWORD_HELP = "https://support.google.com/accounts/answer/185833";
const GMAIL_LIMITS = "https://support.google.com/mail/answer/22839";
const WORKSPACE_LIMITS = "https://support.google.com/a/answer/166852";
const GOOGLE_SENDER_GUIDELINES = "https://support.google.com/a/answer/81126";
const BREVO_PRICING = "https://www.brevo.com/pricing/";
const BREVO_SMTP_KEYS = "https://app.brevo.com/settings/keys/smtp";

/** The R29 warning of the Gmail preset. The owner accepts it before the first campaign. */
export const GMAIL_POLICY_WARNING =
  "A personal Gmail account is for personal email. Google can lock an account that sends " +
  "bulk email, and recipients see your Gmail address. Gmail sends at most 500 messages a " +
  "day. Use it only for a small list that asked for your email.";

/** The R29 warning of the Google Workspace preset. */
export const WORKSPACE_POLICY_WARNING =
  "Google Workspace accounts are for business email, not bulk email. Google can suspend " +
  "sending for an account that sends to many recipients or gets many complaints. " +
  "Workspace sends at most 2,000 messages a day per user. Use it only for a small list " +
  "that asked for your email.";

const NO_BOUNCES =
  "This connection has no provider webhook, so Envelopen gets no bounce or complaint events. Bounces arrive as emails in the sender's inbox.";

const GOOGLE_FIELDS: ProviderPreset["fieldHints"] = {
  username: {
    label: "Google account address",
    placeholder: "you@gmail.com",
  },
  password: {
    label: "App password",
    hint: "A 16-character app password from your Google account, not your normal password. It needs 2-Step Verification.",
    placeholder: "abcd efgh ijkl mnop",
  },
};

export const SMTP_PRESETS: readonly ProviderPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Send from a personal Gmail address through smtp.gmail.com.",
    fixed: { host: "smtp.gmail.com", port: "587", security: "starttls" },
    fieldHints: GOOGLE_FIELDS,
    defaultDailyCap: GMAIL_DAILY_CAP,
    capSource: { label: "Gmail sending limits", url: GMAIL_LIMITS },
    policyWarning: GMAIL_POLICY_WARNING,
    notes: [
      "Google requires an app password for SMTP. Turn on 2-Step Verification, then create one.",
      NO_BOUNCES,
    ],
    links: [
      { label: "Create an app password", url: GOOGLE_APP_PASSWORDS },
      { label: "About app passwords", url: GOOGLE_APP_PASSWORD_HELP },
      { label: "Gmail sending limits", url: GMAIL_LIMITS },
    ],
    webhook: false,
  },
  {
    id: "workspace",
    label: "Google Workspace",
    description: "Send from a Google Workspace address through smtp.gmail.com.",
    fixed: { host: "smtp.gmail.com", port: "587", security: "starttls" },
    fieldHints: {
      ...GOOGLE_FIELDS,
      username: { label: "Workspace address", placeholder: "you@example.com" },
    },
    defaultDailyCap: WORKSPACE_DAILY_CAP,
    capSource: { label: "Google Workspace sending limits", url: WORKSPACE_LIMITS },
    policyWarning: WORKSPACE_POLICY_WARNING,
    notes: [
      "Google requires an app password for SMTP, unless your admin turned app passwords off.",
      NO_BOUNCES,
    ],
    links: [
      { label: "Create an app password", url: GOOGLE_APP_PASSWORDS },
      { label: "Workspace sending limits", url: WORKSPACE_LIMITS },
      { label: "Google sender guidelines", url: GOOGLE_SENDER_GUIDELINES },
    ],
    webhook: false,
  },
  {
    id: "brevo",
    label: "Brevo",
    description: "Send through the Brevo SMTP relay, with bounce and complaint webhooks.",
    fixed: { host: "smtp-relay.brevo.com", port: "587", security: "starttls" },
    fieldHints: {
      username: {
        label: "SMTP login",
        hint: "The login on the SMTP & API page of Brevo, usually your Brevo account address.",
        placeholder: "you@example.com",
      },
      password: {
        label: "SMTP key",
        hint: "An SMTP key from the SMTP & API page of Brevo. It is not your Brevo password or an API key.",
        placeholder: "xsmtpsib-...",
      },
    },
    defaultDailyCap: BREVO_FREE_DAILY_CAP,
    capSource: { label: "Brevo plans", url: BREVO_PRICING },
    policyWarning: null,
    notes: [
      "The default cap is the daily limit of Brevo's free plan. Set the limit of your Brevo plan.",
      "After you connect, add the Brevo webhook so bounces, complaints, and unsubscribes reach Envelopen.",
    ],
    links: [
      { label: "Brevo SMTP keys", url: BREVO_SMTP_KEYS },
      { label: "Brevo plans", url: BREVO_PRICING },
    ],
    webhook: true,
  },
  {
    id: "custom",
    label: "Custom SMTP",
    description: "Any SMTP server that accepts STARTTLS on 587 or implicit TLS on 465.",
    fixed: {},
    fieldHints: {},
    defaultDailyCap: null,
    capSource: null,
    policyWarning: null,
    notes: [
      "Port 25 is not supported. Use 587 with STARTTLS or 465 with implicit TLS.",
      NO_BOUNCES,
    ],
    links: [],
    webhook: false,
  },
];

export function smtpPreset(id: string | undefined): ProviderPreset | undefined {
  return SMTP_PRESETS.find((preset) => preset.id === id);
}
