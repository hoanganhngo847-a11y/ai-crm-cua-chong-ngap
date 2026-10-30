# Meta Ads: discovered assets and isolated validation proposal

Prepared 2026-10-30. **Planning and offline verification only. Live validation has not succeeded and has not been attempted for these assets.** No secrets were generated/read from Render, no production settings or migrations were changed, and no lead or campaign was created. The only source for the asset inventory below is the user's browser-based discovery; code tests use mocked HTTP responses.

## 1. Verified inventory and unverified relationships

| Asset | Discovered identifier | What this establishes |
| --- | --- | --- |
| Real Ad Account | `996324396811261` / API ID `act_996324396811261` | Name: TKQC Du học - NV mới. This is not an approved test account. |
| Business | `718969187283577` | Discovered business; assignment of every asset/principal still needs proof. |
| Production-connected Page | `654520554683416` | Name: Du Học Áo CHD. Do not create test leads here. |
| Form on that Page | `1698659958359492` | User verified Page/form pairing; not an approved staging form. |
| Candidate app | `1780871206505449` | Not compared with configured Render `META_APP_ID`; appears Development/Unpublished. |
| App business | `1042474848807943` | Different from discovered business; cross-business sharing/access is unverified. The difference alone does not prove either compatibility or incompatibility. |
| Existing test lead | None found | No lead ID exists for a lead-detail acceptance check. |
| Correct production Render service | `srv-db2dcguk1f9s73a289cg` | Credential-location reference only; never use the earlier mistyped service ID. This service is excluded from staging mutations. |

Co-discovery of a Page and an Ad Account does **not** establish ownership, advertiser access, campaign use of the Page, or CRM tenant membership. Business IDs are not CRM company UUIDs. Record explicit asset assignments/partner sharing, Page advertiser/lead access and app role grants before testing. Do not infer any of those facts from names.

## 2. Current blockers

1. No dedicated staging Render service/origin, isolated Supabase project, CRM company UUID, approved test Ad Account, separate test Page or test form has been supplied. The discovered real account/Page/form are excluded from lead creation.
2. No approved credential access procedure exists for staging. A Render service ID plus variable names is a location reference, not a verified secret-manager URI, token validity proof, or authorization to copy production secrets.
3. Configured app ID versus candidate app ID, app ownership/roles, access levels, permission grants, granular asset scopes and token expiry have not been verified.
4. The app appears unpublished. The official Testing Tool guide says that tool cannot be used in development mode. Do not switch the production app live to work around this; establish an allowed test setup and its access level first. If Meta supports the API testing route for the chosen test setup, verify that eligibility separately rather than assume it.
5. App-level Page `leadgen` field subscription, Page-level app subscription, callback isolation, and correct verification/signature secrets are unverified.
6. Page ↔ Ad Account ↔ Business/App assignments remain unverified. The Page/form pairing by itself does not resolve them.
7. `META_TOKEN_ENCRYPTION_KEY`, `META_PREVIOUS_TOKEN_ENCRYPTION_KEY`, `META_SYSTEM_USER_TOKEN`, and `META_MARKETING_VERSION` were not observed in the production discovery. Do not provision or change them now. Fresh staging needs its own dedicated primary key before OAuth account-token persistence. A previous key is needed only when migrating existing ciphertext, with the prior effective-key plan verified first.
8. The Page form-catalog read requires additional API acceptance: the current official v26 Page `leadgen_forms` reference says reading is unavailable, while this branch has an optional GET helper for that edge. That helper is not invoked by OAuth selection or the account coordinator. Its mocked tests prove request construction only. Resolve the documentation/endpoint discrepancy before claiming form-catalog support; do not create a form or add write scopes as a workaround.
9. Permission dependencies are not settled by requesting a scope string. The current permission reference lists additional dependencies for `leads_retrieval`; actual granted/access-level requirements must be verified on the chosen app and test assets. Do not claim that removal of ad-specific fields proves the reduced permission set sufficient.

## 3. API versions and code compatibility

Use **`META_GRAPH_VERSION=v26.0`** and **`META_MARKETING_VERSION=v26.0`** for the proposed staging run. They are separate variables. The code accepts Graph v21–v26 and Marketing v25/v26, but those are compatibility ranges, not evidence of successful endpoint access. Never send Marketing traffic using the production Graph variable implicitly.

Official version tables inspected 2026-10-30 list v26.0 (released July 29, 2026) for both APIs. Marketing v24 expired October 6, 2026; v25/v26 are available. Graph v21 remains listed until January 21, 2027. This proposal pins v26 for both and records the actual API response/version evidence during future acceptance.

| Path or behavior | Implementation review |
| --- | --- |
| OAuth start/callback | Uses Graph version; state verification; server session bound to actor/company; BOSS_ADMIN/AAL2 except the existing review exception. Exact callback is `/api/facebook/connect/callback`. Do not copy production reviewer exceptions into staging. |
| Page discovery | `GET /me/accounts`; paginated. Page `654520554683416` is a valid numeric ID, but selection requires it in both the managed Page result and server-owned bindings. Discovery alone never adds a binding. |
| Ad Account discovery/selection | `GET /me/adaccounts` uses Marketing version. OAuth selection matches the returned ID **`act_996324396811261`**. Marketing sync accepts the raw numeric account ID and adds `act_` when needed. It does not derive a Page relationship from the selection. |
| Page binding | `META_PAGE_BINDINGS` maps Page ID to a staging CRM **company UUID** and a separate token env **name**. `META_PAGE_BINDINGS` overrides the single-Page fallback. No token value belongs in its JSON. |
| Form/lead webhook | `/api/webhooks/meta` validates the app signature and Page binding, parses a numeric-string form ID and ingests a lead via its stable Page/lead key. Form `1698659958359492` fits the parser. There is no form-only allowlist or automatic account/Page ownership proof; therefore isolation must be at the Page/app/service boundary. |
| Basic lead read | Graph `/{leadgen_id}?fields=id,created_time,form_id,field_data`. Ad-specific Lead fields are not requested. The signed webhook's ad ID is looked up in company-scoped synced Ads records. |
| Attribution | Unknown/missing ad/campaign mappings stay UNATTRIBUTED. Raw IDs are retained. Selection of an account never proves an incoming lead belongs to it. |
| Subscription mutation | Existing OAuth select subscribes **both `messages,leadgen`**, not leadgen alone. Running it against a real Page is a mutation and is not approved. For an Ads-only staging run, approve a dedicated Page and either explicitly accept that combined scope/subscription or first implement/review a leadgen-only connection path. |
| Reporting sync | Account access, campaigns, ad sets, ads, account/campaign daily insights use Marketing version and Bearer headers. No campaign/ad mutation is part of this test. A system-user token is optional for interactive OAuth; unattended sync needs a valid stored token or an authorized staging system-user token. |

The offline regression uses all discovered public IDs, proves Page binding fails closed before configuration, verifies `act_` normalization and separate Page/form/account request paths, and makes **no live Meta calls**. It proves syntactic/code compatibility, not asset access or relationships.

## 4. Permission minimum and verification rules

The least-privilege **proposed base set** for account reporting plus basic lead intake is below. It is not yet a verified sufficient set for this app's Meta access model.

| Permission | Why requested | Future verification, without recording tokens |
| --- | --- | --- |
| `ads_read` | Account assets and insights, read-only | Granted permission/access level plus successful bounded GETs for the approved account. No campaign write call. |
| `leads_retrieval` | Basic lead answers | App review/access level and Leads Access Manager assignment; retrieve only the dedicated staging test lead after approval. Check all current dependency requirements. |
| `pages_show_list` | Managed Page discovery | Approved staging Page appears in `/me/accounts`; relevant granted/granular scopes. Do not treat mere list presence as lead access. |
| `pages_read_engagement` | Page metadata needed by the connection | Granted access and successful minimal Page metadata read. |
| `pages_manage_metadata` | Subscribe the staging Page to webhook events | Permission grant plus app/Page subscription read-back; the subscription write is a separate approved staging action. |
| `pages_messaging` | Existing combined Messenger/OAuth connection only | Required by the current combined connection path, not inherently by Ads reporting. If used, verify grant but block all outbound messaging. Otherwise a reviewed Ads-only path is required before removing it. |

The official `leads_retrieval` reference currently lists `Ads Management Standard Access` (a feature/access level), `ads_management`, `ads_read`, `business_management`, `pages_manage_ads`, `pages_read_engagement` and `pages_show_list` as dependencies. That is broader than the code's six requested OAuth scopes. Therefore the actual minimum sufficient permission set for lead retrieval is **not yet established**; this is a blocker, not permission verification by omission of fields.

`ads_management`, `pages_manage_ads`, `business_management`, `pages_manage_posts` and other write/management scopes are **not silently added**. Official lead docs/reference list management/dependency requirements for some lead/ad-level operations. If Meta requires any additional scope even for this exact basic-read/test-asset flow, stop and record endpoint, access level, documented dependency and sanitized error code. Obtain separate review of the minimum justified scope; do not broaden permission or app mode merely to obtain a passing test.

A privileged operator can inspect token-debugging metadata in a confidential session using Meta's official debugger or an approved in-memory harness. The debugging endpoint requires an app token or an app-developer user token associated with the input token's app. Do not grant the agent bulk access to production environment values. No token is passed in shell arguments, copied into chat, exported in screenshots or logged in a URL/error body. Do not save browser HAR/network exports containing credentials.

Retain only: app ID comparison result, token validity, expiry/data-access expiry, granted/declined scope names, relevant granular target IDs, principal/asset assignment proof and HTTP/error codes. `/me/permissions` confirms grant status; `debug_token` metadata confirms token/app association and granular scopes; direct minimal reads confirm effective access. None of those checks alone substitutes for the others.

## 5. Render configuration checklist — proposal only

No operation on `srv-db2dcguk1f9s73a289cg` is included. Select a **new staging service ID** before approval. Confirm its Render workspace/project/environment and whether Dashboard, Blueprint or an environment group owns configuration. Never attach the production env group to staging. Render env changes can trigger a deploy; even “Save only” affects a later deploy. This document is not approval to save changes.

| Staging configuration | Required evidence before approval |
| --- | --- |
| Repository/commit | Exact reviewed PR head SHA; no merge or production deploy. Disable automatic deployment while preparing the test. |
| `WEBSITE_ORIGIN` | Dedicated HTTPS staging origin; distinct from production and OAuth allowlist entry. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Fresh staging-only database/keys; no production project, storage or customer-data copy. Never export service-role key to the client. |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Dedicated approved staging app, or documented isolated test-app setup. An operator provisions/validates these later; no secrets are generated in this task. Compare app ID before checking token metadata. |
| `META_GRAPH_VERSION`, `META_MARKETING_VERSION` | Explicitly `v26.0`, independently configured. |
| `META_TOKEN_ENCRYPTION_KEY` | Dedicated staging effective 32-byte key, supplied securely in a separately approved setup. Required before storing OAuth credentials. |
| `META_PREVIOUS_TOKEN_ENCRYPTION_KEY` | Absent for a fresh empty staging vault; otherwise blocked until old-key/ciphertext verification passes. Never copy a production passphrase as a parsed effective key. |
| `META_PAGE_BINDINGS` | Only the approved **new staging Page ID**, staging company UUID and token-env name. Do not insert any of the discovered production Page IDs. |
| `META_STAGING_PAGE_TOKEN` | Example env name referenced by the binding, with a valid staging Page token provisioned by an operator later. No secret value in the JSON. Existing `META_PAGE_ACCESS_TOKEN`/CHD/Botcake names do not prove the token belongs to the new Page. |
| `META_SYSTEM_USER_TOKEN` | Optional for interactive test; only required if the approved run includes unattended sync and no valid stored token suffices. Dedicated staging assets/scopes only. |
| `META_LOGIN_CONFIG_ID` | If present, verify that Login for Business config's actual scopes and asset targets; it can determine grants beyond the source's `scope` parameter. |
| `CRON_SECRET`, campaign/AI/provider config | No production secrets; no background cron, AI auto-reply, campaign scheduler, Messenger/Zalo/voice sending or third-party CRM connector. Use empty/default-off staging settings and verify them in the database/runtime. No invented env kill switch is assumed. |

Use a placeholder-only binding when reviewing configuration, never an executable production mapping:

```json
[{"page":"<NEW_STAGING_PAGE_ID>","company":"<STAGING_COMPANY_UUID>","tokenEnv":"META_STAGING_PAGE_TOKEN","name":"Meta Ads isolated test"}]
```

Apply migrations **only** to the new isolated staging database after separate approval. While applying them, block egress to production endpoints and audit migration-created cron/jobs/triggers; some historical Messenger migrations configure live automation. Disable staging scheduler jobs before enabling ingress. Prove staging has no enabled live-delivery settings, production Page bindings, outbound worker or connected external CRM. A fresh database alone is not sufficient isolation if historical automation is active.

## 6. Meta Developer / Business checklist

- Confirm the configured app, candidate app and staging app identities separately; do not assume `1780871206505449` is the deployed CRM app.
- Approve app/test-app mode, app roles, business/partner assignments, required access levels and any review/business verification requirements. Preserve the production app's mode and settings.
- Supply a dedicated test Page and new test form, approved test principal, and a reporting-only test account or explicitly authorized non-production account. No active campaign modifications or ad creation is necessary.
- Register the exact staging OAuth redirect URI and staging domains in the staging app. Use staging privacy/deletion URLs as required; do not overwrite production URLs.
- Configure Page Webhooks callback as `https://<STAGING_ORIGIN>/api/webhooks/meta`, correct verify token and `leadgen` field/API version. Use the same staging app's signing secret; never reuse/change production verification settings for this test.
- Verify both app-level `leadgen` subscription and Page-level app subscription. For the current combined connector, review its `messages,leadgen` behavior before authorizing selection.
- Confirm Leads Access Manager grants the chosen app/CRM and operator access to the staging Page's leads; Page admin/advertiser status alone is not sufficient proof when customized access is enabled.
- Confirm the chosen test mechanism is allowed for the app's mode. The official guide limits the Testing Tool in development mode; do not bypass this limitation with the real Page or by publishing the production app.
- Record the staging Page/form/account relationships independently. A dedicated test lead can legitimately have no ad/campaign association.

## 7. Exact future validation sequence — request approval only after prerequisites are evidenced

**This sequence has not been executed.** Fill in staging service, DB project, app, Page, form, account, CRM company UUID, test operator and exact commit SHA. Confirm none equal the excluded production service/Page/form. Approval must specify whether it covers staging deployment/migrations, Page subscription, and creation/cleanup of exactly one test lead; those are separate external mutations.

1. **Isolation audit:** verify dedicated HTTPS origin and database, no copied customer data, no shared production tokens/env groups, schedulers/AI/outbound delivery disabled, no active campaign changes, and egress restrictions. Audit migrations while production egress is denied. Stop on any missing isolation proof.
2. **Offline acceptance:** run all required tests, complete local/staging reset and native concurrency/RLS tests, typecheck, lint and build on the exact reviewed commit. Require all GitHub checks green. A contract mock is labeled as a mock.
3. **Read-only credentials audit:** operator verifies the staging app ID and token metadata/expiry/scopes/granular targets without exposing values. Compare app IDs exactly. Read `/me/permissions` using the staged user principal. Stop on a missing grant, denied permission, wrong app or wrong target asset.
4. **Bounded read-only endpoint checks:** using Bearer headers and sanitized responses, list managed staging Pages and accounts; verify the exact staging Page ID and returned `act_<ID>` account ID; read account status/currency and one bounded, fully paginated campaigns/adsets/ads/insights sample. An empty completed dataset is valid, not evidence that the production Page belongs to the real Ad Account. Verify the form's staging Page association through the currently supported official read surface or Business UI. Resolve the optional form-catalog GET discrepancy separately; do not replace it with a creation call.
5. **Webhook registration/read-back (only if approved):** establish the staging callback handshake, staging app-level `leadgen` subscription, and staging Page-level app subscription. Read back the app ID and subscribed fields. Never call OAuth selection or subscription against Page `654520554683416`.
6. **Create exactly one dedicated lead (only if approved and Meta-mode prerequisites pass):** on the **new staging form only**, confirm no pre-existing test lead. Use Meta's permitted Testing Tool or `POST /v26.0/<STAGING_FORM_ID>/test_leads` with an in-memory Page token and synthetic non-contact data. Do not delete an existing test lead to make room. Do not use form `1698659958359492`. The official API test lead has no ad association, so expected attribution is **UNATTRIBUTED** with raw identifiers preserved.
7. **Receive/retrieve:** capture only the new lead ID and sanitized receipt metadata. Retrieve `/{STAGING_LEAD_ID}?fields=id,created_time,form_id,field_data` with staging Page credentials. Verify the form/Page association, real Meta `x-hub-signature-256` verification, one durable PROCESSED event, one intake interaction and one touchpoint in the isolated staging tenant. Keep field answers/tokens out of logs. Verify there is no message send or campaign write.
8. **Retry/failure checks:** replay only this approved staging event with controlled staging fault injection and valid staging signing credentials. Verify one owner, retryable 503 on claim/attribution/finalization failure, no false acknowledgement and one final interaction/touchpoint. Invalid signatures and unbound Pages fail closed. Preserve first touch and event-time latest touch. Offline tests remain the proof for concurrent/fault cases unless a separate staging replay is approved.
9. **Attribution boundary:** record UNATTRIBUTED as the correct result for a test lead without an ad. A positive real ad-to-campaign attribution proof requires a separately approved non-production ad fixture or genuine test event whose IDs map to synced records; it is not established by this test and never justifies modifying active campaigns.
10. **Evidence and cleanup:** retain commit, asset IDs, UTC timestamps, API versions, sanitized status/error codes, scope names, and database counts. No token/secret/HAR/raw lead answers. Delete only the newly created staging test lead or revoke only staging subscriptions if that exact cleanup was approved. Leave all production assets untouched. Report any partial/failed stage explicitly; production release still requires independent review.

## Official sources checked

- [Meta Graph/Marketing version tables](https://developers.facebook.com/docs/graph-api/changelog/)
- [Meta permission reference](https://developers.facebook.com/docs/permissions/)
- [Lead retrieval and ad-level permission requirements](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/)
- [Lead Ads testing: mode limitation and ad-less API test leads](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/testing-troubleshooting/)
- [Token-debugging metadata and required caller](https://developers.facebook.com/docs/graph-api/reference/debug_token/)
- [Page leadgen_forms reference: unresolved read support](https://developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/)
- [Render environment variables, groups and save/deploy behavior](https://render.com/docs/configure-environment-variables)

The web fetcher returned 429 for Meta and rejected Render's Markdown content type; official HTML/Markdown was fetched directly instead. Endpoint/permission conflicts above remain blockers and are not resolved by mocked tests.
