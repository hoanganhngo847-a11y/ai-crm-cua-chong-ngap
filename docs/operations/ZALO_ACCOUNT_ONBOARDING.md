# Additional personal Zalo accounts

Boss admins with MFA manage up to three additional accounts at `/admin/zalo`.
The existing environment-configured account remains separate. The UI accepts a
label, J2TEAM cookie JSON, Zalo Web IMEI and the matching browser User-Agent.
Instructions and the official extension link are included on the page.

## Runtime and storage

- Apply `20261029164514_zalo_account_onboarding.sql` before the CRM release.
- Set the CRM-only `ZALO_ACCOUNT_ENCRYPTION_KEY` to 32 random bytes in base64.
  Keep this key stable and preserve it with the deployment's secret backups.
- Credentials use AES-256-GCM with company/account authenticated data. Private
  tables and service-only RPCs keep credentials out of browser reads and audit
  payloads. Only metadata appears in account lists.
- Deploy the CRM before the worker. The worker starts `src/supervisor.mjs`, polls
  the authenticated runtime endpoint and creates one OS process per account.
  This isolation is required by the pinned SDK's global `appContext`.
- Retain the persistent mount `/app/data`. The original queue path stays in
  place; added accounts use `/app/data/accounts/<uuid>/inbound-queue.jsonl`.
  Replacements wait for the previous queue owner to exit.
- Verified provider UIDs are unique within the company and distinct from the
  current account. A saved record cannot be changed to another provider UID.
- Added account identities, conversations and message references use an
  `account:<uuid>:` namespace. Routing refuses unavailable or paused accounts.
  New conversations start with AI paused; staff can reply manually in Inbox.

## Verification

`npm run test:zalo` covers encryption/AAD, admin authorization, private ACLs,
account limits, provider UID checks, lifecycle revisions, conversation isolation,
group sync, canonical outbox recipient preservation and durable ingestion.
The worker suite also runs the production supervisor against local fake provider
processes to exercise text/media/group routing and refusal after pausing.

After deployment, verify CRM page/API access under the real admin session,
unauthenticated denial, original worker `/ready`, zero pending inbound events,
and its legacy runtime heartbeat. Real login and message acceptance for an added
account require that account owner's still-valid session information.

Provider instructions: [SDK login documentation](https://github.com/ngogiaphat/ZCAJS#login)
and [official J2TEAM Cookies listing](https://chromewebstore.google.com/detail/j2team-cookies/okpidcojinmlaakglciglbpcpajaibco).
