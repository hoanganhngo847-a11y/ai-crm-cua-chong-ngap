import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const routePath = new URL('../../app/api/voice/zalo-personal/live/session/route.ts', import.meta.url);
const migrationPath = new URL('../../supabase/migrations/20261026083543_zalo_personal_live_voice_bridge.sql', import.meta.url);
const inboundMigrationPath = new URL('../../supabase/migrations/20261026092307_zalo_personal_inbound_live_voice.sql', import.meta.url);
const inboundHardeningMigrationPath = new URL('../../supabase/migrations/20261026111500_zalo_personal_inbound_live_voice_hardening.sql', import.meta.url);

test('Zalo personal live voice is fail-closed when the server flag is off', async () => {
  const previous = process.env.ZALO_PERSONAL_LIVE_VOICE_ENABLED;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.ZALO_PERSONAL_LIVE_VOICE_ENABLED = '0';
  process.env.OPENAI_API_KEY = 'test-key-must-not-leak';
  try {
    const route = await import(routePath.href);
    const response = await route.POST(new Request('https://crm.example.test/api/voice/zalo-personal/live/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zalo-device-id': '33333333-3333-4333-8333-333333333333',
        authorization: `Bearer ${'x'.repeat(40)}`,
      },
      body: JSON.stringify({ request_id: '11111111-1111-4111-8111-111111111111', local_call_id: '22222222-2222-4222-8222-222222222222' }),
    }));
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, { ok: false, error: 'LIVE_VOICE_DISABLED' });
    assert.equal(JSON.stringify(body).includes('test-key-must-not-leak'), false);
  } finally {
    if (previous === undefined) delete process.env.ZALO_PERSONAL_LIVE_VOICE_ENABLED;
    else process.env.ZALO_PERSONAL_LIVE_VOICE_ENABLED = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('live session route uses Gemini Live ephemeral tokens and the documented audio rates', async () => {
  const source = await readFile(routePath, 'utf8');
  assert.match(source, /GoogleGenAI/);
  assert.match(source, /authTokens\.create/);
  assert.match(source, /access_token/);
  assert.match(source, /input_sample_rate: 16000/);
  assert.match(source, /output_sample_rate: 24000/);
  assert.doesNotMatch(source, /OPENAI_API_KEY|client_secret|api\.openai\.com/);
});

test('live voice migration is additive, tenant-scoped and service-role only', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE public\.zalo_personal_live_voice_sessions/);
  assert.match(sql, /FOREIGN KEY\(company_id, customer_id\) REFERENCES public\.customers/);
  assert.match(sql, /FOREIGN KEY\(company_id, outbound_request_id\) REFERENCES public\.zalo_outbound_call_requests/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.zalo_begin_live_voice_session/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.zalo_begin_live_voice_session[^;]* TO service_role/);
  assert.match(sql, /CHECK \(status IN \('REQUESTED', 'ACTIVE', 'ENDED', 'FAILED', 'EXPIRED'\)\)/);
});

test('inbound live voice accepts unknown callers but remains device-scoped and fail-closed', async () => {
  const sql = await readFile(inboundMigrationPath, 'utf8');
  assert.match(sql, /ALTER COLUMN customer_id DROP NOT NULL/);
  assert.match(sql, /ALTER COLUMN outbound_request_id DROP NOT NULL/);
  assert.match(sql, /direction text NOT NULL DEFAULT 'OUTBOUND'/);
  assert.match(sql, /zalo_begin_inbound_live_voice_session/);
  assert.match(sql, /ALTER COLUMN provider SET DEFAULT 'GEMINI_LIVE'/);
  assert.match(sql, /provider IN \('OPENAI_REALTIME', 'GEMINI_LIVE'\)/);
  assert.match(sql, /WHERE id = p_device AND active AND device_key_hash = p_key_hash/);
  assert.match(sql, /INSERT INTO public\.zalo_personal_live_voice_sessions[\s\S]*'INBOUND'/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.zalo_begin_inbound_live_voice_session[^;]* TO service_role/);
});

test('inbound live session does not reuse expired or terminal provider sessions', async () => {
  const sql = await readFile(inboundHardeningMigrationPath, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.zalo_begin_inbound_live_voice_session/);
  assert.match(sql, /ZALO_LIVE_SESSION_EXPIRED/);
  assert.match(sql, /ZALO_LIVE_SESSION_TERMINAL/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.zalo_begin_inbound_live_voice_session/);
});

test('inbound live session remains fenced when post-begin work fails', async () => {
  const source = await readFile(routePath, 'utf8');
  assert.match(source, /const inboundId =/);
  assert.match(source, /sessionId = inboundId/);
  assert.match(source, /LIVE_VOICE_SCHEMA_UNAVAILABLE/);
  assert.match(source, /message\.includes\('does not exist'\)/);
});
