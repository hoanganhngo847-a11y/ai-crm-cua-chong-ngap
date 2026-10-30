# Zalo group identity and message reliability — 2026-10-29

Status: release in progress. Migrations `20261029154354` and `20261029154410` are applied to Supabase project `yrauljxzyklhisxijeim`. Render worker `srv-dba20juq1p3s73a0re10` now has a 1 GB persistent disk at `/app/data`, the queue path configured under it, and `/ready` health checks. Application deployments and live acceptance are pending. No customer test message was sent.

## Changes

- Group details use exact string IDs, a five-minute cache with explicit refresh, and invalidation on group events. Roster IDs come from `memberIds`, `memVerList`, and current member previews; separate member-profile lookups fill missing names with bounded concurrency/timeouts. Unknown counts stay unknown and incomplete rosters are labelled.
- Individual sender IDs are retained. History reads a server-only author projection and realtime uses the same group-prefix presenter. Re-fetches may repair author projections while the original raw audit table remains append-only.
- The queue persists and flushes original events before enrichment, retries until explicit CRM acknowledgement, retains events above its warning threshold, and preserves malformed bytes in a quarantine file. Boot resumes the queue before starting the listener; shutdown waits for queued writes.
- The pinned dependency requests direct and group history on reconnect and periodically, including bounded cursor pagination over a seven-day window. WebSocket errors close the socket to enter the existing reconnect path. Actual restoration depends on the history Zalo returns.
- Native timestamps survive recovery. History imports and messages delayed more than two minutes cannot enqueue new AI replies through the ZCAJS wrapper. No AI setting is enabled by these migrations.
- The inbox first loads its newest 100 messages, then offers older pages using timestamp and ID cursors. Database read errors are shown instead of an empty conversation. Older-message loading preserves scroll position.

## Validation

- `npm run test:zalo`: PostgreSQL/PGlite migrations and ingestion contracts, group metadata/author repair and tenant boundaries, history safety, 1,100-message pagination, normalizer and worker durability/protocol tests.
- `npm run typecheck`, a full `npm run build`, and targeted ESLint on the changed CRM modules: passed.
- `npm run test:realtime-inbox` and `npm run test:short-messages-and-links`: passed.
- Exact Docker-pinned ZCAJS source plus all dependency patches compiled with `npm run build`. A full Docker image build and real Zalo acceptance were not performed.
- `npm run test:inbox`: tenant isolation, phone masking, webhook/RBAC, delivery polling, and conversation/heartbeat checks passed. The suite then fails in existing Facebook fixture setup: a nonnumeric `page_id` becomes null in `seed_messenger_pages_canary`, violating the allowlist's NOT NULL constraint. This same failure was reproduced while excluding both new migrations. The separate outbound-status contract test encounters the same pre-existing fixture problem.

## Deployment requirements and remaining acceptance

Follow [the operations guide](../ZALO_ZCAJS_OPERATIONS.md#group-identity-and-message-reliability-rollout-2026-10-29): apply both new migrations, deploy CRM, rebuild/deploy the worker, and verify its queue path is on a persistent disk. Confirm group names, sender identity, counts and rosters against naturally arriving Zalo PC messages; perform interruption/restart acceptance in a controlled environment. Deleted, expired, inaccessible, or older provider history cannot be promised recoverable.
