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

## Readiness check

```text
GET /api/webhooks/botcake
```

- When configured: HTTP 200 `{ "success": true, "service": "Botcake inbound webhook", "status": "READY", "page_id": "1343097708890171" }`
- When missing env vars: HTTP 503 `{ "success": false, "error": "BOTCAKE_NOT_CONFIGURED" }`

## Botcake Flow / JSON API block setup

In the Botcake Flow Builder (or Default Reply flow):
1. Add a **JSON API / HTTP Request** block.
2. Method: `POST`
3. URL: `https://<render-domain>/api/webhooks/botcake`
4. Headers:
   - `Content-Type`: `application/json`
   - `X-Botcake-Webhook-Secret`: `<BOTCAKE_WEBHOOK_SECRET>` (or `Authorization: Bearer <BOTCAKE_WEBHOOK_SECRET>`)
5. Body (JSON):
```json
{
  "page_id": "1343097708890171",
  "psid": "{{customer.psid}}",
  "message_id": "{{message.mid}}",
  "text": "{{message.text}}",
  "sender_name": "{{customer.name}}"
}
```
