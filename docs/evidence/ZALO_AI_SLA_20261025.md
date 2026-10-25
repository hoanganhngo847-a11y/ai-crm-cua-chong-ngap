# Zalo AI production investigation, 25 October 2026

## Verified production facts

- Target delivery `fa56dc6a-5c0a-41d1-939c-5fafca232a03`: FAILED, attempts 5, BRAIN_PROVIDER_ERROR, sent_at NULL. Last brain_turn_id `2d0b2171-8947-4785-a36e-9b63a8d910b3`.
- Source interaction `1453a2e8-9937-4a23-bb87-912664f3a803`: CUSTOMER/INBOUND at 11:19:49.892973 UTC (18:19:49 Vietnam). Delivery created 11:19:49.878611 UTC, completed 11:28:00.648075 UTC. Current available_at 11:30:30.648075 is the final retry timestamp; it does not preserve initial availability.
- Production enqueue omits available_at; its default is now(). Production claim had no five-minute source-message age gate. Therefore queue creation did not enforce the requested SLA. Original first claim time is not recorded in the delivery row.
- Render logs queried for CRM, Brain and Runtime between 11:19 and 11:29 UTC returned no entries. The precise exception for this historical delivery cannot be reconstructed from those results. Absence of returned logs does not establish that no request arrived.
- Saved Render CRM/Brain credentials match. Saved Brain/Runtime credentials match and the runtime token has the required jvs_ prefix. No token was rotated.
- CRM and Brain live commit at investigation: `3af107299fadcef49c18d79dae966fc5e4f58d11`. Runtime live commit: `76e066d4566f0b85b31ed39e0fa83a3030497161`.
- Runtime start command seeds server/.api_tokens.json from JAVIS_RUNTIME_INTERNAL_TOKEN, hashes with SHA-256, scope chat; no JAVIS_STATE_DIR override is saved. Exact deployed config.py confirms this path and verification contract. Local isolated tests of that exact source accepted the correct synthetic token, rejected a wrong token and denied /settings to chat scope. These are not filesystem inspection of the running container.

## Reproduced current failure (synthetic only)

- Synthetic Brain turn `e956aee8-d7af-4d65-9e42-6c2f826f3c03`, trace `907dce4d-dc51-46b8-96c9-8d220f9c6e62`: Brain 500 at 12:39:40.577 UTC, latency 22776 ms. Runtime /chat returned 200 immediately before it at 12:39:40.560 UTC.
- Independent authenticated synthetic /chat: HTTP 200, ok:false, nonempty text containing Gemini 404 and model unavailable for new users: models/gemini-2.5-flash. This proves runtime auth passes and the configured model rejects generation. It does not prove the historical target failed for the same cause.
- Wrong synthetic jvs_ token: HTTP 401 at 12:39:37.620 UTC.
- No Zalo transport invoked by these probes. No production interaction/delivery inserted for testing. No historical delivery replayed.
- Direct model probe from the local machine timed out, so it supplies no inference proof.

## Repair

- Safe error codes and numeric upstream status travel from Runtime backend through Brain headers to the CRM result; response bodies/secrets/customer text are excluded from error logs and DB metadata.
- Runtime HTTP 200/ok:false is never interpreted as a proposal. Known numeric model statuses distinguish invalid configuration, throttling and timeouts. Unknown free-form failures remain MODEL_PROVIDER_ERROR.
- Each model turn receives an independent runtime session, preventing cross-customer shared-session context.
- Additive migration enforces five-minute initial availability and claim age, adds retryable, stops auth/config retries and makes existing FAILED Zalo deliveries non-retryable. It preserves dispatch fencing even on production schema versions without optional Messenger dispatch columns.
- Before generation and immediately before transport, a service-only DB gate revalidates lease, ACTIVE mode, SLA, live settings and absence of Sale/Technician/AI reply since the inbound.
- Local gate evidence and deployment/acceptance results must be appended when established. No SENT claim may be based on synthetic fixtures.

## Selective replay, owner action only

Start with a read-only review (replace the placeholder with ONE explicitly selected UUID):

```sql
select d.id, d.company_id, d.conversation_id, d.source_interaction_id,
       d.send_status, d.attempts, d.retryable, d.error_code, d.sent_at,
       i.created_at as inbound_at, c.ai_mode
from public.ai_brain_live_deliveries d
join public.interactions i on i.id=d.source_interaction_id
join public.conversations c on c.id=d.conversation_id
where d.id = '<ONE_OWNER_APPROVED_DELIVERY_UUID>'::uuid and d.channel='ZALO';
```

A later explicitly authorized replay can reset that exact FAILED/unsent row to PENDING, attempts=0, retryable=true and available_at=now() in a transaction guarded by the expected company/conversation/source IDs and no existing outbound command `ai-live:<source_interaction_id>`. Do not run a bulk UPDATE or automatically reset failures after deployment. Recheck the existing outbox for accepted/uncertain dispatch before authorizing replay; the worker's normal SLA/human/idempotency guards still apply.

## Local validation before commit

- AI Brain: 316/316; Javis Brain: 81/81, including real HTTP diagnostic propagation.
- Local PostgreSQL SLA/retry regression passed, migration applied twice inside a rolled-back transaction; existing live DB suite 9/9.
- Integration gate 28/28; voice unit and local Supabase integration passed; Next.js webpack production build and standalone Brain build passed.
- Lint: zero errors (13 existing warnings). Typecheck and git diff --check passed.
- Production security advisor baseline contains pre-existing findings outside this repair; no new grants to client roles are introduced.
