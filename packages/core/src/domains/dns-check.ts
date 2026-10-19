// Sending domain checks over DNS over HTTPS (R12). A Worker has no DNS resolver API, so
// the checks ask Cloudflare's public resolver in its JSON format.
// https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
//
// Each check returns a status and a sentence for the UI:
// - `pass`: the record is right.
// - `missing`: no record yet. The owner may still be waiting for DNS.
// - `fail`: a record exists, but it is wrong, for example two SPF records.
// - `error`: the resolver failed, so nothing is known. It never counts as `fail`.
// - `unknown`: the check cannot run, for example no DKIM selector is known.

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export type CheckStatus = "pass" | "missing" | "fail" | "error" | "unknown";

export interface CheckResult {
  status: CheckStatus;
  detail: string;
}

type RecordType = "TXT" | "CNAME" | "A" | "MX";
const TYPE_CODES: Record<RecordType, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16 };

export type DohAnswer = { ok: true; records: string[] } | { ok: false; error: string };

export interface DohClient {
  query(name: string, type: RecordType): Promise<DohAnswer>;
}

/** A DoH client on a fetch. Status 3 (NXDOMAIN) is an empty answer, not an error. */
export function createDohClient(fetcher: typeof fetch, endpoint = DOH_ENDPOINT): DohClient {
  return {
    async query(name, type) {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      let body: { Status?: number; Answer?: { type?: number; data?: string }[] };
      try {
        const response = await fetcher(url, {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok)
          return { ok: false, error: `The DNS resolver returned ${response.status}.` };
        body = (await response.json()) as typeof body;
      } catch {
        return { ok: false, error: "The DNS resolver did not answer." };
      }
      if (body.Status === 3) return { ok: true, records: [] };
      if (body.Status !== 0)
        return { ok: false, error: `The DNS lookup failed (status ${body.Status}).` };
      const records = (body.Answer ?? [])
        .filter((answer) => answer.type === TYPE_CODES[type] && typeof answer.data === "string")
        .map((answer) =>
          type === "TXT" ? joinTxt(answer.data as string) : stripDot(answer.data as string),
        );
      return { ok: true, records };
    },
  };
}

/** A TXT answer as one string: `"v=spf1 " "include:x ~all"` becomes `v=spf1 include:x ~all`. */
export function joinTxt(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
  return parts.length > 0 ? parts.join("") : data;
}

function stripDot(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

const failed = (answer: Extract<DohAnswer, { ok: false }>): CheckResult => ({
  status: "error",
  detail: answer.error,
});

/**
 * SPF: one `v=spf1` record on the domain or on the provider's return-path host, with
 * the provider's include. A return path that is a CNAME (Postmark) also passes.
 */
export async function checkSpf(
  doh: DohClient,
  hosts: readonly string[],
  include: string | null,
): Promise<CheckResult> {
  let sawError: CheckResult | null = null;
  for (const host of hosts) {
    const answer = await doh.query(host, "TXT");
    if (!answer.ok) {
      sawError = failed(answer);
      continue;
    }
    const spf = answer.records.filter((record) => /^v=spf1(\s|$)/i.test(record));
    if (spf.length > 1) {
      return {
        status: "fail",
        detail: `${host} has ${spf.length} SPF records. Merge them into one.`,
      };
    }
    if (spf.length === 1) {
      const record = spf[0] as string;
      if (include && !record.toLowerCase().includes(`include:${include}`)) {
        return { status: "fail", detail: `The SPF record of ${host} does not include ${include}.` };
      }
      return { status: "pass", detail: `${host}: ${record}` };
    }
    if (host !== hosts[0]) {
      const cname = await doh.query(host, "CNAME");
      if (cname.ok && cname.records.length > 0) {
        return { status: "pass", detail: `${host} points to ${cname.records[0]}.` };
      }
    }
  }
  return sawError ?? { status: "missing", detail: `No SPF record on ${hosts.join(" or ")}.` };
}

export interface ExpectedDkim {
  host: string;
  type: "TXT" | "CNAME";
  /** For a CNAME: the target. For a TXT: ignored, any key passes. */
  value?: string;
}

/** DKIM: every expected key record exists. A TXT needs a public key, a CNAME its target. */
export async function checkDkim(
  doh: DohClient,
  expected: readonly ExpectedDkim[],
): Promise<CheckResult> {
  if (expected.length === 0) {
    return {
      status: "unknown",
      detail: "Add the DKIM selector that your provider shows, then check again.",
    };
  }
  const missing: string[] = [];
  for (const record of expected) {
    const answer = await doh.query(record.host, record.type);
    if (!answer.ok) return failed(answer);
    if (record.type === "CNAME") {
      const target = answer.records[0];
      if (!target) missing.push(record.host);
      else if (record.value && target !== stripDot(record.value)) {
        return {
          status: "fail",
          detail: `${record.host} points to ${target}, not ${record.value}.`,
        };
      }
      continue;
    }
    const keys = answer.records.filter((value) => /(^|;)\s*p=[^;\s]+/.test(value));
    if (keys.length === 0) {
      // A TXT key published as a CNAME to the provider is fine too.
      const cname = await doh.query(record.host, "CNAME");
      if (!(cname.ok && cname.records.length > 0)) missing.push(record.host);
    }
  }
  if (missing.length === expected.length) {
    return { status: "missing", detail: `No DKIM record on ${missing.join(", ")}.` };
  }
  if (missing.length > 0)
    return { status: "missing", detail: `Still missing: ${missing.join(", ")}.` };
  return {
    status: "pass",
    detail: `${expected.length} DKIM ${expected.length === 1 ? "key" : "keys"} found.`,
  };
}

/** DMARC: one `v=DMARC1` record at `_dmarc.<domain>`. */
export async function checkDmarc(doh: DohClient, domain: string): Promise<CheckResult> {
  const host = `_dmarc.${domain}`;
  const answer = await doh.query(host, "TXT");
  if (!answer.ok) return failed(answer);
  const records = answer.records.filter((record) => /^v=DMARC1\s*(;|$)/i.test(record));
  if (records.length === 0) return { status: "missing", detail: `No DMARC record on ${host}.` };
  if (records.length > 1)
    return { status: "fail", detail: `${host} has ${records.length} DMARC records. Keep one.` };
  const policy = /(?:^|;)\s*p=([a-z]+)/i.exec(records[0] as string)?.[1];
  if (!policy) return { status: "fail", detail: "The DMARC record has no policy (p=)." };
  return { status: "pass", detail: `Policy ${policy.toLowerCase()}.` };
}

/**
 * Tracking domain (R13): a CNAME to the app host, or a Workers custom domain in the same
 * account. A custom domain resolves to Cloudflare addresses, not a CNAME, so the check
 * then asks the Worker's health route on that host.
 */
export async function checkTracking(
  doh: DohClient,
  fetcher: typeof fetch,
  trackingDomain: string | null,
  appHost: string | null,
): Promise<CheckResult> {
  if (!trackingDomain)
    return { status: "unknown", detail: "No tracking domain. Links use the app address." };
  const cname = await doh.query(trackingDomain, "CNAME");
  if (!cname.ok) return failed(cname);
  const target = cname.records[0];
  if (target) {
    if (appHost && target === appHost.toLowerCase())
      return { status: "pass", detail: `Points to ${target}.` };
    return {
      status: "fail",
      detail: `${trackingDomain} points to ${target}, not ${appHost ?? "this app"}.`,
    };
  }
  const address = await doh.query(trackingDomain, "A");
  if (!address.ok) return failed(address);
  if (address.records.length === 0)
    return { status: "missing", detail: `No record for ${trackingDomain}.` };
  try {
    const response = await fetcher(`https://${trackingDomain}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as { status?: string };
    if (response.ok && body.status === "ok") {
      return { status: "pass", detail: `${trackingDomain} reaches this Worker.` };
    }
  } catch {
    // Falls through to the failure below.
  }
  return {
    status: "fail",
    detail: `${trackingDomain} resolves, but it does not reach this Envelopen.`,
  };
}
