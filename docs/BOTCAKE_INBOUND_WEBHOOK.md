# Botcake inbound webhook

The CRM exposes a server-to-server receiver at:

```text
POST /api/webhooks/botcake
```

The receiver is fail-closed and uses server-owned configuration:

```text
BOTCAKE_PAGE_ID=1343097708890171
BOTCAKE_COMPANY_ID=<company UUID>
BOTCAKE_WEBHOOK_SECRET=<dedicated random secret>
```

Do not use the Botcake public API key as the webhook secret. Keep the public API
key only in the server-side variable used by the outbound adapter; never commit
either secret.

Configure the Botcake HTTP/JSON API call with either header:

```text
Authorization: Bearer <BOTCAKE_WEBHOOK_SECRET>
```

or:

```text
X-Botcake-Webhook-Secret: <BOTCAKE_WEBHOOK_SECRET>
```

The minimum JSON contract is:

```json
{
  "page_id": "1343097708890171",
  "psid": "customer-page-scoped-id",
  "message_id": "botcake-message-id",
  "text": "Nội dung khách gửi",
  "timestamp": "2026-10-26T16:05:05.000Z",
  "sender_name": "Tên khách"
}
```

The receiver also accepts `pageId`, `sender_id`, `senderId`,
`external_user_id`, `messageId`, `mid`, `content`, and nested `message`/`user`
fields for adapter compatibility. The payload's `company_id` is ignored; the
tenant is always resolved from `BOTCAKE_COMPANY_ID`.

This endpoint creates/updates the existing Facebook conversation and preserves
the message ID for durable idempotency. It does not itself make Botcake emit
events: Botcake must be configured to call this endpoint with a payload that
contains the actual inbound message ID and text.
