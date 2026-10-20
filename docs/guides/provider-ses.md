# Amazon SES

Last checked: 2026-10-19

## What Envelopen uses it for

Envelopen sends campaigns, test sends, and system email (owner alerts) through your Amazon SES account. Envelopen uses the SES v2 API and signs each request with your IAM access key.

SES reports delivery, bounce, complaint, reject, and rendering failure events to Envelopen through an Amazon SNS topic. Envelopen can create the configuration set, the SNS topic, and the subscription for you.

The adapter policy is `campaign`. You can send campaigns through SES without a policy warning.

## Cost and free tier

| Item | Price |
|---|---|
| Outbound email (pay as you go) | 0.10 USD per 1,000 emails, plus 0.12 USD per GB of attachments |
| New AWS customers | Up to 200 USD in AWS Free Tier credits. You can use the credits for SES. The free plan lasts 6 months. |
| SNS notifications to Envelopen | SNS charges for messages to HTTPS endpoints. See the SNS pricing page. |
| Dedicated IP address | 24.95 USD per month per IP. You do not need one for small volumes. |

AWS also sells SES plans (Essentials, Pro, Enterprise) with a different price per email. Envelopen works with all of them.

## Limits and constraints

### Sandbox

All new SES accounts start in the sandbox. The sandbox status is separate in each AWS Region. In the sandbox:

- You can send only to verified email addresses and verified domains.
- You can send at most 200 emails per 24 hours.
- You can send at most 1 email per second.

Effect on Envelopen: in the sandbox, a campaign fails for every contact who is not a verified address. A test send works only if each test address is verified in SES. The connection card shows the warning "The account is in the SES sandbox".

### Production access

You must request production access before your first campaign. Select the **Marketing** use case in the request. AWS gives an initial answer within 96 hours. If AWS needs more information, it can take longer. Request production access as early as possible.

### Production limits

| Limit | Value | Effect on Envelopen |
|---|---|---|
| Sending rate | AWS sets it for your account. The sandbox rate is 1 email per second. | Envelopen reads `MaxSendRate` with `GetAccount` when you connect and each time you select **Check**. The rate bucket charges one token per recipient. If Envelopen cannot read the rate, it uses 1 email per second. |
| Emails per 24 hours | AWS sets it for your account. You can request an increase. | When SES reports that the daily quota is used up, Envelopen pauses the campaign. Resume it after the quota resets. |
| Quotas per Region | Each Region has its own quotas and its own sandbox status. | Use one Region for all sending. Envelopen stores the Region with the connection. |
| Recipients per message | 50 | Envelopen sends one recipient per message, so each contact gets a personal unsubscribe link. |
| Message size | 40 MB with the v2 API | Campaign email is much smaller. |
| API rate for other actions | 1 request per second (all actions except the send actions) | Envelopen calls these actions only during connect, **Check**, and event setup. |
| Configuration set name | Up to 64 letters, digits, hyphens, and underscores | Envelopen names its set `envelopen-` plus 16 characters of the webhook secret. |
| SNS topic type | Standard only. SES does not support FIFO topics. | Envelopen creates a Standard topic. |

### How the adapter sends

The plan considered `SendBulkEmail`. The adapter does not use it, because `SendBulkEmail` takes only templates. Envelopen calls `SendEmail` once per recipient, with the unsubscribe headers in `Content.Simple.Headers`.

- One batch holds 25 recipients. Envelopen runs at most 5 `SendEmail` calls at the same time.
- After a throttle, quota, or account error, Envelopen does not start the other messages of the batch. It marks them as not sent, so a retry cannot send duplicates.
- SES has no idempotency key. If a request times out, the batch becomes uncertain. Open the campaign page and select retry or skip for each uncertain batch.

### Policy

- In the production access request, you agree to send only to people who asked for your email. You also confirm that you handle bounces and complaints. Envelopen handles bounces and complaints when events are set up.
- AWS can pause sending if your bounce rate or complaint rate is too high. If AWS pauses sending, the connection card shows "Sending is paused for this SES account."

## When to choose it, and when not to

Choose SES when:

- You want the lowest price per email.
- You send large volumes.
- You already use AWS.

Do not choose SES when:

- You cannot wait several days for production access.
- You do not want to manage an AWS account and IAM permissions.

## Setup

1. Sign in to the AWS console, or create an AWS account.
2. Open the SES console. Select one Region, for example `us-east-1`. Use this Region for all steps.
3. Go to **Identities** and select **Create identity**. Create a domain identity for your sending domain.
4. Add the DKIM CNAME records that SES shows to your DNS.
5. Optional: set a custom MAIL FROM domain on the identity. This aligns SPF with your domain.
6. Add a DMARC record to your DNS, for example `v=DMARC1; p=none;`.
7. Request production access. Go to **Account dashboard**. Select **View Get set up page**, then **Request production access**.
8. In the request, select **Marketing**. Enter your website URL. Accept the acknowledgement and submit.
9. Open the IAM console. Create an IAM user for Envelopen.
10. Attach a policy to the user. Use the example policy below.
11. Create an access key for the user. Copy the access key ID and the secret access key.

### IAM policy

The `Send` statement is necessary. The `AutoWebhook` statement lets Envelopen create and remove the events setup. If you leave out `AutoWebhook`, Envelopen shows manual steps.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Send",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:GetAccount", "ses:GetEmailIdentity"],
      "Resource": "*"
    },
    {
      "Sid": "AutoWebhook",
      "Effect": "Allow",
      "Action": [
        "ses:CreateConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:DeleteConfigurationSet",
        "sns:CreateTopic",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:DeleteTopic"
      ],
      "Resource": "*"
    }
  ]
}
```

| Permission | Why Envelopen needs it |
|---|---|
| `ses:SendEmail` | Sends each email. |
| `ses:GetAccount` | Checks the key, the sandbox status, and the send quota. |
| `ses:GetEmailIdentity` | Reads the DKIM records for the **Sending domains** page. |
| `ses:CreateConfigurationSet`, `ses:CreateConfigurationSetEventDestination` | Creates the configuration set and its SNS event destination. |
| `sns:CreateTopic`, `sns:SetTopicAttributes`, `sns:Subscribe` | Creates the topic, sets `SignatureVersion` to 2, and subscribes the Envelopen webhook URL. |
| `ses:DeleteConfigurationSet`, `sns:DeleteTopic` | Removes the setup when you remove the connection. |

## Connect to Envelopen

1. In Envelopen, open **Connections**. The **Providers** tab opens.
2. Under **Add a provider**, find **Amazon SES** and select **Connect**.
3. Enter the **Access key ID**, the **Secret access key**, and the **Region** (for example `us-east-1`).
4. Select **Connect**. Envelopen calls `GetAccount` to check the key. It sends no email.
5. Envelopen tries to create the events setup. If it succeeds, the card shows "Envelopen created the webhook".
6. Check the SNS topic access policy (see the next section).
7. If the card shows "Set up the webhook by hand", select **Set up the webhook**. Follow the manual steps below.
8. Open the **Sending domains** tab. Add your sending domain and check the DNS records.
9. Under **Send a test**, select a from address and send a test to yourself.

### What the automatic setup creates

- A configuration set named `envelopen-` plus 16 characters.
- A Standard SNS topic with the same name, with `SignatureVersion` set to 2 (SHA256).
- An HTTPS subscription to the Envelopen webhook URL. Envelopen confirms the subscription when SNS calls it.
- An SNS event destination for these event types: Deliveries, Bounces, Complaints, Rejects, and Rendering failures.

Envelopen adds the configuration set name to each `SendEmail` call.

### SNS topic access policy

The SES documentation says that SES needs permission to publish to the topic. Envelopen does not set this policy. If no events arrive after a test send, add it:

1. Open the SNS console. Select the topic named `envelopen-...`.
2. Select **Edit**. Expand **Access policy**.
3. Add a statement that allows the principal `ses.amazonaws.com` to call `sns:Publish` on the topic.
4. Limit the statement with `AWS:SourceAccount` (your account ID) and `AWS:SourceArn` (the configuration set ARN).
5. Select **Save changes**.

```json
{
  "Effect": "Allow",
  "Principal": { "Service": "ses.amazonaws.com" },
  "Action": "sns:Publish",
  "Resource": "arn:aws:sns:REGION:ACCOUNT_ID:envelopen-xxxxxxxxxxxxxxxx",
  "Condition": {
    "StringEquals": {
      "AWS:SourceAccount": "ACCOUNT_ID",
      "AWS:SourceArn": "arn:aws:ses:REGION:ACCOUNT_ID:configuration-set/envelopen-xxxxxxxxxxxxxxxx"
    }
  }
}
```

### Manual setup

Use these steps if the IAM user does not have the `AutoWebhook` permissions. The **Set up the webhook** dialog shows the same steps with your webhook URL.

1. In the SES console, open **Configuration sets**. Create a set named `envelopen`.
2. In the SNS console, create a Standard topic. Under **Message signature**, select SignatureVersion 2 (SHA256).
3. Create an HTTPS subscription on the topic. Use the **Webhook URL** from the dialog as the endpoint.
4. Wait about one minute. Envelopen confirms the subscription.
5. In the configuration set, add an SNS event destination with the topic. Select Deliveries, Hard bounces, Complaints, Rejects, and Rendering failures.
6. Add the SNS topic access policy from the previous section.
7. Open your domain identity in SES. Set `envelopen` as its default configuration set.

### Webhook URL

The webhook URL has this shape:

```
https://<your Envelopen address>/hooks/ses/<workspace id>/<connection id>?token=<webhook secret>
```

The token is the webhook secret. Envelopen rejects a request if the token is wrong, if the topic is not the topic of the connection, or if the SNS signature is not valid.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "AWS rejected the access key. Check the key, the secret, and the region." | The key is wrong, or the Region does not match. | Check the three fields. Create a new access key if necessary. |
| The card shows "The account is in the SES sandbox" | AWS did not grant production access in this Region. | Request production access with the Marketing use case. Select **Check** after AWS grants it. |
| "Email address is not verified" | The account is in the sandbox. | Verify the recipient in SES for a test. Request production access for campaigns. |
| "Automatic webhook setup did not finish" | The IAM user does not have the `AutoWebhook` permissions. | Add the permissions and select **Try automatic setup again**. Or follow the manual steps. |
| No delivery, bounce, or complaint events | SES cannot publish to the topic, or the subscription is not confirmed. | Add the SNS topic access policy. In the SNS console, check that the subscription status is "Confirmed". |
| The campaign pauses with a quota message | The 24-hour quota is used up. | Wait for the quota to reset, then resume. Request a higher quota in the SES console. |
| The campaign slows down | The rate bucket follows `MaxSendRate`. | After AWS raises your rate, select **Check** on the connection card. Envelopen reads the new rate. |
| The card shows "Sending is paused for this SES account." | AWS paused sending, often for a high bounce rate or complaint rate. | Read the message from AWS in the SES console. Fix the cause and ask AWS to resume sending. |
| Uncertain batches on the campaign page | A `SendEmail` request timed out, and SES has no idempotency key. | Select retry or skip for each batch. A retry can send a second copy to some contacts. |

## Sources

Last checked: 2026-10-19

- [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Service quotas in Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- [Set up an Amazon SNS event destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html)
- [Sending email with the SES API](https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html)
- [SES API v2 reference](https://docs.aws.amazon.com/ses/latest/APIReference-V2/)
- [Verify SNS message signatures](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
