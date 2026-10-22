# Upstream Audit: JAVIS OS Reference Architecture

> **Audit Target:** `https://github.com/blogminhquy/javis-os` pinned at [`a0561b0c3a8f593f205946a1f1356887d72b5a1a`](https://github.com/blogminhquy/javis-os/tree/a0561b0c3a8f593f205946a1f1356887d72b5a1a)
> **Auditor Role:** Antigravity upstream audit, corrected after Codex review | **Mode:** Static source inspection; no upstream application execution or source mutation

---

## 1. Files Read & Audit Manifest

Audited files in upstream reference repository (`a0561b0c`):
- [`ARCHITECTURE.md`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/ARCHITECTURE.md): System overview, local Markdown Second Brain, and engine topologies.
- [`LICENSE`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/LICENSE): Upstream MIT license terms.
- `server/capability_registry.py` (lines 34-40): Brain scope generation via SHA256 hashing of resolved casefolded paths.
- `server/memory_index.py` (lines 1-5, 103-145, 424-506): SQLite FTS5 index and scope-qualified cascaded retrieval.
- `server/model_router.py` (lines 1-16, 46-97, 101-160, 212-244): Capability filtering and fallback decision logic.
- `server/mcp_catalog.py` (lines 24-32, 486-553): Heuristic classification, permission ranking, and mode caps.
- `server/mcp_hub.py` (lines 222-278, 928-1012, 1748-1760): Tool gateway, conditional execution, and HTTP auth.
- `server/mcp_store.py` (lines 26-30, 95-97, 174-179, 300-330): Server registry and local encrypted secret storage.
- `server/learn.py` (lines 283-325, 930-1010, 1203-1268, 1590-1615): Distillation promoter, write guards, and BrainLock.
- `server/sessions.py` (lines 38-42, 128-164, 421-447, 1207, 1854): SQLite conversation store with optional brain filters.
- `server/chatbot_store.py` (lines 35-37, 118-128, 157-169) & `server/chatbot_runtime.py` (lines 1497-1566): Bot registry and dispatch.
- Realtime & Voice modules: `server/voice_brain.py` (lines 1-49, 81-142), `server/voice_call.py` (lines 18-89), `server/voice_ear.py` (lines 153-181), `server/voice_live.py` (lines 14-80), `server/codex_realtime.py` (lines 64-100), `dashboard/voice-live.js` (lines 25-41, 168-197), and `dashboard/voice-live-worklet.js` (lines 28-56).

---

## 2. Static Code Audit Findings

1. **Brain Scope vs. CRM Tenant ACL:** Upstream does NOT exhibit absolute "zero tenant separation". [`server/memory_index.py:424-506`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/memory_index.py#L424-L506) enforces SQL filtering scoped to `brain_scope(brain)`. [`server/capability_registry.py:34-40`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/capability_registry.py#L34-L40) derives this scope by SHA256-hashing the resolved casefolded filesystem path. In [`server/sessions.py:1207,1854`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/sessions.py#L1207), brain filtering is supported as an optional parameter. While this provides brain scoping within a local runtime, it does NOT constitute CRM multi-tenant company/customer authorization.
2. **Model Router Fallback Risk:** `server/model_router.py` cannot be reused unchanged or immediately adopted. In [`server/model_router.py:212-236`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/model_router.py#L212-L236), the router returns `keep` (preserving current model) if the session is unadmitted, step kind is unrouted, or no candidate is eligible. In CRM, this fallback behavior could bypass capability/data-class filtering. CRM must validate current and fallback models against policy or reject. Adopt filter/rank pattern via adapter only.
3. **Tool Classification & Permissive Defaults:** In [`server/mcp_catalog.py:486-534`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/mcp_catalog.py#L486-L534), an unknown tool defaults to `"read"` (:533). In `:538-540`, unlisted permissions or modes default to `"full"`, and `:546` returns `allowed = True` whenever effective permission is `"full"`. Furthermore, [`server/mcp_hub.py:1748-1760`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/mcp_hub.py#L1748-L1760) validates requests using a single global hub bearer token and defaults caller header `x-javis-mode` to `"full"`. CRM context gateway must enforce strict default-deny and exact allowlists.
4. **Shell Execution Context & Bot Risks:** Shell exposure in [`server/mcp_hub.py:928-950`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/mcp_hub.py#L928-L950) (`javis_run_command`) is CONDITIONAL on having a `workspace_root` AND an active coding context in `auto`/`full` mode. Terminal access (`javis_terminal` :954-985) is restricted to coding sessions with `full` permission. These registration branches do not add coding command/terminal tools without the stated context. This does not establish a general engine sandbox; bot full mode has the separate documented risk below. In [`server/chatbot_store.py:157-169`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/chatbot_store.py#L157-L169), upstream explicitly documents that `full` mode grants administrative host OS access to whoever messages the bot. All shell, terminal, and raw vault tools must be rejected for CRM.
5. **Learning Engine Controls & Candidate Lifecycle:** [`server/learn.py`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/learn.py) contains real controls: `allow_write` gate (:1203,1211), dry-run listings, `git_brain.BrainLock` (:1227), regex secret scanning (`secret_hits` :297), and injection sanitization (:323). However, these controls do not provide a CRM customer candidate lifecycle. CRM requires a candidate-only model: types (`FACT`, `PREFERENCE`, `INTENT`, `OBJECTION`, `TEMPORARY_CONTEXT`, `AI_INFERENCE`), lifecycle status (`UNVERIFIED`, `ACTIVE`, `SUPERSEDED`), mandatory `company_id` and `customer_id`, and full source metadata. `AI_INFERENCE` must never auto-promote to fact, and company knowledge must never be learned automatically from customer chat.
6. **Realtime Audio & AudioWorklet:** [`dashboard/voice-live-worklet.js:28-56`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/dashboard/voice-live-worklet.js#L28-L56) provides PCM16 16 kHz audio capture, but must NOT be adopted directly absent audio quality, barge-in, and latency verification. It remains a Phase 6 candidate only. Upstream browser audio streaming is not telephony or PSTN gateway acceptance.
7. **Scope Alignment with Root Architecture:** Removed all invented external rules, fixed 5-minute timers, BOSS-only approval mandates, domain-specific survey/pricing requirements, and enterprise secret-manager requirements. Alignment is strictly against the generic phased plan in `ARCHITECTURE.md`.

---

## 3. Component Decisions (Reuse / Adapt / Reject)

| Component | Pinned Source Path:Line | Decision | Audit Verdict & Migration Requirement |
| :--- | :--- | :---: | :--- |
| **Model Router** | [`server/model_router.py:46-97,212-244`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/model_router.py#L212-L244) | **ADAPT** | Adopt filter/rank pattern via adapter. Reject `keep` fallback without CRM policy check; enforce strict API allowlist. |
| **Memory Index** | [`server/memory_index.py:424-506`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/memory_index.py#L424-L506) | **ADAPT** | Adapt cascaded retrieval (exact/FTS/graph) to PostgreSQL (`tsvector`/`pgvector`). Enforce mandatory `(company_id, customer_id)`. |
| **Learning Extraction** | [`server/learn.py:930-1010,1203-1268`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/learn.py#L1203-L1268) | **ADAPT** | Retain guard concepts; adapt extraction schema to candidate-only `UNVERIFIED` lifecycle. Zero autonomous file/git writes. |
| **Fast Voice Brain** | [`server/voice_brain.py:1-49,81-142`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/voice_brain.py#L81-L142) | **ADAPT** | Adapt fast/main brain split and structured code-validated escalation for official API models. No CLI or text injection. |
| **Voice Live Events** | [`server/voice_live.py:14-80`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/voice_live.py#L14-L80) | **ADAPT** | Adapt WebSocket event lifecycle and interruption truncation for internal agent voice. Official cloud APIs only. |
| **Audio Worklet** | [`dashboard/voice-live-worklet.js:28-56`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/dashboard/voice-live-worklet.js#L28-L56) | **ADAPT** | Phase 6 candidate only. Do not adopt directly absent audio quality, barge-in, and latency testing. Not a PSTN gateway. |
| **Tool Gateway** | [`server/mcp_hub.py:928-1012`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/mcp_hub.py#L928-L1012) | **REJECT** | Reject catalog defaults and shell/command tools. CRM Context Gateway requires exact read allowlist and default-deny. |
| **MCP Secret Store** | [`server/mcp_store.py:26-30,95-97`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/mcp_store.py#L95-L97) | **REJECT** | Reject direct use of the local JSON credential store; encryption helpers alone do not provide CRM tenant authorization. Credentials remain in CRM server environment / trusted store. |
| **Session Storage** | [`server/sessions.py:421-447,1207,1854`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/sessions.py#L421-L447) | **REJECT** | Reject shared local SQLite. CRM conversation state resides strictly in PostgreSQL with RLS and tenant scope. |
| **Chatbot Runtime** | [`server/chatbot_store.py:118-169`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/chatbot_store.py#L118-L169) | **REJECT** | Reject direct autonomous messaging dispatch and `full` mode shell access. CRM core retains exclusive outbound authority. |
| **Desktop CLI Bridge** | [`server/codex_realtime.py:64-100`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/codex_realtime.py#L64-L100) | **REJECT** | Reject desktop CLI subscription wrappers (`codex`, `claude`, `agy`). Only official cloud provider APIs permitted. |
| **Client Engine Selector** | [`server/voice_call.py:18-89`](https://github.com/blogminhquy/javis-os/blob/a0561b0c3a8f593f205946a1f1356887d72b5a1a/server/voice_call.py#L18-L89) | **REJECT** | Reject local desktop browser mic selector. Telephony requires server-side PBX/SIP gateways, separate from Brain. |

---

No audited module is approved for unchanged production reuse. Pure utilities are candidates only after focused tests and license/dependency review; this phase vendors no code.

## 4. Proposed Private Brain Boundary

```mermaid
flowchart TD
  CRM["CRM Trusted Core (PostgreSQL Single Source of Truth)"]
  GW["CRM Context Gateway (Signed Scope, Exact Read Allowlist, Default-Deny)"]
  BRAIN["Private Brain Service Boundary (Provider-Neutral)"]
  ROUTER["Model Router Adapter (Filter & Rank; Policy-Checked Fallback)"]
  MEM["Three-Tier Scoped Memory (Company Knowledge, Customer Memory, Ephemeral Context)"]
  DISTILL["Candidate Distillation Worker (UNVERIFIED Proposals; Full Provenance)"]
  APIS["Official Cloud APIs (Anthropic, Gemini, OpenAI)"]

  CRM -->|Scoped Turn Envelope (company_id, customer_id, turn_id)| BRAIN
  BRAIN --> ROUTER
  ROUTER --> APIS
  BRAIN -->|Allowlisted Read Request| GW
  GW --> CRM
  BRAIN --> MEM
  APIS -->|Untrusted Draft / Suggestion| CRM
  CRM -.->|Completed Interaction Event| DISTILL
  DISTILL -.->|UNVERIFIED Candidates Only| CRM
```

### Boundary Principles
1. **CRM Authority & Single Source of Truth:** All authoritative business records, customer profiles, and interactions reside in CRM PostgreSQL. Brain holds no shadow master data.
2. **Tool Restrictions:** Zero shell execution, zero OS process tools, zero raw SQL queries, and zero direct external messaging dispatch tools. Context Gateway exposes only exact read-only projections. Brain receives no Supabase service-role key, database credentials, channel tokens or arbitrary connector discovery. Phase 1a uses a server-owned authorization resolver; the future private service requires short-lived tenant/customer/turn capabilities and fresh resource authorization; the global Javis hub token is not reused as that boundary.
3. **Three-Tier Memory Architecture:**
   - *Tier 1 (Company Knowledge):* Approved tenant documents, pricing policies, and procedures (`company_id`). Read-only for AI.
   - *Tier 2 (Customer Memory):* Long-term sanitized customer profile, preferences, and verified facts (`company_id`, `customer_id`). Initialized as `UNVERIFIED`; no auto-promotion from `AI_INFERENCE`.
   - *Tier 3 (Working Memory):* Ephemeral turn context bounded to `(company_id, customer_id, conversation_id/session_id)`.
4. **Candidate-Only Distillation Lifecycle:** Distillation outputs only `UNVERIFIED` structured proposals (`FACT`, `PREFERENCE`, `INTENT`, `OBJECTION`, `TEMPORARY_CONTEXT`, `AI_INFERENCE`), with mandatory tenant/customer scoping and source references. Only a separately validated CRM review lifecycle can produce `ACTIVE` or `SUPERSEDED` memory records. Never automatically learns company knowledge from customer chats.
5. **Official APIs Only:** No desktop CLI subprocess execution. Model routing uses official cloud SDKs with CRM policy-validated selection and fail-closed error handling.

---

## 5. Licensing, Risks & Verification Scope

1. **Licensing:** Root repository license is MIT (`Copyright (c) 2026 Nguyễn Minh Quý`). Third-party dependencies, assets, and ported origins remain unverified; no upstream code is vendored or copied into this repository.
2. **Operational & Performance Assumptions:** Static source comments (e.g. latency targets, engine claims) do not constitute measured production benchmarks or provider SLA guarantees.
3. **Verification limit:** Source inspection commands only; no upstream application/scripts, provider requests, credential access or production tests. No measured latency, capacity or quality result is claimed.
4. **Scaling risk:** SQLite WAL/thread locks and local JSON/Markdown state (`sessions.py:421-447`, `mcp_store.py:26-30`) need durable coordination and scoped cache invalidation for multiple service replicas. Actual contention and capacity remain unmeasured.
5. **Privacy risk:** Brain paths and sender/account keys do not establish CRM customer access rights. Minimize projected data, preserve current role/MFA/staff restrictions, exclude raw contact/transcript data by default, and define retention/deletion for memory, logs and provider requests before shadow activation. Regex injection/secret filters are defense in depth, not an authorization boundary.
