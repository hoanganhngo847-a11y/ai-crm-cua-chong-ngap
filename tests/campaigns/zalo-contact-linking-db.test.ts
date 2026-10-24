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
const externalId = "900000001";

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

test("contact sync never auto-links by display name; boss confirmation creates canonical route", () =>
  run(`
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"${externalId}","displayName":"Trung Ten"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT count(*)=1
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='${externalId}'
      AND status='UNLINKED' AND linked_customer_id IS NULL),
  'same display name does not auto-link candidate'
);
SELECT pg_temp.ok(
  (SELECT count(*)=0 FROM public.identities
    WHERE company_id='${company}' AND channel='ZALO' AND external_id='${externalId}'),
  'same display name does not create identity'
);
CREATE TEMP TABLE candidate AS
SELECT id FROM public.zalo_personal_contact_candidates
 WHERE company_id='${company}' AND external_id='${externalId}';
SELECT public.link_zalo_personal_contact(
  '${company}','${boss}',(SELECT id FROM candidate),'${customer}'
);
SELECT pg_temp.ok(
  (SELECT count(*)=1 FROM public.identities
    WHERE company_id='${company}' AND customer_id='${customer}'
      AND channel='ZALO' AND external_id='${externalId}'
      AND metadata->>'provider'='zcajs'),
  'confirmed link creates ZCAJS identity'
);
SELECT pg_temp.ok(
  (SELECT count(*)=1 FROM public.conversations
    WHERE company_id='${company}' AND customer_id='${customer}'
      AND channel='ZALO' AND external_conversation_id='${externalId}'
      AND metadata->>'provider'='zcajs'),
  'confirmed link creates canonical ZCAJS conversation route'
);
SELECT pg_temp.ok(
  (SELECT status='LINKED' AND linked_customer_id='${customer}'::uuid
     FROM public.zalo_personal_contact_candidates
    WHERE id=(SELECT id FROM candidate)),
  'candidate is marked linked to confirmed customer'
);
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"${externalId}","displayName":"Trung Ten"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT linked_customer_id='${customer}'::uuid AND status='LINKED'
     FROM public.zalo_personal_contact_candidates
    WHERE id=(SELECT id FROM candidate)),
  'future directory sync preserves confirmed link'
);
SELECT pg_temp.ok(
  NOT has_function_privilege('anon','public.link_zalo_personal_contact(uuid,uuid,uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.link_zalo_personal_contact(uuid,uuid,uuid,uuid)','EXECUTE')
  AND has_function_privilege('service_role','public.link_zalo_personal_contact(uuid,uuid,uuid,uuid)','EXECUTE'),
  'link RPC remains server-only'
);
`));

test("manual link rejects an exact ZCAJS UID already owned by another customer", () =>
  run(`
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified,metadata)
VALUES('${company}','${otherCustomer}','ZALO','900000002',false,'{"provider":"zcajs"}');
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"900000002","displayName":"Other"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT status='LINKED' AND linked_customer_id='${otherCustomer}'::uuid
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='900000002'),
  'exact existing ZCAJS identity is auto-recognized'
);
DO $$
DECLARE cid uuid;
BEGIN
  SELECT id INTO cid FROM public.zalo_personal_contact_candidates
   WHERE company_id='${company}' AND external_id='900000002';
  BEGIN
    PERFORM public.link_zalo_personal_contact('${company}','${boss}',cid,'${customer}');
    RAISE EXCEPTION 'expected identity conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDENTITY_CONFLICT%' THEN RAISE; END IF;
  END;
END $$;
`));

test("numeric OA identity is never reclassified as a personal Zalo route", () =>
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
  'official identity is not automatic evidence for personal Zalo'
);
SELECT pg_temp.ok(
  (SELECT metadata->>'source'='ZALO_OA' AND metadata->>'provider' IS NULL
     FROM public.identities
    WHERE company_id='${company}' AND external_id='900000003'),
  'official identity metadata is preserved'
);
DO $$
DECLARE cid uuid;
BEGIN
  SELECT id INTO cid FROM public.zalo_personal_contact_candidates
   WHERE company_id='${company}' AND external_id='900000003';
  BEGIN
    PERFORM public.link_zalo_personal_contact('${company}','${boss}',cid,'${customer}');
    RAISE EXCEPTION 'expected route conflict';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDENTITY_ROUTE_CONFLICT%' THEN RAISE; END IF;
  END;
END $$;
`));
