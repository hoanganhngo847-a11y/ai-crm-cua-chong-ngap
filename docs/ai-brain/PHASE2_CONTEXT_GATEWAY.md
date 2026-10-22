# Phase 2 — CRM Read-only Context Gateway

## Purpose

Phase 2 creates a CRM-owned, server-only read boundary that a future Brain/Javis runtime may use to retrieve **minimal context for the already-authorized customer**.

It does not expose Supabase credentials to Javis and does not create a public data API for arbitrary CRM browsing.

## Trust boundary

A context session is bound from trusted server scope:

- `companyId`
- `customerId`
- `conversationId`
- `channel`
- `traceId`

Tool calls do not accept any of those selectors. In Phase 2, tool `arguments` must be an exact empty object. Result limits are fixed in CRM code.

This prevents a model from changing `customerId`, changing tenant, asking for `limit=100000`, or invoking an arbitrary table/query.

## Read-only allowlist

The initial allowlist is:

- `get_customer_profile`
- `get_recent_conversations`
- `get_recent_interactions`
- `get_customer_stage_history`
- `get_upcoming_appointments`
- `get_call_history`
- `get_recent_call_summaries`

There is no generic SQL tool and no generic table reader.

## Data minimization

The Supabase source explicitly selects small field lists and fixed row windows.

Not returned in this phase:

- bank/payment data;
- contract value or finance summaries;
- recording paths/references;
- provider call/message IDs;
- conversation raw metadata;
- raw error messages;
- raw Zalo transcript text;
- credentials, tokens, cookies or authorization headers;
- arbitrary CRM records from other customers.

`interactions.sanitized_content` is the only message text source in this phase. Rows must have sanitization status `SUCCEEDED` or `NOT_REQUIRED` and non-null sanitized content. Returned message content is explicitly marked `untrustedContent: true`; it remains data, never authority/instructions.

Call summaries are retrieved only after selecting completed transcription IDs scoped by both `company_id` and `customer_id`.

## Supabase authorization note

The implementation uses the existing server-only service-role client as a transport credential. Service role is **not** treated as authorization. Every customer-bearing query explicitly filters both tenant and customer.

During Phase 2 audit, production grants showed that the selected source tables are readable by `service_role`, except `ai_analyses`. We intentionally did **not** widen database privileges merely to expose AI analyses, so that source is excluded from the first allowlist.

This also avoids relying on implicit Data API grants. Supabase's 2026 platform change makes table grants and RLS separate concerns and moves toward explicit grants for Data API exposure.

## Failure behavior

- Invalid trusted scope → `BRAIN_CONTEXT_INVALID_SCOPE`
- Unknown/non-empty tool arguments → `BRAIN_CONTEXT_TOOL_NOT_ALLOWED`
- Missing customer → `BRAIN_CONTEXT_NOT_FOUND`
- DB/source failure → `BRAIN_CONTEXT_UNAVAILABLE`

Raw database errors are collapsed and never returned to the Brain.

## What Phase 2 does not do

- no Javis deployment;
- no live Javis tool calls;
- no public/internal HTTP context endpoint;
- no customer-memory table or ingestion;
- no Company Brain knowledge ingestion;
- no model call;
- no Messenger/Zalo sending;
- no PSTN/Stringee changes;
- no CRM writes;
- no database migration or privilege change.

## Next step

After this boundary passes CI and security review, Phase 3 can add Company Knowledge + Customer Memory storage/retrieval and then expose these read tools through a narrowly authenticated Brain-service tool bridge. Auto-reply remains a later shadow-mode decision.
