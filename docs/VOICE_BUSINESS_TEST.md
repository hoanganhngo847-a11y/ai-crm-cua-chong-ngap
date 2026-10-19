# Business-aware Stringee app-to-app test

Baseline audited: `77fd5073df40b2e67c6e1477fe1877caa684f4d0`.

## Audit findings

- Human flow: `CallToCustomerButton` → `callCustomerViaVoiceAction` → `executeClickToCall` → per-company provider → Stringee REST → signed webhook → `apply_voice_call_status_atomic`.
- Previously the human flow created a call/audit but no attempt. The AI scheduler already had a separate durable attempt/dispatch flow; it is not used to schedule human test calls.
- Diagnostic A/B calls previously bypassed CRM preparation entirely. The five baseline status events had no corresponding CRM call.
- Customer detail had a decorative call button. Inbox had no call entry. `/calls/[customerId]` already had the softphone but derived the customer name from history, losing context for a first call.
- Status processing previously allowed nonterminal regressions and terminal outcomes to overwrite each other. An event persisted before call-id binding could not be applied on retry.
- Existing domain-specific intake fields (`door_type`, `flood_depth_mm`, `survey_address`, etc.) remain technical debt and are unchanged.

## Business test

1. Explicitly enable `STRINGEE_APP_TO_APP_TEST_PROJECT_ID` for the intended test project; recording must be off. This does not enable PSTN or change billing.
2. A trusted operator creates a synthetic customer without a phone in the test tenant, and registers its customer/integration IDs in service-only `voice_test_customers`. Real customers are excluded from the test route/action.
3. Open the customer context → call history → “Thử cuộc gọi CRM tới Client B”. The page/action retain the existing diagnostic BOSS_ADMIN restriction.
4. Use the peer link to open Client B in a separate tab. Each business-test tab mounts only one SDK client. Connect A and B; call from A. The same `executeClickToCall` helper authorizes the customer and atomically creates a call, Stringee attempt, actor association/audit and a short-lived A/B reservation before `makeCall`.
5. The signature-verified, project-checked Answer URL binds the canonical Stringee call ID to that prepared call/attempt. It never creates a new call for this route. Early status events are reconciled.
6. Answer B, speak in both directions, hang up. The existing signed status processor drives the lifecycle. Only webhook evidence can establish CONNECTED/COMPLETED; the browser cannot report successful lifecycle status to the database.
7. Compare specific call/attempt/event IDs, not only counts. Re-deliver a status and confirm one persisted idempotency key and no duplicate call/attempt.

Microphone and remote live-track/signal indicators are provided for each client. An explicit “Bật âm thanh” button handles autoplay rejection. Signal detection proves non-silent remote media, not intelligible human speech; a listener must confirm the latter. There is no recording or audio upload. Close/hangup releases media playback and meters.

Human Sale attempts do not advance AI retry stages. Production PSTN still resolves its original tenant provider and private phone server-side. Browser test mode never invokes a PSTN provider and receives no raw customer phone, integration credentials, or server secrets.

## Verification

- `npm run test:voice:unit`: identity length/routing, signatures, recording policy and existing provider units.
- `npm run test:voice:business`: all repository migrations on PostgreSQL/PGlite; preparation, actor/tenant/customer/integration denial, retry idempotency, early event reconciliation, monotonic lifecycle, attempt finalization, no human retry/stage mutation, service-only access.
- Voice CI additionally runs the existing real Supabase auth/security/Voice suites, lint, build and typecheck.
- Local PostgreSQL/PGlite does not prove real provider behavior, microphone permission, network media, PostgREST/JWT behavior or true multi-connection concurrency. Production verification is reported separately.

Production media verification observed one-way reception with two SDK clients in one page, and live non-silent remote audio in both directions with one client per tab. Business test UI therefore isolates the SDK contexts by default. This does not assert a provider root cause or intelligible-speech confirmation.
