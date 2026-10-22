# Phase 0 audit evidence and validation

Date: 2026-10-22 (Asia/Ho_Chi_Minh).
CRM baseline: `182c63ea20ad908f5eb9aaa432d5bd8da06b6a85`.
Javis baseline: `a0561b0c3a8f593f205946a1f1356887d72b5a1a`.
Branch: `feat/ai-brain-architecture`.

## Evidence boundaries

This is a local source audit of pinned revisions. No live Supabase/Render configuration,
production database, real customer context, model provider, Messenger/Zalo send, SIP/PSTN
call or production permission was exercised. No upstream Javis executable/dependency was
installed or run. Upstream clone is reference-only. No Javis code is copied into CRM.

Original checkout remains on its existing branch with its prior dirty files preserved.
`origin/main` was fetched before worktree creation; baseline Verify was successful for the
exact audited CRM SHA: [39721616776](https://github.com/hoanganhngo847-a11y/ai-crm-cua-chong-ngap/actions/runs/39721616776).
That is baseline CI, not CI for these new documents.

## Local checks

| Check | Result and limit |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | PASS, isolated worktree dependencies; lockfile unchanged. |
| `npm rebuild ffmpeg-static` | PASS, installs existing locked package binary for local verification only. |
| `npm run lint` | PASS, 0 errors and 13 existing warnings outside new documentation. |
| `npm run typecheck` | PASS (`next typegen && tsc --noEmit`). |
| `npm run build` | PASS with localhost URL and dummy build-only keys; 4 existing Turbopack tracing warnings in transcription audio splitter. No real credentials loaded. |
| `npm run test:omnichannel` | PASS, 6 deterministic/mock runtime tests. Not a live Meta acceptance test. |
| `npm run test:voice:unit` | PASS, recorded routing and pure helper tests. Local Supabase integration intentionally excluded by `--unit`; no phone calls. |
| `git diff --check` | PASS at document review. |
| Pinned source reference bounds | PASS: 12 explicit upstream path/line ranges in the architecture exist and are within the pinned files; source semantics separately reviewed. |
| Auth/security full DB suites | NOT VALIDATED in this audit. An exploratory `test:auth` with dummy local keys stopped in fixture setup with malformed-JWT error; no assertions ran. The chained security suite consequently did not execute. Do not count this attempt as PASS or as an application regression. Do not reset/reuse shared local fixtures just for a documentation PR. |
| New 15-point Brain tests | Planned in the architecture matrix; no Brain implementation exists in Phase 0. Not claimed passed. |

The initial build attempt without environment placeholders failed during prerender because
Supabase URL/anon key were absent. Repeating with explicit localhost/dummy build settings
passed. Neither attempt used production configuration.

Documentation-only changes do not alter runtime behavior. These checks do not prove deployed
private ingress, future Brain authorization, hosted RLS, model quality, latency or live
telephony. Those require the separate acceptance gates in `ARCHITECTURE.md`.

## Antigravity coordination

- `agy-0d02127c` — Claude Opus 4.6 (Thinking): FAILED at local agent engine immediately;
  no audit evidence or implementation accepted.
- `agy-4a9aaaff` — Claude Sonnet 4.6 (Thinking): FAILED at local agent engine immediately;
  no audit evidence or implementation accepted.
- `agy-6cdd7abc` — Gemini 3.8 Flash (High): COMPLETED; initial report required corrections.
- `agy-3c980925` — Gemini 3.8 Flash (High): COMPLETED; corrected audit reviewed below.

Codex owns `ARCHITECTURE.md`; the audit worker may write only `JAVIS_AUDIT.md`. No shared-file
editing is permitted. Any worker claim requires direct source verification before acceptance.

### Codex review of initial worker report

Initial audit `agy-6cdd7abc` completed in 521.47 s and created only `JAVIS_AUDIT.md`.
It was **not accepted as written**. Codex directly inspected memory scope SQL/path hashing,
optional session filters, MCP permission defaults and conditional coding tools, learning
write guards, router fallback, voice selector/realtime source and root license.

Corrections requested in `agy-3c980925` (Gemini 3.8 Flash High): acknowledge actual brain
scoping; replace unchanged-router reuse with adapter review; default-deny tool policy; preserve
conditional execution/write guards in descriptions; use a complete candidate-only CRM memory
schema; remove invented fixed wait/domain behavior, unmeasured latency and legal/compliance
certainty; use pinned source references and official-API-only proposed integration.

Independent focused review `agy-1bf74ee2` (Gemini 3.8 Flash Medium), completed in 40.94 s,
confirmed the relevant code branches in `mcp_catalog.py:486-553`, `mcp_hub.py:1748-1760`,
`model_router.py:182-236` and `capability_registry.py:34-40`. Codex does **not** adopt its stronger
claim that a leak is inevitable: exploitability depends on downstream integration/configuration,
which was not tested. Its suggested unkeyed scope hash is **not authentication**; the target
architecture instead requires issuer/audience-bound signed capabilities and live CRM checks.

Phase 1a branch `feat/ai-brain-contract` was prepared without implementation changes.
An earlier Sonnet implementation attempt failed before creating files. Worker availability
is not an architecture dependency: Phase 1a may be implemented by Codex or Gemini Flash High,
with full Codex diff and security review. No further Sonnet retry is required.

### Final Phase 0 decision

Correction job `agy-3c980925` completed in 259.07 s. Codex reviewed the actual corrected
98-line report and rechecked cited branches. Final editorial integration clarified that
conditional coding tools do not prove a general engine sandbox, removed an unverified
credential-encryption implementation detail, made the no-service-role capability boundary
explicit, constrained distiller output to UNVERIFIED, and added explicit scaling/privacy
unknowns. All source permalinks are pinned to the audited upstream SHA.

**Phase 0: PASS (source audit and architecture only).** Three documentation files added;
no application/runtime files modified. The local auth fixture limitation is not a Phase 0
architecture failure. Later DB/auth changes require real CI/Supabase verification.

This record captures the audit checks above. The documentation PR must pass its own CI before
merge. Phase 1a remains a separate PR, based on the merged architecture: trusted in-process
context, provider-neutral contract, READ_ONLY gate and deterministic provider only. Private
service authentication belongs to Phase 1b; no artificial authentication mechanism is needed
for a local module. No production automation, messaging, telephony, memory ingestion or
Javis deployment is part of either initial PR.
