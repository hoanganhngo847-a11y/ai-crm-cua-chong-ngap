# Outbound delivery contract repair

Two browser-outbox changes broke existing outbound paths:

- `record_outbound_interaction_atomic` referenced `conversations.customer_name`, which does not exist. Migration `20261020220001_fix_outbound_customer_metadata.sql` reads canonical `customers.name` using both the effective customer ID and company ID. It preserves the RPC signature, actor checks, transaction, idempotency, empty search path, and service-role-only execution.
- The later delivery-status CHECK omitted `DISPATCHING`, `PROVIDER_SENT_PENDING_FINALIZE`, `UNCERTAIN`, and `PROVIDER_UNCERTAIN`, introduced by `20261001150001_ai_durable_dispatch_hardening.sql` and still used by existing RPCs. Migration `20261020220003_restore_outbound_delivery_status_contract.sql` restores the closed union of the 13 legitimate AI and browser-outbox states. The separate browser-worker `status` column and RLS remain unchanged.

Both migrations preserve existing rows and existing migration files. Their timestamps follow the repository's existing future-dated migration `20261020220000`; the CLI-generated scaffolds were renamed to preserve deterministic ordering.

## Validation

`npm run test:inbox` includes actual PGlite SQL regressions for canonical metadata, tenant isolation, actor attribution, idempotency, status acceptance/rejection, and client write denial. Each test independently fails when only its repair migration is excluded from the in-memory bootstrap.

Relevant commands:

```sh
npm run test:inbox
npm run test:inbox:db
npm run test:zalo:db
npm run test:round3-product-runtime
npm run test:integration-gate
npm run typecheck
npm run lint
npm run build
```

Codex verified the real local Supabase Inbox and Zalo OA database suites, all 72 product-runtime checks, the 28-gate integration runner, and a production build using local placeholder configuration. The checks use controlled fixtures and mocked provider sends; they do not prove live provider delivery. Lint has 13 existing warnings and no errors.

## Rollout

Apply the two additive migrations, verify the database and RPCs, then merge and deploy. Main may auto-deploy on Render.

During this overnight run, the two reviewed SQL repairs were applied only to the named local Docker Supabase instance for testing, without changing migration history. No production migration, main merge, or production deployment was performed. Production rollout requires separate explicit authorization.
