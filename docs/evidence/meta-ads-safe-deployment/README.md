# Safe deployment preflight evidence

Application/migration snapshot: `bdb4ee6b4a42d6e875e96926a6f53c1938f4ccc8`.
Date: 2026-10-30. Decision: **BLOCKED for deployment**.
Report: [META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md](../../META_ADS_STAGING_SAFE_DEPLOYMENT_PLAN.md).

All hosted database calls were metadata/count SELECTs against staging
`qmhfmgkymjgoevwmkidm`. Render calls were read-only GETs against the explicitly
identified staging service, including names-only retention of environment variables.
No production database, Meta credential/App setting, hosted backup/restore or
provider messaging operation was used. Environment values never appear here.

## Artifacts

- `staging-metadata.json`: actual ledger identities, stored SQL hashes, extension
  versions, named object existence, counts and seed-trigger absence.
- `staging-catalog.json`, `catalog-fingerprint.sql`: ten application catalog and
  effective-role privilege fingerprints; no private rows or secret values.
- `staging-default-acls.json`: actual Supabase default privileges used to model
  the local platform bootstrap before replaying exact application source bytes.
- `staging-legacy-counts.json`: all 13 existing target tables empty at observation;
  the fourteenth target absent. These are observations, not future DROP approval.
- `migration-inventory.json`, `PENDING_MIGRATION_INVENTORY.md`: all 121 source hashes,
  all 100 pending classifications/dependencies/transaction/recovery requirements.
- `migration-risk-statements.json`, `FULL_MIGRATION_RISK_MATRIX.md`: all 2,330
  top-level statements, including ALTER subcommands and immediate DO/dynamic SQL.
  Runtime function-body operations are labeled separately.
- `DESTRUCTIVE_REGISTER.md`, `DESTRUCTIVE_APPROVAL_ITEMS.md`,
  `destructive-approval-items.json`: 133 statement/subcommand records (115 pending),
  expanded to 178 target/subcommand items (160 pending), none approved. Dynamic
  catalog-dependent target sets must be revalidated at their actual boundary.
- `function-definition-timeline.json`, `legacy-pre-removal-functions.json`,
  `surviving-legacy-function-references.json`: source definitions/drop timeline,
  dynamic legacy signature expansion and retained QC body references.
- `local-reproduction-unmodeled-default-acls.json`: first structural replay; its
  privilege mismatches are retained, not hidden or treated as hosted parity.
- `local-reproduction.json`: final PostgreSQL 17.11 tests A/B/C with correct platform
  defaults, full per-file hashes/outcomes, ten matching prefix fingerprints,
  actual destructive-boundary object deltas, synthetic row-loss example, successful
  full Meta pipeline, retained QC failure and conditional canary-trigger failure.
  All three randomly named local databases were removed. No ledger row was invented
  or copied into them, and no external service was contacted by the SQL fixtures.
- `render-readiness.json`: live service branch/config and deploy identity; no deploy
  hook, credential or environment value is captured.
- `render-env-names.json`: only the three direct environment-variable names.
- `render-env-groups.json`: environment-group metadata; no linked group applies
  to staging and no group secret/value was retrieved or retained.
- `validation-results.json`: command results, expected failures and limits.

## Reproduction

The offline parser requires **pglast 8.7** in an external Python environment. It
uses PostgreSQL grammar 18.6 for AST inventory. Native PostgreSQL 17.11 executes the
actual SQL separately; parsing is not a dependency oracle or execution approval.
No runtime/application dependency was added for the parser.

```sh
python scripts/meta-ads/staging-preflight-inventory.py --test
python scripts/meta-ads/staging-preflight-inventory.py
npm run test:meta-staging-preflight
```

To refresh **local** reproduction evidence only:

```sh
CRM_SAFE_PREFLIGHT_EVIDENCE=1 npm run test:meta-staging-preflight
```

The TypeScript fixture uses only Docker `exec` into the local Supabase container
named by the repository's local `project_id`. It exposes no database URL, generic
remote target or remote executor interface. CREATE/DROP operations are confined
to its new `crm_safe_<uuid>_*` databases; canonical destructive statements execute
only inside those fixtures. A read-only hosted catalog capture is input evidence,
never an instruction or an applied-history row.

CI runs the same fixture after its disposable local Supabase start/reset. It pins
the reviewed 121 hashes while also replaying any additional checkout migrations;
additional checkout execution is not approved deployment scope. It does not
overwrite committed evidence unless the explicit local evidence flag is set.

## Limits

Auth/Storage managed-service internals are platform stubs; no JWT/MFA/Storage service
restore or Meta permission acceptance is claimed. pg_cron/pg_net are absent, so
their guarded provisioning/network branches are not validated. The non-empty
cleanup example is one pricing-policy row and a surviving customer, not full
non-empty coverage of every destructive target. RLS/ACL/catalog equality does not
certify outside callers, future row counts, lock timing or the exact future live
CASCADE closure. A passing DDL replay does not repair the retained QC API.

No backup archive or object bytes exist in this evidence bundle. A real encrypted
checkpoint, independent key custody and actual isolated restore proof are still
required by the report. All previous evidence and historical migration files were
left unchanged. This bundle provides no permission for deployment, cleanup,
history repair, configuration changes, resource creation, real leads or sending.
