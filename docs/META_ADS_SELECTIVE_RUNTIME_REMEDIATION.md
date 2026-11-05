# Meta Ads Selective Runtime Remediation

**Scope:** PR #139, branch \`meta_ads_integration\`  
**Purpose:** Correct the execution-boundary gap identified during final review.  
**Deployment status:** Hosted Staging and Production remain untouched and blocked.

## 1. Correction to the previous implementation report

At commit \`cfae1d7\`, \`buildSelectiveExecutorPackage()\` generated the SQL bundle and the project/version helpers existed as separate pure functions. There was no runtime entrypoint that invoked those helpers against the exact database connection used to execute the bundle.

Accordingly, earlier wording that described TypeScript target/version verification as already wired "before running migrations" overstated what the code actually did. The SQL preflight still contained its own target-ref and PostgreSQL-major-version guards, but those did not prove that the TypeScript connection URL being used by the operator was the intended Supabase project.

This addendum supersedes those earlier claims.

## 2. Runtime path added

The new \`scripts/meta-ads/selective-runtime.ts\` provides \`executeSelectiveRelease()\` and a guarded CLI entrypoint.

The runtime now performs these steps in order:

1. Parse the PostgreSQL URL without printing or logging its password.
2. Accept only:
   - Supabase direct: \`db.<project-ref>.supabase.co\` with user \`postgres\`.
   - Supabase pooler: \`<region>.pooler.supabase.com\` with user \`postgres.<project-ref>\`.
   - Localhost only when the caller explicitly sets \`allowLocalTest: true\`.
3. Compare the detected project ref with the fixed Staging ref \`qmhfmgkymjgoevwmkidm\`. A matching username on an unrelated host is rejected.
4. Require TLS for hosted Supabase connections.
5. Query \`server_version\` and \`server_version_num\` over the same parsed connection configuration that will be used for execution; reject anything outside PostgreSQL 17.x before sending the release SQL.
6. Require both a verified backup/restore rehearsal and an explicit owner-approval reference before any hosted execution. Local disposable tests use the separate local-test opt-in.
7. Execute the existing atomic SQL package once.
8. Open a fresh psql process and probe the database after both successful and failed execution results. Never retry automatically.

The CLI reads the connection URL from \`META_ADS_DATABASE_URL\`; it never prints that value. Hosted approval requires all three operator inputs:

- \`META_ADS_BACKUP_RESTORE_VERIFIED=1\`
- \`META_ADS_OWNER_APPROVED=1\`
- \`META_ADS_OWNER_APPROVAL_REFERENCE=<reviewed approval reference>\`

These flags are not set by CI. Hosted execution remains blocked until the real backup/restore and owner-approval steps have actually occurred.

## 3. Recovery behavior

| Runtime status | Meaning | Required action |
|---|---|---|
| \`COMMITTED_VERIFIED\` | psql returned success and the fresh-session probe verified the release | Do not rerun |
| \`COMMITTED_AFTER_ACK_LOSS\` | psql returned an error, but the fresh-session probe proved the database committed | Do not rerun |
| \`UNCOMMITTED_CLEAN\` | psql returned an error and the fresh-session probe proved no release objects/record were committed | No automatic retry; operator reviews the error first |
| \`HALT_AND_INVESTIGATE\` | Probe shows partial or inconsistent state | Stop; do not rerun |
| \`PROBE_UNAVAILABLE\` | The fresh-session probe could not be trusted or reached | Stop; do not rerun |

A successful psql exit is not sufficient by itself: the release is only reported committed after the independent probe confirms the registry, seven expected Meta relations, canonical ledger count, bundle hash, postconditions marker, and fence trigger.

## 4. Test evidence and its limits

The new \`tests/staging/selective-runtime.test.ts\` uses disposable local PostgreSQL databases built from the exact 21-migration prefix.

It verifies:

- Wrong project refs and arbitrary-host/pooler-username spoofing are rejected before any query.
- Local connections are rejected unless explicit local-test opt-in is present.
- Hosted execution is blocked before opening a connection unless backup/restore proof and owner approval are supplied.
- PostgreSQL 16 is rejected before the release SQL is sent.
- A normal local PostgreSQL 17 release is verified through a fresh probe.
- A deterministic lost-ack fault injection executes and commits the real SQL package, then returns an \`ECONNRESET\`-style client error. The runtime must discover the committed state through a fresh probe and return \`COMMITTED_AFTER_ACK_LOSS\`; the test asserts the release SQL was invoked exactly once.
- A pre-commit connection failure returns \`UNCOMMITTED_CLEAN\` without an automatic retry.

**Important limitation:** the lost-ack test injects the transport error at the psql-runner boundary after the database commit. It exercises the real PostgreSQL transaction and fresh-session recovery path, but it is not a packet-level TCP proxy test that physically drops the acknowledgement packet. The evidence must not be described as a physical network-disconnect rehearsal.

## 5. Safety boundary

This change does not:

- Connect to Hosted Staging or Production.
- Run \`supabase db push\`.
- Apply a migration to any remote database.
- Create real Meta leads or connect live Meta assets.
- Merge PR #139 or deploy Render services.

Hosted Staging remains **BLOCKED** pending a physical backup, isolated restore rehearsal, and explicit Project Owner approval.

## 6. Local verification command

After starting the disposable local Supabase stack, run:

\`\`\`bash
npm run test:selective-runtime
\`\`\`

The guarded manual entrypoint is available as:

\`\`\`bash
npm run meta-ads:execute-selective-release
\`\`\`

It refuses local execution unless \`META_ADS_ALLOW_LOCAL_TEST=1\`, and refuses hosted execution unless the three explicit approval variables above are present.
