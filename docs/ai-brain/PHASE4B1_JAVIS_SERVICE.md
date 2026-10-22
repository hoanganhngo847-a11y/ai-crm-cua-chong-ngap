# Phase 4B.1 — Javis Brain Companion Production Service

## 1. Executive Summary & Audit Reality

Phase 4B.1 delivers the standalone companion Node HTTP web service for AI CRM (`services/javis-brain/`).

### Deployment Audit Reality (No Existing Javis OS Runtime)
The rollout audit found no Javis OS runtime in this repository and no Javis service among the three services in Render workspace `tea-db27ttjtqb8s73cdhrj0`. The CRM already has an HTTPS client adapter and official model SDKs. The existing production Gemini credential can access metadata for the configured summary model, `gemini-2.5-flash`.

This implementation reuses that SDK and pure CRM contract validators. It does not reuse the summary worker or its database access. The earlier upstream reference review remains in [JAVIS_AUDIT.md](./JAVIS_AUDIT.md); this rollout does not install or run upstream Javis OS.

Therefore, `javis-brain` is built as a **narrow production companion service** adhering strictly to the CRM contract (`features/ai-brain/contracts.ts`, `features/ai-brain/javis-provider.ts`). It is **not** Javis OS. All AI inference is quarantined behind this separate HTTP service boundary, completely separated from CRM database transactions and shadow workers.

---

## 2. Architecture & Service Boundary

```
[CRM Shadow Worker / BrainService]
              │
              │ HTTPS POST /v1/brain/turn (Bearer Token, X-AI-Brain-Contract: v1)
              ▼
┌─────────────────────────────────────────────────────────────┐
│              services/javis-brain/ (Node HTTP)              │
│                                                             │
│  1. Transport & Auth: Constant-time Bearer token verify    │
│  2. Schema & Bounds: Exact keys, UUIDs, 32 KiB body limit    │
│  3. Deterministic Policy: Short-circuit NO_REPLY / HANDOVER │
│  4. Concurrency Limiter: Max 2 in-flight (excess => 503)   │
│  5. Sanitized Prompt: User input text only (no IDs/keys)    │
│  6. Bounded Inference: Gemini 2.5 Flash, 3500ms / 1000ms   │
│  7. Leak Prevention: Token/key/canary scan on output        │
│  8. Output Validator: validateProviderProposal (exact keys)│
└─────────────────────────────────────────────────────────────┘
              │
              │ Google GenAI SDK (@google/genai 2.30.0)
              ▼
   [gemini-2.5-flash API]
```

### Boundary & Permission Footprint
- **Zero Database Imports**: No Supabase client, no PostgreSQL driver, no SQL queries, and no direct CRM storage access.
- **Zero Messaging Imports**: No Facebook Graph API, no Zalo ZCAJS, no Stringee/Twilio SDKs, and zero customer dispatch paths.
- **Shared Pure Contracts**: Reuses pure type definitions from `features/ai-brain/contracts.ts` and `validateProviderProposal` from `features/ai-brain/validation.ts`.
- **Pure Node HTTP**: Built on native `node:http` with zero additional root npm dependencies (`@google/genai` is already pinned at `2.30.0`).

### Test Seams & Production HTTPS Invariance
- **Strict Production HTTPS**: `JavisBrainProvider` in `features/ai-brain/javis-provider.ts` strictly mandates `https:` protocol and rejects `http:`. In production, all transport between CRM shadow workers and the Javis companion service travels over secure TLS. Production HTTPS is never weakened or bypassed.
- **Local E2E Socket Test Seam**: To exercise real TCP sockets, HTTP framing, headers, and serialization in local tests without generating fake certificates or weakening production validation, `tests/javis-brain/e2e.test.ts` uses an explicit test seam: `fetchImpl` maps requests directed to the logical HTTPS origin (`https://javis.internal.example`) to the ephemeral loopback HTTP server (`http://127.0.0.1:<port>`). Production code remains completely untouched.

---

## 3. HTTP Endpoints & Contract Enforcement

### 3.1 `GET /health`
- **Purpose**: Authenticated readiness probe.
- **Authentication**: `Authorization: Bearer <token>` (constant-time timingSafeEqual with SHA-256 digest comparison).
- **Headers**: Requires `X-AI-Brain-Contract: v1`.
- **Response** (HTTP 200):
  ```json
  {
    "ok": true,
    "service": "javis-brain",
    "version": "v1"
  }
  ```
- **Error Codes**: 401 Unauthorized (missing/bad token), 400 Bad Request (missing/wrong contract header, duplicate headers), 405 Method Not Allowed (non-GET).

### 3.2 `POST /v1/brain/turn`
- **Purpose**: Evaluates an authorized CRM turn and returns a structured proposal.
- **Transport Security & Body Handling**:
  - `Authorization: Bearer <token>` (constant-time verification).
  - `X-AI-Brain-Contract: v1`
  - `Content-Type: application/json`
  - Duplicate sensitive headers rejected with 400 Bad Request.
  - Non-identity `Content-Encoding` rejected with 415 Unsupported Media Type.
  - Body size capped at 32 KiB (32768 bytes) across `Content-Length` and streaming chunks (exceeding returns 413 Payload Too Large).
  - 413 Payload Too Large and 408 Request Timeout flush response headers and body before socket is destroyed (`res.on('finish', () => req.destroy())`).
  - Strict UTF-8 decoding: Request chunks are buffered in bounded `Buffer[]` and decoded ONCE with `TextDecoder('utf-8', { fatal: true })` on `end`. Deliberate chunk splits inside multi-byte characters (Vietnamese, emojis) preserve exact characters; malformed byte sequences fail safely with 400 Bad Request.
  - Header timeout bounded with `connectionsCheckingInterval` (configured dynamically to `Math.max(50, Math.min(500, Math.floor(headersTimeoutMs / 2)))`), ensuring stalled header clients are terminated promptly.
  - Slow client body timeout (3000ms default, configurable) cleans listeners and returns 408 Request Timeout.
- **Request Validation**:
  - Exact top-level keys allowed: `version`, `turnId`, `traceId`, `scope`, `policy`, `input`, `latencyProfile`. Extra keys rejected.
  - RFC 4122 UUID validation for `turnId`, `traceId`, `scope.companyId`, `scope.customerId`, `scope.conversationId`, and optional `scope.sessionId`.
  - Enum validation: `channel` in `['MESSENGER', 'ZALO', 'PHONE', 'WEB', 'INTERNAL']`, `modality` in `['TEXT', 'VOICE']`, `latencyProfile` in `['STANDARD', 'REALTIME']`.
  - Policy enforcement: `policy.permissionProfile` must strictly be `'READ_ONLY'`.
  - Bounded input: `input.text` must be non-blank, <= 4000 JavaScript characters, and <= 12000 UTF-8 bytes.
- **Deterministic Policy Short-Circuiting**:
  - Strict CRM precedence alignment: If `conversationState === 'HANDOVER_REQUIRED'`, returns `HANDOVER` (`CONVERSATION_STATE_HANDOVER_REQUIRED`, confidence: 1.0) immediately, taking precedence over `allowDrafts === false` (matching `features/ai-brain/service.ts`).
  - If `allowDrafts === false` or `conversationState === 'AI_PAUSED'`: returns `NO_REPLY` (confidence: 1.0) immediately without calling Gemini.
  - If `conversationState === 'HUMAN_ACTIVE'` and `allowDrafts === true`: proceeds to model to generate a draft proposal for agent review.
- **Model Backend Safety, Upstream Bounds & Leak Prevention**:
  - Model: Explicit production `gemini-2.5-flash`.
  - Prompt: Internal CRM customer service assistant. Sent payload contains **only** sanitized customer `input.text`. Scope IDs, company credentials, and tenant keys are strictly excluded.
  - Schema: `draft` and `handoverReason` forbid `nullable: true`. Prompt explicitly instructs the model to omit irrelevant fields and never return `null`. `handoverReason` must strictly match uppercase machine codes `^[A-Z][A-Z_]{0,63}$`.
  - Upstream HTTP bounds: `perCallFetch` wraps upstream responses with a strict 64 KiB cap (`MAX_UPSTREAM_RESPONSE_BYTES`) on declared `Content-Length` and streamed bytes before SDK JSON parsing. Upstream stream cancellation on overflow.
  - Non-2xx upstream bodies are never read or logged; constant `UPSTREAM_HTTP_ERROR` is thrown.
  - Single SDK call: `retryOptions: { attempts: 1 }` (no retries, no fallback).
  - Safe candidate reading: Directly reads `response.candidates[0].content.parts` without invoking SDK `.text` getter (which logs `console.warn` on non-text parts and risks PII leakage). Rejects thought/tool/non-text parts, multiple candidates, and thought signatures (strict no CoT).
  - Normalized leak scan: JSON is parsed first before leak checks, ensuring Unicode escape sequences (`\u00xx`) cannot bypass secret scans. Inspects normalized draft, handoverReason, and raw text for API keys, bearer tokens, and canary phrases without logging them.
  - JSON proposal raw text capped at 16 KiB.
- **Output Boundary Runtime Validation**:
  - Server HTTP handler invokes shared `validateProviderProposal` on the backend result before serializing into `TurnResponse`.
  - Rejects malformed backend ERROR decisions, unknown keys, non-empty references, bad confidence, or null/missing fields with safe 500 without leaking raw backend responses or granting delivery authority.
- **Success Response** (HTTP 200):
  ```json
  {
    "ok": true,
    "version": "v1",
    "proposal": {
      "decision": "RESPOND",
      "draft": "Xin chào, em có thể hỗ trợ gì cho anh/chị ạ?",
      "confidence": 0.95
    }
  }
  ```

---

## 4. Resource Bounds & Concurrency

- **Concurrency Limit & Capacity Retention**:
  - Maximum 2 concurrent active model calls.
  - Capacity slot is held until the underlying backend promise actually settles (`.then(releaseSlot, releaseSlot)`).
  - If a backend ignores abort and continues running after an HTTP timeout (504) or client disconnect, the slot remains occupied. Subsequent requests fail closed with `503 Service Unavailable` (`{"error": "SERVICE_UNAVAILABLE"}`), preventing backend overload. No unbounded queueing.
  - Observed promise settlement handlers prevent unhandled rejections on late resolution/rejection.
  - Active requests are aborted on server shutdown (`server.close()`).
- **Deadlines & Disconnects**:
  - Standard Latency: 3500ms model deadline.
  - Realtime Latency: 1000ms model deadline.
  - Outer Request Timeout: 5000ms.
  - Client Disconnect: Real client socket disconnect detected via `res.on('close')` (`!res.writableEnded`). Settle promptly via `disconnectPromise` and abort backend without waiting for the full deadline.
  - Race Protection: `Promise.race([backendPromise, timeoutPromise, disconnectPromise])` ensures timely settlement.

---

## 5. Deployment Commands (Render Node Web Service)

Render Web Service deployment is configured directly via Codex MCP or the Render dashboard (free tier compatible). No `render.yaml` file is required.

### Service Settings
| Parameter | Value |
| :--- | :--- |
| **Service Type** | Web Service |
| **Environment** | Node |
| **Root Directory** | `.` |
| **Build Command** | `npm ci --include=dev && npm run build:javis-brain` |
| **Start Command** | `npm run start:javis-brain` |
| **Health Check Path** | TCP Health Check (default) |

> [!NOTE]
> Render default TCP check is used because `/health` requires strict Bearer authentication. No unauthenticated health exception is exposed.

### Required Environment Variables
| Variable | Required | Description |
| :--- | :---: | :--- |
| `PORT` | Auto | Injected by Render (default 8080 if local). |
| `JAVIS_BRAIN_INTERNAL_TOKEN` | Yes | Generate a strong secret directly in Render and securely copy the same value to CRM after service verification. The loader also supports `JAVIS_BRAIN_AUTH_TOKEN` as an alias; configure only the preferred name. |
| `GEMINI_API_KEY` | Yes | Google Gemini API key. |
| `JAVIS_BRAIN_MODEL` | Yes | Fixed model identifier: `gemini-2.5-flash`. |

---

## 6. Safe Operations & Rollback Plan

### Runtime Rollback
1. **Worker Pause**: In CRM database, set `enabled = false` for the target company/channel in `public.ai_brain_shadow_settings`. The worker rechecks this before reasoning and skips disabled work. This does not cancel an inference that already passed that check.
2. **Fail-Closed Companion Service**: If the companion service is disabled, stopped, or rolled back, CRM `JavisBrainProvider` safely handles network failures and maps them to canonical `BRAIN_UNAVAILABLE` or `BRAIN_PROVIDER_ERROR` without leaking exception text or tokens.
3. **No CRM Database Migrations**: Phase 4B.1 introduces zero database schema changes or migrations.
4. **Secrets Quarantine**: All secrets reside in server environments; no keys, tokens, or credentials are logged or checked into Git.

### Safe Structured Logging
Logs output structured JSON with safe, non-sensitive audit fields only:
```json
{
  "turnId": "3a3e26a1-833c-47d6-adc4-b15572c84708",
  "traceId": "55555555-5555-4555-8555-555555555555",
  "latencyMs": 142.5,
  "decision": "RESPOND",
  "status": 200,
  "provider": "javis-brain-service",
  "model": "gemini-2.5-flash"
}
```
Customer message text, drafts, PII, CoT, and credentials are never included in logs or error bodies.

---

## 7. Local Verification & CI Integration

### Commands
- **Compile Standalone**: `npm run build:javis-brain`
- **Start Standalone**: `npm run start:javis-brain`
- **Run Tests**: `npm run test:javis-brain`
- **Run AI Brain Tests**: `npm run test:ai-brain`
- **Project Typecheck**: `npm run typecheck`
- **Project Lint**: `npm run lint`

### CI Integration
Added to `.github/workflows/verify.yml`:
```yaml
      - run: npm run test:ai-brain
      - run: npm run test:javis-brain
      - run: npm run build:javis-brain
```
The local service suite has 49 tests, alongside 168 existing AI Brain tests. Verify the exact PR head in CI before merging; local results alone do not establish a successful production deployment.

### Free Compute Plan Limitation
The initial deployment uses Render's `free` web-service plan with TCP readiness checks. Free services can sleep after idle periods; a cold start can exceed CRM's five-second turn deadline and must fail closed. This phase verifies synthetic integration and leaves Shadow settings and its scheduler OFF. Do not add keepalive automation or upgrade compute as part of this phase.
