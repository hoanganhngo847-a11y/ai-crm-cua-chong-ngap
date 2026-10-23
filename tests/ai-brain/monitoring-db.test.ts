import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  throw new Error('Monitoring DB test requires local Supabase env');
}

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const FIXTURE_COMPANY_ID = '00000000-0000-4000-8000-000000000088';

let fixturePromise: Promise<void> | null = null;

async function provisionFixture(): Promise<void> {
  const companyInsert = await service
    .from('companies')
    .upsert(
      [{ id: FIXTURE_COMPANY_ID, name: 'AI Monitoring Fixture Company', status: 'ACTIVE' }],
      { onConflict: 'id', ignoreDuplicates: true },
    );
  assert.ifError(companyInsert.error);
}

function ensureFixture(): Promise<void> {
  if (!fixturePromise) {
    fixturePromise = provisionFixture();
  }
  return fixturePromise;
}

test('Monitoring DB: record_ai_monitoring_alert creates active alert and deduplicates subsequent occurrences', async () => {
  await ensureFixture();

  const fingerprint = `QUEUE_DEPTH_THRESHOLD_EXCEEDED:${randomUUID()}`;

  // 1. First trigger -> should insert new alert
  const { data: firstData, error: firstError } = await service.rpc('record_ai_monitoring_alert', {
    p_company_id: FIXTURE_COMPANY_ID,
    p_alert_type: 'QUEUE_DEPTH_THRESHOLD_EXCEEDED',
    p_severity: 'HIGH',
    p_fingerprint: fingerprint,
    p_title: 'Hàng đợi tin AI vượt ngưỡng',
    p_description: 'Hiện có 15 tin nhắn đang chờ xử lý trong hàng đợi.',
    p_channel: 'ALL',
    p_metadata: { queueDepth: 15 },
  });

  assert.ifError(firstError);
  assert.ok(firstData && firstData.length > 0);
  const firstAlertId = firstData[0].alert_id;
  assert.equal(firstData[0].deduplicated, false);
  assert.equal(firstData[0].trigger_count, 1);

  // 2. Second trigger with same fingerprint -> should deduplicate
  const { data: secondData, error: secondError } = await service.rpc('record_ai_monitoring_alert', {
    p_company_id: FIXTURE_COMPANY_ID,
    p_alert_type: 'QUEUE_DEPTH_THRESHOLD_EXCEEDED',
    p_severity: 'HIGH',
    p_fingerprint: fingerprint,
    p_title: 'Hàng đợi tin AI vượt ngưỡng',
    p_description: 'Hiện có 20 tin nhắn đang chờ xử lý trong hàng đợi.',
    p_channel: 'ALL',
    p_metadata: { queueDepth: 20 },
  });

  assert.ifError(secondError);
  assert.ok(secondData && secondData.length > 0);
  assert.equal(secondData[0].alert_id, firstAlertId, 'Must update existing alert ID');
  assert.equal(secondData[0].deduplicated, true, 'Must flag as deduplicated');
  assert.equal(secondData[0].trigger_count, 2, 'Must increment trigger count to 2');

  // Verify DB record
  const { data: alertRow, error: fetchError } = await service
    .from('ai_monitoring_alerts')
    .select('*')
    .eq('id', firstAlertId)
    .single();

  assert.ifError(fetchError);
  assert.equal(alertRow.status, 'ACTIVE');
  assert.equal(alertRow.trigger_count, 2);
  assert.equal(alertRow.metadata.queueDepth, 20);
});

test('Monitoring DB: acknowledge_ai_monitoring_alert and resolve_ai_monitoring_alert lifecycle', async () => {
  await ensureFixture();

  const fingerprint = `CRON_CONSECUTIVE_FAILURES:${randomUUID()}`;

  // Create alert
  const { data: createData, error: createError } = await service.rpc('record_ai_monitoring_alert', {
    p_company_id: FIXTURE_COMPANY_ID,
    p_alert_type: 'CRON_CONSECUTIVE_FAILURES',
    p_severity: 'CRITICAL',
    p_fingerprint: fingerprint,
    p_title: 'Lỗi cron dispatch',
    p_description: 'Cron failure detected.',
    p_channel: 'ALL',
    p_metadata: { failures: 3 },
  });

  assert.ifError(createError);
  const alertId = createData[0].alert_id;

  // 1. Acknowledge
  const { data: ackSuccess, error: ackError } = await service.rpc('acknowledge_ai_monitoring_alert', {
    p_company_id: FIXTURE_COMPANY_ID,
    p_alert_id: alertId,
  });

  assert.ifError(ackError);
  assert.equal(ackSuccess, true);

  const { data: ackRow } = await service
    .from('ai_monitoring_alerts')
    .select('status, acknowledged_at')
    .eq('id', alertId)
    .single();

  assert.equal(ackRow?.status, 'ACKNOWLEDGED');
  assert.ok(ackRow?.acknowledged_at);

  // 2. Resolve
  const { data: resolveSuccess, error: resolveError } = await service.rpc('resolve_ai_monitoring_alert', {
    p_company_id: FIXTURE_COMPANY_ID,
    p_alert_id: alertId,
  });

  assert.ifError(resolveError);
  assert.equal(resolveSuccess, true);

  const { data: resolvedRow } = await service
    .from('ai_monitoring_alerts')
    .select('status, resolved_at')
    .eq('id', alertId)
    .single();

  assert.equal(resolvedRow?.status, 'RESOLVED');
  assert.ok(resolvedRow?.resolved_at);

  // 3. New trigger with same fingerprint after resolution -> should create NEW active alert
  const { data: thirdData, error: thirdError } = await service.rpc('record_ai_monitoring_alert', {
    p_company_id: FIXTURE_COMPANY_ID,
    p_alert_type: 'CRON_CONSECUTIVE_FAILURES',
    p_severity: 'CRITICAL',
    p_fingerprint: fingerprint,
    p_title: 'Lỗi cron dispatch mới',
    p_description: 'New failure.',
    p_channel: 'ALL',
    p_metadata: { failures: 1 },
  });

  assert.ifError(thirdError);
  assert.notEqual(thirdData[0].alert_id, alertId, 'Must create a new alert after previous was resolved');
  assert.equal(thirdData[0].deduplicated, false);
});

test('Monitoring DB: Security & RLS - anon cannot read, update, or delete ai_monitoring_alerts', async () => {
  await ensureFixture();

  // Anon select should return empty or be denied
  const { data: anonData, error: anonSelectError } = await anon
    .from('ai_monitoring_alerts')
    .select('*')
    .limit(1);

  assert.ok(anonSelectError || (anonData && anonData.length === 0));

  // Anon delete should be rejected
  const { error: anonDeleteError } = await anon
    .from('ai_monitoring_alerts')
    .delete()
    .eq('company_id', FIXTURE_COMPANY_ID);

  assert.ok(anonDeleteError, 'Anon delete must fail');
});

test('Monitoring DB: get_ai_channel_scheduler_health is strictly service_role only, revoked from anon', async () => {
  // 1. service_role can call get_ai_channel_scheduler_health for ZALO and MESSENGER
  const { data: zaloData, error: zaloErr } = await service.rpc('get_ai_channel_scheduler_health', {
    p_channel: 'ZALO',
    p_limit: 5,
  });

  assert.ifError(zaloErr);
  assert.ok(zaloData && typeof zaloData === 'object');
  assert.equal(zaloData.channel, 'ZALO');
  assert.equal(zaloData.job_name, 'ai_brain_live_zalo_worker');
  assert.ok(Array.isArray(zaloData.runs));

  const { data: msgData, error: msgErr } = await service.rpc('get_ai_channel_scheduler_health', {
    p_channel: 'MESSENGER',
    p_limit: 5,
  });

  assert.ifError(msgErr);
  assert.ok(msgData && typeof msgData === 'object');
  assert.equal(msgData.channel, 'MESSENGER');
  assert.equal(msgData.job_name, 'ai_brain_live_messenger_worker');
  assert.ok(Array.isArray(msgData.runs));

  // In local test DB without pg_cron, job_exists must be null (safe explicit unknown, not false positive)
  if (!zaloData.extension_available) {
    assert.equal(zaloData.job_exists, null, 'Safe missing extension must return explicit null for job_exists');
    assert.equal(zaloData.job_active, null);
    assert.equal(zaloData.job_schedule, null);
  }

  // 2. anon cannot execute get_ai_channel_scheduler_health (permission denied)
  const { data: anonData, error: anonErr } = await anon.rpc('get_ai_channel_scheduler_health', {
    p_channel: 'ZALO',
  });

  assert.equal(anonData, null);
  assert.ok(anonErr, 'Anon execution of get_ai_channel_scheduler_health must be rejected');
  assert.ok(
    anonErr.code === '42501' || anonErr.message.includes('permission denied'),
    `Expected permission denied error, got: ${anonErr.message}`
  );

  // 3. Unused synonym get_ai_scheduler_dispatch_status must be dropped
  const { error: synonymErr } = await service.rpc('get_ai_scheduler_dispatch_status', {
    p_channel: 'ZALO',
  });
  assert.ok(synonymErr, 'Unused synonym get_ai_scheduler_dispatch_status must NOT exist');

  // 4. Invalid channel must be rejected
  const { error: invalidChanErr } = await service.rpc('get_ai_channel_scheduler_health', {
    p_channel: 'TELEGRAM',
  });
  assert.ok(invalidChanErr, 'Unsupported channel must be rejected');
  assert.ok(invalidChanErr.message.includes('UNSUPPORTED_CHANNEL'));
});
