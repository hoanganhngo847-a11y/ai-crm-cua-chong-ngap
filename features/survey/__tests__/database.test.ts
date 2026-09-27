import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const container = process.env.SURVEY_DB_TEST_CONTAINER || 'supabase_db_ai-crm-cua-chong-ngap';
const db = `survey_test_${process.pid}_${Date.now()}`;
const docker = (args: string[], input?: string) => execFileSync('docker', ['exec', '-i', container, ...args], {
  input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
});
const sql = (query: string) => docker(['psql', '-X', '-qAt', '-U', 'supabase_admin', '-d', db, '-v', 'ON_ERROR_STOP=1'], query).trim();
const q = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
const company = randomUUID(), otherCompany = randomUUID(), customer = randomUUID();
const tech = randomUUID(), boss = randomUUID(), otherTech = randomUUID(), inactive = randomUUID(), inactiveProfile = randomUUID(), foreignTech = randomUUID();
const measurements = { clear_width_mm: 2000, barrier_height_mm: 600, anticipated_flood_height_mm: 500,
  gate_type: 'REMOVABLE_PANEL', mounting_method: 'INSIDE_JAMB' };
const site = { wall_material: 'SOLID_BRICK', floor_material: 'CONCRETE_SMOOTH', floor_evenness: 'FLAT', slope_grade: 'SLOPING_OUT' };
const payload = { measurements, site_condition: JSON.stringify(site), completed_at: '1999-01-01T00:00:00Z',
  company_id: otherCompany, photos: [{ slot: 'OVERVIEW', objectPath: 'fake/foreign/path' }] };
const call = (id: string, actor = tech, data: unknown = payload) =>
  `SELECT public.complete_survey_atomic(${q(id)}, ${q(actor)}, ${q(JSON.stringify(data))}::jsonb)`;
function reject(query: string, expected: RegExp) {
  try { sql(query); assert.fail('Expected database rejection'); } catch (error) {
    assert.match(String((error as { stderr?: string }).stderr || error), expected);
  }
}
function appointment(status = 'ACCEPTED', assignee = tech, type = 'SURVEY', photos = true) {
  const id = randomUUID();
  sql(`INSERT INTO public.appointments(id,company_id,customer_id,assignee_id,type,address,start_time,status)
    VALUES(${q(id)},${q(company)},${q(customer)},${q(assignee)},${q(type)},'Test only',now(),${q(status)});`);
  if (photos) for (const slot of ['OVERVIEW','BOTTOM_LEFT','BOTTOM_RIGHT']) {
    sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('survey-photos',
      ${q(`${company}/${customer}/${id}/${slot}.jpg`)}, '{"size":10,"mimetype":"image/jpeg"}');`);
  }
  return id;
}
const concurrent = (query: string) => new Promise<string>((resolve, rejectPromise) => {
  const child = spawn('docker', ['exec','-i',container,'psql','-X','-qAt','-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1']);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', rejectPromise);
  child.on('close', code => code === 0 ? resolve(stdout.trim()) : rejectPromise(new Error(stderr)));
  child.stdin.end(query);
});

test('PostgreSQL Survey hardening (isolated database, real functions/RLS/transactions)', async t => {
  // Explicit opt-out is for machines without local Supabase; CI/review must run this DB gate.
  if (process.env.SURVEY_SKIP_DB_TESTS === '1') { t.skip('Local Supabase DB tests explicitly disabled'); return; }
  docker(['createdb','-U','supabase_admin',db]);
  try {
    const schema = docker(['pg_dump','-U','supabase_admin','-d','postgres','--schema-only','--no-publications','--no-subscriptions','--no-owner']);
    sql(schema);
    sql(readFileSync('supabase/migrations/20260917000001_0005_survey_atomic_completion.sql','utf8'));
    sql(readFileSync('supabase/migrations/20260924000001_survey_integrity_hardening.sql','utf8'));
    sql(`INSERT INTO public.companies(id,name) VALUES (${q(company)},'Survey test'),(${q(otherCompany)},'Other tenant');
      INSERT INTO public.customers(id,company_id,name,source,stage) VALUES (${q(customer)},${q(company)},'Fixture','MANUAL','LEAD_NEW');
      INSERT INTO storage.buckets(id,name,public) VALUES ('survey-photos','survey-photos',false) ON CONFLICT DO NOTHING;`);
    for (const [id,role,memberStatus,profileStatus,fixtureCompany] of [
      [tech,'TECHNICIAN','ACTIVE','ACTIVE',company], [boss,'BOSS_ADMIN','ACTIVE','ACTIVE',company],
      [otherTech,'TECHNICIAN','ACTIVE','ACTIVE',company],[inactive,'TECHNICIAN','INACTIVE','ACTIVE',company],
      [inactiveProfile,'TECHNICIAN','ACTIVE','INACTIVE',company],[foreignTech,'TECHNICIAN','ACTIVE','ACTIVE',otherCompany],
    ]) sql(`INSERT INTO auth.users(id) VALUES (${q(id)});
      INSERT INTO public.user_profiles(id,full_name,status) VALUES (${q(id)},'Fixture',${q(profileStatus)})
        ON CONFLICT (id) DO UPDATE SET full_name = 'Fixture', status = ${q(profileStatus)};
      INSERT INTO public.company_members(company_id,user_id,role,status) VALUES (${q(fixtureCompany)},${q(id)},${q(role)},${q(memberStatus)});`);

    await t.test('RPC EXECUTE denied to anon/authenticated; service_role allowed; SECURITY DEFINER/search_path', () => {
      const id = appointment();
      for (const role of ['anon','authenticated']) reject(`SET ROLE ${role}; ${call(id)};`, /permission denied for function complete_survey_atomic/);
      assert.equal(JSON.parse(sql(`SET ROLE service_role; ${call(id)};`)).isExisting, false);
      for (const fn of [
        'complete_survey_atomic(uuid,uuid,jsonb)',
        'begin_survey_photo_operation(uuid,uuid)',
        'end_survey_photo_operation(uuid,uuid)',
        'guard_survey_appointment_write()'
      ]) {
        assert.equal(sql(`SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='public.${fn}'::regprocedure;`), 't', `Expected function ${fn} to be SECURITY DEFINER with search_path = ''`);
      }
    });
    await t.test('ASSIGNED/CANCELLED/REJECTED reject; ACCEPTED and IN_PROGRESS complete', () => {
      for (const status of ['ASSIGNED','CANCELLED','REJECTED']) reject(call(appointment(status)),/INVALID_PREDECESSOR_STATE/);
      for (const status of ['ACCEPTED','IN_PROGRESS']) {
        const id = appointment(status); assert.equal(JSON.parse(sql(call(id))).isExisting,false);
        assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(id)}`),'COMPLETED');
      }
    });
    await t.test('Missing resource and non-SURVEY reject', () => {
      reject(call(randomUUID()),/APPOINTMENT_NOT_FOUND/);
      reject(call(appointment('ACCEPTED',tech,'INSTALLATION')),/APPOINTMENT_TYPE_NOT_SURVEY/);
    });
    await t.test('Boss, unrelated, inactive membership/profile and wrong company provenance reject', () => {
      reject(call(appointment(),boss),/INVALID_COMPLETED_BY/);
      reject(call(appointment('ACCEPTED',boss),boss),/INVALID_COMPLETED_BY/);
      reject(call(appointment(),otherTech),/INVALID_COMPLETED_BY/);
      for (const id of [inactive,inactiveProfile]) reject(call(appointment('ACCEPTED',id),id),/INVALID_COMPLETED_BY/);
      reject(call(appointment('ACCEPTED',foreignTech),foreignTech),/INVALID_COMPLETED_BY/);
    });
    await t.test('All technical fields/enums/ranges and exact mandatory server photo slots enforced', () => {
      for (const key of Object.keys(measurements)) {
        const m = {...measurements} as Record<string,unknown>; delete m[key];
        reject(call(appointment(),tech,{...payload,measurements:m}), /INVALID_SURVEY/);
      }
      for (const key of Object.keys(site)) {
        const c = {...site} as Record<string,unknown>; delete c[key];
        reject(call(appointment(),tech,{...payload,site_condition:JSON.stringify(c)}),/INVALID_SURVEY/);
      }
      for (const bad of [0,499,15001,500.5,'1000',true]) reject(call(appointment(),tech,
        {...payload,measurements:{...measurements,clear_width_mm:bad}}),/INVALID_SURVEY/);
      reject(call(appointment(),tech,{...payload,measurements:{...measurements,gate_type:'FAKE'}}),/INVALID_SURVEY/);
      reject(call(appointment('ACCEPTED',tech,'SURVEY',false)),/MISSING_MANDATORY_SURVEY_PHOTO/);
      const missingRightId = appointment('ACCEPTED', tech, 'SURVEY', false);
      sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES
        ('survey-photos',${q(`${company}/${customer}/${missingRightId}/OVERVIEW.jpg`)}, '{"size":10,"mimetype":"image/jpeg"}'),
        ('survey-photos',${q(`${company}/${customer}/${missingRightId}/BOTTOM_LEFT.jpg`)}, '{"size":10,"mimetype":"image/jpeg"}'),
        ('survey-photos',${q(`${company}/${customer}/${missingRightId}/OBSTACLE.jpg`)}, '{"size":10,"mimetype":"image/jpeg"}');`);
      reject(call(missingRightId),/MISSING_MANDATORY_SURVEY_PHOTO/);
    });
    await t.test('Browser path/tenant/time ignored; canonical DB time and assigned tech persisted', () => {
      const id = appointment(); const result = JSON.parse(sql(call(id)));
      const row = JSON.parse(sql(`SELECT row_to_json(s) FROM public.surveys s WHERE id=${q(result.id)}`));
      assert.equal(row.company_id,company); assert.equal(row.completed_by,tech);
      assert.ok(Date.now()-Date.parse(row.completed_at) < 60_000);
      assert.equal(row.photos.length,3);
      assert.equal(row.photos[0].objectPath,`${company}/${customer}/${id}/OVERVIEW.jpg`);
    });
    await t.test('Concurrent duplicate completion creates exactly one row; retry is receipt only', async () => {
      const id = appointment();
      const results = await Promise.all([concurrent(`BEGIN; ${call(id)}; SELECT pg_sleep(0.2); COMMIT;`),concurrent(call(id))]);
      const receipts = results.map(value=>JSON.parse(value.split('\n')[0]));
      assert.equal(receipts[0].id,receipts[1].id);
      assert.deepEqual(receipts.map(r=>r.isExisting).sort(),[false,true]);
      assert.equal(sql(`SELECT count(*) FROM public.surveys WHERE appointment_id=${q(id)}`),'1');
      const retry = JSON.parse(sql(call(id,tech,{})));
      assert.deepEqual(Object.keys(retry).sort(),['id','isExisting']); assert.equal(retry.isExisting,true);
    });
    await t.test('COMPLETED without Survey is inconsistent, fails closed', () => {
      const id=appointment();
      sql(`ALTER TABLE public.appointments DISABLE TRIGGER guard_survey_appointment_write;
        UPDATE public.appointments SET status='COMPLETED' WHERE id=${q(id)};
        ALTER TABLE public.appointments ENABLE TRIGGER guard_survey_appointment_write;`);
      reject(call(id),/SURVEY_COMPLETION_INCONSISTENT/);
    });
    await t.test('INSERT failure rolls back appointment; appointment UPDATE failure rolls back Survey', () => {
      for (const table of ['surveys','appointments']) {
        const id=appointment();
        sql(`CREATE FUNCTION public.survey_test_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END $$;
          CREATE TRIGGER survey_test_inject_failure BEFORE ${table==='surveys'?'INSERT':'UPDATE'} ON public.${table}
          FOR EACH ROW EXECUTE FUNCTION public.survey_test_inject_failure();`);
        reject(call(id),/TEST_INJECTED_FAILURE/);
        assert.equal(sql(`SELECT status FROM public.appointments WHERE id=${q(id)}`),'ACCEPTED');
        assert.equal(sql(`SELECT count(*) FROM public.surveys WHERE appointment_id=${q(id)}`),'0');
        sql(`DROP TRIGGER survey_test_inject_failure ON public.${table}; DROP FUNCTION public.survey_test_inject_failure();`);
      }
    });
    await t.test('Direct survey writes and generic completion denied, read RLS preserved', () => {
      const id=appointment();
      reject(`UPDATE public.appointments SET status='COMPLETED' WHERE id=${q(id)}`,/SURVEY_COMPLETION_REQUIRES_ATOMIC_RPC/);
      for (const verb of ['INSERT','UPDATE','DELETE']) assert.equal(sql(`SELECT has_table_privilege('authenticated','public.surveys',${q(verb)})`),'f');
      reject(`SET ROLE authenticated; UPDATE public.surveys SET notes='bypass';`,/permission denied for table surveys/);
      reject(`SET ROLE authenticated; INSERT INTO public.surveys(company_id) VALUES (${q(company)});`,/permission denied for table surveys/);
      const receipt=JSON.parse(sql(call(id)));
      assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub=${q(tech)}; SELECT count(*) FROM public.surveys WHERE id=${q(receipt.id)}`),'0');
      assert.equal(sql(`SET ROLE authenticated; SET request.jwt.claim.sub=${q(boss)}; SELECT count(*) FROM public.surveys WHERE id=${q(receipt.id)}`),'1');
      reject(`UPDATE public.appointments SET address='changed' WHERE id=${q(id)}`,/SURVEY_APPOINTMENT_TERMINAL/);
    });
    await t.test('Storage guard: 5-point bounded lease and fencing token semantics', () => {
      const id = appointment();

      // 1. Active unexpired token A: second begin is blocked
      const tokenA = sql(`SELECT public.begin_survey_photo_operation(${q(id)},${q(tech)})`);
      assert.ok(tokenA && tokenA.length > 0);
      const leaseSeconds = Number(sql(`SELECT EXTRACT(EPOCH FROM (expires_at - now())) FROM public.survey_photo_operations WHERE appointment_id=${q(id)}`));
      assert.ok(leaseSeconds > 850 && leaseSeconds <= 900, `Expected ~900s (15 min) lease, got ${leaseSeconds}s`);
      reject(`SELECT public.begin_survey_photo_operation(${q(id)},${q(tech)})`, /SURVEY_PHOTO_OPERATION_IN_PROGRESS/);
      reject(`SELECT public.begin_survey_photo_operation(${q(id)},${q(boss)})`, /SURVEY_PHOTO_OPERATION_IN_PROGRESS/);

      // Caller cannot arbitrarily shorten lease duration (p_lease_seconds removed from signature)
      reject(`SELECT public.begin_survey_photo_operation(${q(id)}::uuid,${q(tech)}::uuid, 5)`, /function public\.begin_survey_photo_operation\(uuid, uuid, integer\) does not exist/);

      // 5. Active operation blocks reassignment and Survey completion
      reject(`UPDATE public.appointments SET assignee_id=${q(otherTech)} WHERE id=${q(id)}`, /SURVEY_PHOTO_OPERATION_IN_PROGRESS/);
      reject(call(id), /SURVEY_PHOTO_OPERATION_IN_PROGRESS/);

      // 2. Token A expires: if nobody reclaimed it yet, token A can still end/delete its own stale row
      sql(`UPDATE public.survey_photo_operations SET expires_at = now() - interval '10 seconds' WHERE appointment_id = ${q(id)}`);
      assert.equal(sql(`SELECT expires_at <= now() FROM public.survey_photo_operations WHERE appointment_id = ${q(id)}`), 't');
      // Expired lock does NOT block appointment address update
      sql(`UPDATE public.appointments SET address='Stale lock allowed update' WHERE id=${q(id)}`);
      // Token A deletes its own row even though expired (fencing token authority)
      sql(`SELECT public.end_survey_photo_operation(${q(id)},${q(tokenA)})`);
      assert.equal(sql(`SELECT count(*) FROM public.survey_photo_operations WHERE appointment_id = ${q(id)}`), '0');

      // 3. Token A expires and token B reclaims: row now contains token B; token A can NEVER delete/release token B row
      const tokenA2 = sql(`SELECT public.begin_survey_photo_operation(${q(id)},${q(tech)})`);
      sql(`UPDATE public.survey_photo_operations SET expires_at = now() - interval '5 seconds' WHERE appointment_id = ${q(id)}`);
      const tokenB = sql(`SELECT public.begin_survey_photo_operation(${q(id)},${q(boss)})`);
      assert.notEqual(tokenA2, tokenB, 'Token B must be a distinct fresh fencing token');
      assert.equal(sql(`SELECT token FROM public.survey_photo_operations WHERE appointment_id = ${q(id)}`), tokenB);
      // Token A2 attempt to delete token B row is rejected
      reject(`SELECT public.end_survey_photo_operation(${q(id)},${q(tokenA2)})`, /SURVEY_PHOTO_GUARD_MISMATCH/);
      assert.equal(sql(`SELECT token FROM public.survey_photo_operations WHERE appointment_id = ${q(id)}`), tokenB);

      // 4. Token B can release token B row
      sql(`SELECT public.end_survey_photo_operation(${q(id)},${q(tokenB)})`);
      assert.equal(sql(`SELECT count(*) FROM public.survey_photo_operations WHERE appointment_id = ${q(id)}`), '0');

      // Once released, completion succeeds
      assert.equal(JSON.parse(sql(call(id))).isExisting, false);
      reject(`SELECT public.begin_survey_photo_operation(${q(id)},${q(tech)})`, /INVALID_SURVEY_PHOTO_RESOURCE/);
    });
  } finally {
    docker(['dropdb','-U','supabase_admin','--force',db]);
  }
});
