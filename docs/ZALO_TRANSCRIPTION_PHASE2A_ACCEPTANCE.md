# Phase 2A production acceptance — 2026-10-21

## Result and scope

Phase 2A application rollout and the single authorized production transcription passed. The one-minute scheduler is active. No Phase 2B features, paid services, plan upgrades, or billing configuration changes were introduced. Existing compute and provider usage costs still apply.

The scheduler uses Supabase `pg_cron` → private `cron_internal` helper → `pg_net` → authenticated Render worker. It dispatches only for due work. Row locks, fresh lock tokens, retry/lease recovery, private recordings, and tenant checks remain in force. A one-minute polling interval supports the 1–2 minute latency goal; cold starts, backlog, and provider latency can increase completion time. Production automatic processing of a second call was deliberately not tested because authorization specified exactly one controlled test.

## Git, CI, and deployment

- Application PR: [#67](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/pull/67), merged after all **7/7 checks succeeded**.
- Feature head: `7ab3ef62f7d68de94d9ec6450070651509b4ad09` on `feat/zalo-transcription-automation`.
- Application merge/live commit: `88c5f96cf6e47e1dce0042a36bf70457faef3757`.
- Render service: `srv-db2dcguk1f9s73a289cg`, existing free web service in the confirmed My Workspace.
- Render deployment: `dep-dbcbqr0ae00c7398koe0`, verified `live` at `2026-10-21T13:27:56Z`.
- Auto-deploy configuration reported enabled, but no event/deploy appeared after merge. Exactly one manual deployment was triggered; the cause of the missing automatic trigger was not established.
- Post-merge main `Verify` run `39607582337` also succeeded.
- Smoke checks: `/login` → 200; unauthenticated POST to cron with an invalid query → 401 before parameter validation.

## Database and scheduler

Only additive RPC migrations were introduced. Existing migrations were not edited.

| Source migration / operation | Hosted recorded version | Verification |
|---|---|---|
| `20261021160000_zalo_targeted_transcription_claim.sql` | `20261021131610` | Service-only targeted claim, empty search path, tenant/READY/lease checks |
| `20261021160001_zalo_bulk_transcription_lease_recovery.sql` | `20261021131611` | Bulk delegates to targeted claim; expired attempts terminate safely |
| Manual scheduler setup operation | `20261021132902` | Private helper/history/status view; actual extensions installed |

Source filenames and hosted MCP migration timestamps differ; no old migration history was rewritten. Both RPCs deny `anon`/`authenticated`, allow `service_role`, and use `SECURITY DEFINER SET search_path=''`.

- Job: `zalo-transcription-worker`, `* * * * *`, active.
- Command: `SELECT cron_internal.invoke_zalo_transcription_cron();` — no token or endpoint in the cron command.
- Vault configuration was confirmed by the user and checked through booleans/metadata only. Secret values were not retrieved or printed.
- Actual scheduled idle runs at 13:40 and 13:41 UTC succeeded; later runs continued succeeding. Empty queue produced zero automatic HTTP dispatches.
- Final queue after the controlled test: COMPLETED 3; PENDING/PROCESSING/FAILED 0.

Managed Supabase owns `pg_net` objects through `supabase_admin`; `postgres` cannot revoke those owner grants. This is not proof of client API access. The supported boundary was independently verified: `anon`/`authenticated` are NOLOGIN, and public Data API requests with `Accept-Profile` set to `net`, `cron_internal`, or `vault` each returned **406 / PGRST106**. The private helper is not executable by `anon`, `authenticated`, or `service_role`. Recheck API exposure after configuration changes. See [official Supabase permissions documentation](https://supabase.com/docs/guides/database/extensions/pg_net#permissions).

Security Advisor had no new finding for the two RPCs; unrelated pre-existing findings were not changed.

## Exactly one controlled production test

| Evidence | Observed result |
|---|---|
| Call | `37fd17a2-dee9-4f49-a6b7-7036e16f7617` |
| Transcription | `08be9ad7-05b8-441b-996d-681977d99ee7` |
| Invocation | One targeted POST, `pg_net` request ID 1; no second invocation |
| HTTP result | 200, TARGETED, claimed 1, processed 1, failed 0 |
| Provider / model | GEMINI / `gemini-3.5-transcribe` |
| Final status | COMPLETED; attempts 0; no error code |
| Utterances | 15: CUSTOMER/LEFT 5, STAFF/RIGHT 10 |
| Recording | READY; original object exists in private `zalo-call-recordings`; checksum metadata present |
| Worker duration | 26,274 ms from sanitized Render invocation logs |
| Unrelated data | Full-row fingerprints of both completed baseline calls and transcriptions unchanged |

The test's initial provider field was the enqueue default OPENAI; the worker correctly persisted its configured GEMINI provider/model before processing. Original audio was not deleted or overwritten by this change. Transcript persistence was verified in the database; no claim is made that the CRM transcript screen was visually inspected or that transcription wording quality was manually rated.

## Independent validation and review

Passed: `npm run typecheck`, `npm run test:zalo-recordings`, `npm run test:zalo-recordings:db`, `npm run test:security`, `npm run test:auth`, `npm run test:cron-auth`, changed-file ESLint, `npm run build`, and `git diff --check`.

New behavior coverage: 27 automation cases, 8 bulk recovery cases, and 8 actual separate-connection PostgreSQL concurrency cases. Existing Gemini/OpenAI tests passed. The build retained four existing audio-splitter tracing warnings.

Scheduler SQL was also exercised against isolated PostgreSQL 17 with actual pg_cron/pg_net/Vault, including setup/enable/disable idempotency, empty queues, due-work dispatch, Vault validation, timeout/correlation, and expired-lease handling. Additional native verification used a nonsuperuser operator and a separate managed extension owner; NOLOGIN and private-helper assertions were tested with deliberate permission changes. No local validation reset the user's shared database.

Codex reviewed real diffs and requested corrections for lock-first claiming, bounded expired retries, native test isolation, sanitized logs, and managed permissions. Static tests that only mirrored source strings were removed. The original dirty checkout was preserved; implementation and review used isolated worktrees.

## Antigravity implementation and Codex integration

| Model | Job | Result / responsibility |
|---|---|---|
| Gemini 3.8 Flash High | `agy-38d69eb5` | COMPLETED; targeted locking and concurrency corrections |
| Gemini 3.8 Flash Medium | `agy-9ad40b21` | COMPLETED; bulk lease recovery |
| Gemini 3.8 Flash Medium | `agy-07a48e42` | COMPLETED; native test isolation, test wiring, initialization logging |
| Gemini 3.8 Flash Medium | `agy-1ce92f4c` | COMPLETED; remove source-mirroring tests |
| Gemini 3.8 Flash Medium | `agy-13397638` | COMPLETED; managed permissions documentation and assertions |
| Gemini 3.8 Flash Medium | `agy-272e5010` | COMPLETED; metadata inspection includes PUBLIC grants |

Codex independently validated the real diffs, SQL, CI, and production behavior, and controls Git integration. Production changes and acceptance were executed by Codex.
