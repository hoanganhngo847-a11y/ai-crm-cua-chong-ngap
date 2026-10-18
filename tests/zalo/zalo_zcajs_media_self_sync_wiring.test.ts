import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/inbox/zalo-zcajs/inbound/route.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20261018221000_zcajs_observed_outbound.sql', 'utf8');
const worker = fs.readFileSync('zalo-zcajs-worker/src/index.mjs', 'utf8');
const normalizer = fs.readFileSync('zalo-zcajs-worker/src/message-normalizer.mjs', 'utf8');
const messageContent = fs.readFileSync('features/inbox/components/message-content.tsx', 'utf8');

assert.match(worker, /selfListen:\s*true/, 'ZCAJS worker must listen to self-sent messages.');
assert.match(worker, /shouldSuppressCrmSelfEcho/, 'CRM-originated self echoes must be suppressed to avoid duplicate bubbles.');
assert.match(normalizer, /\[\[ZALO_IMAGE\]\]/, 'Image attachments must be normalized into the media marker contract.');
assert.match(normalizer, /direction:\s*message\.isSelf \? 'outbound' : 'inbound'/, 'Self messages must be marked outbound.');
assert.match(route, /record_observed_zcajs_outbound_atomic/, 'Observed self messages must use the non-dispatch persistence RPC.');
assert.match(route, /direction === 'outbound'/, 'Inbound bridge must branch on outbound self observations.');
assert.match(migration, /provider_message_id = v_msg_id/, 'Observed self persistence must dedupe CRM-originated provider messages.');
assert.match(migration, /'OUTBOUND'/, 'Observed native-Zalo messages must persist with OUTBOUND direction.');
assert.match(messageContent, /extractZaloImageMarkers/, 'Inbox UI must recognize Zalo image markers.');
assert.match(messageContent, /alt="Ảnh gửi qua Zalo"/, 'Inbox UI must render a visible image element.');

console.log('[PASS] ZCAJS image + manual self-message sync wiring is present.');
