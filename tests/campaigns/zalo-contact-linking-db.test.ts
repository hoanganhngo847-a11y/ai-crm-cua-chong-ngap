import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const endpoint = execFileSync(
  "docker",
  ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
).trim();
if (
  !endpoint.startsWith("unix://") ||
  (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://"))
) {
  throw new Error("LOCAL_DOCKER_ONLY");
}

const testDb = `zalo_contact_link_${process.pid}_${Date.now()}`;

function sql(input: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_ai-crm-cua-chong-ngap",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      testDb,
    ],
    { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
}

before(() => {
  execFileSync("docker", [
    "exec",
    "supabase_db_ai-crm-cua-chong-ngap",
    "createdb",
    "-U",
    "supabase_admin",
    testDb,
  ]);
  const schema = execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_ai-crm-cua-chong-ngap",
      "pg_dump",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "--schema-only",
      "--no-publications",
      "--no-subscriptions",
      "--no-owner",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  sql(schema);
});

after(() => {
  execFileSync("docker", [
    "exec",
    "supabase_db_ai-crm-cua-chong-ngap",
    "dropdb",
    "-U",
    "supabase_admin",
    "--force",
    testDb,
  ]);
});

const company = "ce000000-0000-4000-8000-000000000001";
const boss = "ce000000-0000-4000-8000-000000000002";
const customer = "ce000000-0000-4000-8000-000000000011";
const otherCustomer = "ce000000-0000-4000-8000-000000000012";
const sender = "ce000000-0000-4000-8000-000000000021";
const template = "ce000000-0000-4000-8000-000000000031";
const externalId = "900000001";
const logicalSender = `zcajs:${company}`;

const setup = `BEGIN;
CREATE FUNCTION pg_temp.ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF;
END $$;
INSERT INTO public.companies(id,name,status)
VALUES('${company}','Zalo contact linking test','ACTIVE');
INSERT INTO auth.users(id,email)
VALUES('${boss}','zalo-contact-boss@synthetic.test');
INSERT INTO public.user_profiles(id,full_name,status)
VALUES('${boss}','Zalo Contact Boss','ACTIVE')
ON CONFLICT(id) DO UPDATE SET status='ACTIVE';
INSERT INTO public.company_members(company_id,user_id,role,status)
VALUES('${company}','${boss}','BOSS_ADMIN','ACTIVE');
INSERT INTO public.customers(id,company_id,name,source,stage,customer_code)
VALUES
('${customer}','${company}','Trung Ten','ZALO','LEAD_NEW','ZL-A'),
('${otherCustomer}','${company}','Trung Ten','ZALO','LEAD_NEW','ZL-B');
`;

function run(body: string) {
  const output = sql(setup + body + "\nROLLBACK;");
  assert.match(output, /ROLLBACK/);
}

test("directory sync creates a canonical UID customer without matching same-name customers", () =>
  run(`
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"${externalId}","displayName":"Trung Ten"}]'::jsonb
);
CREATE TEMP TABLE canonical AS
SELECT linked_customer_id AS id
  FROM public.zalo_personal_contact_candidates
 WHERE company_id='${company}' AND external_id='${externalId}';
SELECT pg_temp.ok(
  (SELECT id IS NOT NULL AND id NOT IN ('${customer}'::uuid,'${otherCustomer}'::uuid) FROM canonical),
  'same display name creates a separate UID-canonical customer'
);
SELECT pg_temp.ok(
  (SELECT status='LINKED' FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='${externalId}'),
  'candidate is zero-touch linked'
);
SELECT pg_temp.ok(
  (SELECT count(*)=1 FROM public.identities
    WHERE company_id='${company}' AND customer_id=(SELECT id FROM canonical)
      AND channel='ZALO' AND external_id='${externalId}'
      AND metadata->>'provider'='zcajs' AND metadata->>'zero_touch'='true'),
  'zero-touch identity is canonical'
);
SELECT pg_temp.ok(
  (SELECT count(*)=0 FROM public.conversations
    WHERE company_id='${company}' AND customer_id=(SELECT id FROM canonical)
      AND channel='ZALO' AND external_conversation_id='${externalId}'),
  'directory sync does not create a synthetic Inbox conversation'
);
SELECT pg_temp.ok(
  (SELECT count(*)=3 FROM public.customers
    WHERE company_id='${company}' AND name='Trung Ten'),
  'no existing customer was reused by name'
);
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"${externalId}","displayName":"Trung Ten"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT count(*)=3 FROM public.customers
    WHERE company_id='${company}' AND name='Trung Ten'),
  'repeat sync is idempotent and does not create a duplicate canonical customer'
);
SELECT pg_temp.ok(
  NOT has_function_privilege('anon','public.sync_zalo_personal_contacts(uuid,jsonb)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.sync_zalo_personal_contacts(uuid,jsonb)','EXECUTE')
  AND has_function_privilege('service_role','public.sync_zalo_personal_contacts(uuid,jsonb)','EXECUTE'),
  'sync RPC remains server-only'
);
`));

test("exact ZCAJS UID already owned by a customer is reused without creating another customer", () =>
  run(`
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified,metadata)
VALUES('${company}','${otherCustomer}','ZALO','900000002',false,'{"provider":"zcajs","source":"ZCAJS"}');
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"900000002","displayName":"Other"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT status='LINKED' AND linked_customer_id='${otherCustomer}'::uuid
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='900000002'),
  'exact existing ZCAJS identity is reused'
);
SELECT pg_temp.ok(
  (SELECT count(*)=2 FROM public.customers WHERE company_id='${company}'),
  'no duplicate customer is created for an exact ZCAJS identity'
);
SELECT pg_temp.ok(
  (SELECT count(*)=0 FROM public.conversations
    WHERE company_id='${company}' AND external_conversation_id='900000002'),
  'identity-only contact stays out of Inbox until a real conversation arrives'
);
`));

test("directory-only canonical customer is campaign-eligible directly from its ZCAJS identity", () =>
  run(`
INSERT INTO public.messaging_campaign_settings(company_id,enabled,sale_execute)
VALUES('${company}',true,false);
INSERT INTO public.zalo_oa_configs(company_id,oa_id,app_id,status)
VALUES('${company}','${logicalSender}','ZCAJS','ACTIVE');
INSERT INTO public.messaging_sender_accounts(
  id,company_id,channel,external_id,name,connected,verified
) VALUES(
  '${sender}','${company}','ZALO_PERSONAL','${logicalSender}','Zalo cá nhân',true,true
);
INSERT INTO public.message_templates(
  id,company_id,name,channel,template_type,content,status,created_by
) VALUES(
  '${template}','${company}','Zero touch personal','ZALO_PERSONAL','ZALO_PERSONAL_TEXT',
  'Chao {{customer_name}}','ACTIVE','${boss}'
);
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"900000004","displayName":"Zero Touch"}]'::jsonb
);
CREATE TEMP TABLE canonical AS
SELECT linked_customer_id AS id
  FROM public.zalo_personal_contact_candidates
 WHERE company_id='${company}' AND external_id='900000004';
CREATE TEMP TABLE camp AS
SELECT (public.campaign_command(
  '${company}','${boss}','create',jsonb_build_object(
    'request_id',gen_random_uuid(),
    'name','Zero touch send',
    'channel','ZALO_PERSONAL',
    'sender_account_id','${sender}',
    'template_id','${template}',
    'customer_ids',jsonb_build_array((SELECT id FROM canonical))
  )
)->>'id')::uuid AS id;
SELECT public.campaign_command(
  '${company}','${boss}','validate',jsonb_build_object('id',(SELECT id FROM camp))
);
SELECT pg_temp.ok(
  (SELECT eligible_count=1 FROM public.messaging_campaigns WHERE id=(SELECT id FROM camp)),
  'directory-only canonical customer is eligible'
);
SELECT pg_temp.ok(
  (SELECT eligibility_status='ELIGIBLE' AND channel_identity_id IS NOT NULL AND conversation_id IS NULL
     FROM public.messaging_campaign_recipients WHERE campaign_id=(SELECT id FROM camp)),
  'campaign recipient uses identity UID directly without a conversation'
);
`));

test("numeric OA identity remains fail-closed and is never reclassified", () =>
  run(`
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified,metadata)
VALUES('${company}','${otherCustomer}','ZALO','900000003',true,'{"source":"ZALO_OA","oa_id":"oa-test"}');
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"900000003","displayName":"Same numeric id"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT status='UNLINKED' AND linked_customer_id IS NULL
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='900000003'),
  'official identity blocks zero-touch personal materialization'
);
SELECT pg_temp.ok(
  (SELECT metadata->>'source'='ZALO_OA' AND metadata->>'provider' IS NULL
     FROM public.identities
    WHERE company_id='${company}' AND external_id='900000003'),
  'official identity metadata is preserved'
);
SELECT pg_temp.ok(
  (SELECT metadata->>'zero_touch_blocked'='true'
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='900000003'),
  'route conflict is recorded without sending or guessing'
);
SELECT pg_temp.ok(
  (SELECT count(*)=2 FROM public.customers WHERE company_id='${company}'),
  'route conflict never creates an ambiguous customer'
);
`));
