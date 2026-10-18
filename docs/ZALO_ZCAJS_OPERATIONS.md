# ZCAJS transport for CRM Zalo

This integration uses the user-selected fork `ngogiaphat/ZCAJS` as the personal-account Zalo transport while preserving the existing CRM Zalo inbox, tenant isolation, durable outbound fencing and official Zalo OA implementation.

## Pinned upstream

The worker image builds directly from:

- Repository: `https://github.com/ngogiaphat/ZCAJS.git`
- Commit: `0d99d7d025f5183822d627088fac89d1f55ef691`
- Package version at that commit: `zca-js@1.2.1`

The fork does not commit its `dist/` directory and has no `prepare` script. Its committed `package-lock.json` is also out of sync with `package.json` at the pinned commit, so `npm ci` cannot build that exact fork. The worker Dockerfile therefore clones the exact commit, runs `npm install` to resolve the fork's declared dependencies, builds it, and installs the resulting package tarball. It does not silently substitute another ZCAJS repository or npm/upstream implementation.

## Architecture

Inbound:

`Zalo personal account -> ZCAJS WebSocket listener -> ZCAJS worker -> POST /api/inbox/zalo-zcajs/inbound -> ingestNormalizedEvent -> Unified Inbox`

Outbound:

`Unified Inbox -> durable Zalo outbox -> ZcaJsTransportClient -> ZCAJS worker /v1/send -> api.sendMessage -> Zalo user`

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
```

Set the cookie/IMEI/user-agent directly in the deployment provider. Do not commit or paste these values into source control, tickets or chat.

Health endpoints:

- `GET /health` — process health; returns login/listener state without credentials.
- `GET /ready` — 200 only after the Zalo session has logged in.

## Current supported message scope

The bridge intentionally starts with direct text messages only:

- direct inbound text -> CRM inbox
- direct outbound text -> Zalo
- group messages are ignored
- non-text inbound events are ignored
- outbound success requires the stable `msgId` returned by ZCAJS; missing IDs are marked `UNCERTAIN`, never synthesized

This keeps the current CRM idempotency and no-duplicate-send guarantees intact.

## Important ZCAJS constraint

The selected fork states that only one Zalo Web listener can be active at a time. Opening the same Zalo account in Zalo Web while the worker listener is running can close the worker listener. The worker reconnects with backoff, but operators should avoid using the same account in Zalo Web during normal operation.

Because ZCAJS is an unofficial API that simulates Zalo Web, the selected repository also warns that account lock/ban is possible. This transport should therefore be treated as an explicit operational choice rather than an official Zalo API integration.

## Security rules

- Never log or return cookie, IMEI, user-agent session data or shared secret.
- Worker-to-CRM and CRM-to-worker calls use the shared secret over HTTPS.
- Production CRM rejects non-HTTPS worker URLs.
- The inbound endpoint derives `company_id` from server environment, never from the worker payload.
- The worker rejects outbound requests for any company other than its configured company.
- Network/5xx ambiguity is classified `UNCERTAIN` so the CRM does not automatically resend and create duplicate customer messages.
