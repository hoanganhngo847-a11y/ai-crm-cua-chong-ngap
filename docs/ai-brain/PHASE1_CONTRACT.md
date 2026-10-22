# Phase 1a: in-process AI Brain contract

Status: server-only contract and deterministic tests. There is no production caller, HTTP
route, Javis runtime, live model adapter, database adapter or channel dispatcher.
Base: Phase 0 PR #74, merge `a4ccfad8be5707ad1572cefbfbe23971b95aee30`.

## Entry point and authority

`features/ai-brain/index.ts` exports `createBrainService`, the contracts and the deterministic
mock provider. Construct the service in trusted server code with a required `resolveContext`
function and an explicitly selected provider, then call `handleBrainTurn(untrustedInput)`.
A missing resolver fails closed; an absent provider returns `BRAIN_UNAVAILABLE`.

The input contains resource selectors (`customerId`, `conversationId`, optional `sessionId`),
channel, modality, bounded text, optional latency and requested capability. Unknown fields,
including company, role, actor, tools, context and permissions, are rejected. All resource IDs
are UUIDs. Text is bounded by characters and UTF-8 bytes; no arbitrary channel metadata is
forwarded. The resolver receives only immutable selectors, never the customer message.

Only the server resolver supplies company, caller identity, capability profile, conversation
control, draft permission and trace ID. Scope must match selectors, including channel,
modality and optional session. Context is projected to known data fields, snapshotted and
frozen. Accessors and inherited authority are rejected. Provider requests are deeply frozen.
The provider cannot replace customer/conversation/company, grant tools or set delivery state.

**Security assumption:** the resolver is trusted server code. A real adapter MUST verify the
current actor/workload, active membership and company/customer/conversation/channel access
using CRM authorization before returning context. The same applies to future authenticated
background workloads. No resolver adapter is installed in this phase. Shape validation,
UUIDs and TypeScript types are not authentication. The tests use explicit test resolvers and
do not claim deployed AuthN, RLS or real CRM resource authorization. Providers are also vetted
server code: this module does not sandbox a malicious JavaScript plugin's own side effects.

## Policy, providers and results

Channels `MESSENGER`, `ZALO`, `PHONE`, `WEB`, `INTERNAL` share the same request/result path;
modalities are `TEXT` and `VOICE`, latency profiles `STANDARD` and `REALTIME`. Voice currently
means a text turn associated with voice context; no audio streaming, telephony or call identity
resolver is implemented. A UUID conversation selector is required even for the contract's
voice fixtures; real call/session mapping needs its later adapter.

Only `READ_ONLY` executes. `SAFE_WRITE` and `HUMAN_APPROVAL_REQUIRED` are preparation types
and fail closed. No actual CRM read/write tools or memory retrieval are implemented, so
non-empty tool/memory/source provenance claims from a provider are rejected.

- `RESPOND` always contains a draft with `delivery: DRAFT_ONLY`, in every conversation state.
- `HUMAN_ACTIVE` and `AI_PAUSED` can produce a draft only when the resolver permits drafts.
  Any false draft permission yields `NO_REPLY` without invoking the provider.
- `HANDOVER_REQUIRED` returns `HANDOVER` immediately without invoking the provider.
- `HANDOVER` and `NO_REPLY` proposals cannot contain a draft. Handover reasons are bounded
  identifier codes, not free-form reasoning.
- `ERROR` results are created by the service; provider proposals never select infrastructure
  error codes. Confidence must be finite in [0,1]. Unknown fields, including chain-of-thought,
  scope overrides, provider/model overrides and automatic-send requests, are rejected.

The deterministic provider returns a constant generic draft and performs no IO. Descriptor
`id`/`model` are server registration labels, never extracted from the proposal. Unknown
metadata properties are not read/copied; credential-like labels are rejected. Label checks
are defense in depth: server configuration must contain labels, never credentials.

## Deadline, errors and audit

The service uses one overall deadline covering resolver and provider, races pending work,
propagates an AbortSignal and clears the timer. Ignored cancellation cannot extend the
handler's wait or cause a late resolver to invoke the provider. Late promise rejections are
observed. Limits: default 5 seconds STANDARD / 1.5 seconds REALTIME; an explicit finite budget
must be between 1 ms and 10 seconds. These are bounded waits, not measured latency guarantees;
synchronous hostile plugin code cannot be preempted by a JavaScript timer.

Canonical errors: `BRAIN_UNAVAILABLE`, `BRAIN_TIMEOUT`, `BRAIN_POLICY_DENIED`,
`BRAIN_INVALID_CONTEXT`, `BRAIN_PROVIDER_ERROR`. Raw exceptions, messages, causes and stacks
are never returned or logged. Provider throws cannot forge another authority/error class.

Every result contains an immutable `audit` projection built inside the service from the
validated context: company/customer/conversation, channel/modality, generated turn ID,
server trace ID, provider/model labels, latency, decision, handover flag, empty provenance
arrays and safe error code. Before authorization completes, scope fields are null; no
untrusted selector is presented as authorized scope. Audit excludes input, drafts, raw
errors, credentials and reasoning. No audit database/log sink is installed. Future code must
persist this projection under CRM access/retention policy, rather than logging full results.

Turn IDs are generated per invocation; durable source-event correlation, replay/idempotency,
private service authentication, key distribution and transport belong to later phases. There
is no simulated service authentication or fake durable ledger in this local module.

## Verification and implementation review

Run `npm run test:ai-brain`; Verify CI executes it immediately after dependency installation.
Tests cover scope/authority injection, selector mutation, context mismatch, capabilities,
takeover/draft gates, every channel and voice modality, strict proposals, finite confidence,
bounds, metadata/error canaries, accessor/prototype rejection, provider scope mutation,
resolver/provider timeouts, late completion/rejection and timer cleanup. Compile-time maps
cover all channel and decision variants.

Antigravity implementation job `agy-d21b49ed` (Gemini Flash High) was cancelled after a partial
implementation. Codex reviewed all five written files, rewrote service/validation, removed
unused/public validation exports, added server-owned audit projection and the regression
suite, and wired the npm/CI entry. Initial mutable resolver selectors were corrected; the
service no longer accepts a caller-provided scope for audit projection.

Local contract tests: 92 passed. Lint: 0 errors, the same 13 pre-existing warnings; typecheck,
build, 6 Omnichannel tests, Voice unit tests and diff check passed.
Local auth/security suites passed against loopback Supabase: 66 auth and 119 security tests.
These unchanged suites establish local regression evidence; new resolver fixtures remain
mock authorization. PR CI separately runs real Supabase migration/auth/security/integration
gates. No test calls a model or sends a customer message/call.

Next work remains Phase 1b adapter skeleton, then Phase 2 CRM read-only tools. Nothing in
this module authorizes shadow activation, auto reply, telephony, memory ingestion, a new
scheduler, provider-key changes or Javis deployment.
