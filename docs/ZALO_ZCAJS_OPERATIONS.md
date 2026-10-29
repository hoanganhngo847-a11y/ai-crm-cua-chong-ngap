# ZCAJS transport for CRM Zalo

This integration uses the user-selected fork `ngogiaphat/ZCAJS` as the personal-account Zalo transport while preserving the existing CRM Zalo inbox, tenant isolation, durable outbound fencing and official Zalo OA implementation.

## Pinned upstream

The worker image builds directly from:

- Repository: `https://github.com/ngogiaphat/ZCAJS.git`
- Commit: `0d99d7d025f5183822d627088fac89d1f55ef691`
- Package version at that commit: `zca-js@1.2.1`

The fork does not commit its `dist/` directory and has no `prepare` script. Its committed `package-lock.json` is also out of sync with `package.json` at the pinned commit, so `npm ci` cannot build that exact fork. The worker Dockerfile therefore clones the exact commit, runs `npm install` to resolve the fork's declared dependencies, builds it, and installs the resulting package tarball. It does not silently substitute another ZCAJS repository or npm/upstream implementation.

## Architecture

Inbound customer messages:

`Zalo personal account -> ZCAJS WebSocket listener -> ZCAJS worker -> POST /api/inbox/zalo-zcajs/inbound -> ingestNormalizedEvent -> Unified Inbox`

Manual messages sent from the connected native Zalo account:

`Zalo native app -> ZCAJS self listener -> worker -> /api/inbox/zalo-zcajs/inbound -> record_observed_zcajs_outbound_atomic -> Unified Inbox`

These observed native messages are persisted as `OUTBOUND` interactions and are never enqueued back to Zalo.

CRM outbound:

`Unified Inbox -> durable Zalo outbox -> authenticated dispatch endpoint -> ZcaJsTransportClient -> ZCAJS worker /v1/send -> api.sendMessage -> Zalo user`

The worker suppresses the self-listener echo of CRM-originated sends so a successful CRM send produces one canonical bubble instead of a duplicate observed-native bubble.

The existing official OA webhook/client remain available when `ZALO_TRANSPORT=OA`.

## CRM web-service environment

Set these server-only variables on the CRM web service:

```env
ZALO_TRANSPORT=ZCAJS
ZALO_ZCAJS_COMPANY_ID=<company UUID>
ZALO_ZCAJS_WORKER_URL=https://<zcajs-worker-host>
ZALO_ZCAJS_WORKER_SECRET=<long random shared secret>
```

The CRM creates only a non-secret logical routing row `zcajs:<company UUID>` in `zalo_oa_configs` so the existing durable Zalo outbox can keep its current idempotency/fencing invariants. Zalo cookies, IMEI, user-agent and the worker secret are never stored in that row.

## ZCAJS worker environment

Deploy `zalo-zcajs-worker/Dockerfile` as a separate long-running service and set:

```env
ZCAJS_COMPANY_ID=<same company UUID>
ZCAJS_CRM_BASE_URL=https://<crm-host>
ZCAJS_WORKER_SECRET=<same shared secret as CRM>
ZCAJS_COOKIE=<Zalo Web cookie/session value>
ZCAJS_IMEI=<Zalo Web z_uuid/sh_z_uuid value>
ZCAJS_USER_AGENT=<user agent from the same browser/session>
PORT=10000
# Optional; defaults to data/zcajs-inbound-queue.jsonl inside the worker container.
ZCAJS_INBOX_QUEUE_FILE=/app/data/zcajs-inbound-queue.jsonl
```

Set the cookie/IMEI/user-agent directly in the deployment provider. Do not commit or paste these values into source control, tickets or chat.

Health endpoints:

- `GET /health` — process health; returns login/listener state and `pendingInbound` queue depth without credentials.
- `GET /ready` — 200 only after the Zalo session has logged in.

Inbound durability:

- Every normalized message is written to `ZCAJS_INBOX_QUEUE_FILE` before the first CRM HTTP attempt.
- Messages are removed only after the CRM returns success; transient failures keep retrying with capped exponential backoff.
- On worker boot the queue is replayed before/during listener startup, so a CRM deploy or worker restart no longer drops the customer messages that were waiting.
- The queue is a JSONL file owned by the worker process (mode 0600). Mount a persistent disk if the deployment provider restarts containers onto fresh filesystems.

## Current supported message scope

- direct inbound text -> CRM inbox
- direct inbound Zalo photo/image attachment -> CRM inbox image preview
- direct outbound text from CRM -> Zalo
- direct messages sent manually from the connected Zalo account -> mirrored into CRM as outbound history
- **group inbound messages -> CRM inbox** (one conversation per Zalo group)
- **group outbound text/media from CRM -> Zalo group**
- group messages sent manually from the connected Zalo account -> mirrored into CRM as outbound history
- group conversations are stored under the `group:<groupId>` namespace; individual messages are prefixed with the sender's Zalo display name
- group discovery is message-driven: the pinned ZCAJS fork has no group directory, so a group appears in CRM after its first inbound or observed outbound message
- group history cannot be replayed after worker downtime because the pinned fork exposes no group-history endpoint (the reconnect rescan covers 1:1 chats only)
- unsupported non-text attachment types are represented with a safe placeholder/link when possible
- outbound CRM success requires the stable `msgId` returned by ZCAJS; missing IDs are marked `UNCERTAIN`, never synthesized

Provider-hosted image URLs are rendered with `referrerPolicy=no-referrer` and an external-link fallback. They can expire according to Zalo/CDN behavior; permanent media archiving is not part of this bridge.

## Temporarily disabling AI auto-replies on Zalo

The durable switch is `ai_brain_live_settings.enabled` for channel `ZALO` in AI Control Center (`/admin/ai`). The repository migration `20261029120000_zcajs_groups_and_zalo_ai_pause.sql` disables it and closes pending Zalo AI deliveries so a later re-enable cannot send stale replies.

There is also an immediate environment brake on the CRM web service:

```env
ZALO_AI_AUTO_REPLY_ENABLED=false
```

`false` stops every automated AI Zalo send (AI Brain live worker and the Response SLA runtime) while manual Sale replies continue to work. AI is never allowed to answer a Zalo group even after re-enabling the channel. To restore AI, set the channel back to enabled in AI Control Center and remove/true the env flag; see `docs/sql/zalo-ai-auto-reply-toggle.sql`.

## Important ZCAJS constraint

The selected fork states that only one Zalo Web listener can be active at a time. Opening the same Zalo account in Zalo Web while the worker listener is running can close the worker listener. The worker reconnects with backoff, but operators should avoid using the same account in Zalo Web during normal operation.

Because ZCAJS is an unofficial API that simulates Zalo Web, the selected repository also warns that account lock/ban is possible. This transport should therefore be treated as an explicit operational choice rather than an official Zalo API integration.

## Security rules

- Never log or return cookie, IMEI, user-agent session data or shared secret.
- Worker-to-CRM and CRM-to-worker calls use the shared secret over HTTPS.
- Production CRM rejects non-HTTPS worker URLs.
- The inbound endpoint derives `company_id` from server environment, never from the worker payload.
- The worker rejects outbound requests for any company other than its configured company.
- Native self messages use a dedicated non-dispatch persistence RPC to prevent send loops.
- CRM-originated self echoes are suppressed in the worker and also deduped at the database by provider message id.
- Network/5xx ambiguity is classified `UNCERTAIN` so the CRM does not automatically resend and create duplicate customer messages.
