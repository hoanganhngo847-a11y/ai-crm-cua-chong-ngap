# Staging Deployment Runbook

This document is the executable, operational runbook for provisioning, deploying, and validating a fresh staging environment for `ai-crm-cua-chong-ngap`.

---

## 1. Exact Source Commit

Staging deployment must be fully deterministic and trace directly back to an immutable Git commit SHA.

```bash
# 1. Ensure working directory is clean and on canonical staging branch
git status --porcelain

# 2. Capture and record the exact HEAD commit SHA
DEPLOY_COMMIT=$(git rev-parse HEAD)
echo "Deploying commit: ${DEPLOY_COMMIT}"

# 3. Optional: tag staging release for traceability
git tag -a "staging-deploy-$(date +%Y%m%d-%H%M%S)" -m "Staging release from commit ${DEPLOY_COMMIT}"
```

In Vercel, verify that the deployment uses `VERCEL_GIT_COMMIT_SHA` matching `${DEPLOY_COMMIT}`.

---

## 2. Dedicated Supabase Staging Provisioning

A clean staging deployment must use its own dedicated, isolated Supabase project.  
**DO NOT** reuse the production database or point staging at the local development container.

### Step-by-Step CLI Execution

```bash
# 1. Authenticate with Supabase CLI
supabase login

# 2. Link repository to the hosted staging Supabase project
# Replace <STAGING_PROJECT_REF> with the 20-character reference ID of the hosted staging project
supabase link --project-ref <STAGING_PROJECT_REF>

# 3. Apply all repository forward migrations sequentially
supabase db push

# 4. Verify applied migration history
supabase migration list
```

### Storage Buckets & Policies Verification

All required storage buckets are provisioned idempotently through repository migrations (specifically `20260929220004_contract_storage_hardening.sql`, `20260928000001_operations_p0_hardening.sql`, and `20261005100001_staging_storage_bucket_provisioning.sql`).

Verify that the staging database contains the following private buckets and configurations:

```sql
SELECT id, name, public, file_size_limit, allowed_mime_types 
FROM storage.buckets;
```

Expected bucket matrix:

| Bucket ID | Public | Max File Size | Allowed MIME Types | Primary Purpose |
|:---|:---:|:---:|:---|:---|
| `survey-photos` | `false` | 10 MiB (`10485760`) | `image/jpeg`, `image/png`, `image/webp` | On-site survey measurement photos |
| `installation-docs` | `false` | 10 MiB (`10485760`) | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` | Installation photos & handover documents |
| `contracts` | `false` | 10 MiB (`10485760`) | `application/pdf` | Generated and signed customer contracts |
| `contract-documents` | `false` | 10 MiB (`10485760`) | `application/pdf` | Contract documents compatibility alias |
| `call-recordings` | `false` | 25 MiB (`26214400`) | N/A | Call recordings for voice media pipeline |

### Security Invariant
All buckets enforce restrictive RLS (`RESTRICTIVE FOR INSERT, UPDATE, DELETE, SELECT TO anon, authenticated`) prohibiting direct client read/write. Storage operations are performed exclusively via server-authorized `service_role` clients and short-lived signed URLs.

---

## 3. Supabase Auth Configuration

Staging Auth must be configured with the staging application origin, never `http://127.0.0.1:3000`.

### Dashboard Configuration (`Authentication -> URL Configuration`)

1. **Site URL:**
   ```text
   https://<staging-app-domain>.vercel.app
   ```
2. **Redirect URLs (Allow list):**
   ```text
   https://<staging-app-domain>.vercel.app/**
   https://<staging-app-domain>.vercel.app/auth/callback
   ```

### Multi-Factor Authentication (MFA / TOTP)
- Ensure TOTP MFA remains enabled.
- The production codebase enforces `AAL2` (Authenticator App TOTP) for privileged operations:
  - Boss Admin actions (Sales Style profile approval/activation, sensitive customer data unmasking)
  - Contract signing actions
- Verify staging users can enroll TOTP via `/settings/security` or standard Supabase MFA flow.

---

## 4. Vercel Environment Matrix

Configure these environment variables in Vercel under **Project Settings -> Environment Variables**.  
Scope them strictly to **Preview / Staging** (or Production respectively).

| Variable Name | Environment Scope | Visibility | Secret? | Description / Contract |
|:---|:---:|:---:|:---:|:---|
| `NEXT_PUBLIC_SUPABASE_URL` | Preview & Prod | **Public** | No | Staging Supabase project URL (`https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Preview & Prod | **Public** | No | Staging Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Preview & Prod | **Server-Only** | **YES** | Staging Supabase service-role key (fail-closed, bypasses RLS) |
| `CRON_SECRET` | Preview & Prod | **Server-Only** | **YES** | Random 32+ char secret for authenticating Vercel cron workers |
| `WEBHOOK_SECRET` | Preview & Prod | **Server-Only** | **YES** | HMAC-SHA256 signing secret for payment / bank transfer webhooks |
| `PHONE_IDENTITY_HMAC_SECRET` | Preview & Prod | **Server-Only** | **YES** | 32+ byte secret for deterministic SHA-256 phone pseudonymization |
| `META_APP_SECRET` | Preview & Prod | **Server-Only** | **YES** | Meta App secret for validating `x-hub-signature-256` |
| `META_VERIFY_TOKEN` | Preview & Prod | **Server-Only** | **YES** | Token for Meta webhook initial challenge verification |
| `META_GRAPH_VERSION` | Preview & Prod | **Server-Only** | No | Graph API version (e.g. `v21.0`) |
| `META_PAGE_ID` | Preview & Prod | **Server-Only** | No | Staging Facebook Page ID (single-page fallback) |
| `META_PAGE_ACCESS_TOKEN` | Preview & Prod | **Server-Only** | **YES** | Staging Facebook Page Access Token |
| `META_PAGE_BINDINGS` | Preview & Prod | **Server-Only** | No | Multi-page JSON mapping `[{"page":"...","company":"...","tokenEnv":"..."}]` |
| `OMNICHANNEL_COMPANY_ID` | Preview & Prod | **Server-Only** | No | UUID of the staging company mapped to website/omnichannel |
| `WEBSITE_ORIGIN` | Preview & Prod | **Server-Only** | No | Staging website origin (e.g. `https://staging-website.example.com`) |
| `WEBSITE_RATE_SECRET` | Preview & Prod | **Server-Only** | **YES** | Secret for website rate limiting and lead generation protection |
| `TURNSTILE_SECRET_KEY` | Preview & Prod | **Server-Only** | **YES** | Cloudflare Turnstile secret key for server-side CAPTCHA verification |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`| Preview & Prod | **Public** | No | Cloudflare Turnstile public site key for frontend widget |
| `ZALO_APP_ID` | Preview & Prod | **Server-Only** | No | Staging Zalo App ID |
| `ZALO_WEBHOOK_SECRET` | Preview & Prod | **Server-Only** | **YES** | Fallback Zalo webhook secret (per-OA secrets live in DB) |
| `OPENAI_API_KEY` | Preview & Prod | **Server-Only** | **YES** | OpenAI API key for AI response generation and classification |
| `OPENAI_TRANSCRIPTION_MODEL` | Preview & Prod | **Server-Only** | No | e.g. `gpt-4o-transcribe-diarize` |
| `OPENAI_INTAKE_MODEL` | Preview & Prod | **Server-Only** | No | e.g. `gpt-5-mini` |
| `OPENAI_REALTIME_MODEL` | Preview & Prod | **Server-Only** | No | e.g. `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | Preview & Prod | **Server-Only** | No | e.g. `marin` |
| `VOICE_PROVIDER` | Preview & Prod | **Server-Only** | No | `STRINGEE` or `MOCK` for staging test calls |
| `NEXT_PUBLIC_VOICE_PROVIDER` | Preview & Prod | **Public** | No | Voice provider identifier for browser UI (`STRINGEE`) |

> [!CAUTION]
> **Server-Only Secret Invariant:**  
> Never prefix sensitive credentials (`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `WEBHOOK_SECRET`, `PHONE_IDENTITY_HMAC_SECRET`, `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`, `ZALO_WEBHOOK_SECRET`, `OPENAI_API_KEY`) with `NEXT_PUBLIC_`.  
> Never commit real secrets to source control.

---

## 5. Canonical External Callback Map

Staging external integrations must point **exclusively** to the specialized canonical routes.  

| Channel / Provider | Canonical Endpoint URL | Auth / Verification Mechanism |
|:---|:---|:---|
| **Facebook / Meta** | `https://<staging-domain>/api/webhooks/meta` | `x-hub-signature-256` HMAC via `META_APP_SECRET` |
| **Zalo Official Account** | `https://<staging-domain>/api/webhooks/zalo` | `X-ZEvent-Signature` SHA256 via DB-managed `private.zalo_oa_secrets` |
| **Website Lead Form** | `https://<staging-domain>/api/website/leads` | Cloudflare Turnstile token + origin check against `WEBSITE_ORIGIN` |
| **Payment / Bank Transfer** | `https://<staging-domain>/api/webhooks/payment` | `x-provider-signature` HMAC-SHA256 via `WEBHOOK_SECRET` |
| **Voice Provider** | `https://<staging-domain>/api/webhooks/voice/<routingToken>` | Opaque routing token + `voice_provider_integrations` signing secret |
| **OpenAI Realtime** | `https://<staging-domain>/api/webhooks/openai-realtime/<routingToken>` | Opaque routing token + webhook signature verification |

### Canonical Routing Invariant
- **Single Ingress Path:** 1 provider event delivery $\rightarrow$ 1 canonical ingress route.
- **Legacy Route Warning:** The generic endpoint `/api/inbox/webhook` is **LEGACY** and non-canonical.  
  **DO NOT** configure Facebook or Zalo webhooks to deliver to `/api/inbox/webhook` simultaneously with the canonical routes. Doing so would violate idempotent message ingestion and cause duplicate lead processing.

---

## 6. Cron Schedule Verification

`vercel.json` schedules three canonical background workers:

```json
{
  "crons": [
    {
      "path": "/api/cron/response-sla-worker",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/voice-scheduler",
      "schedule": "*/5 * * * *"
    },
    {
      "path": "/api/cron/zalo-care",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

### Post-Deployment Verification Commands

Run these smoke queries against the deployed staging environment:

```bash
STAGING_HOST="https://<staging-domain>.vercel.app"

# 1. Verify Response SLA Worker (scheduled every 1 minute)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${STAGING_HOST}/api/cron/response-sla-worker"
# Expected: 200

# 2. Verify Voice Scheduler (scheduled every 5 minutes)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${STAGING_HOST}/api/cron/voice-scheduler"
# Expected: 200

# 3. Verify Zalo Care Worker (scheduled every 15 minutes)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${STAGING_HOST}/api/cron/zalo-care"
# Expected: 200

# 4. Verify Unauthorized Calls Are Blocked Fail-Closed
curl -s -o /dev/null -w "%{http_code}\n" \
  "${STAGING_HOST}/api/cron/response-sla-worker"
# Expected: 401

curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer wrong-token-value" \
  "${STAGING_HOST}/api/cron/response-sla-worker"
# Expected: 401
```

---

## 7. Staging Provider Setup Guidelines

To guarantee isolation between staging and production:

1. **Meta Page $\rightarrow$ Company Binding:**
   - Use a dedicated test Facebook Page linked to a development Meta App.
   - Configure Page Webhook subscription to point to `${STAGING_HOST}/api/webhooks/meta`.
   - Never subscribe production Pages to staging endpoints.

2. **Zalo OA Integration:**
   - Use a dedicated Zalo OA test sandbox or test account.
   - Manage OA credentials via `upsertZaloOaConnectionAction` (Boss Admin + MFA). Credentials are stored encrypted in `private.zalo_oa_secrets` with tenant isolation.
   - Point Zalo webhook callback to `${STAGING_HOST}/api/webhooks/zalo`.

3. **Website Lead Form:**
   - Set `WEBSITE_ORIGIN` to the staging website URL.
   - Use Cloudflare Turnstile staging/testing keys (`1x00000000000000000000AA` for always-pass testing if desired).

4. **Payment Webhook:**
   - Generate a cryptographically secure random string (32+ chars) for `WEBHOOK_SECRET`.
   - Configure staging banking simulator or payment gateway sandbox to send `x-provider-signature: <hex-hmac>` using this secret.

5. **Voice Hotline:**
   - Create staging tenant records in `voice_provider_integrations` with dedicated opaque routing tokens.
   - Point telephony provider (e.g. Stringee webhook) to `${STAGING_HOST}/api/webhooks/voice/<routingToken>`.

---

## 8. Automated Staging Readiness Verification Gate

Before deploying, run the local staging readiness gate:

```bash
npm run test:staging-readiness
```

This gate automatically verifies:
1. `vercel.json` contains all required cron paths with compliant schedules.
2. All cron route implementation files exist in `app/api/cron/`.
3. `.env.example` documents all mandatory staging environment variables without exposing server secrets.
4. Supabase has provisioned `survey-photos`, `installation-docs`, `contracts`, and `contract-documents` with exact private and MIME configurations.
5. Storage RLS restricts direct client uploads and verifies server-authorized write access.
6. All canonical external webhook route handlers exist.
