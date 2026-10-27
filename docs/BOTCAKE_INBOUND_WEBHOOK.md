# Botcake / Pancake inbound webhook

The CRM receives Botcake-managed Messenger messages at:

```text
POST /api/webhooks/botcake
```

When the Page is managed by Pancake, the preferred transport is the **Pancake
page Webhook** (`event_type: "messaging"`). The older Botcake Flow **JSON API**
block is still accepted for compatibility, but it cannot be used to sync real
messages. See “Why the JSON API block cannot sync messages” below.

## Current production transport (verified 2026-10-27)

The Botcake-managed Page `1343097708890171` is **not present** in the Pancake
dashboard, so the Pancake Webhook cannot be enabled for it. Production therefore
uses the **direct Meta webhook**:

- Page `1343097708890171` → company `de6a7bf3-b5bc-418d-92d6-f9b241472598`
- Page subscribed to Meta app `1780871206505449` for `messages`
- Page token stored in Render as `META_PAGE_BOTCAKE_TOKEN`
- Callback: `https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/meta`

The `/api/webhooks/botcake` endpoint and Pancake parser remain in the code for
future use, but they are not the active transport for this Page. Do not enable
both transports for the same Page; see the warning in “Direct Meta webhook
fallback”.

## Why the JSON API block cannot sync messages

Botcake’s JSON API block is a Flow action, not an event webhook. Its documented
variables are limited to customer/bot fields:

```text
{{user.full_name}}  {{user.first_name}}  {{user.last_name}}
{{user.email}}      {{user.phone_number}} {{user.gender}}
{{user.address}}    {{user.id}}
{{bot.name}}        {{bot.welcome_message}} {{bot.description}}
{{user.custom_field_name}}
```

It does **not** document `{{message.text}}`, `{{message.mid}}`,
`{{customer.psid}}`, or `{{customer.name}}`. In production those values were sent
literally, not interpolated:

```text
sanitized_content = "{{message.text}}"
external_ref      = "{{message.mid}}"
sender_name       = "{{customer.name}}"
```

That created a single placeholder conversation. Because every delivery used the
same literal `external_ref`, later deliveries were treated as duplicates.

There is a second limitation: the JSON API block only runs when its Flow runs.
“Tin nhắn mặc định” is an Automation feature with a repeat cycle (for example,
once per 24 hours), not an every-message event. A Flow attached there will not
fire for every inbound message.

The only Botcake/Pancake transport that carries the real message ID, text,
sender, and timestamp for every inbound message is the Pancake page Webhook.

Official references:

- Botcake Flow / JSON API variables: <https://docs.pancake.biz/botcake/st-f3/st-p3?lang=vi>
- Botcake Automation / default message cycle: <https://docs.pancake.biz/botcake/st-f3/st-p4?lang=vi>
- Pancake Webhooks: <https://developer.pancake.biz/webhook>

## Server configuration

These values are server-owned. Never accept a Page ID or company ID from the
request body.

```text
BOTCAKE_PAGE_ID=1343097708890171
BOTCAKE_COMPANY_ID=<company UUID>
BOTCAKE_WEBHOOK_SECRET=<dedicated random secret>
```

`BOTCAKE_WEBHOOK_SECRET` must be different from `META_APP_SECRET`,
`META_VERIFY_TOKEN`, and any Botcake public API token. Keep it only in Render’s
environment variables.

## Configure the Pancake page Webhook

In the Pancake/Botcake page that owns the Fanpage:

1. Open the page’s **Settings → Tools → Webhook** (Pancake may label this
   “Webhook Settings”).
2. Enable the **messaging** event.
3. Set the callback URL to:

   ```text
   https://ai-crm-cua-chong-ngap.onrender.com/api/webhooks/botcake?token=<BOTCAKE_WEBHOOK_SECRET>
   ```

   The secret is in the URL because Pancake’s Webhook settings do not provide a
   custom-header field. The CRM never logs the query string. If your Pancake
   plan exposes custom headers, prefer:

   ```text
   X-Botcake-Webhook-Secret: <BOTCAKE_WEBHOOK_SECRET>
   ```

4. Save, then use Pancake’s test delivery or send a real Messenger message from
   a personal account.

Pancake may require one free connection slot per page for Webhooks. If the
Webhook is suspended after repeated errors, re-enable it in the same settings
screen.

## Accepted Pancake payload

The receiver understands the official `messaging` shape:

```json
{
  "page_id": "1343097708890171",
  "event_type": "messaging",
  "data": {
    "conversation": {
      "id": "fb_conversation_1",
      "from": { "id": "customer-psid", "name": "Nguyễn Văn A" },
      "type": "INBOX"
    },
    "message": {
      "id": "m_real_message_id",
      "conversation_id": "fb_conversation_1",
      "page_id": "1343097708890171",
      "message": "Anh ơi báo giá giúp em",
      "original_message": "Anh ơi báo giá giúp em",
      "type": "INBOX",
      "inserted_at": "2026-10-27T03:14:43.000000",
      "from": {
        "id": "customer-psid",
        "name": "Nguyễn Văn A",
        "page_customer_id": "page-customer-id"
      },
      "attachments": []
    }
  }
}
```

Mapping:

| CRM field | Pancake field |
| --- | --- |
| Page | `page_id` (also accepts `fb_`, `facebook_`, `page_`, `messenger_`, `pancake_` prefixes) |
| Sender / PSID | `data.message.from.id` |
| Sender name | `data.message.from.name` |
| Message ID | `data.message.id` |
| Text | `data.message.message`, then `original_message`, then `conversation.snippet` |
| Timestamp | `data.message.inserted_at` (UTC; a missing zone is treated as UTC) |
| Provider conversation | `data.message.conversation_id` (stored as metadata only) |

The CRM conversation identity is always `page_id:sender_psid`, matching the
direct Meta webhook. This keeps Page provenance and company isolation correct.

This endpoint is inbound-only. It does not give the CRM a Page access token and
does not make the CRM’s outbound sender work for the Botcake-managed Page. Keep
replying through Botcake/Pancake unless you also configure the direct Meta
binding described below.

### Events that are acknowledged but not ingested

These return HTTP 200 with `{ "success": true, "ignored": true, "reason": ... }`
so Pancake does not retry or suspend the Webhook:

- `COMMENT` messages
- messages authored by the Page/staff (outbound)
- removed/hidden messages
- non-`messaging` events

### Attachments

A message with no text but with attachments is stored as
`[Tệp đính kèm]` so the conversation still appears. Attachment URLs are not
downloaded by this endpoint.

## Legacy JSON API contract

The endpoint still accepts the older custom shape for manual tests and
backwards compatibility:

```json
{
  "page_id": "1343097708890171",
  "psid": "customer-page-scoped-id",
  "message_id": "real-message-id",
  "text": "Nội dung khách gửi",
  "timestamp": "2026-10-26T16:05:05.000Z",
  "sender_name": "Tên khách"
}
```

Headers:

```text
Authorization: Bearer <BOTCAKE_WEBHOOK_SECRET>
```

or:

```text
X-Botcake-Webhook-Secret: <BOTCAKE_WEBHOOK_SECRET>
```

The parser also accepts `pageId`, `sender_id`, `senderId`,
`external_user_id`, `messageId`, `mid`, `content`, and nested `message`/`user`
fields.

Unresolved identity placeholders are rejected with HTTP 422
`UNRESOLVED_TEMPLATE_VARIABLE` instead of creating a junk conversation:

```json
{
  "page_id": "1343097708890171",
  "psid": "{{customer.psid}}",
  "message_id": "{{message.mid}}",
  "text": "{{message.text}}"
}
```

Do not configure this shape as the production message-sync path. It cannot
carry the real message text or message ID.

## Direct Meta webhook fallback

If Pancake Webhooks are unavailable, the Botcake-managed Page can be subscribed
directly to the CRM’s Meta app. The Meta receiver already supports multiple
Page bindings:

```text
META_PAGE_BINDINGS=[
  {
    "page": "1026991374010112",
    "company": "<company UUID>",
    "tokenEnv": "META_PAGE_CHD_TOKEN",
    "name": "Du học Đức và Học Tiếng Đức CHD"
  },
  {
    "page": "1343097708890171",
    "company": "<company UUID>",
    "tokenEnv": "META_PAGE_BOTCAKE_TOKEN",
    "name": "Cửa Chống Ngập"
  }
]
```

Then:

1. Grant the CRM Meta app access to Page `1343097708890171` with
   `pages_show_list`, `pages_messaging`, and `pages_manage_metadata`.
2. Exchange the user token for a Page token and store it in
   `META_PAGE_BOTCAKE_TOKEN` (never commit it).
3. Subscribe the Page to the app:

   ```text
   POST /{page-id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks
   ```

4. Verify:

   ```text
   GET /{page-id}/subscribed_apps
   ```

This path uses Meta’s signed webhook and does not depend on Botcake Flow
triggers. It can run alongside Botcake’s own chatbot app.

Use one inbound transport per Page. If both Pancake Webhook and direct Meta
delivery are enabled for the same Page, the two providers may use different
message IDs and the CRM can store the same message twice.

## Readiness check

```text
GET /api/webhooks/botcake
```

Configured response:

```json
{
  "success": true,
  "service": "Botcake inbound webhook",
  "status": "READY",
  "page_id": "1343097708890171",
  "transport": "PANCAKE_WEBHOOK",
  "accepts": ["PANCAKE_WEBHOOK", "JSON_API"]
}
```

Missing configuration returns HTTP 503 `BOTCAKE_NOT_CONFIGURED`.

## Local verification

The repository test uses `DEMO_MODE=true` and an in-memory store. It never writes
to production:

```bash
npx tsx --conditions=react-server --test tests/omnichannel/botcake_webhook.test.ts
```

Do not POST fake payloads to the production URL: a valid payload creates a real
conversation in the production Inbox. Use Pancake’s test delivery or a real
Messenger message for production verification.

## Troubleshooting

- **HTTP 401**: the URL is missing `?token=...` or the header does not match
  `BOTCAKE_WEBHOOK_SECRET`.
- **HTTP 403 `PAGE_NOT_CONFIGURED`**: the Webhook is enabled on a different
  Pancake page than `BOTCAKE_PAGE_ID`. Compare the `page_id` in Pancake’s test
  delivery with `BOTCAKE_PAGE_ID`. The parser accepts the common `fb_`,
  `facebook_`, `page_`, `messenger_`, and `pancake_` prefixes; if Pancake uses a
  different internal page ID, set `BOTCAKE_PAGE_ID` to the exact value Pancake
  sends.
- **HTTP 422 `UNRESOLVED_TEMPLATE_VARIABLE`**: a legacy JSON API body still
  contains `{{...}}` in `psid` or `message_id`.
- **HTTP 200 `ignored: true`**: the event is a comment, outbound reply, removed
  message, or a non-`messaging` event. This is expected.
- **No request reaches Render**: the Pancake Webhook is disabled, suspended, or
  pointed at the wrong URL. Check Pancake’s Webhook delivery log and Render logs
  for `[botcake-webhook]`.
