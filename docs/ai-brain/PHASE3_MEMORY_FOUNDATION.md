# Phase 3 — Company Knowledge + Customer Memory Foundation

## Scope

Phase 3 adds storage and read-only retrieval for the two long-term knowledge layers described in the AI Brain architecture:

1. **Company Knowledge** — business-approved information shared across customers of one company.
2. **Customer Memory** — long-term customer-scoped facts/preferences/intents/objections/context with provenance, confidence and verification state.

This phase creates **no ingestion worker**, performs **no historical backfill**, makes **no live model/Javis call**, and does **not** enable automatic messaging or telephony.

## Company Knowledge

Table: `public.ai_company_knowledge`

Categories:

- `COMPANY_PROFILE`
- `PRODUCT`
- `SERVICE`
- `FAQ`
- `POLICY`
- `SALES_PLAYBOOK`
- `PROCESS`
- `OTHER`

Knowledge has independent verification and lifecycle state.

Only rows with:

- `verification_status = VERIFIED`
- `lifecycle_status = ACTIVE`

are eligible for Brain retrieval.

The schema stores title/content/source/version/checksum/metadata and a generated full-text search vector. Phase 3 does not automatically populate it.

## Customer Memory

Table: `public.ai_customer_memories`

Memory types:

- `FACT`
- `PREFERENCE`
- `INTENT`
- `OBJECTION`
- `TEMPORARY_CONTEXT`
- `AI_INFERENCE`

Each memory is scoped by **both `company_id` and `customer_id`** with a composite foreign key to `customers(company_id,id)`.

Stored provenance includes:

- source kind;
- source channel;
- opaque source reference id;
- source event time;
- creator type;
- confidence;
- verification timestamp;
- supersession relationship.

`source_ref_id` is intentionally polymorphic and opaque. Application code must never dereference it without reapplying company/customer scope.

### Fact safety

The database rejects:

`memory_type = AI_INFERENCE` + `verification_status = CONFIRMED`

If a human later verifies an inference as true, the record must be promoted/re-expressed as an appropriate non-inference memory type rather than silently turning inference into fact.

Confirmed memories require `last_verified_at`.

## Lifecycle

Customer memories:

- `ACTIVE`
- `SUPERSEDED`
- `ARCHIVED`

Company knowledge:

- `ACTIVE`
- `ARCHIVED`

There is intentionally **no DELETE grant for service_role** in Phase 3. Historical knowledge/memory should be archived or superseded, preserving provenance and auditability.

## Database access model

Both tables:

- have RLS enabled;
- revoke all access from `PUBLIC`, `anon`, and `authenticated`;
- grant only `SELECT`, `INSERT`, `UPDATE` to `service_role`;
- expose no public policy.

The service-role credential remains inside the CRM server. It is not sent to Javis, browser clients, Mac agents or models.

## Brain retrieval tools

The Context Gateway gains two read-only tools:

### `get_customer_memory`

Accepts no arguments.

Tenant/customer/limits are server-owned. The datasource returns at most 30 `ACTIVE` memories for the bound customer and excludes `REJECTED` memories.

Returned memory content is marked `untrustedContent: true`. The result includes memory type, confidence and verification state so downstream prompting can distinguish confirmed facts from unverified memory or AI inference.

### `search_company_knowledge`

Accepts exactly:

```json
{ "query": "..." }
```

The query is trimmed, limited to 300 characters and cannot contain control characters. No `companyId`, `customerId`, `conversationId` or row limit can be supplied by the model.

The datasource searches only the already-bound `company_id`, only `VERIFIED + ACTIVE` rows, and returns a fixed maximum of 12 items.

## Retrieval safety

Customer memory:

- always filters both `company_id` and `customer_id`;
- excludes `REJECTED` and non-active rows;
- preserves confidence and verification status;
- is treated as untrusted data, not instruction authority.

Company knowledge:

- always filters the server-bound `company_id`;
- only verified active knowledge is eligible;
- model search text affects search terms only, never scope or result count.

## Tests

Phase 3 adds:

- unit regression for knowledge-search argument validation;
- model attempts to override company/customer/limit are rejected;
- DB integration after `supabase db reset`;
- anon cannot read either memory table;
- service_role can insert/read/update but cannot delete;
- DB rejects confirmed `AI_INFERENCE`;
- real Supabase datasource retrieves active customer memory and verified company knowledge while excluding rejected/unverified records where required.

## Explicitly not implemented

- no automatic memory distillation;
- no historical conversation/call ingestion;
- no Company Knowledge admin editor;
- no embeddings/vector database;
- no live Javis Brain Service deployment;
- no Javis tool bridge yet;
- no write tool available to the model;
- no Messenger/Zalo auto-reply;
- no PSTN/AI outbound calling;
- no CRM stage/deal/payment mutation.

## Next phase

The next safe step is a **Memory Distillation Candidate Pipeline in shadow mode**:

raw sanitized interaction/call summary → structured candidate memory → validation/deduplication → stored as `UNVERIFIED`.

It must not promote AI inference to confirmed fact, must not backfill history automatically, and must remain non-customer-facing until separately accepted.
