# Phase 1B — Javis Brain Service Adapter Skeleton

## Status

Phase 1B adds a **server-only, provider-neutral HTTP adapter skeleton** from the CRM `BrainProvider` contract to a future Javis-compatible internal Brain Service.

It does **not** deploy Javis OS, call a live model, read CRM data, send customer messages, or change telephony behavior.

## Why CRM does not call Javis OS `/chat` directly

Javis OS exposes `/chat` for its CLI and owner-facing conversational shell. That API is designed around Javis sessions, brains and agent/tool behavior and returns a conversational result.

The CRM boundary has different requirements:

- every turn is already scoped by trusted `companyId`, `customerId` and `conversationId`;
- Phase 1 is `READ_ONLY` and draft-only;
- the remote side must return a small structured proposal rather than arbitrary authority metadata;
- raw remote errors must never become CRM errors/logs;
- customer-facing runtimes must not receive a general Javis owner token or broad Javis capabilities;
- future Messenger, Zalo and Voice callers must use the same schema.

Therefore Phase 1B targets a narrow companion service contract. That service may later wrap/reuse Javis OS internally.

## CRM → Javis-compatible service

Endpoint:

`POST /v1/brain/turn`

Transport requirements:

- HTTPS only in Phase 1B;
- `Authorization: Bearer <server-only credential>`;
- `X-AI-Brain-Contract: v1`;
- `Content-Type: application/json`;
- redirect following disabled;
- request deadline is owned by the existing CRM `BrainService` and propagated with `AbortSignal`.

The request body is the already-authorized immutable `BrainTurnRequest` from Phase 1A. Credentials and caller identity are not added to the body.

Expected response envelope:

```json
{
  "ok": true,
  "version": "v1",
  "proposal": {
    "decision": "RESPOND",
    "draft": "...",
    "confidence": 0.9
  }
}
```

The proposal is validated at the adapter boundary and again by `BrainService`.

Phase 1B still rejects non-empty `toolsUsed`, `memoryReferences` and `sourceReferences`, because CRM Context Tools and memory retrieval are not implemented yet.

## Health contract

Endpoint:

`GET /health`

Expected response:

```json
{
  "ok": true,
  "service": "javis-brain",
  "version": "v1"
}
```

The same server-only bearer credential is used. No CRM/customer payload is sent by the health request.

## Error behavior

The adapter does not inspect or return non-2xx response bodies. Network failures, malformed JSON, unexpected response keys, authority-expanding proposals and remote contract mismatches are treated as provider failures by the outer `BrainService`.

The outer service continues to own canonical errors:

- `BRAIN_TIMEOUT` when its deadline aborts the request;
- `BRAIN_PROVIDER_ERROR` for remote/provider failures;
- existing policy/context errors remain unchanged.

No raw provider response, token, authorization header or chain-of-thought is exposed.

## URL and credential policy

Phase 1B requires a server-owned HTTPS base URL with:

- no embedded username/password;
- no query string;
- no fragment.

HTTP/private-network transport is intentionally not enabled implicitly. If a later deployment requires private HTTP, that is a separate explicit deployment/security decision.

The adapter accepts its credential through constructor options only. Phase 1B adds no environment variables or production configuration and does not instantiate the adapter in any production route/worker.

## Not implemented in Phase 1B

- no live Javis service deployment;
- no Javis OS `/chat` direct integration;
- no CRM Context/MCP tools;
- no Company Brain or Customer Memory storage;
- no tool execution;
- no Messenger/Zalo auto reply;
- no Stringee/PSTN changes;
- no outbound calls;
- no database migration;
- no new production secret;
- no scheduler or background automation.

## Next phase

Phase 2 should build the **CRM Read-only Context Gateway / tools**. Only after tenant/resource authorization is proven should a Javis-compatible service be allowed to request customer profile, conversation, deal, note, call and knowledge context.
