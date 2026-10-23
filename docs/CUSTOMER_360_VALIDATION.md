# Customer 360 local validation — 2026-10-23

Base: `cf57dd0b0ea37c3505c181f7f0bcc9e2138e757c` (`origin/main`, fetched again before commit). Main repository only; no worktree or clone. No production mutation, deployment, customer send, Meta/Zalo setting change, or paid service.

All required local gates ran sequentially. Local Supabase environment was derived from `supabase status`; no production URL or credentials were used.

| Gate | Result | Seconds |
| --- | --- | ---: |
| `git diff --check` | PASS | 0.1 |
| `npm run typecheck` | PASS | 17.4 |
| `npm run lint` | PASS | 11.9 |
| `npm run test:customer-360` | PASS | 1.0 |
| `npm run test:customer-360:db` | PASS | 0.9 |
| `npm run test:security` | PASS | 18.6 |
| `node_modules/.bin/tsx --conditions=react-server --test tests/ai-brain/tenant-rpc-security-db.test.ts` | PASS | 1.5 |
| `npm run test:ai-brain` | PASS | 1.7 |
| `npm run test:javis-brain` | PASS | 1.5 |
| `npm run build:javis-brain` | PASS | 1.2 |
| `npm run test:zalo-recordings` | PASS | 33.9 |
| `npm run test:zalo-recordings:db` | PASS | 35.8 |
| `npm run test:ai-brain:live` | PASS | 0.8 |
| `npm run test:ai-brain:live-db` | PASS | 0.8 |
| `npm run test:meta-messenger` | PASS | 0.6 |
| `npm run test:ai-brain:messenger` | PASS | 1.0 |
| `npm run test:ai-brain:messenger-db` | PASS | 6.4 |
| `npm run build -- --webpack` | PASS | 48.6 |

Additional verification: `test:migration-integrity`: 13 passed, 0 failed. Customer 360 DB tests were rerun after the final null-token/null-lease fence change: 2 passed, 0 failed. The two DB cases contain identity, tenant FK/ACL, rate-limit, stale/expired/null lease, failure preservation, version history, paging/search/filter, timeline dedupe and actual recording/transcript RLS assertions.

Browser acceptance: native Chrome → local auth → Customer 360 list → synthetic customer dossier. Verified four identities/contact types, address/year/notes/owner, snapshot with CRM score 50, Zalo and Messenger messages, note, call, private playback, transcript and AI call summary. Audio reached currentTime=2, duration=2, readyState=4, media error=null. Saving a manual note returned success, added the timeline row, retained the previous snapshot, and showed pending refresh. Audio is a synthetic tone; transcript/summary and model output are explicit fixtures behind the real local Javis HTTP service/CRM adapter, not live inference/transcription proof.

Screenshots: [list](customer-360/list.jpg), [dossier](customer-360/dossier.jpg), [call/transcript](customer-360/call-transcript.jpg).

The first Zalo live DB run encountered old shared fixture state (tenant B had an enabled ZALO settings row left by other existing DB suites). Only the two source-defined synthetic fixture tenants' local delivery queue and the expected absent tenant-B setting were cleared; assertions were unchanged. The final sequential run passed.

The first production build exposed pre-existing unsupported helper exports in five cron routes under Next.js 16.3. Handlers were moved intact to sibling files and test imports adjusted without removing assertions. The final production build and affected regression suites passed.

Local Supabase security advisors: 21 existing-schema findings, no Customer 360 objects named. Advisor command exits nonzero for the existing `public.safe_staff_directory` SECURITY DEFINER view (ERROR), 19 existing mutable function search paths (WARN), and `pg_trgm` in public (WARN). This is a known baseline finding, not a clean whole-project advisor result. These unrelated historical objects were not modified by this module.

CI status is reported separately on the PR; local PASS is not hosted CI or production acceptance. See [architecture, security and deployment](CUSTOMER_360.md).
