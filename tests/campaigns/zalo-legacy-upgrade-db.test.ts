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

const testDb = `zalo_legacy_upgrade_${process.pid}_${Date.now()}`;

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

const company = "cf000000-0000-4000-8000-000000000001";
const customer = "cf000000-0000-4000-8000-000000000011";
const otherCustomer = "cf000000-0000-4000-8000-000000000012";

const setup = `BEGIN;
CREATE FUNCTION pg_temp.ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF;
END $$;
INSERT INTO public.companies(id,name,status)
VALUES('${company}','Legacy Zalo upgrade test','ACTIVE');
INSERT INTO public.customers(id,company_id,name,source,stage,customer_code)
VALUES
('${customer}','${company}','Tuan Anh','ZALO','LEAD_NEW','ZL-LEGACY-A'),
('${otherCustomer}','${company}','Other','ZALO','LEAD_NEW','ZL-LEGACY-B');
`;

function run(body: string) {
  const output = sql(setup + body + "\nROLLBACK;");
  assert.match(output, /ROLLBACK/);
}

test("legacy blank identity and conversation on the same exact UID/customer are upgraded to ZCAJS", () =>
  run(`
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified,metadata,display_name)
VALUES('${company}','${customer}','ZALO','7994906426019206392',false,'{}','Tuan Anh');
INSERT INTO public.conversations(company_id,customer_id,channel,external_conversation_id,metadata)
VALUES('${company}','${customer}','ZALO','7994906426019206392','{"channel":"zalo","sender_id":"7994906426019206392","sender_name":"Tuan Anh"}');
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"7994906426019206392","displayName":"Tuan Anh"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT metadata->>'provider'='zcajs' AND metadata->>'source'='ZCAJS'
     AND metadata->>'legacy_upgraded'='true'
     FROM public.identities
    WHERE company_id='${company}' AND channel='ZALO' AND external_id='7994906426019206392'),
  'legacy identity is promoted to ZCAJS'
);
SELECT pg_temp.ok(
  (SELECT metadata->>'provider'='zcajs' AND metadata->>'legacy_upgraded'='true'
     FROM public.conversations
    WHERE company_id='${company}' AND channel='ZALO' AND external_conversation_id='7994906426019206392'),
  'matching legacy conversation is promoted to ZCAJS'
);
SELECT pg_temp.ok(
  (SELECT status='LINKED' AND linked_customer_id='${customer}'::uuid
     AND coalesce(metadata->>'zero_touch_blocked','false') <> 'true'
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='7994906426019206392'),
  'candidate becomes linked without manual action'
);
SELECT pg_temp.ok(
  (SELECT count(*)=2 FROM public.customers WHERE company_id='${company}'),
  'legacy upgrade reuses the existing customer instead of creating a duplicate'
);
`));

test("legacy UID stays blocked when identity and conversation point to different customers", () =>
  run(`
INSERT INTO public.identities(company_id,customer_id,channel,external_id,verified,metadata,display_name)
VALUES('${company}','${customer}','ZALO','7994906426019206393',false,'{}','Conflict');
INSERT INTO public.conversations(company_id,customer_id,channel,external_conversation_id,metadata)
VALUES('${company}','${otherCustomer}','ZALO','7994906426019206393','{"channel":"zalo","sender_id":"7994906426019206393"}');
SELECT public.sync_zalo_personal_contacts(
  '${company}',
  '[{"externalUserId":"7994906426019206393","displayName":"Conflict"}]'::jsonb
);
SELECT pg_temp.ok(
  (SELECT metadata='{}'::jsonb
     FROM public.identities
    WHERE company_id='${company}' AND channel='ZALO' AND external_id='7994906426019206393'),
  'mismatched legacy identity is not reclassified'
);
SELECT pg_temp.ok(
  (SELECT status='UNLINKED' AND linked_customer_id IS NULL
     AND metadata->>'zero_touch_blocked'='true'
     FROM public.zalo_personal_contact_candidates
    WHERE company_id='${company}' AND external_id='7994906426019206393'),
  'mismatched route remains fail-closed'
);
`));
