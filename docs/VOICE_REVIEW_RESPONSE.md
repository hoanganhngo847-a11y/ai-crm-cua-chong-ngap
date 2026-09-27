# Voice review response — 2026-09-22

This branch addresses the review at HEAD `9e3f411` as follows:

1. Foundation ownership: `lib/sensitive/click-to-call.ts` and `proxy.ts` are restored to `main`; migrations 001–004 remain unchanged. The voice action injects a tenant provider into the existing Foundation click-to-call contract.
2. Tenant-scoped status lookup: calls are resolved by `company_id + provider + provider_call_id`; a matching unique partial index is added.
3. Trusted tenant routing: tenant-less webhook endpoints return 404. Dynamic endpoints resolve an opaque routing-token hash to an active provider integration. Stringee additionally requires signed `project_id` to match the configured provider account. OpenAI uses the integration-specific signing secret and API key.
4. Private phone boundary: the dispatcher uses `claim_voice_attempt_phone`; direct private-schema fallback was removed.
5. Atomic scheduler: attempt completion, retry creation, customer stage and stage history run in one PostgreSQL command.
6. Canonical stage history: transitions write `actor_type='AI'`, reason and source reference.
7. Atomic inbound identity: phone lookup/customer/private contact/PHONE identity are serialized by an advisory transaction lock. Call plus interaction creation is a second atomic, idempotent command keyed by tenant/provider/call id.
8. SECURITY DEFINER hardening: transcript/contact upserts validate parent tenant; transcript worker access also requires the corresponding claimed media job.
9. Recording reference: provider payload can no longer write `calls.recording_ref`; only the storage pipeline derives and persists the canonical path.
10. Worker boundary: due media jobs are claimed atomically with `FOR UPDATE SKIP LOCKED`; phone and transcript access require a claimed attempt/job.
11. Tests: voice regression tests assert the tenant-routing, private-boundary, transaction, actor, RPC and recording invariants. Runtime Foundation suites remain unchanged.
12. CI: `.github/workflows/voice-ci.yml` runs Supabase locally and gates lint, typecheck, auth, security, voice and build on branch pushes/PRs.

No pull request is created by this work, per repository-owner instruction.
