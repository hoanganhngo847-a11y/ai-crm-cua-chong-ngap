/** Explicit synthetic acceptance fixture. Never imported by app/worker or run by CI tests. */
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createJavisBrainServer } from '../../services/javis-brain/server';
import { JavisBrainProvider } from '../../features/ai-brain/javis-provider';
import { processDossierRefresh } from '../../features/customer-360/worker';
import { bindCustomerIdentity } from '../../features/customer-360/identity';
import { context, snapshot } from './fixture';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('LOCAL_SUPABASE_ONLY');
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } });
  let step = 0;
  const check = <T extends { error: unknown }>(result: T): T => { step++; if (result.error) throw new Error(`SYNTHETIC_FIXTURE_WRITE_FAILED_STEP_${step}`); return result; };
  const created = await db.auth.admin.createUser({ email: 'customer360-local@example.test', password: 'Synthetic-Local-360-Only!', email_confirm: true });
  let userId = created.data.user?.id;
  if (!userId) userId = (await db.auth.admin.listUsers({ perPage: 1000 })).data.users.find(u => u.email === 'customer360-local@example.test')?.id;
  if (!userId) throw new Error('SYNTHETIC_USER_FAILED');
  check(await db.from('companies').upsert({ id: context.companyId, name: 'Customer 360 — Synthetic LOCAL', status: 'ACTIVE' }));
  check(await db.from('user_profiles').upsert({ id: userId, full_name: 'Boss Synthetic Local', status: 'ACTIVE' }));
  check(await db.from('company_members').upsert({ company_id: context.companyId, user_id: userId, role: 'BOSS_ADMIN', status: 'ACTIVE' }, { onConflict: 'company_id,user_id' }));
  check(await db.from('customers').upsert({ id: context.customerId, company_id: context.companyId, name: 'Khách Synthetic Customer 360', source: 'ZALO', stage: 'PRICE_OFFERED' }));
  process.env.PHONE_HASH_SECRET ||= 'synthetic-local-c360-regression-secret';
  for (const [type,value,displayName] of [['ZALO','synthetic-account:uid','Synthetic Zalo'],['FACEBOOK','synthetic-page:psid','Synthetic Facebook'],['EMAIL','synthetic@example.test',undefined]] as const) {
    await bindCustomerIdentity(db, { companyId: context.companyId, customerId: context.customerId, type, value, displayName, verified: true });
  }
  // Reuse the existing atomic customer/contact creation primitive is unnecessary for an existing
  // fixture customer. SQL stays strictly inside the local Docker database for private phone setup.
  await bindCustomerIdentity(db, { companyId: context.companyId, customerId: context.customerId, type: 'PHONE', value: '0912345678', verified: false });
  execFileSync('docker', ['exec','-i','supabase_db_ai-crm-cua-chong-ngap','psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], {
    input: `INSERT INTO private.customer_private_contacts(company_id,customer_id,normalized_phone,raw_phone) VALUES('${context.companyId}','${context.customerId}','+84912345678','0912345678') ON CONFLICT(customer_id) DO NOTHING;`, stdio: ['pipe','ignore','pipe'] });
  check(await db.from('customer_dossier_profiles').upsert({ company_id: context.companyId, customer_id: context.customerId,
    address: 'Địa chỉ giả lập tại Hà Nội (LOCAL)', birth_year: 1998, special_notes: 'Dữ liệu synthetic, chỉ liên hệ buổi chiều.', assigned_sale_id: userId }));
  check(await db.from('interactions').upsert([
    { id: 'cc360000-0000-4000-8000-000000000003', company_id: context.companyId, customer_id: context.customerId, channel: 'ZALO', type: 'MESSAGE', direction: 'INBOUND', actor_type: 'CUSTOMER', sanitized_content: context.sources[0].text, sanitization_status: 'SUCCEEDED' },
    { id: 'cc360000-0000-4000-8000-000000000004', company_id: context.companyId, customer_id: context.customerId, channel: 'FACEBOOK', type: 'MESSAGE', direction: 'OUTBOUND', actor_type: 'SALE', actor_user_id: userId, sanitized_content: 'Sale sẽ gửi thông tin chi phí lắp đặt.', sanitization_status: 'SUCCEEDED' },
    { id: 'cc360000-0000-4000-8000-000000000005', company_id: context.companyId, customer_id: context.customerId, channel: 'WEBSITE', type: 'NOTE', direction: 'OUTBOUND', actor_type: 'SALE', actor_user_id: userId, sanitized_content: 'Ghi chú thủ công: khách cần hiểu rõ chi phí.', sanitization_status: 'SUCCEEDED' },
  ]));
  const device = 'cc360000-0000-4000-8000-000000000031', call = 'cc360000-0000-4000-8000-000000000033', tx = 'cc360000-0000-4000-8000-000000000035';
  check(await db.from('zalo_recording_devices').upsert({ id: device, company_id: context.companyId, staff_user_id: userId, device_name: 'Synthetic local audio', device_key_hash: 'c'.repeat(64), zalo_account_key: 'cc360000-0000-4000-8000-000000000032' }));
  execFileSync('ffmpeg', ['-y','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ac','2','-c:a','aac','/tmp/customer360-synthetic.m4a']);
  const audio = readFileSync('/tmp/customer360-synthetic.m4a');
  const path = `${context.companyId}/${device}/${call}.m4a`;
  check(await db.storage.from('zalo-call-recordings').upload(path, audio, { contentType: 'audio/mp4', upsert: true }));
  check(await db.from('zalo_personal_calls').upsert({ id: call, company_id: context.companyId, device_id: device, staff_user_id: userId,
    local_call_id: 'cc360000-0000-4000-8000-000000000034', zalo_account_key: 'cc360000-0000-4000-8000-000000000032', customer_id: context.customerId,
    direction: 'INBOUND', remote_display_name: 'Khách Synthetic Customer 360', remote_display_name_normalized: 'khách synthetic customer 360', identity_confidence: 'UNKNOWN',
    started_at: '2026-10-23T10:03:00Z', ended_at: '2026-10-23T10:03:02Z', duration_seconds: 2, agent_version: 'synthetic-local', audio_validation: { synthetic: true, channels: 2 },
    recording_status: 'READY', recording_path: path, recording_bytes: audio.length, recording_sha256: createHash('sha256').update(audio).digest('hex'),
    payload_fingerprint: 'e'.repeat(64), upload_lease: 'cc360000-0000-4000-8000-000000000036', upload_lease_until: '2026-10-23T10:10:00Z',
    matching_status: 'EXACT', transcript_status: 'COMPLETED', summary_status: 'COMPLETED' }));
  check(await db.from('zalo_call_transcriptions').upsert({ id: tx, company_id: context.companyId, call_id: call, customer_id: context.customerId,
    status: 'COMPLETED', full_transcript: 'CUSTOMER: Tôi quan tâm cửa chống ngập. STAFF: Sẽ tư vấn chi phí lắp đặt.', completed_at: new Date().toISOString() }));
  check(await db.from('zalo_call_transcript_utterances').upsert([
    { company_id: context.companyId, transcription_id: tx, call_id: call, sequence: 1, speaker_role: 'CUSTOMER', channel: 'LEFT', start_ms: 0, end_ms: 900, text: 'Tôi quan tâm cửa chống ngập.' },
    { company_id: context.companyId, transcription_id: tx, call_id: call, sequence: 2, speaker_role: 'STAFF', channel: 'RIGHT', start_ms: 900, end_ms: 1900, text: 'Sẽ tư vấn chi phí lắp đặt.' },
  ], { onConflict: 'transcription_id,sequence' }));
  check(await db.from('zalo_call_ai_summaries').upsert({ company_id: context.companyId, call_id: call, transcription_id: tx, status: 'COMPLETED',
    provider: 'SYNTHETIC', model: 'synthetic-local', summary: 'Synthetic: Khách quan tâm cửa chống ngập, cần tư vấn chi phí.', customer_needs: ['Tư vấn chi phí'], objections: ['Chi phí lắp đặt'],
    next_actions: ['Tư vấn chi phí'], key_points: ['Dữ liệu mô phỏng; audio chỉ là âm thử'], lead_temperature: 'WARM', confidence: 'HIGH', completed_at: new Date().toISOString() }, { onConflict: 'company_id,transcription_id' }));
  check(await db.from('customer_dossier_settings').upsert({ company_id: context.companyId, enabled: true }));
  check(await db.rpc('c360_request_refresh', { p_company_id: context.companyId, p_customer_id: context.customerId }));
  const token = 'synthetic-local-javis-token-000000000000000';
  const server = createJavisBrainServer({ authToken: token, onAuditLog: () => undefined, modelBackend: { generate: async () => { throw new Error('NOT_USED'); },
    generateDossier: async () => ({ ...snapshot, painPoints: snapshot.objections, riskFlags: snapshot.objections }) } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOCAL_JAVIS_FAILED');
  process.env.CUSTOMER_DOSSIER_ENABLED = 'true';
  try {
    const provider = new JavisBrainProvider({ baseUrl: 'https://synthetic-javis.test', authToken: token,
      fetchImpl: (input, init) => fetch(String(input).replace('https://synthetic-javis.test', `http://127.0.0.1:${address.port}`), init) });
    const result = await processDossierRefresh({ db, companyId: context.companyId, customerId: context.customerId, provider });
    console.log(JSON.stringify({ synthetic: true, customerRoute: `/customers/${context.customerId}/dossier`, refresh: result.status }));
    if (result.status !== 'COMPLETED') throw new Error('SYNTHETIC_REFRESH_FAILED');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error('LOCAL_SYNTHETIC_ACCEPTANCE_SETUP_FAILED', error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'INVALID_FIXTURE'); process.exitCode = 1; });
