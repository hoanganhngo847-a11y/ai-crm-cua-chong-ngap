# Zalo Call Transcription: Dual Provider Architecture (OpenAI Whisper & Google Gemini)

## Overview

This document specifies the dual transcription provider architecture for the Zalo Personal Call pipeline in `ai-crm-cua-chong-ngap`. It details provider selection, metadata persistence, database migration design, error handling, security guarantees, and the safe production rollout plan.

---

## 1. Pipeline Architecture

```
Zalo Stereo Recording (.m4a)
           ↓
Private Supabase Storage (`zalo-personal-recordings`)
           ↓
Worker Claim (`zalo_claim_transcription_jobs`, Postgres SKIP LOCKED, 300s lease)
           ↓
Provider Resolution (`provider-factory.ts`, inside worker try/catch)
           ↓
Atomic Metadata Persistence (`zalo_set_transcription_provider_metadata`, fenced before quota)
           ↓
ffmpeg stereo split (local bounded process)
 ├── LEFT  channel = CUSTOMER (audio/m4a)
 └── RIGHT channel = STAFF    (audio/m4a)
           ↓
Selected TranscriptionProvider (`OPENAI` or `GEMINI`)
 ├── Left mono M4A  → RawUtteranceSegment[]
 └── Right mono M4A → RawUtteranceSegment[]
           ↓
Deterministic Merge (`merger.ts`, ordered by start_ms ASC)
           ↓
Atomic Persist (`zalo_complete_transcription`, fenced by lock_token)
 ├── `zalo_call_transcriptions` (COMPLETED, provider, model, full_transcript)
 └── `zalo_call_transcript_utterances` (speaker_role, channel, text, sequence)
```

---

## 2. Configuration & Environment Variables

### Provider Selection
| Environment Variable | Allowed Values | Default | Behavior |
|---|---|---|---|
| `TRANSCRIPTION_PROVIDER` | `OPENAI`, `GEMINI` | `OPENAI` | Default applied **only when undefined**. Blank, whitespace, or invalid explicit values **fail closed** with `INVALID_TRANSCRIPTION_PROVIDER` (no raw input in error). |

### OpenAI Provider
| Environment Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | When `TRANSCRIPTION_PROVIDER=OPENAI` | None | Secret, server-only. Never logged or exposed. |
| `OPENAI_TRANSCRIPTION_MODEL` | Optional | `whisper-1` (Zalo default) | **Shared Environment Caveat:** Shared with legacy voice intake (which defaults to `gpt-4o-transcribe-diarize`). For Zalo transcription, `whisper-1` is the only model validated for `verbose_json` segment-level timestamps. When unset in Zalo, it internally defaults to `whisper-1`. |

### Google Gemini Provider
| Environment Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | When `TRANSCRIPTION_PROVIDER=GEMINI` | None | Secret, server-only. Never logged or exposed. |
| `GEMINI_TRANSCRIPTION_MODEL` | Optional | `gemini-3.5-transcribe` | Dedicated verbatim speech-to-text model supporting word-level annotations. |

### Fallback Policy
**NO AUTOMATIC FALLBACK.** If `GEMINI` is selected and encounters an error (quota, auth, rate limit, timeout), it fails closed as a Gemini error. It **never** silently falls back to OpenAI, avoiding unexpected credit consumption.

---

## 3. Dedicated Gemini API & Model Specifications

### Official Documentation & Reference URLs
- **Speech-to-Text / Transcribe:** [Google Gemini Speech-to-Text Documentation](https://ai.google.dev/gemini-api/docs/transcribe)
- **API Key Management:** [Google AI Studio API Keys Guide](https://ai.google.dev/gemini-api/docs/api-key)
- **Files API:** [Google Gemini Files API Reference](https://ai.google.dev/gemini-api/docs/files)
- **SDK Documentation:** [Google GenAI JS SDK Reference](https://googleapis.github.io/js-genai/release_docs/), [GitHub Repository](https://github.com/googleapis/js-genai), and [@google/genai npm](https://www.npmjs.com/package/@google/genai)

### Core Provider Specifications
- **SDK:** `@google/genai` pinned exact `2.30.0` (verified in `package.json` and `package-lock.json`).
- **Model:** `gemini-3.5-transcribe` (dedicated verbatim speech-to-text model).
- **Audio Limits:** Maximum 30 minutes duration (`GEMINI_MAX_TIMESTAMP_MS = 30 * 60 * 1000`) and 25 MB per mono channel buffer (`MAX_PROVIDER_AUDIO_BYTES = 25_000_000`). Exceeding audio fails closed before upload with `AUDIO_TOO_LARGE` or `GEMINI_AUDIO_TOO_LONG`. No other limits are assumed or invented.
- **Audio Upload:** Files API (`client.files.upload`) used for mono M4A audio with MIME normalized to `audio/m4a`.
- **Cleanup:** Best-effort deletion in a `finally` block via Files API `delete` while time remains within the cleanup reservation window (`CLEANUP_RESERVE_MS = 10_000`). If deletion fails or the deadline expires before completion, uploaded file handles rely on Google's automatic 48-hour TTL. Original recording audio in Supabase storage (`zalo-personal-recordings`) remains completely unchanged.
- **Inference Mode:** Verbatim transcription with word-level timestamps:
  `generation_config.transcription_config.mode = { type: verbatim, timestamp_granularities: [word] }`.
- **Speaker Mapping:** Known strictly from channel geometry:
  - **LEFT channel = CUSTOMER**
  - **RIGHT channel = STAFF**
  - Stereo channels are split locally via ffmpeg and submitted independently. Diarization is never requested from Gemini.
- **Word Grouping:** Word annotations with `start_offset` and `end_offset` are deterministically grouped into utterance phrases based on sentence punctuation, natural pauses (>1500ms), and max word limits (40 words). First word `start_ms` and last word `end_ms` are preserved.
- **Missing Timestamps:** If the Gemini response lacks valid timestamp annotations, it fails closed with sanitized error code `GEMINI_TIMESTAMP_MISSING`.
- **Deadline Bounds & No Success After Deadline:** Operations are strictly bounded by an aggregate deadline (default 120s) with 10s reserved exclusively for cleanup (`CLEANUP_RESERVE_MS = 10_000`). Active primary work (upload, polling, inference) must return before `activeDeadline` (`overallDeadline - 10s`). If inference returns after the active or overall deadline, it is strictly rejected with `GEMINI_TIMEOUT`—late primary results are never treated as success, preventing stale results and microtask/timer races. Temporary uploaded Google Files API handles are deleted via best-effort cleanup in a `finally` block while time remains within the cleanup reservation window; if deletion fails or the hard deadline is exhausted (`remaining <= 0`), cleanup is skipped and files rely on Google's automatic 48-hour TTL, leaving original storage audio unchanged.

---

## 4. Metadata Persistence & Database Migration

### Need for Additive Migration
The existing table `public.zalo_call_transcriptions` included `provider text NOT NULL DEFAULT OPENAI`, but contained **no model column** and no general-purpose metadata JSON column. The only existing JSON column, `channels_silent`, is strictly reserved for left/right silence flags and must not be overloaded.

To durably and accurately track both the provider and model across all job states (processing, completed, failed, retry), an additive migration was created:
- Migration: `supabase/migrations/20261021150000_zalo_transcription_provider_model.sql`
- Adds column: `ALTER TABLE public.zalo_call_transcriptions ADD COLUMN IF NOT EXISTS model text;`
- Grant: `GRANT SELECT(model) ON public.zalo_call_transcriptions TO authenticated;`

> [!IMPORTANT]
> **Migration Status:** The migration file `supabase/migrations/20261021150000_zalo_transcription_provider_model.sql` is created in code but **not applied** to staging or production. Applying this database migration requires separate explicit authorization (DB before code).

### Atomic Service RPC
To eliminate quota waste and ensure accurate audit records even upon early failure, the worker updates `provider` and `model` **before audio upload and inference** via `public.zalo_set_transcription_provider_metadata`.

The complete function implementation, search path configuration, and security definer definitions are maintained directly in the migration file:
[`../supabase/migrations/20261021150000_zalo_transcription_provider_model.sql`](../supabase/migrations/20261021150000_zalo_transcription_provider_model.sql) as the single source of truth.

**Exact Fail-Closed Model Metadata:**
- Model identifier validation is strict and fail-closed (`validateSafeModelIdentifier`).
- Valid model strings must match pattern `^(?:models/)?[a-z][a-z0-9_.:-]*$` with max length 128.
- Whitespace trimming is rejected (model strings must match exactly without modification).
- Secrets and keys (prefixes like `sk-`, `bearer`, or `AIza`) are rejected.
- Any invalid model identifier throws permanent `INVALID_TRANSCRIPTION_MODEL` immediately before any metadata RPC or network request.

**Fencing Guarantees:**
- Enforces `company_id = p_company` (tenant boundary).
- Enforces `id = p_transcription_id` and `lock_token = p_lock_token` (exclusive claim).
- Enforces `status = PROCESSING` and active unexpired lease (`lease_expires_at IS NOT NULL AND lease_expires_at > now()`).
- Any NULL or expired lease is rejected with `TRANSCRIPTION_LOCK_LOST`.
- Fails before any API quota is consumed if the worker lost ownership.

**RPC Result Enforcement:**
- The worker strictly verifies that the RPC response `data === true`.
- If RPC returns `false`, `null`, or an error, execution fails closed immediately (raising `TRANSCRIPTION_LOCK_LOST` or `PERSIST_METADATA_FAILED`), preventing any subsequent audio download, upload, or provider quota consumption.

**ACL Security:**
- `REVOKE ALL ON FUNCTION public.zalo_set_transcription_provider_metadata(...) FROM PUBLIC, anon, authenticated;`
- `GRANT EXECUTE ON FUNCTION public.zalo_set_transcription_provider_metadata(...) TO service_role;`
- `authenticated` users can only read (`SELECT`) metadata, never invoke the RPC.

---

## 5. Error Classification & Defense-in-Depth Sanitization

### Error Categories
| Error Code | Classification | Action |
|---|---|---|
| `GEMINI_NOT_CONFIGURED` | Permanent | Marked `FAILED` (terminal). |
| `GEMINI_AUTH_ERROR` | Permanent | Marked `FAILED` (terminal). |
| `GEMINI_INVALID_RESPONSE` | Permanent | Marked `FAILED` (terminal). |
| `GEMINI_TIMESTAMP_MISSING` | Permanent | Marked `FAILED` (terminal). |
| `GEMINI_AUDIO_TOO_LONG` / `AUDIO_TOO_LARGE` | Permanent | Marked `FAILED` (terminal). |
| `INVALID_TRANSCRIPTION_PROVIDER` | Permanent | Marked `FAILED` (terminal). |
| `INVALID_TRANSCRIPTION_MODEL` | Permanent | Marked `FAILED` (terminal). |
| `GEMINI_TIMEOUT` | Transient | Retry scheduled with exponential backoff. |
| `GEMINI_RATE_LIMITED` | Transient | Retry scheduled with exponential backoff. |
| `GEMINI_PROVIDER_UNAVAILABLE` | Transient | Retry scheduled with exponential backoff. |

### Sanitization Rules (`sanitizeErrorMessage`)
- Google API Keys: Redacted to `AIza***` via `\bAIza[0-9A-Za-z_\-]{20,}\b`.
- Google Headers: Masked via `x-goog-api-key[:=\s]+\S+` → `x-goog-api-key: ***`.
- URL Query Keys: Masked via `key=[A-Za-z0-9_\-]+` → `key=***`.
- OpenAI Keys: Redacted to `sk-***` via `sk-[A-Za-z0-9_\-]{20,}`.
- Bearer Tokens: Redacted to `Bearer ***` via `Bearer\s+[A-Za-z0-9_\-.]+`.
- Local Filesystem Paths: Replaced with `[path]` via `\/[\w.\-]+(?:\/[\w.\-]+)+`.
- Safe Identifiers & Primary Validation Boundaries:
  - **Primary Application Validation:** Strict fail-closed validation occurs before logging and network calls. Providers are verified against the known provider allowlist (`OPENAI`, `GEMINI`). Models are strictly validated via `validateSafeModelIdentifier` against `^(?:models/)?[a-z][a-z0-9_.:-]*$` with a maximum length of 128 characters, rejecting whitespace, uppercase prefixes, and API secrets.
  - **Logger / Sanitizer Defense-in-Depth Filter:** The error message sanitizer applies secondary regex bounds (`^[A-Za-z0-9_]{1,32}$` for provider names and `^[a-zA-Z0-9_\-\.:\/]{1,64}$` for logged identifier snippets) to protect log output from injection, but this broad filter is not the primary validation gate.
- Cleanup & Lifecycle Bounds: Temporary uploaded Google Files API handles are cleaned up best-effort in a `finally` block while time remains within the deadline reservation window; if deletion fails or deadlines expire, files rely on Google's automatic 48-hour TTL, leaving private storage audio untouched.

---

## 6. Security & Multi-Tenant Guarantees

1. **Multi-Tenant Isolation:** Every RPC and query enforces `company_id` fencing. Cross-tenant reads and mutations fail with access denial or `TRANSCRIPTION_LOCK_LOST`.
2. **Private Storage:** Original recordings reside exclusively in private Supabase bucket `zalo-personal-recordings`. Original audio checksum is verified immutable throughout transcription.
3. **Customer Identity Linking Guarantees:** Customer identification relies strictly on verified outbound request EXACT context and inbound `DISPLAY_NAME_ONLY` with no heuristic auto-linking; ambiguous or suggested names require explicit manual confirmation. No business-specific identity hardcoding is permitted.
4. **Service-Role Boundary:** Database mutations are restricted to `service_role`. Client browser actors and Zalo Local Agents cannot modify transcription state or invoke internal RPCs.

---

## 7. Safe Future Production Rollout Plan

> [!CAUTION]
> NO production database migrations, code deployments, environment variables, or cron jobs should be modified without explicit separate authorization. Rollout must strictly follow the DB-before-code sequence.

1. **Step 1: Database Migration Deployment (Separately Authorized, DB Before Code)**
   - Apply additive migration `20261021150000_zalo_transcription_provider_model.sql` to staging/production under explicit separate authorization.
   - Verify column addition: `SELECT model FROM public.zalo_call_transcriptions LIMIT 1;`.
   - Verify RPC privileges & ACL: Confirm `anon` and `authenticated` execution is revoked, and execute is granted exclusively to `service_role` on `public.zalo_set_transcription_provider_metadata`.

2. **Step 2: Separately Authorized Merge & Deployment**
   - Render production tracks `main`. Only after DB migration and RPC verification succeed, merge `feat/zalo-transcription-gemini-provider` into `main` and deploy under separate authorization.
   - **Runtime Compatibility Verification:** SDK `@google/genai` 2.30.0 requires Node >= 20 (not a Node 22+ requirement). Local offline smoke tests passed on Node 22.23.3, but the actual Render runtime container is not live verified. Verify that the Render runtime provides a compatible Node version (Node >= 20) and that the existing ffmpeg static binary is present and executable.

3. **Step 3: Secure Environment Configuration (Keep Cron Off)**
   - In Render production dashboard (Environment Settings), configure:
     - `TRANSCRIPTION_PROVIDER` set to `GEMINI`
     - `GEMINI_API_KEY` set to authorized secret key from Google AI Studio
     - `GEMINI_TRANSCRIPTION_MODEL` set to `gemini-3.5-transcribe`
   - Retain existing `OPENAI_API_KEY` independently without fallback.
   - Keep recurring cron worker disabled/off during configuration.

4. **Step 4: Separately Authorized Controlled Single-Recording Validation**
   - **Queue Isolation & Safety Policy:**
     - Perform a **read-only queue inspection** first. Never clear, delete, or cancel unrelated production queue jobs.
     - Note that `/api/cron/zalo-transcription` drains up to **10 due jobs** per invocation. If other pending jobs are present in the queue, do NOT invoke the cron route assuming single-call isolation.
     - Execute only an approved bounded/isolated test plan on a single designated recording once separately authorized.
   - **Validation Criteria:**
     - `provider = GEMINI` and `model = gemini-3.5-transcribe` persisted in `zalo_call_transcriptions`.
     - Channel mapping preserved: Left channel mapped to `CUSTOMER` and Right channel mapped to `STAFF`.
     - Word-level timestamps correctly grouped into utterances with accurate Vietnamese speech transcription.
     - Google Files API temporary handle deleted via best-effort cleanup in `finally` while time remains within the deadline reservation window (unresolved cleanup relies on Google's automatic 48-hour TTL), and original recording audio in Supabase storage remains intact and immutable.

5. **Step 5: Quality Acceptance & Approval Before Recurring Cron**
   - Review transcription quality and verify that no errors or leaks occurred.
   - Recurring cron schedule must only be enabled after quality acceptance and explicit separate approval.
   - **Historical Failed Jobs & Backfill Policy:**
     - Known failed call/transcription (Call `859dff16-e94f-4259-aeb9-4ec3fb53bae8` / Transcription `eef159d2-5c18-4156-9592-4b45d6aeebce`) remains in `FAILED` status and must **not** be retried until separately authorized.
     - No automatic queue backfill is executed.
     - Downstream AI call summary remains strictly out of scope.
