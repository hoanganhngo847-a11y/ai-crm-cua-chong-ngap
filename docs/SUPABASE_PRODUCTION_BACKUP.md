# Supabase DB-only backup and independent restore

This runner prepares a logical backup of the approved Supabase PostgreSQL 17.11 database. The export, R2 publish, and independent restore are separate Owner-controlled steps. GitHub Actions runs the disposable synthetic fixture with a loopback S3 server. It has no archive upload step or Production credentials.

## Scope and prerequisites

- Production source is project `yrauljxzyklhisxijeim`, database `postgres`, through its direct endpoint or session pooler on port 5432 with TLS `verify-full`. Use native PostgreSQL 17.11 clients on the backup host and the pinned Supabase image on the restore host. The Python requirements are pinned with hashes.
- The export covers every application and managed database schema, roles without passwords, memberships, owners, ACLs, database and database-specific role settings, RLS, extension-owned data, sequences, large objects and the migration ledger. It keeps PostgreSQL Storage metadata in scope. Storage object bytes, platform and application secrets, Edge deployments, WAL/PITR and service recovery require separate plans.
- Use an Owner-approved encrypted host and an existing private scratch directory outside the repository with mode `0700`. The runner checks at least 5 GiB free before export and restore. The Owner also verifies encryption, peak disk headroom, Docker backing storage and the network egress budget. Native client tools and the pinned image must be available before the approved window.
- Verify the age binary checksum against an approved release for the host architecture. The backup runner only receives the Owner's public X25519 recipient. Use a separate encrypted restore host and local Docker socket. Keep the private identity in the Owner's custody.
- Store the trusted receipt outside GitHub and separate from the R2 writer. Record the exact source revision and tool checksums separately. The receipt carries the project, UTC snapshot, recipient fingerprint, immutable R2 key, image digest, ciphertext bytes and SHA-256.

## Synthetic rehearsal

The fixture creates its own PostgreSQL 17.11 source with artificial records and a disposable restore target. It covers database ACL and GUC settings, role attributes and memberships, column/default grants, RLS across two tenants, extension data, a sequence, a large object and the migration ledger. The default run verifies a PUT whose response was lost after commit using a loopback S3 server.

The following setup is for an approved host. Reuse its existing dependencies and pinned image when available.

```sh
python3 -m pip install --require-hashes -r scripts/production_backup/requirements.txt
docker pull public.ecr.aws/supabase/postgres:17.11.0.002@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53
python3 tests/production_backup/fixture_roundtrip.py
```

For a real Cloudflare smoke, the Owner runs the fixture locally with verified binaries. The script prompts on the terminal after the synthetic export succeeds. It sends a single unique ciphertext to the approved bucket under `smoke/`, downloads it for SHA-256 and lifecycle verification, and downloads it again for independent decryption and restore. The bucket lifecycle removes the synthetic object after one day.

```sh
python3 tests/production_backup/fixture_roundtrip.py \
  --live-r2 \
  --scratch /absolute/private/encrypted/scratch \
  --age-dir /absolute/verified/age/bin \
  --age-sha256 YOUR_VERIFIED_AGE_SHA256 \
  --age-keygen-sha256 YOUR_VERIFIED_AGE_KEYGEN_SHA256
```

## Production procedure after separate approval

1. Run `scripts/production_backup/main.py export` on the approved backup host with `--owner-approved-project yrauljxzyklhisxijeim`. Supply `--scratch`, `--age-dir`, `--age-sha256`, `--recipient`, `--pg-bin` and `--ca-file`. Enter the connection URL at the hidden prompt. Use a quiet window for schema and role changes and sequence drift. The export uses a shared read-only snapshot and verifies scope, archive table of contents, and drift before issuing an upload-ready receipt.
2. Review and save the trusted `receipt.json` outside the R2 writer's control. Run `main.py publish --owner-approved-project yrauljxzyklhisxijeim --receipt PATH --ciphertext PATH` using that receipt and ciphertext. Enter the existing bucket-scoped token at the hidden prompts. The runner only sends a conditional PUT to the unique `pre-migration/` key, then verifies the exact ciphertext via GET.
3. If PUT times out or the process stops, retain the ciphertext and receipt. Use `main.py reconcile --owner-approved-project yrauljxzyklhisxijeim --receipt PATH` for a read-only check. A matching size and SHA-256 verifies the original object. A missing or unreadable object leaves the attempt unresolved. The Owner decides whether to repeat the same conditional PUT with the same bytes and key. A conflicting digest remains a failed verification. The runner has no DELETE operation.
4. After Owner approval for restore, the independent operator runs `main.py restore` with `--owner-approved-project yrauljxzyklhisxijeim`, `--receipt`, `--scratch`, `--age-dir`, `--age-sha256` and `--identity`. Supply a read-authorized R2 credential via the hidden prompt. Keep the Owner's identity file out of the Docker container. The runner verifies R2 SHA-256, age decryption and the internal manifest before executing SQL. It restores roles, native database creation/ACL/settings, pre-data, data, extension rows, sequences and post-data on the isolated PostgreSQL 17.11 container.
5. Record elapsed time, sanitized status and the trusted receipt. Retain the ciphertext until upload and reconciliation have closed. The runner cleans plaintext from its private scratch and removes its own restore container. Treat database coverage and platform recovery as separate results.

[PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) · [Cloudflare R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) · [Supabase backup scope](https://supabase.com/docs/guides/platform/backups)
