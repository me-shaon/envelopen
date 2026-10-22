// Starts a local Envelopen demo with sample data: `pnpm demo`.
//
//   node scripts/demo.mjs [--reset] [--port <port>]
//
// - Builds the admin app, then starts `wrangler dev` with its own state in .wrangler/demo,
//   so it never touches the `pnpm dev` data in .wrangler/state.
// - Makes its own random secrets and keeps them in .wrangler/demo/secrets.json (mode 600),
//   so a restart keeps sessions, tracking links, and unsubscribe links valid. wrangler
//   reads them from .wrangler/demo/demo.vars (mode 600), not from its command line.
// - Sends every provider and DNS request to the local provider mock
//   (apps/web/e2e/provider-mock.mjs). No email leaves this computer, and nothing reaches
//   Cloudflare.
// - On the first start, seeds the demo through the real HTTP API: the owner, a Resend
//   connection, a verified domain, contacts, lists, tags, templates, and campaigns. The
//   stats come from real pixel and click requests to the links of the sent emails, and
//   from signed provider webhooks.
// - Runs the per-minute cron while it runs. Some opens and clicks of the sample campaigns
//   arrive over the first two hours, so the hourly charts fill in.
//
// --reset deletes the demo state and seeds again.
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadSecrets, writeVarsFile } from "./demo/secrets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEMO_DIR = join(ROOT, ".wrangler", "demo");
const STATE_DIR = join(DEMO_DIR, "state");
const SECRETS_FILE = join(DEMO_DIR, "secrets.json");
/** The secrets for `wrangler dev --env-file`, written before each start. */
const VARS_FILE = join(DEMO_DIR, "demo.vars");
const SEED_FILE = join(DEMO_DIR, "seed.json");
const PENDING_FILE = join(DEMO_DIR, "pending-events.json");
const LOG_FILE = join(DEMO_DIR, "wrangler.log");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const VITE = join(ROOT, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const MOCK = join(ROOT, "apps", "web", "e2e", "provider-mock.mjs");

const OWNER = { name: "Dana Demo", email: "demo@example.com", password: "envelopen-demo" };
const WORKSPACE = "Acme Demo";
const DOMAIN = "mail.example.com";
const FROM = { name: "Acme", email: `news@${DOMAIN}` };
/** The signing secret that the provider mock returns when Envelopen creates the webhook. */
const RESEND_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const CRON_INTERVAL_MS = 60_000;
/** Clicks sooner than this after the send count as a link scanner's (KTD29). */
const BOT_WINDOW_MS = 30_000;

const BROWSERS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
];

// ---------------------------------------------------------------------------------------
// Arguments and state
// ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const portArg = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : null;
if (portArg !== null && !(Number.isInteger(portArg) && portArg > 0 && portArg < 65536)) {
  fail("Usage: pnpm demo [--reset] [--port <port>]");
}
for (const arg of args) {
  if (arg.startsWith("--") && arg !== "--reset" && arg !== "--port") {
    fail(`Unknown option ${arg}. Usage: pnpm demo [--reset] [--port <port>]`);
  }
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`- ${message}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

if (reset && existsSync(DEMO_DIR)) {
  step("Deleting the demo data (--reset)");
  rmSync(DEMO_DIR, { recursive: true, force: true });
} else if (existsSync(DEMO_DIR) && !existsSync(SEED_FILE)) {
  // An earlier seed stopped part way. A partial seed cannot continue, so start again.
  step("The last seed did not finish. Deleting the demo data and seeding again");
  rmSync(DEMO_DIR, { recursive: true, force: true });
}
mkdirSync(DEMO_DIR, { recursive: true });

const secrets = loadSecrets(SECRETS_FILE, () => ({
  SETUP_TOKEN: randomBytes(32).toString("hex"),
  SIGNING_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
}));
const seeded = existsSync(SEED_FILE);

// ---------------------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------------------

const children = new Set();
let stopping = false;
let cronTimer = null;

function track(child, name) {
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`\n${name} stopped (exit code ${code}). See ${LOG_FILE}.`);
      void stop(1);
    }
  });
  return child;
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (cronTimer) clearInterval(cronTimer);
  const exits = [...children].map((child) => new Promise((resolve) => child.once("exit", resolve)));
  for (const child of children) child.kill("SIGTERM");
  const timeout = sleep(5000).then(() => {
    for (const child of children) child.kill("SIGKILL");
  });
  await Promise.race([Promise.all(exits), timeout]);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!stopping) console.log("\nStopping the demo.");
    void stop(0);
  });
}

const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
/** The Worker URL and the provider mock URL. `main` sets them. */
let BASE = "";
let MOCK_ORIGIN = "";

/** Runs the Worker's scheduled handler once, as the per-minute cron does when deployed. */
async function runCron() {
  try {
    await fetch(`${BASE}/cdn-cgi/local/scheduled`);
  } catch {
    // The next run tries again.
  }
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await isFree(port)) return port;
  }
  return fail(`No free port from ${start} to ${start + 99}.`);
}

async function waitFor(url, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (stopping) return;
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  console.error(`\n${label} did not start in ${timeoutMs / 1000} seconds. See ${LOG_FILE}.`);
  await stop(1);
}

// ---------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// HTTP client for the seed
// ---------------------------------------------------------------------------------------

const cookies = new Map();
let workspaceId = null;

async function api(method, path, body, options = {}) {
  const headers = { Origin: BASE, Accept: "application/json" };
  if (cookies.size > 0) {
    headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  if (workspaceId !== null) headers["X-Envelopen-Workspace"] = String(workspaceId);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // A retry with the same key never runs a write twice (R58).
  if (method === "POST") headers["Idempotency-Key"] = randomUUID();
  const url = path.startsWith("/") ? `${BASE}${path}` : path;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(500 * attempt);
      continue;
    }
    if (options.allow?.includes(res.status)) return null;
    throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 500)}`);
  }
}

/** Runs `task` for each item, at most `size` at a time. */
async function pool(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// A fixed seed, so every demo has the same contacts and the same numbers.
let randomState = 20261020;
function random() {
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (probability) => random() < probability;
const pick = (items) => items[Math.floor(random() * items.length)];

// ---------------------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------------------

const FIRST_NAMES = (
  "Ada Grace Alan Linus Margaret Ken Barbara Dennis Frances Edsger Hedy Tim Radia " +
  "Vint Katherine Donald Annie John Sophie Guido Shafi Leslie Anita Brian Joan " +
  "Bjarne Mary Niklaus Lynn Yuki Carol James Evelyn Rasmus Adele Larry Jean Ward " +
  "Ida Rob"
).split(" ");
const LAST_NAMES = (
  "Lovelace Hopper Turing Torvalds Hamilton Thompson Liskov Ritchie Allen Dijkstra " +
  "Lamarr Berners Perlman Cerf Johnson Knuth Easley McCarthy Wilson Rossum " +
  "Goldwasser Lamport Borg Kernighan Clarke Stroustrup Keller Wirth Conway " +
  "Matsumoto Shaw Gosling Boyd Lerdorf Goldberg Wall Sammet Cunningham Rhodes Pike"
).split(" ");
const COMPANIES = (
  "Northwind Traders|Globex|Initech|Umbrella Labs|Stark Studio|Wayne Supply|Hooli|" +
  "Vandelay Imports|Soylent Foods|Tyrell Systems|Wonka Works|Pied Piper|" +
  "Aperture Labs|Blue Sun|Gringotts Finance|Oceanic Air"
).split("|");
const CITIES =
  "Berlin Lisbon Toronto Austin Dhaka Nairobi Melbourne Oslo Seoul Bogota Dublin Kyoto".split(" ");
const CONTACT_COUNT = 240;

function sampleContacts() {
  const seen = new Set();
  const contacts = [];
  while (contacts.length < CONTACT_COUNT) {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const domain = chance(0.7) ? "example.com" : "example.org";
    const base = `${firstName}.${lastName}`.toLowerCase();
    let email = `${base}@${domain}`;
    for (let n = 2; seen.has(email); n += 1) email = `${base}${n}@${domain}`;
    seen.add(email);
    const roll = random();
    const plan = roll < 0.35 ? "free" : roll < 0.65 ? "starter" : roll < 0.9 ? "pro" : "business";
    const tags = [];
    if (plan !== "free") tags.push("Customer");
    else if (chance(0.5)) tags.push("Trial");
    if (plan === "business" || chance(0.06)) tags.push("VIP");
    if (chance(0.2)) tags.push("Webinar: October");
    const consent = random();
    contacts.push({
      email,
      firstName,
      lastName,
      // Contacts with an unknown consent basis get re-permission campaigns only.
      consentBasis:
        consent < 0.7 ? "explicit_opt_in" : consent < 0.95 ? "existing_customer" : "unknown",
      fields: { company: pick(COMPANIES), city: pick(CITIES), plan },
      tags,
      lists: {
        newsletter: chance(0.85),
        product: chance(0.55),
        beta: chance(0.12),
      },
    });
  }
  return contacts;
}

const FOOTER = `<p style="margin-top:32px;font-size:12px;color:#6b7280">You get this email because you signed up at example.com.<br>Acme Demo, 1 Example Street, Example City.<br><a href="{{ unsubscribe_url }}" style="color:#6b7280">Unsubscribe or change your preferences</a></p>`;
const STYLE = "font-family:Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.5";

const TEMPLATES = {
  newsletter: {
    name: "Monthly newsletter",
    subject: "The Acme monthly",
    preheader: "Faster exports, a customer story, and office hours",
    format: "html",
    source: `<html><body style="margin:0;padding:24px;background:#f7f5f2"><div style="max-width:600px;margin:0 auto;background:#ffffff;padding:32px;border-radius:12px;${STYLE}">
<h1 style="font-size:22px;margin:0 0 16px">The Acme monthly</h1>
<p>Hi {{ first_name | default: "there" }},</p>
<p>Here is what changed at Acme this month.</p>
<h2 style="font-size:17px;margin:24px 0 4px">Exports are ten times faster</h2>
<p>Large exports now finish in seconds. <a href="https://example.com/blog/faster-exports">Read how we did it</a>.</p>
<h2 style="font-size:17px;margin:24px 0 4px">How Northwind Traders cut churn</h2>
<p>A short story about onboarding emails that people read. <a href="https://example.com/customers/northwind">Read the story</a>.</p>
<h2 style="font-size:17px;margin:24px 0 4px">Office hours on Thursday</h2>
<p>Bring your questions to the team. <a href="https://example.com/events/office-hours">Save a seat</a>.</p>
${FOOTER}
</div></body></html>`,
  },
  announcement: {
    name: "Product announcement",
    subject: "New in Acme",
    preheader: "A new feature is ready for you",
    format: "html",
    source: `<html><body style="margin:0;padding:24px;background:#f7f5f2"><div style="max-width:600px;margin:0 auto;background:#ffffff;padding:32px;border-radius:12px;${STYLE}">
<p style="font-size:13px;color:#6b7280;margin:0">Product update</p>
<h1 style="font-size:24px;margin:4px 0 16px">Smart segments are here</h1>
<p>Hi {{ first_name | default: "there" }},</p>
<p>Segments now update themselves. Pick the rules once, and every campaign goes to the right people.</p>
<p style="margin:28px 0"><a href="https://example.com/changelog/smart-segments" style="background:#2f6f5e;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">See what is new</a></p>
<p>Want the details first? <a href="https://example.com/docs/segments">Read the guide</a>.</p>
${FOOTER}
</div></body></html>`,
  },
};

// ---------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------

async function seed() {
  step("Creating the owner and the workspace");
  const owner = await api("POST", "/api/setup/owner", {
    token: secrets.SETUP_TOKEN,
    email: OWNER.email,
    name: OWNER.name,
    workspaceName: WORKSPACE,
    password: OWNER.password,
  });
  await api("POST", "/api/auth/sign-in/email", {
    email: OWNER.email,
    password: OWNER.password,
  });
  workspaceId = owner.workspaceId;

  step("Connecting Resend (mock) and verifying mail.example.com");
  const connection = await api("POST", "/api/connections", {
    provider: "resend",
    name: "Resend",
    credentials: { apiKey: "re_demo_key_123456" },
  });
  const domain = await api("POST", "/api/domains", { domain: DOMAIN });
  if (domain.status !== "verified") throw new Error(`The domain is ${domain.status}.`);

  step("Creating lists and tags");
  const lists = {
    newsletter: await api("POST", "/api/lists", {
      name: "Newsletter",
      description: "The monthly newsletter.",
    }),
    product: await api("POST", "/api/lists", {
      name: "Product updates",
      description: "New features and changes.",
    }),
    beta: await api("POST", "/api/lists", {
      name: "Beta testers",
      description: "People who try features early.",
    }),
  };
  const tags = {};
  for (const name of ["Customer", "Trial", "VIP", "Webinar: October"]) {
    tags[name] = await api("POST", "/api/tags", { name });
  }

  const contacts = sampleContacts();
  step(`Creating ${contacts.length} contacts`);
  const upsert = (contact) =>
    api("POST", "/api/contacts", {
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      consentBasis: contact.consentBasis,
      fields: contact.fields,
      tags: contact.tags,
      listIds: Object.entries(contact.lists)
        .filter(([, member]) => member)
        .map(([key]) => lists[key].id),
    });
  // The first contact creates the custom fields, so the parallel requests do not race.
  const [first, ...rest] = contacts;
  const created = [await upsert(first), ...(await pool(rest, 6, upsert))];
  contacts.forEach((contact, index) => {
    contact.id = created[index].contact.id;
  });

  step("Unsubscribing and suppressing a few contacts");
  const sendable = contacts.filter((contact) => contact.consentBasis !== "unknown");
  for (const contact of sendable.slice(10, 15)) {
    await api("PATCH", `/api/contacts/${contact.id}`, { unsubscribe: true });
  }
  await api("POST", "/api/suppressions", {
    emails: sendable.slice(20, 23).map((contact) => contact.email),
  });

  step("Setting the brand kit");
  await api("PUT", "/api/brand", {
    name: "Acme Demo",
    colorPrimary: "#4b3f8f",
    colorAccent: "#e39a78",
    font: "system",
    footer: "You get this email because you joined the Acme Demo list.",
    address: "Acme Demo, 1 Example Street, Example City",
    social: { website: "https://example.com" },
  });

  step("Creating two templates and sending a test to the owner");
  const newsletter = await api("POST", "/api/templates", TEMPLATES.newsletter);
  const announcement = await api("POST", "/api/templates", TEMPLATES.announcement);
  await api("POST", "/api/test-sends", {
    to: [OWNER.email],
    from: FROM.email,
    fromName: FROM.name,
    templateId: newsletter.id,
  });

  const sent = [];
  sent.push(
    await sendCampaign({
      name: "September newsletter",
      templateId: newsletter.id,
      subject: "The Acme monthly: September",
      preheader: TEMPLATES.newsletter.preheader,
      audience: { listIds: [lists.newsletter.id] },
      rates: { open: 0.48, click: 0.3, bounceHard: 0.012, bounceSoft: 0.01, complaint: 1 },
    }),
  );
  sent.push(
    await sendCampaign({
      name: "Launch: smart segments",
      templateId: announcement.id,
      subject: "Smart segments are here",
      preheader: "Segments that update themselves",
      audience: { listIds: [lists.product.id], excludeTagIds: [tags.Trial.id] },
      rates: { open: 0.41, click: 0.36, bounceHard: 0.008, bounceSoft: 0.008, complaint: 0 },
    }),
  );

  step("Sending delivery and bounce events from the provider");
  const hook = `${BASE}/hooks/resend/${workspaceId}/${connection.id}`;
  for (const campaign of sent) await sendProviderEvents(hook, campaign);

  step("Opening the sample emails");
  const pending = [];
  for (const campaign of sent) pending.push(...(await openAndClick(campaign, "opens")));

  // A click this soon after the send counts as a link scanner's, so wait for the window.
  const last = Math.max(...sent.map((campaign) => campaign.finishedAt));
  const wait = last + BOT_WINDOW_MS + 3000 - Date.now();
  if (wait > 0) {
    step(`Waiting ${Math.ceil(wait / 1000)} seconds, so the clicks count as people's clicks`);
    await sleep(wait);
  }
  step("Clicking links and unsubscribing a few recipients");
  for (const campaign of sent) pending.push(...(await openAndClick(campaign, "clicks")));
  writeJson(
    PENDING_FILE,
    pending.sort((a, b) => a.at - b.at),
  );

  step("Creating a draft campaign and a scheduled campaign");
  await api("POST", "/api/campaigns", {
    name: "October newsletter",
    templateId: newsletter.id,
    subject: "The Acme monthly: October",
    preheader: TEMPLATES.newsletter.preheader,
    fromName: FROM.name,
    fromEmail: FROM.email,
    audience: { listIds: [lists.newsletter.id] },
  });
  const scheduled = await api("POST", "/api/campaigns", {
    name: "Webinar invite: deliverability basics",
    templateId: announcement.id,
    subject: "Join us: deliverability basics",
    preheader: "A free 45-minute session",
    fromName: FROM.name,
    fromEmail: FROM.email,
    audience: { tagIds: [tags["Webinar: October"].id] },
  });
  const inThreeDays = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const scheduleAt = inThreeDays - (inThreeDays % (60 * 60 * 1000)) + 15 * 60 * 1000;
  const prepared = await api("POST", `/api/campaigns/${scheduled.id}/prepare`, {
    mode: "schedule",
    scheduledAt: scheduleAt,
  });
  if (!prepared.token) throw new Error(`Cannot schedule: ${failures(prepared)}`);
  await api("POST", `/api/campaigns/${scheduled.id}/confirm`, { token: prepared.token });

  step("Creating an API key");
  await api("POST", "/api/api-keys", { name: "CRM sync", preset: "enrollment_sync" });

  writeJson(SEED_FILE, {
    seededAt: new Date().toISOString(),
    owner: OWNER.email,
    workspaceId,
    contacts: contacts.length,
    campaigns: sent.map((campaign) => ({ id: campaign.id, name: campaign.name })),
  });
}

function failures(prepared) {
  return prepared.checklist
    .filter((item) => item.status === "fail")
    .map((item) => `${item.label ?? item.id}: ${item.detail ?? ""}`)
    .join("; ");
}

async function mockSent() {
  return (await fetch(`${MOCK_ORIGIN}/sent`)).json();
}

/** Creates, confirms, and sends a campaign, then waits until it shows Sent. */
async function sendCampaign(spec) {
  step(`Sending the campaign "${spec.name}" through the mock`);
  const before = new Set((await mockSent()).map((email) => email.id));
  const campaign = await api("POST", "/api/campaigns", {
    name: spec.name,
    templateId: spec.templateId,
    subject: spec.subject,
    preheader: spec.preheader,
    fromName: FROM.name,
    fromEmail: FROM.email,
    audience: spec.audience,
  });
  const prepared = await api("POST", `/api/campaigns/${campaign.id}/prepare`, {
    mode: "send_now",
  });
  if (!prepared.token) throw new Error(`Cannot send: ${failures(prepared)}`);
  await api("POST", `/api/campaigns/${campaign.id}/confirm`, { token: prepared.token });

  // The cron changes the campaign to Sent after the last batch.
  const until = Date.now() + 180_000;
  let detail = null;
  while (Date.now() < until) {
    await sleep(2000);
    await runCron();
    detail = await api("GET", `/api/campaigns/${campaign.id}`);
    if (detail.status === "sent") break;
    if (["paused", "needs_decision", "cancelled"].includes(detail.status)) {
      throw new Error(`The campaign "${spec.name}" is ${detail.status}.`);
    }
  }
  if (detail?.status !== "sent") throw new Error(`The campaign "${spec.name}" did not finish.`);
  const emails = (await mockSent()).filter(
    (email) => !before.has(email.id) && !email.subject.startsWith("[Test]"),
  );
  return { ...spec, id: campaign.id, finishedAt: Date.now(), recipients: plan(emails, spec.rates) };
}

const decode = (url) => url.replaceAll("&amp;", "&");
/** The path and query of a link in an email. The links name the https app host. */
const localPath = (url) => {
  const parsed = new URL(decode(url));
  return `${parsed.pathname}${parsed.search}`;
};

/** Decides once, with the fixed seed, what each recipient does. */
function plan(emails, rates) {
  let complaints = rates.complaint;
  let unsubscribes = 2;
  return emails.map((email) => {
    const pixel = /src="([^"]+\/t\/o\/[^"]+)"/.exec(email.html)?.[1];
    // The honeypot link is /t/h/, so this pattern leaves it out.
    const links = [...email.html.matchAll(/href="([^"]+\/t\/c\/[^"]+)"/g)].map((m) => m[1]);
    const unsubscribe = email.headers?.["List-Unsubscribe"]?.slice(1, -1);
    const recipient = {
      to: email.to[0],
      messageId: email.id,
      pixel: pixel ? localPath(pixel) : null,
      links: links.map(localPath),
      unsubscribe: unsubscribe ? localPath(unsubscribe) : null,
      outcome: "delivered",
      opens: 0,
      clicks: [],
      machineOpen: false,
      unsubscribes: false,
      agent: pick(BROWSERS),
    };
    const roll = random();
    if (roll < rates.bounceHard) recipient.outcome = "bounce_hard";
    else if (roll < rates.bounceHard + rates.bounceSoft) recipient.outcome = "bounce_soft";
    if (recipient.outcome !== "delivered") return recipient;
    recipient.machineOpen = chance(0.07);
    if (chance(rates.open)) {
      recipient.opens = chance(0.25) ? 2 : 1;
      if (chance(rates.click) && recipient.links.length > 0) {
        // People click the first link most.
        const first = random() < 0.55 ? 0 : 1 + Math.floor(random() * (recipient.links.length - 1));
        recipient.clicks.push(Math.min(first, recipient.links.length - 1));
        if (chance(0.2) && recipient.links.length > 1) {
          recipient.clicks.push((recipient.clicks[0] + 1) % recipient.links.length);
        }
      } else if (unsubscribes > 0 && chance(0.1)) {
        unsubscribes -= 1;
        recipient.unsubscribes = true;
      } else if (complaints > 0 && chance(0.1)) {
        complaints -= 1;
        recipient.outcome = "complaint";
      }
    }
    return recipient;
  });
}

function svixHeaders(id, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(RESEND_SECRET.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

/** Signed Resend webhooks: delivered for most, bounces and a complaint for a few. */
async function sendProviderEvents(hook, campaign) {
  const events = [];
  for (const recipient of campaign.recipients) {
    const data = { email_id: recipient.messageId, to: [recipient.to] };
    if (recipient.outcome === "bounce_hard" || recipient.outcome === "bounce_soft") {
      const permanent = recipient.outcome === "bounce_hard";
      events.push({
        type: "email.bounced",
        data: {
          ...data,
          bounce: permanent
            ? { type: "Permanent", subType: "General" }
            : { type: "Transient", subType: "MailboxFull" },
        },
      });
      continue;
    }
    events.push({ type: "email.delivered", data });
    if (recipient.outcome === "complaint") events.push({ type: "email.complained", data });
  }
  await pool(events, 6, async (event) => {
    const body = JSON.stringify({ ...event, created_at: new Date().toISOString() });
    const res = await fetch(hook, {
      method: "POST",
      headers: svixHeaders(`msg_${randomUUID()}`, body),
      body,
    });
    if (!res.ok) throw new Error(`The webhook answered ${res.status}: ${await res.text()}`);
  });
}

/**
 * One tracking request, as a mail client or a browser sends it. `HEAD` opens count as
 * machine opens (KTD29). Clicks do not follow the redirect, so no request leaves this
 * computer.
 */
async function hit(event) {
  const url = `${BASE}${event.path}`;
  if (event.kind === "unsubscribe") {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
    });
    return;
  }
  const res = await fetch(url, {
    method: event.kind === "machine_open" ? "HEAD" : "GET",
    headers: { "user-agent": event.agent ?? BROWSERS[0], accept: "*/*" },
    redirect: "manual",
  });
  await res.arrayBuffer();
}

/**
 * The opens (phase "opens") or the clicks and unsubscribes (phase "clicks") of one
 * campaign. About 60 percent happen now. The rest go into the pending list, spread over
 * the next two hours, and the cron loop sends them when they are due.
 */
async function openAndClick(campaign, phase) {
  const now = [];
  const later = [];
  const delay = () => Math.min(120, Math.round(-Math.log(1 - random()) * 25)) * 60_000;
  for (const recipient of campaign.recipients) {
    if (recipient.outcome === "bounce_hard" || recipient.outcome === "bounce_soft") continue;
    if (phase === "opens") {
      if (recipient.machineOpen && recipient.pixel) {
        now.push({ kind: "machine_open", path: recipient.pixel });
      }
      if (recipient.opens > 0 && recipient.pixel) {
        recipient.openLater = chance(0.4);
        const first = { kind: "open", path: recipient.pixel, agent: recipient.agent };
        if (recipient.openLater) {
          recipient.openAt = Date.now() + delay();
          later.push({ ...first, at: recipient.openAt });
        } else {
          now.push(first);
        }
        if (recipient.opens > 1) {
          later.push({ ...first, at: (recipient.openAt ?? Date.now()) + delay() + 60_000 });
        }
      }
      continue;
    }
    const after = (recipient.openAt ?? Date.now()) + 60_000;
    recipient.clicks.forEach((index, order) => {
      const click = { kind: "click", path: recipient.links[index], agent: recipient.agent };
      // A second click comes minutes later, so it never looks like a scanner's burst.
      if (order === 0 && !recipient.openLater) now.push(click);
      else later.push({ ...click, at: after + delay() + order * 120_000 });
    });
    if (recipient.unsubscribes && recipient.unsubscribe) {
      now.push({ kind: "unsubscribe", path: recipient.unsubscribe });
    }
  }
  await pool(now, 6, hit);
  return later;
}

let sending = false;
/** Sends the pending opens and clicks that are due. Runs with each cron run. */
async function sendDueEvents() {
  if (sending || !existsSync(PENDING_FILE)) return;
  sending = true;
  try {
    const pending = readJson(PENDING_FILE);
    const due = pending.filter((event) => event.at <= Date.now());
    if (due.length === 0) return;
    await pool(due, 4, (event) => hit(event).catch(() => undefined));
    writeJson(
      PENDING_FILE,
      pending.filter((event) => !due.includes(event)),
    );
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function main() {
  step("Building the admin app");
  const build = spawnSync(process.execPath, [VITE, "build", "--logLevel", "warn"], {
    cwd: join(ROOT, "apps", "web"),
    env,
    stdio: "inherit",
  });
  if (build.status !== 0) fail("The admin app did not build.");

  step("Applying the database migrations to the demo database");
  const migrate = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE_DIR],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  if (migrate.status !== 0) {
    console.error(migrate.stdout, migrate.stderr);
    fail("The migrations did not apply.");
  }

  if (portArg !== null && !(await isFree(portArg))) fail(`Port ${portArg} is in use.`);
  const port = portArg ?? (await freePort(8787));
  // The end-to-end tests use ports 8790 to 8800, so the mock starts above them.
  const mockPort = await freePort(port === 8850 ? 8851 : 8850);
  BASE = `http://localhost:${port}`;
  MOCK_ORIGIN = `http://127.0.0.1:${mockPort}`;

  step(`Starting the provider mock on port ${mockPort}`);
  track(
    spawn(process.execPath, [MOCK, String(mockPort), "--dmarc"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    }),
    "The provider mock",
  );
  await waitFor(`${MOCK_ORIGIN}/health`, 15_000, "The provider mock");

  writeVarsFile(VARS_FILE, {
    SETUP_TOKEN: secrets.SETUP_TOKEN,
    SIGNING_KEY: secrets.SIGNING_KEY,
    ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
  });
  step(`Starting wrangler dev on port ${port} (log: ${LOG_FILE})`);
  const log = createWriteStream(LOG_FILE, { flags: "a" });
  const dev = track(
    spawn(
      process.execPath,
      [
        WRANGLER,
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        STATE_DIR,
        "--show-interactive-dev-session=false",
        // The secrets come from a private file, not argv, so no process list shows them.
        // With --env-file, wrangler does not read the project's .dev.vars.
        "--env-file",
        VARS_FILE,
        "--var",
        "PBKDF2_ITERATIONS:100000",
        // Tracking events reach D1 a second after they arrive, not 30 seconds.
        "EVENT_FLUSH_DELAY_MS:1000",
        `OUTBOUND_MOCK_ORIGIN:${MOCK_ORIGIN}`,
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    ),
    "wrangler dev",
  );
  dev.stdout.pipe(log);
  dev.stderr.pipe(log);
  await waitFor(`${BASE}/api/health`, 120_000, "wrangler dev");

  if (seeded) {
    step("The demo data exists. Starting without a new seed (use --reset to seed again)");
  } else {
    try {
      await seed();
    } catch (error) {
      console.error(`\nThe seed failed: ${error instanceof Error ? error.message : error}`);
      console.error(`The next \`pnpm demo\` starts again. The Worker log is in ${LOG_FILE}.`);
      await stop(1);
    }
  }

  await runCron();
  await sendDueEvents();
  cronTimer = setInterval(() => {
    void runCron().then(sendDueEvents);
  }, CRON_INTERVAL_MS);

  const line = "-".repeat(66);
  console.log(`
${line}
  Envelopen demo is ready

  Open:      ${BASE}
  Email:     ${OWNER.email}
  Password:  ${OWNER.password}

  No real email is sent. A local mock stands in for Resend and DNS.
  The cron runs every minute. Some opens and clicks arrive over
  the next two hours.

  Reset the demo data:  pnpm demo --reset
  Stop the demo:        Ctrl+C
${line}
`);
}

await main();
