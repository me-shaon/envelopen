# Set up a sending domain

A sending domain is the domain in the From address of your emails, for example `mail.example.com`. Envelopen lists the DNS records that the domain needs and checks them. A campaign can send only from a verified sending domain.

## Before you start

- Connect a provider on the **Connections** page. See the guide for your provider in [Related guides](#related-guides).
- Add the domain to your provider first. Envelopen then reads the exact records from the provider, if the provider API supports it.
- Get access to the DNS settings of the domain.
- Optional: choose a tracking domain, for example `track.example.com`. It must be a zone in the same Cloudflare account as the Envelopen Worker. Envelopen v1 does not support a tracking domain in another account or at another DNS host.

## Steps

### How Envelopen checks the records

A Worker has no DNS resolver, so Envelopen asks Cloudflare's public resolver over DNS over HTTPS (`https://cloudflare-dns.com/dns-query`). Each check gets one of these results:

| Result in the UI | Meaning |
|---|---|
| Verified | The record is correct. |
| Waiting | No record yet. DNS can take some time to update. |
| Wrong | A record exists, but it is not correct. For example, the host has two SPF records. |
| Not checked | The resolver did not answer. Envelopen knows nothing, and it does not count this as wrong. |
| Not set | The check cannot run. For example, no DKIM selector is known, or there is no tracking domain. |

The domain is **Verified** when SPF, DKIM, and DMARC pass. The tracking check does not affect the domain status. Envelopen checks again when you add the domain, when you change its settings, and when you select **Check again**.

| Record | Type | Host | What Envelopen checks |
|---|---|---|---|
| SPF | TXT | The domain, or the return-path host of the provider | One `v=spf1` record that includes the provider. A return-path CNAME (Postmark) also passes. |
| DKIM | TXT or CNAME | `<selector>._domainkey.<domain>` | Each expected key exists. A TXT record needs a public key (`p=`). A CNAME must point to the provider's target. |
| DMARC | TXT | `_dmarc.<domain>` | One `v=DMARC1` record with a policy (`p=`). |
| Tracking | CNAME, or a Workers custom domain | The tracking domain | The host points to the Envelopen host, or it answers as this Worker on `/api/health`. |

### Add the domain

1. Open **Connections**, then select **Sending domains**.
2. In **Sending domain**, enter the domain, for example `mail.example.com`.
3. Optional: in **Tracking domain (optional)**, enter the tracking domain.
4. Select **Add domain**. Envelopen runs the first check and opens the domain page.

### Add the DNS records

1. On the domain page, find the table **DNS records to add**.
2. For each row, copy the host and the value with the copy buttons.
3. Add each record at your DNS host.
4. For SPF: if the host has an SPF record already, add the `include:` part to it. A host can have only one SPF record.
5. For DKIM: if the value is empty, copy it from your provider's dashboard.
6. For DMARC: start with the value that Envelopen shows, `v=DMARC1; p=none; rua=mailto:dmarc@<domain>`. Move to `p=quarantine` when the reports look clean.

### Set the DKIM selectors

Some providers do not give Envelopen their records through the API. The DKIM row then shows `<selector>._domainkey.<domain>`.

1. Find the DKIM selector in your provider's dashboard. It is the part before `._domainkey`.
2. On the domain page, in **Settings**, enter it in **DKIM selectors**. Separate several selectors with commas.
3. Select **Save and check**.

### Set up the tracking domain

Use a Workers custom domain. Cloudflare creates the DNS record for you.

1. In the Cloudflare dashboard, open **Workers & Pages**, and select the Envelopen Worker.
2. Open **Settings**, then **Domains & Routes**.
3. Select **Add**, then **Custom Domain**.
4. Enter the tracking domain, for example `track.example.com`.
5. Select **Add Custom Domain**.
6. In Envelopen, on the domain page, select **Check again**.

The tracking domain must be a zone in the same Cloudflare account. A Custom Domain cannot use a host that has a CNAME record already. Remove the CNAME first.

Until the Tracking check shows **Verified**, Envelopen does not use the tracking domain. Links and unsubscribe links in campaigns use the Envelopen host. The campaign checklist shows a warning for this.

### Check the domain

1. Wait a few minutes after you add the records.
2. On the domain page, select **Check again**.
3. Read the result and the detail under SPF, DKIM, DMARC, and Tracking.
4. Repeat until SPF, DKIM, and DMARC show **Verified**.

The **Sending domains** list shows **Verified**, **Waiting for DNS**, or **Fix DNS** for each domain.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| SPF shows **Wrong** with "has 2 SPF records". | The host has two `v=spf1` records. | Merge them into one record. |
| SPF shows **Wrong** with "does not include". | The SPF record has no `include:` for the provider. | Add the `include:` value from the SPF row. |
| DKIM shows **Not set**. | Envelopen does not know the selector. | Add the selector in **DKIM selectors**, then select **Save and check**. |
| DKIM shows "points to ..., not ...". | The CNAME target is wrong. | Copy the target from the DKIM row again. |
| DMARC shows **Wrong** with "has 2 DMARC records". | Two `v=DMARC1` records on `_dmarc`. | Keep one. |
| A check shows **Not checked**. | The DNS resolver did not answer in 5 seconds. | Select **Check again** later. |
| Tracking shows "resolves, but it does not reach this Envelopen". | The host points somewhere else, or it is a custom domain of another Worker. | Add the host as a Custom Domain of the Envelopen Worker. |
| Tracking shows "points to ..., not ...". | A CNAME points to the wrong host. | Remove the CNAME, and add a Workers Custom Domain. |
| The domain stays **Waiting for DNS** for hours. | The records are on the wrong host, or DNS has not updated. | Compare each host with the table. Some DNS hosts add the domain to the host name for you. |
| A test send fails with "The From address must be on a sending domain". | The From address uses another domain. | Use an address on the sending domain, or add that domain. |

Select **Remove** on the domain page to stop using a domain. Envelopen does not change your DNS records or the domain at your provider.

## Related guides

- [Amazon SES](provider-ses.md)
- [Resend](provider-resend.md)
- [Postmark](provider-postmark.md)
- [toSend](provider-tosend.md)
- [Cloudflare Email](provider-cloudflare-email.md)
- [Send a test email](test-send.md)
- [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [DNS over HTTPS, JSON format](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)
