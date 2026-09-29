# Facebook / Website pre-merge remediation

Scope: `feature/facebook-website`, original HEAD `183b2a0f2f00ce5ba01cd3a75c10bc33a3dc375f`.

## Identity and intake

- Only an existing Facebook Page/PSID identity selects an existing customer. Extracted or submitted phone numbers are unverified candidates, even when they match a verified contact belonging to somebody else.
- A new sender or Website submission with a matching phone gets a separate customer and durable `IDENTITY_REVIEW` intake record. The candidate phone stays private. Existing identities keep their customer; contact conflicts never overwrite an existing contact. Review is audited in the same transaction. No automatic merge is performed.
- Website `request_id` is solely an idempotency/event key. Website has no persistent external identity until a separate verification/linking contract exists. Repeat requests with the same key return the same interaction; a different key is a new submission and can require identity review.
- Invalid CAPTCHA does not consume phone/global business quota. Production requires Turnstile, hostname and `lead` action checks. Development without a Turnstile secret keeps the existing local-only bypass. Edge flood protection is a deployment concern, independent of business quotas.

## Tenant and provider binding

- Migration 005 adds tenant-scoped uniqueness and foreign keys for intake interaction, outbox conversation, outbox interaction (including its conversation), care delivery and actor membership. Existing migrations 001–004 are unchanged.
- `META_PAGE_BINDINGS` is a server-owned JSON array of `{page, company, tokenEnv}`. Each Page is unique. `tokenEnv` names the environment variable holding that Page's access token. All Pages belong to the Meta application verified by `META_APP_SECRET`.
- Webhook company comes from the mapping of the signed entry's Page ID. Every entry/recipient is validated before intake starts. No request-supplied company is accepted.
- Inbox can select `?page=PAGE_ID`; the server derives Company from configuration and verifies membership/role. With multiple configured Pages, omitting the selector fails with `PAGE_REQUIRED`. Existing single-Page environment variables remain supported when `META_PAGE_BINDINGS` is absent.
- Conversation and campaign reads use Foundation authorization with the same `NOT_A_MEMBER` → 404 masking semantics. Other auth errors keep their denial status. Foundation files are unchanged.

## Sanitization and inbox

- Sanitization runs synchronously within a bounded 10,000-character intake/send operation. Numeric phone-like runs, spelled digit sequences, explicit contact fields, email addresses and URLs are redacted. Measurements such as `2.5m`, `40cm`, quantities and ordinary slash-separated dates/times remain useful.
- Ambiguous spelled-number content and unsupported numeric scripts terminate as `FAILED` with null content. New writes cannot enter `PENDING`. This is the bounded processing alternative to a background worker; failed content never falls back to raw. A future recovery/reprocessing UI is outside this branch.
- This migration is for the unmerged, unapplied 005 baseline. If the original 005 has already been deployed anywhere, do not reapply it: ship an additive migration including a bounded reprocessing path for existing `PENDING` rows and removal/review of legacy Website identities.
- Inbox sorts and paginates by `(last_message_at DESC, id DESC)` with a matching index. Activity updates between pages can move conversations, so consumers should refresh the first page for new activity.

## Verification

- `npm run test:omnichannel`: route/runtime tests, including CAPTCHA quota ordering, signature/Page checks, multi-Page configuration, resource masking, inactive user/member, role denial, sanitizer, 24h window and transport failure handling.
- `npm run test:omnichannel:db`: real PostgreSQL transactional tests, including duplicate intake, idempotency conflicts, identity conflicts, Website identity model, tenant FKs, private/raw separation, outbox replay, wrong tenant/actor, inactive user/member, role denial, window closure, care opt-out, audit rollback and business quotas. Requires the local Supabase stack with migration 005 applied; fixtures are rolled back.
- `.github/workflows/verify.yml` runs lint, typecheck, runtime tests, local Supabase, auth/security/database tests, build and whitespace checks on PRs and branch pushes. A workflow file alone does not configure branch-protection requirements or prove a hosted run has passed.

Local execution on 2026-09-23 (Node 24.21.0, Next 16.3.5, Supabase CLI 2.117.0, PostgreSQL 17):

| Check | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:auth` | 66 passed, 0 failed |
| `npm run test:security` | 119 passed, 0 failed |
| `npm run test:omnichannel` | 6 test groups passed, 0 failed |
| `npm run test:omnichannel:db` | 44 assertions passed; transaction rolled back |
| `npm run build` | PASS with local Supabase URL/anon key |
| `git diff --check` | PASS |

The first build attempt without Supabase environment variables failed during prerender; rerunning with the local stack's public configuration passed. Meta and Turnstile calls use test doubles; no live provider messages or lead submissions were sent. Hosted CI has not run for these uncommitted changes.
