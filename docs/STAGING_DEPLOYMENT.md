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

In the hosting deployment dashboard, verify that the deployed commit SHA matches `${DEPLOY_COMMIT}` (e.g. `VERCEL_GIT_COMMIT_SHA` if using Vercel Pro).

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
| `contracts` | `false` | 10 MiB (`10485760`) | `NULL` | Generated and signed customer contracts (canonical bucket from `20260929220004`) |
| `call-recordings` | `false` | 25 MiB (`26214400`) | N/A | Call recordings for voice media pipeline |

> [!NOTE]
> **Canonical Contract Storage:** The canonical contract storage bucket is `contracts` (`STORAGE_BUCKET_MAP.CONTRACT = 'contracts'`), provisioned by historical migration `20260929220004_contract_storage_hardening.sql`. No product runtime uses `contract-documents`.

### Security Invariant
All buckets enforce restrictive RLS (`RESTRICTIVE FOR INSERT, UPDATE, DELETE, SELECT TO anon, authenticated`) prohibiting direct client read/write. Storage operations are performed exclusively via server-authorized `service_role` clients and short-lived signed URLs.

---

## 3. Supabase Auth Configuration

Staging Auth must be configured with the staging application origin, never `http://127.0.0.1:3000`.

### Dashboard Configuration (`Authentication -> URL Configuration`)

1. **Site URL:**
   ```text
   https://<staging-host>
   ```
2. **Redirect URLs (Allow list):**
   ```text
   https://<staging-host>/**
   https://<staging-host>/auth/callback
   ```

### Multi-Factor Authentication (MFA / TOTP)
- Ensure TOTP MFA remains enabled.
- The production codebase enforces `AAL2` (Authenticator App TOTP) for privileged operations:
  - Boss Admin actions (Sales Style profile approval/activation, sensitive customer data unmasking)
  - Contract signing actions
- Verify staging users can enroll and verify TOTP via the canonical product routes:
  - `/admin/mfa/enroll` (Enroll TOTP authenticator factor and display QR code / secret)
  - `/admin/mfa/verify` (Verify code and elevate session to AAL2)

---

## 4. Staging Architecture: Hosting Decoupling & Scheduler Strategy

### Staging Architecture Specification

- **Scheduler:**
  `cron-job.org` (External free scheduler: 1m / 5m / 15m cadences, HTTPS GET, Bearer auth)

- **Hosting Candidate Classification:**
  - **Preferred Candidate:** `Koyeb Free` (Eco Web Service, 512 MB RAM, 0.1 vCPU, Full Node.js runtime, official Next.js support)
  - **Deployment Status:** `NOT YET PROVISIONED` (Evaluation recorded in `docs/STAGING_HOST_EVALUATION.md`; real deployment deferred to STG-004)
  - **Fallback Candidate:** `Render Free` (750 free instance-hrs/mo, but continuous 1-min SLA pings consume nearly entire allowance)
  - **Paid Alternative:** `Vercel Pro` ($20/mo, technically compatible)
  - **Disqualified:** `Vercel Hobby` (prohibited by Vercel Terms for commercial projects)

> [!WARNING]
> **Vercel Hobby Non-Commercial-Use Incompatibility:**
> Vercel Hobby must **NOT** be used as the canonical staging host for this commercial project under current Vercel Hobby non-commercial-use terms.
> This project is a commercial CRM containing sales pipelines, order management, deposit tracking, contract signing, production dispatch, installation scheduling, and warranty service workflows.

### Background Cadence Invariant
Regardless of the ultimate hosting platform, the product runtime strictly requires high-frequency background cron execution:
- `/api/cron/response-sla-worker`: Every 1 minute (`* * * * *`) to maintain the 5-minute customer response SLA.
- `/api/cron/voice-scheduler`: Every 5 minutes (`*/5 * * * *`).
- `/api/cron/zalo-care`: Every 15 minutes (`*/15 * * * *`).

The scheduler architecture is fully decoupled from the hosting platform: `cron-job.org` triggers standard HTTPS endpoints with Bearer token authentication, independent of whether the staging app runs on Koyeb, Vercel Pro, or an alternative commercial-compatible PaaS. Because `cron-job.org` calls `response-sla-worker` every minute, the Koyeb Free web service will normally remain awake once scheduler jobs are enabled.

### Koyeb Deployment Contract (Documentation Only — STG-003 Hardening Phase)
When provisioning the staging environment on Koyeb in the subsequent phase:
- **Service Type:** Web Service
- **Source:** GitHub repository (`hoanganhngo847-a11y/ai-crm-cua-chong-ngap`)
- **Runtime:** Node.js
- **Build Command:** `npm ci && npm run build`
- **Run Command:** `npm run start`
- **Application Port:** Dynamically bind to hosting-provided `PORT` environment variable (Next.js default handles `process.env.PORT`)
- **Environment Scope:** Configure staging-only variables from Section 5 below
- **Storage Backend:** Supabase Storage (`survey-photos`, `installation-docs`, `contracts`) — **NEVER** use local Koyeb filesystem for persistent application data
- **Database & Auth:** Supabase dedicated staging project — **NEVER** create a Koyeb-managed database

> [!IMPORTANT]
> **Boundary Guard:** Do **NOT** execute this deployment during STG-003. Do not add a paid Koyeb instance. Do not create Koyeb resources. Do not add payment credentials. Supabase remains the canonical DB/Auth/Storage platform.

---

## 5. Staging Environment Matrix

Configure these environment variables in your staging hosting environment (e.g. Project Settings -> Environment Variables).
Scope them strictly to this dedicated staging project.

| Variable Name | Environment Scope | Visibility | Secret? | Description / Contract |
|:---|:---:|:---:|:---:|:---|
| `NEXT_PUBLIC_SUPABASE_URL` | Preview & Prod | **Public** | No | Staging Supabase project URL (`https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Preview & Prod | **Public** | No | Staging Supabase anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Preview & Prod | **Server-Only** | **YES** | Staging Supabase service-role key (fail-closed, bypasses RLS) |
| `CRON_SECRET` | Preview & Prod | **Server-Only** | **YES** | Random 32+ char secret for authenticating cron workers |
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

## 6. Canonical External Callback Map

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

## 7. External Scheduler Configuration (cron-job.org) & Cadence Verification

Staging uses `cron-job.org` as the canonical free external scheduler triggering the commercial-use-compatible staging host over HTTPS.

### Target Architecture

```text
cron-job.org
     |
     | HTTPS
     | Authorization: Bearer <STAGING_CRON_SECRET>
     v
commercial-use-compatible staging host
     |
     +-- /api/cron/response-sla-worker  (every 1 minute)
     +-- /api/cron/voice-scheduler      (every 5 minutes)
     +-- /api/cron/zalo-care            (every 15 minutes)
```

### Canonical Scheduler Manifest (`config/external-scheduler.json`)

The schedules and HTTP methods are declaratively defined in `config/external-scheduler.json`:

```json
{
  "provider": "cron-job.org",
  "jobs": [
    {
      "name": "response-sla-worker",
      "path": "/api/cron/response-sla-worker",
      "schedule": "* * * * *",
      "method": "GET"
    },
    {
      "name": "voice-scheduler",
      "path": "/api/cron/voice-scheduler",
      "schedule": "*/5 * * * *",
      "method": "GET"
    },
    {
      "name": "zalo-care",
      "path": "/api/cron/zalo-care",
      "schedule": "*/15 * * * *",
      "method": "GET"
    }
  ]
}
```

> [!IMPORTANT]
> **Secret and Host Isolation:**
> `config/external-scheduler.json` contains no secrets, tokens, or deployment domains. `CRON_SECRET`, Bearer header values, and target hostnames remain external configuration.

### Exact cron-job.org Job Configuration

After the staging host deployment URL is active, log into the `cron-job.org` console and configure three jobs:

#### Job 1: Response SLA Worker
- **URL:** `https://<staging-host>/api/cron/response-sla-worker`
- **Schedule:** Every 1 minute (`* * * * *`)
- **HTTP Method:** `GET`
- **Custom Header:** `Authorization: Bearer <STAGING_CRON_SECRET>`

#### Job 2: Voice Scheduler
- **URL:** `https://<staging-host>/api/cron/voice-scheduler`
- **Schedule:** Every 5 minutes (`*/5 * * * *`)
- **HTTP Method:** `GET`
- **Custom Header:** `Authorization: Bearer <STAGING_CRON_SECRET>`

#### Job 3: Zalo Care Worker
- **URL:** `https://<staging-host>/api/cron/zalo-care`
- **Schedule:** Every 15 minutes (`*/15 * * * *`)
- **HTTP Method:** `GET`
- **Custom Header:** `Authorization: Bearer <STAGING_CRON_SECRET>`

> [!CAUTION]
> **Secret Uniformity & Confidentiality:**
> Use the **SAME** staging-only `CRON_SECRET` configured in the staging hosting environment variables.
> Never commit actual secrets to source control or repository documentation.

### External Scheduler Security Requirements

- **HTTPS only:** All scheduled requests must use `https://`. Unencrypted HTTP is prohibited.
- **Staging-specific CRON_SECRET:** Generate a unique, cryptographically random secret (32+ chars, e.g. `openssl rand -hex 32`) dedicated to staging.
- **Never reuse production secret:** Production `CRON_SECRET` must never be used in staging or external test accounts.
- **Never include secret in URL query string:** Token in query strings leaks into server logs, proxy access logs, and referrer headers.
- **Header-only authorization:** Authorization must strictly be transmitted via the `Authorization: Bearer <STAGING_CRON_SECRET>` HTTP request header.
- **Immediate rotation:** Rotate `CRON_SECRET` in both the staging host environment and cron-job.org immediately if scheduler account credentials or secrets are suspected compromised.
- **No IP allowlisting dependency:** Do not configure IP allowlisting for scheduler endpoints because cron-job.org source IP addresses can dynamically change. Any IP filtering must be defense-in-depth only and must NEVER replace Bearer authentication.
- **Availability disclaimer:** `cron-job.org` is a free third-party scheduler service without contractual uptime or SLA guarantees. For mission-critical production environments, native cron on a dedicated production host or an enterprise scheduler with strict SLA guarantees remains the recommended approach.

### Post-Deployment Verification Commands

Run these smoke queries against the deployed staging environment:

```bash
STAGING_HOST="https://<staging-host>"

# 1. Verify Response SLA Worker (scheduled every 1 minute)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${STAGING_HOST}/api/cron/response-sla-worker"

# 2. Verify Voice Scheduler (scheduled every 5 minutes)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${STAGING_HOST}/api/cron/voice-scheduler"

# 3. Verify Zalo Care Worker (scheduled every 15 minutes)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${STAGING_HOST}/api/cron/zalo-care"

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

## 8. Staging Provider Setup Guidelines

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

## 9. Automated Staging Readiness Verification Gate

Before deploying, run the local staging readiness gate:

```bash
npm run test:staging-readiness
```

This gate automatically verifies:
1. `vercel.json` does NOT define platform-native cron jobs (`{}` empty configuration ensuring hosting-provider decoupling and preventing accidental reintroduction of platform-native crons).
2. `config/external-scheduler.json` exists with provider `cron-job.org` and exact canonical cadences (`* * * * *` for response-sla-worker, `*/5 * * * *` for voice-scheduler, `*/15 * * * *` for zalo-care) using `GET` method.
3. All cron route implementation files exist in `app/api/cron/`.
4. All three cron endpoints enforce fail-closed authorization: reject missing Authorization header (401), reject invalid Bearer token (401), reject spoofed headers (401), fail closed if CRON_SECRET is missing in production (503), and successfully reach worker logic when given a valid staging `CRON_SECRET`.
5. `.env.example` documents all mandatory staging environment variables without exposing server secrets.
6. Supabase has provisioned `survey-photos` and `installation-docs` with exact private and MIME configurations, and canonical `contracts` bucket exists from historical migrations (orphan `contract-documents` bucket is not provisioned).
7. Storage RLS restricts direct client uploads: attempts by anonymous and authenticated ordinary users fail closed under RLS (using valid MIME types), and service-role uploads succeed.
8. All canonical external webhook route handlers exist.
9. Upload transport hardening: canonical product upload limit is 10 MiB (`10485760` bytes), Next.js Server Action body limit (`12 MiB`) and proxy request buffering limit (`12 MiB`) provide >= 2 MiB multipart headroom, and server-authorized Storage upload architecture is preserved.

> [!NOTE]
> The automated local gate verifies repository-level configuration, external scheduler manifests, fail-closed cron authorization, upload transport limits, and local Supabase storage RLS. Registration of the three scheduled jobs in the `cron-job.org` console must be completed after the hosted staging host is provisioned.

---

## 10. Hosted-Upload Smoke Specification (Post-Provisioning Verification)

During the subsequent staging provisioning phase (STG-004), after the real hosted environment is running, verify file uploads through the **REAL browser/server transport** (Client $\rightarrow$ HTTP POST FormData $\rightarrow$ Server Action $\rightarrow$ Server Auth $\rightarrow$ Supabase Storage):

| Test Case | Payload Description | Expected Result | Verification Check |
|:---|:---|:---:|:---|
| **1. Small JPEG** | ~100 KiB valid JPEG image | **SUCCEED** | Upload succeeds, signed URL displays image, canonical DB record created |
| **2. >1 MiB JPEG** | ~2–3 MiB valid JPEG image | **SUCCEED** | Overcomes default 1 MB Server Action barrier; uploaded and verified in storage |
| **3. Near-Limit Photo** | ~9.8 MiB valid JPEG image | **SUCCEED** | Full product capacity accepted; transport envelope handles multipart overhead |
| **4. Oversized Photo** | 10 MiB + 1 byte JPEG image | **REJECTED** | Server validation rejects with 400 / `Dung lượng ảnh không được vượt quá 10MB` |
| **5. Invalid MIME** | Renamed `.exe` or `.txt` disguised as `.jpg` | **REJECTED** | Magic byte inspection detects invalid signature and rejects upload |
| **6. Direct Client Storage** | Browser JS calling `supabase.storage.from(...).upload()` directly | **DENIED** | PostgreSQL storage RLS blocks anonymous and authenticated client uploads fail-closed |
| **7. Near-Limit Handover PDF**| ~9.8 MiB valid PDF document | **SUCCEED** | Installation handover Server Action uploads successfully to `installation-docs` |

> [!IMPORTANT]
> This real-browser hosted-upload smoke test is **MANDATORY** before staging User Acceptance Testing (UAT) can commence.
