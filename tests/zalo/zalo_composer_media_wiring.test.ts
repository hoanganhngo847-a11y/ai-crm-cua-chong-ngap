import assert from 'node:assert/strict';
import fs from 'node:fs';

const composer = fs.readFileSync('features/inbox/components/zalo-composer.tsx', 'utf8');
const inboxView = fs.readFileSync('features/inbox/components/inbox-view.tsx', 'utf8');
const mediaRoute = fs.readFileSync('app/api/inbox/zalo-zcajs/media/route.ts', 'utf8');
const mediaClient = fs.readFileSync('features/omnichannel/zalo/zcajs-media-client.ts', 'utf8');
const worker = fs.readFileSync('zalo-zcajs-worker/src/index.mjs', 'utf8');

assert.match(composer, /onPaste=\{handlePaste\}/, 'Composer must intercept clipboard paste events.');
assert.match(composer, /navigator\.clipboard\?\.read/, 'Composer must support explicit image paste from the Clipboard API.');
assert.match(composer, /accept="image\/\*"/, 'Composer must expose an image picker.');
assert.match(composer, /type="file"/, 'Composer must expose file selection controls.');
assert.match(composer, /onSendMedia/, 'Composer must provide a media-send contract to the inbox.');
assert.match(composer, /Gửi 👍/, 'Composer must retain Zalo-like thumbs-up quick send.');

assert.match(inboxView, /import ZaloComposer from '\.\/zalo-composer'/, 'Unified Inbox must mount the Zalo-style composer.');
assert.match(inboxView, /\/api\/inbox\/zalo-zcajs\/media/, 'Unified Inbox must call the authenticated media endpoint.');
assert.match(inboxView, /onQuickSend=\{handleQuickSend\}/, 'Quick-send actions must be wired to the canonical text endpoint.');

assert.match(mediaRoute, /getActorContext\(\)/, 'Media endpoint must derive the authenticated actor server-side.');
assert.match(mediaRoute, /\.eq\('company_id', actor\.companyId\)/, 'Media endpoint must enforce tenant ownership.');
assert.match(mediaRoute, /sendZcaJsMediaMessage/, 'Media endpoint must call the server-only ZCAJS media client.');
assert.match(mediaClient, /Authorization: `Bearer \$\{config\.workerSecret\}`/, 'CRM-to-worker media calls must be authenticated.');

assert.match(worker, /url\.pathname === '\/v1\/send-media'/, 'Worker must expose a dedicated authenticated media endpoint.');
assert.match(worker, /attachments: localPaths/, 'Worker must pass local attachment paths to the pinned ZCAJS sendMessage API.');
assert.match(worker, /fs\.mkdtemp/, 'Worker must isolate temporary attachment files.');
assert.match(worker, /fs\.rm\(tempDir, \{ recursive: true, force: true \}\)/, 'Worker must remove temporary files after every send outcome.');

console.log('[PASS] Zalo-style composer, clipboard image paste and ZCAJS media transport are wired.');
