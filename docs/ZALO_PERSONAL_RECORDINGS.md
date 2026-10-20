# Zalo Personal recordings

This module adds an independent recording domain alongside the telephony `calls`
table. The existing table requires a customer, a phone-provider enum and transcript
state; changing those contracts would couple unknown Zalo callers to Stringee and
the media/AI pipeline. The additive `zalo_personal_calls` table supports unknown
customers/direction without modifying telephony, OA messaging or ZCAJS workers.

## Authority and privacy

- `zalo_recording_devices`: registered tenant, optional active staff, immutable
  per-device account context, random 256-bit credential SHA-256 hash, revocation.
- Device registration/revocation requires the current active Boss and production
  AAL2 through the existing trusted actor chain. Credentials display once.
- `POST /api/voice/zalo-personal/recordings`: device UUID header and bearer device
  secret. No browser session, client-supplied company/staff, service key on Mac,
  Zalo session/token/password/cookies/chat ingestion, transcription or AI work.
- Body is bounded while streaming (50 MiB + 64 KiB envelope); file max 50 MiB.
  Metadata schema, direction, names, confidence, timestamp order, duration <=7200 s,
  MIME, ISO-BMFF audio-only AAC stereo container and media duration are validated.
  The server does not decode speech or independently verify signal flags.
- `zalo-call-recordings` is a dedicated private bucket. Browser Storage access is
  denied even if another permissive policy exists. Paths are generated server-side:
  `company/<company-id>/zalo/YYYY/MM/<call-id>.m4a`. MIME, size and SHA-256 persist.
- Playback requires current actor authorization and mandatory audit before a
  60-second signed capability. SALE sees only its device-attributed calls in the
  same tenant; BOSS_ADMIN sees tenant calls. TECHNICIAN is denied. No MANAGER role
  exists in this repository; none is invented by this module.
- Direct user writes/RPC execution and device hash reads are denied. All trusted
  mutating RPCs have empty search_path and explicit service_role-only execution.

## Persistence and retry

The authoritative uniqueness key is `(company_id,device_id,local_call_id)`.
Reservation takes a PostgreSQL advisory lock and creates a fenced 5-minute lease.
The call stays UPLOADING until the private object exists with the expected size.
After upload, a transaction attaches any safe mapping, marks READY and audits it.
No JavaScript rollback is used for database atomicity.

An exact replay of a READY call returns the existing call/recording IDs without
another Storage upload. Different bytes/metadata under that key return 409.
Concurrent requests yield a single lease holder. A crashed request can retry after
lease expiry: an existing immutable object is downloaded and checksum-verified,
then reused; a stale lease cannot finalize a newer upload. Failed finalization
keeps the object and reservation for recovery. Revocation is checked again inside
finalization; no recording is exposed through CRM history until READY.

The Mac queue persists each transition atomically and retains local recordings.
Keychain holds the device secret; configuration and queue files do not. Startup
rebuilds missing/corrupt queue entries from finalized schema-version-1 companions.
Historical/schema-less files are not imported automatically. Exponential retry is
bounded at 12 attempts/one-hour maximum delay; `--retry-uploads` is explicit recovery.

## Matching

Names are NFKC-normalized, trimmed, collapsed and lowercased for contextual lookup;
the original is retained. Accent-insensitive forms serve suggestions and duplicate
protection only. No name normalization asserts global uniqueness.

`zalo_customer_identity_mappings` retains multiple confirmed customers for the same
tenant/account/name context. Exactly one active, non-conflicting mapping may auto
attach. Multiple same-name CRM customers, multiple mappings, or an existing
needs_confirmation flag force manual confirmation. A contradictory manual link
marks existing mappings as requiring confirmation even when "remember" is off.
One confirmation never silently overrides another person's mapping. Unknown
names cannot be remembered. Search returns at most 20 same-tenant safe customer
projections. The UI supports name/code search and phone-less customer creation.
Creation + stage history + attachment + optional mapping + audit are one DB
transaction; a repeated create action returns its existing customer.

Mapping state is EXACT, SUGGESTED or UNMATCHED; `identity_ambiguous` separately
records known ambiguity. No algorithm can detect an unobserved second person with
the same name or a Zalo account switch. Keep account contexts distinct and resolve
known conflicts with manual confirmation; do not interpret EXACT as a verified UID.

## Deployment and recovery

Apply new migrations after reviewing them; never modify frozen Foundation files.
`20261020073819_zalo_personal_recordings.sql` adds only the Zalo domain and bucket.
`20261020080032_restore_sla_rpc_only_writes.sql` restores the existing SLA RPC-only
RPC-only invariant and complete RPC-only access for the existing analysis/style
tables accidentally widened by the earlier core ACL restoration. Production
application paths already use their trusted RPCs. RPC execution rights remain
unchanged. This adds no AI processing.

Both are compatible with the previous application. Roll back application code if
needed while retaining recordings and schema. Do not drop buckets/tables or delete
local audio. Revoking a device stops new upload/finalization; existing signed URLs
remain valid until their short expiry. Correct configuration and run the queue
recovery command between calls after resolving a failure.

## Verification commands

```sh
BUILD_ONLY=1 bash local-agent/run.sh
bash local-agent/tests/run.sh
npm run test:zalo-recordings
npm run test:zalo-recordings:db
npm run test:integration-gate
npm run test:voice
npm run typecheck
npm run lint
npm run build
git diff --check
```

The Zalo test suites use generated stereo AAC and actual production SQL. PGlite
applies every migration; the real Supabase suite additionally tests PostgREST/JWT
ACLs, Storage, signed playback, real concurrent leases and interrupted upload
recovery. They establish synthetic A–D acceptance, not real Zalo-call acceptance.

Real A requires a new live call after device enrollment, automatic queue upload,
unmatched CRM call, playable speech, human customer confirmation and persisted
mapping. Real B requires another call on the same account/contact and correct
automatic attachment. C replays a stable local UUID; D uses known same-name
customers/mappings and must remain unlinked until confirmed. Record production
call IDs and observed results in `local-agent/VERIFICATION.md`; never put secrets,
recordings or private playback URLs into Git.
