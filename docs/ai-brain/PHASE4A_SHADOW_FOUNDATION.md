# Phase 4A — AI Brain Shadow Execution Foundation

## Overview

Phase 4A introduces the background shadow execution worker for the AI Brain. It enables safe, non-invasive evaluation of AI Brain responses against real inbound customer interactions without customer message dispatch.

Companion contracts:
- [Architecture](./ARCHITECTURE.md)
- [Phase 1 Contract](./PHASE1_CONTRACT.md)
- [Phase 1B Javis Adapter](./PHASE1B_JAVIS_ADAPTER.md)
- [Phase 2 Context Gateway](./PHASE2_CONTEXT_GATEWAY.md)
- [Phase 3 Memory Foundation](./PHASE3_MEMORY_FOUNDATION.md)

---

## Execution Flow

1. **Trigger Enqueue**: Database trigger `trg_interactions_ai_brain_shadow_enqueue` maps interaction channel (`FACEBOOK` -> `MESSENGER`, `ZALO` -> `ZALO`). Only rows with `type = 'MESSAGE'`, `direction = 'INBOUND'`, `actor_type = 'CUSTOMER'`, `sanitization_status = 'SUCCEEDED'`, non-blank `public.interactions.sanitized_content` string (never metadata), and active `public.ai_brain_shadow_settings` (`enabled = true`) enqueue a `PENDING` run into `public.ai_brain_shadow_runs`.
2. **Lease Claim**: Worker calls atomic stored procedure `claim_ai_brain_shadow_runs(p_limit, p_lock_token)`. Leases are represented by `locked_at` with a 5-minute timeout window (no `lease_expires_at` column). Stale processing runs on their final attempt (`attempts >= 5`) transition to `FAILED` with `BRAIN_TIMEOUT`. Candidate runs transition to `PROCESSING` with incremented `attempts` up to 5 total attempts (not 5 retries).
3. **Settings Verification**: The worker rechecks `public.ai_brain_shadow_settings` by `company_id` and `channel`. An empty settings table defaults OFF. If disabled or missing after enqueue, the run transitions to `SKIPPED` without invoking external models.
4. **Context & Tenant Scope**: The worker builds server context using opaque scoped UUIDs (`company_id`, `customer_id`, `conversation_id`), channel, and standard workload actor UUID `00000000-0000-4000-8000-0000000000a1` under `READ_ONLY` permission profile. Provider requests exclude private customer contact data, raw messages, and transport credentials.
5. **Provider Execution**: Invokes configured provider bounded by timeout. Only `RESPOND` carries delivery `DRAFT_ONLY` with draft text; `HANDOVER`, `NO_REPLY`, and `ERROR` never produce customer delivery. No customer send APIs or webhook model calls exist. Currently tools, source, and memory reference arrays remain empty per existing provider contract (no context-tool bridge or memory distillation added).
6. **Settlement**: Worker settles runs via `finish_ai_brain_shadow_run(p_id, p_lock_token, p_status, ...)` with explicit result fields:
   - Persists decision, draft, confidence, handover flags and reason, provider, model, latency_ms, error_code, turn_id, trace_id, and ref arrays (no token usage column).
   - Fencing requires matching `p_lock_token` and `locked_at > now() - interval '5 minutes'`.
   - Failed runs back off linearly via `min(300, 30 * attempts)` seconds.

---

## Cron Route (`/api/cron/ai-brain-shadow`)

A separately configured scheduler may invoke this endpoint; this change creates no scheduler.
- **HTTP Methods**: Supports `GET` and `POST`.
- **Authentication**: Requires `Authorization: Bearer $CRON_SECRET`. Constant-time comparison uses `timingSafeEqual`. Missing secret yields `503 Service Unavailable`; missing or invalid Bearer token yields `401 Unauthorized`.
- **Query Parameter Strictness**: Accepts only `?limit=<1..10>` (default: `5`). Leading zeros, fractions, out-of-range values, duplicate keys, or unknown parameters are rejected with `400 Bad Request`.
- **Fault Boundary**: Internal exceptions are suppressed; endpoint logs a safe error and returns `500 Worker error`.

---

## Environment Configuration

Server-only provider configuration from `.env.example`:

```bash
# AI Brain / Javis-compatible internal Brain Service
# Server-only. Shadow Mode remains disabled until ai_brain_shadow_settings is explicitly enabled.
JAVIS_BRAIN_BASE_URL=
JAVIS_BRAIN_INTERNAL_TOKEN=
```

Never prefix these variables with `NEXT_PUBLIC_`. If unset or invalid, the provider fails closed to `BRAIN_UNAVAILABLE`.

---

## Operational Reality & Verification Evidence

- **Local Verification Evidence**:
  - 168 unit tests passing (including 19 shadow worker + 12 shadow cron).
  - Memory DB: 3/3 passing.
  - Shadow DB: 9/9 passing after clean reset.
  - 6 required regression test scripts passed.
- **Build / CI Status**: Local validation commands: npm run lint, npm run typecheck, npm run build. Hosted CI must pass for the current PR head before merge.
- **Hosted State**: No production DB inspection was performed in this work. This change does not seed production settings, apply production migrations, configure scheduler or environment variables, or provision Javis. Existing hosted staging and production states remain unverified.
