# Read-only dependency audit evidence

Source: branch `meta_ads_integration`, commit
`48aab3388f69ecd9dd0f8da5546dfb8e25752e22`, 2026-10-30.
Only remote database inspected: `qmhfmgkymjgoevwmkidm`.
All remote operations were catalog/count SELECTs; no secret values or row
payloads were retrieved. Individual captures span separate transactions and
are not a locked snapshot or a certification of the future cleanup boundary.

The report is [here](../../META_ADS_STAGING_DESTRUCTIVE_DEPENDENCY_AUDIT.md).

## Evidence organization

- `staging-*.json`: actual read-only metadata/count captures. OIDs identify this
  snapshot only. Per-table captures include every current constraint, index,
  non-internal trigger and policy for all 14 target names.
- `queries/`: read-only catalog/count queries used for the captures. Their
  execution is not automated by these offline scripts.
- `staging-cascade-candidates.json`: recursive reverse dependency closure with
  internal-owner edges; **candidate** set, not a DROP dry-run. TOAST and FK RI
  implementation objects are included. PL/pgSQL source references and external
  consumers are not represented by pg_depend alone.
- `local-*.json`: read-only inspection/EXPLAIN of the pre-existing full local
  schema from the prior authorized remediation. No local database was created,
  reset, migrated or destructively tested for this task.
- `migration-risk-statements.json`: every top-level statement with exact SQL,
  original executable line, classification and nested DO/ALTER details.
  Statements use one JSON record per line to keep the artifact manageable.
- `function-definition-timeline.json`: definition/drop source locations and
  parameter metadata. Complete SQL is in the statement inventory; legacy body
  snapshots and the retained QC body reference are recorded separately.
- `repository-references.json`: tracked text search and TypeScript AST call
  inventory, including tests/docs/prior generated evidence, generic RPC helpers,
  dynamic names and four skipped image/icon binaries. Text hits such as
  `shared/contracts` imports are not treated as table consumers.
- `FULL_MIGRATION_RISK_MATRIX.md`, `LEGACY_DEPENDENCY_INVENTORY.md`,
  `DESTRUCTIVE_APPROVAL_CHECKLIST.md`: human review indexes.
- `legacy-dependencies.mmd`: current FK graph and retained QC body dependencies.

## Offline reproduction

Use an external Python environment with **pglast 8.7**; do not add a project
runtime dependency. The parser reports PostgreSQL grammar 18.6, while staging
is PostgreSQL 17. Syntax parsing is not a runtime/version compatibility test.
The repository's existing TypeScript 5.9.3 parser performs the source AST scan.

Run these from the repository worktree with the chosen Python executable:

```text
python docs/evidence/meta-ads-dependency-audit/build_inventory.py --test
python docs/evidence/meta-ads-dependency-audit/build_inventory.py
node docs/evidence/meta-ads-dependency-audit/scan_repository.cjs
python docs/evidence/meta-ads-dependency-audit/build_dependency_appendices.py
python docs/evidence/meta-ads-dependency-audit/validate_audit.py
```

These scripts read source/captured evidence and write only documentation
artifacts in this directory. They never connect to a database, import app
business modules, start workers, run SQL, deploy, repair history or push Git.
The source scanner uses `git ls-files`; after committing the generated evidence,
its self-generated files must remain excluded from a future baseline scan to
avoid counting its own copied references. This capture's source baseline was the
861 tracked files at the source commit before these new files existed.

Classifications are conservative review decisions, not grants of authority.
Metadata-only/additive SAFE statements still require a separate approval to
execute under the user's audit-only scope. All approval checkboxes remain empty.
