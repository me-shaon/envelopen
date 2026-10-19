// A local stand-in for the email providers and the DNS-over-HTTPS resolver, for the
// providers spec. The Worker under test runs with OUTBOUND_MOCK_ORIGIN pointing here,
// so `https://api.resend.com/domains` arrives as `/api.resend.com/domains`.
//
//   node e2e/provider-mock.mjs <port> [--dmarc]
//
// With --dmarc, the zone also has the DMARC record, so the sending domain verifies.
// The responses follow the shapes of the recorded fixtures in
// packages/providers/conformance/fixtures. No request leaves this machine.
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const withDmarc = process.argv.includes("--dmarc");
if (!port) {
  console.error("Usage: node e2e/provider-mock.mjs <port> [--dmarc]");
  process.exit(1);
}

/** The Resend signing secret that the mock webhook returns. The spec signs with it. */
const RESEND_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const DOMAIN = "mail.example.com";

// DNS: SPF and DKIM are in place, DMARC is not, so the domain waits for one record.
const ZONE = {
  [`TXT send.${DOMAIN}`]: ["v=spf1 include:amazonses.com ~all"],
  [`TXT resend._domainkey.${DOMAIN}`]: ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"],
  ...(withDmarc ? { [`TXT _dmarc.${DOMAIN}`]: ["v=DMARC1; p=none"] } : {}),
};
const TYPE_CODES = { A: 1, CNAME: 5, MX: 15, TXT: 16 };

const sent = [];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const routes = {
  "GET /health": (_req, res) => json(res, 200, { ok: true }),
  // The emails that the Worker sent through the mock Resend, for the spec to inspect.
  "GET /sent": (_req, res) => json(res, 200, sent),
  "GET /api.resend.com/domains": (_req, res) =>
    json(res, 200, { data: [{ id: "d91cd9bd", name: DOMAIN }] }),
  "GET /api.resend.com/domains/d91cd9bd": (_req, res) =>
    json(res, 200, {
      id: "d91cd9bd",
      name: DOMAIN,
      records: [
        { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com" },
        { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all" },
        {
          record: "DKIM",
          name: "resend._domainkey",
          type: "TXT",
          value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC",
        },
      ],
    }),
  "POST /api.resend.com/webhooks": (_req, res) =>
    json(res, 201, {
      object: "webhook",
      id: "4dd369bc-aa82-4ff3-97de-514ae3000ee0",
      signing_secret: RESEND_SECRET,
    }),
  "POST /api.resend.com/emails/batch": (_req, res, body) => {
    const emails = JSON.parse(body);
    sent.push(...emails);
    json(res, 200, {
      data: emails.map((_email, index) => ({ id: `e2e-${sent.length}-${index}` })),
    });
  },
  "GET /api.tosend.com/v2/info": (_req, res) =>
    json(res, 200, {
      account: { id: "acc_1", status: "active", credit_balance: 9800 },
      domains: [],
    }),
  "GET /cloudflare-dns.com/dns-query": (req, res) => {
    const url = new URL(req.url, "http://mock");
    const type = url.searchParams.get("type") ?? "";
    const name = url.searchParams.get("name") ?? "";
    const values = ZONE[`${type} ${name}`];
    if (!values) return json(res, 200, { Status: 3 });
    return json(res, 200, {
      Status: 0,
      Answer: values.map((value) => ({
        name,
        type: TYPE_CODES[type],
        TTL: 300,
        data: type === "TXT" ? `"${value}"` : `${value}.`,
      })),
    });
  },
};

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://mock").pathname;
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return json(res, 404, { message: `No mock for ${req.method} ${path}` });
    return handler(req, res, body);
  });
}).listen(port, "127.0.0.1");
