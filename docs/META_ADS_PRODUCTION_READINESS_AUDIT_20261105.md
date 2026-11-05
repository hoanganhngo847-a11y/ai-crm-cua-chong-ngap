# Meta Lead Ads — Production readiness audit (2026-11-05)

## Approved Production target

- Supabase project: `yrauljxzyklhisxijeim` (`ai-crm-cua-chong-ngap-demo`), `ACTIVE_HEALTHY`.
- PostgreSQL: `17.11.0.002`.
- CRM tenant: `de6a7bf3-b5bc-418d-92d6-f9b241472598`.
- Approved Pages: Poland `1418087751743574`; Germany `1026991374010112`; Austria `654520554683416`; German Language Center `1014780055265237`.
- Europe Page is excluded.
- Render Production service `ai-crm-cua-chong-ngap` is attached to `main` with auto-deploy enabled. The separate `ai-crm-meta-staging` service is attached to `meta_ads_integration` with auto-deploy disabled.

## Read-only Production findings

- `supabase_migrations.schema_migrations` contains 102 rows, from `20260914000001` through `20261029170648`.
- The repository `main` branch has 115 migration files. Comparing by version and name found:
  - 72 exact version matches;
  - 30 same-name migrations with different local/remote timestamps;
  - 13 local migration names with no matching remote version/name;
  - one remote-only ledger record: `20261021132902 / zalo_transcription_scheduler_setup`.
- The `meta_ads_integration` branch has 124 migration files. Its additional migrations include the seven Meta Ads source migrations, plus non-Meta changes for Messenger gate behavior, Staging function hardening, and Facebook browser reconciliation RPC security. One earlier Messenger migration timestamp is replaced on that branch.
- Production `public.customers` currently has only its base columns (`id`, `company_id`, `customer_code`, `name`, `source`, `stage`, `created_at`, `updated_at`). The Meta attribution snapshot columns are absent.
- No Meta Ads tables or Lead Ads RPCs were found. `public.meta_data_deletion_requests` exists but is the separate Meta data-deletion feature.
- `private.customer_private_contacts` exists and has a unique tenant-scoped index on `(company_id, normalized_phone)`; reuse this existing phone identity primitive.
- Supabase Security and Performance Advisors each returned zero findings in this read-only inspection.

## Required Production release decisions

1. **Do not run `supabase db push`.** The 102-row remote history and repository migration history are not an exact append-only match. The 30 timestamp differences, 13 local-only migrations, and remote-only history entry require explicit catalog/schema reconciliation. Never fabricate, repair, or rewrite the historical ledger to make it resemble a branch prefix.
2. **Release only the seven Meta Ads migrations** after a Production-specific preflight confirms every dependency and exact source fingerprint. Do not bundle the three non-Meta branch migrations into Lead Ads.
3. **Do not reuse `scripts/meta-ads/selective-runtime.ts` as-is.** Its target guard is pinned to the Staging project `qmhfmgkymjgoevwmkidm` and its preflight assumes a 21-row historical prefix; Production has a different 102-row history.
4. **Page token custody is not complete.** Current Lead Ads and Messenger runtimes read `process.env[config.tokenEnv]`. OAuth retrieves Page access tokens for subscription checks, but the selection route persists Ad Account tokens only; it does not persist Page tokens. Before live intake, either implement and test an encrypted Page-token vault or independently verify secure per-Page token configuration. Do not put raw Page tokens in Git.
5. **Backup and restore are not verified.** No physical/offsite Production backup artifact, independent decryption proof, or isolated restore evidence was supplied. The connected Supabase tools used for this audit expose read-only inspection and SQL/migration actions, not a backup-download or restore-rehearsal workflow.
6. **Do not merge PR #139 wholesale as a Lead Ads-only release.** It currently contains 279 changed files and 122 commits, including unrelated Messenger, Zalo, AI Brain, and Customer 360 changes. Prepare a selective production integration and review its exact diff.
7. **Do not deploy or subscribe Pages until the above gates pass.** The Production Render service auto-deploys from `main`; pushing to `main` would trigger a live deployment.

## Supabase CLI note

Supabase CLI v3 changed the default target for database commands to the local stack and requires explicit `--remote` for hosted targets; unattended hosted changes require explicit `--yes`. See the [Supabase CLI v3 breaking-change notice](https://supabase.com/changelog?tags=supabase-server). Pin and verify the CLI version in CI and release scripts, and never rely on implicit project linking.

## Execution status at audit time

This audit was read-only. No Production DDL, migration-ledger mutation, Render environment change, Render deploy, Page subscription change, or real Meta lead ingestion was performed. Keep the Production hosted-write gate closed until the backup/restore, token-custody, migration-reconciliation, and rollback evidence is reviewed.
