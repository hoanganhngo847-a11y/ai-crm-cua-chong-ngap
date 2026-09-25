# M9.6A — Current-System Integration & Security Gate

> [!IMPORTANT]
> **M9.6A IS NOT THE FINAL FULL BUSINESS-SYSTEM E2E.**
>
> M9.6A is a deterministic, repeatable integration and security gate that locks and verifies all capabilities and security invariants **currently merged and present** on branch `feature/ai-style-analytics`.
>
> M9.6B remains blocked until approved implementations for external communication channels, operations, and full lifecycle business modules are formally reviewed and merged into the trunk.

---

## 1. Boundary & Scope

### A. Capabilities Tested in M9.6A
The following integrated capabilities are thoroughly verified on clean PostgreSQL/Supabase schema:

1. **Foundation & Auth Infrastructure:**
   - Multi-tenant data segregation (`company_id` isolation, immutable tenant keys).
   - Role-Based Access Control (RBAC): `BOSS_ADMIN`, `SALE`, `TECHNICIAN`.
   - Multi-Factor Authentication (MFA) AAL2 enforcement for executive views.
   - User profile and company membership validation.
2. **Sensitive Data Boundaries:**
   - Separation of public vs private schemas (`private.customer_private_contacts`, `private.interaction_raw_contents`, `private.call_transcripts`).
   - Trusted Server Foundation access vs direct module query prevention.
3. **Response SLA Tracking (M9.1 & M9.2):**
   - Inbound customer message opens durable 5-minute SLA tracking window (`+300s` deadline).
   - Idempotent window retrieval on subsequent messages without deadline extension.
   - Outbound Sale response wins within 5 minutes (`SALE_RESPONDED` state, AI reply denied).
   - Atomic AI reply claim after 5 minutes with exclusive lease timestamp and audit trail.
   - Strict race resolution: Sale intervention prevents or cancels unsafe concurrent AI replies.
4. **AI Customer Analysis (M9.3):**
   - Sanitized-only ingestion: restricts AI model input to `sanitization_status = 'SUCCEEDED'` customer `MESSAGE` interactions.
   - Strict exclusion of `PENDING`, `FAILED`, internal `NOTE`, raw phone numbers, and private payloads.
   - Customer stage immutability: AI analysis never mutates `customers.stage` directly.
   - Model version provenance: server-governed model version validation; model-forged versions discarded.
5. **Sales-Style Learning (M9.4A):**
   - Outbound Sale message provenance: strictly learns from verified same-company Sale outbound messages.
   - Strict exclusion of customer messages, other Sales' messages, and inbound messages.
   - Deterministic chronological ingestion order (oldest to newest).
   - Business-policy regex firewall (fail-closed protection against price commitments, discounts, deposits, warranties, contracts, and fees).
6. **Sales-Style Approval & Activation Lifecycle (M9.4B):**
   - Privileged human approval: only active `BOSS_ADMIN` of the same tenant can activate profiles.
   - Single-Active invariant: exactly one `ACTIVE` sales style profile per company + sale user.
   - Atomic transition: activating a new profile automatically marks the previous active profile as `SUPERSEDED` with full lineage.
   - Reactivation prohibition: `SUPERSEDED` profiles cannot be reactivated (fails closed).
   - Machine runtime read: `service_role`-restricted bounded RPC (`get_active_sales_style_profile`) exposing only active parameters without source refs, examples, or message bodies.
7. **Analytics Data Layer (M9.5A) & Admin Dashboard (M9.5B):**
   - Metric interval semantics: strictly honors half-open `[from, to)` interval for period metrics.
   - Financial snapshot separation: company-wide financial position (`finance_summaries`) remains a snapshot of current state and is decoupled from period window.
   - Aggregate-only invariant: zero exposure of customer PII, phone numbers, interaction IDs, conversation IDs, or order IDs.
   - Zero/empty-state robustness: null/zero counts and amounts are formatted cleanly without `NaN`, `Infinity`, or `-Infinity`.
   - Admin UI security: server-side actor derivation, MFA AAL2 requirement, generic error fallback, no client-side DB calls.

---

### B. Modules Out of Scope (Deferred to M9.6B)
The following modules have **NOT** been merged into this branch and are strictly **OUT OF SCOPE** for M9.6A:
- CRM Customer360 & Unified Inbox
- Zalo Official Account Integration & Webhooks
- Facebook Messenger & Website Live Chat
- Cloud Voice / Hotline PBX & Live Audio Streams
- On-Site Survey Scheduling & Technical Measuring Apps
- Pricing Engine, Payment Gateways & Contract Signing
- Production, Installation & Warranty Dispatch Workflows

These capabilities will be validated in **M9.6B** once their respective feature branches are merged. **No mocks, stubs, or synthetic facades have been fabricated for these absent modules in M9.6A.**

---

## 2. Tenant & Authorization Matrix

The table below reflects canonical database and RPC access controls enforced across the system:

| Resource / Operation | Boss A | Sale A | Tech A | Boss B | Anonymous | service_role |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Analytics Overview RPC** | **ALLOW** | DENY | DENY | DENY | DENY | DENY |
| **Analytics Daily Series RPC** | **ALLOW** | DENY | DENY | DENY | DENY | DENY |
| **Sales Style Activation RPC** | **ALLOW** | DENY | DENY | DENY | DENY | DENY |
| **Active Style Worker Read RPC** | DENY | DENY | DENY | DENY | DENY | **ALLOW** |
| **AI Analysis Table Read (RLS)** | **ALLOW** | **ALLOW** | DENY | DENY | DENY | DENY* |
| **Response SLA Windows Table (RLS)** | **ALLOW** | **ALLOW** | DENY | DENY | DENY | DENY* |
| **Private Contacts Table** | DENY | DENY | DENY | DENY | DENY | DENY** |
| **Private Call Transcripts Table** | DENY | DENY | DENY | DENY | DENY | DENY** |

\* *Direct table access revoked from `service_role` to enforce access through bounded, audited SECURITY DEFINER RPCs.*
\*\* *Private schema access is restricted exclusively to trusted server Foundation utilities via security definer RPC.*

---

## 3. Directory Structure

```text
tests/e2e/
├── README.md                          # Milestone documentation & boundary definitions
├── run-integration-gate.ts            # Fail-fast deterministic orchestrator running Gates 1–13
├── current-system.integration.test.ts # Cross-module E2E integration test suite (Scenarios A–P)
└── security-boundaries.test.ts        # Tenant isolation, authorization, and static security guards
```

---

## 4. Running the Tests

### Quick E2E Cross-Module Tests
Runs the integration scenarios and security boundary checks:
```bash
npm run test:e2e-current
```

### Full Integration Gate Orchestrator
Executes all 13 gates sequentially with fail-fast enforcement:
```bash
npm run test:integration-gate
```

### Resetting Local Database
To verify migrations on a completely clean database:
```bash
npx supabase db reset
npm run test:integration-gate
```
