import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Local Supabase only. All synthetic rows are wrapped in one transaction and rolled back.
const endpoint = execFileSync(
  "docker",
  ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
).trim();
if (
  !endpoint.startsWith("unix://") ||
  (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://"))
)
  throw new Error("LOCAL_DOCKER_ONLY");

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
      "postgres",
    ],
    { input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
}

const company = "ca000000-0000-4000-8000-000000000101";
const boss = "ca000000-0000-4000-8000-000000000102";
const customer = "ca000000-0000-4000-8000-000000000103";
const sender = "ca000000-0000-4000-8000-000000000104";

test("disabled delivery still allows template, draft and validation but blocks confirm", () => {
  const output = sql(`
BEGIN;
CREATE FUNCTION pg_temp.ok(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %', label; END IF;
END $$;

INSERT INTO public.companies(id,name,status)
VALUES('${company}','Campaign authoring synthetic','ACTIVE');
INSERT INTO auth.users(id,email)
VALUES('${boss}','campaign-authoring-boss@synthetic.test');
INSERT INTO public.user_profiles(id,full_name,status)
VALUES('${boss}','Campaign Authoring Boss','ACTIVE')
ON CONFLICT(id) DO UPDATE SET status='ACTIVE';
INSERT INTO public.company_members(company_id,user_id,role,status)
VALUES('${company}','${boss}','BOSS_ADMIN','ACTIVE');
INSERT INTO public.messaging_campaign_settings(company_id,enabled,sale_execute)
VALUES('${company}',false,false);
INSERT INTO public.customers(id,company_id,name,source,stage)
VALUES('${customer}','${company}','Authoring Customer','MANUAL','LEAD_NEW');
INSERT INTO public.messaging_sender_accounts(
  id,company_id,channel,external_id,name,connected,verified
) VALUES(
  '${sender}','${company}','FACEBOOK','990001','Synthetic authoring Page',false,false
);

CREATE TEMP TABLE created_template AS
SELECT public.campaign_command(
  '${company}',
  '${boss}',
  'template',
  jsonb_build_object(
    'name','User custom template',
    'channel','FACEBOOK',
    'sender_account_id',NULL,
    'provider_template_id',NULL,
    'template_type','MESSENGER_RESPONSE',
    'parameter_mapping','{}'::jsonb,
    'content','Hello {{customer_name}}',
    'status','ACTIVE'
  )
) payload;

SELECT pg_temp.ok(
  (SELECT NOT enabled FROM public.messaging_campaign_settings WHERE company_id='${company}'),
  'template authoring must restore delivery disabled'
);
SELECT pg_temp.ok(
  EXISTS(
    SELECT 1 FROM public.message_templates
    WHERE company_id='${company}'
      AND id=(SELECT (payload->>'id')::uuid FROM created_template)
      AND status='ACTIVE'
      AND content='Hello {{customer_name}}'
  ),
  'custom template persisted while delivery disabled'
);

CREATE TEMP TABLE created_campaign AS
SELECT public.campaign_command(
  '${company}',
  '${boss}',
  'create',
  jsonb_build_object(
    'request_id',gen_random_uuid(),
    'name','Draft while delivery disabled',
    'channel','FACEBOOK',
    'sender_account_id','${sender}',
    'template_id',(SELECT (payload->>'id')::uuid FROM created_template),
    'customer_ids',jsonb_build_array('${customer}')
  )
) payload;

SELECT pg_temp.ok(
  (SELECT NOT enabled FROM public.messaging_campaign_settings WHERE company_id='${company}'),
  'draft authoring must restore delivery disabled'
);
SELECT public.campaign_command(
  '${company}',
  '${boss}',
  'validate',
  jsonb_build_object('id',(SELECT (payload->>'id')::uuid FROM created_campaign))
);
SELECT pg_temp.ok(
  (SELECT NOT enabled FROM public.messaging_campaign_settings WHERE company_id='${company}'),
  'validation must restore delivery disabled'
);
SELECT pg_temp.ok(
  EXISTS(
    SELECT 1 FROM public.messaging_campaigns
    WHERE company_id='${company}'
      AND id=(SELECT (payload->>'id')::uuid FROM created_campaign)
      AND selected_count=1
  ),
  'campaign draft persisted while delivery disabled'
);

DO $$
BEGIN
  BEGIN
    PERFORM public.campaign_command(
      '${company}',
      '${boss}',
      'confirm',
      jsonb_build_object(
        'id',(SELECT (payload->>'id')::uuid FROM created_campaign),
        'expected_version',(
          SELECT validation_version
          FROM public.messaging_campaigns
          WHERE id=(SELECT (payload->>'id')::uuid FROM created_campaign)
        ),
        'expected_eligible',0,
        'scheduled_at',NULL
      )
    );
    RAISE EXCEPTION 'EXPECTED_DELIVERY_GATE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%MODULE_DISABLED%' THEN RAISE; END IF;
  END;
END $$;

SELECT pg_temp.ok(
  (SELECT NOT enabled FROM public.messaging_campaign_settings WHERE company_id='${company}'),
  'failed confirm must leave delivery disabled'
);
ROLLBACK;
`);
  assert.match(output, /ROLLBACK/);
});
