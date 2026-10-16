import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractActiveThreadMessages } from '../../fb-inbox-worker/src/parser.js';
import { messageReconciler } from '../../fb-inbox-worker/src/message-reconciler.js';
import { processThreadData, syncedFingerprints } from '../../fb-inbox-worker/src/index.js';
import { CONFIG } from '../../fb-inbox-worker/src/config.js';
import { CycleWaker, setupDomMutationSignal } from '../../fb-inbox-worker/src/observer.js';
import { log } from '../../fb-inbox-worker/src/logger.js';

const require = createRequire(process.cwd() + '/package.json');
const { chromium } = require('./fb-inbox-worker/node_modules/playwright');

const PAGE_ID = '1389294167596309';
const CUSTOMER_ID = '61592309996999';
const THREAD_ID = `${PAGE_ID}:${CUSTOMER_ID}`;
const gray = 'background-color: rgb(240, 242, 245); border-radius: 18px; padding: 8px 12px; white-space: pre-wrap';

function bubble(mid: string, html: string) {
  return `<div class="row" style="display:flex;justify-content:flex-start" data-message-id="${mid}"><div dir="auto" style="${gray}">${html}</div></div>`;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
  const oldSecret = CONFIG.FB_WORKER_SECRET;
  const oldTrace = CONFIG.MESSAGE_TRACE;
  const oldFetch = globalThis.fetch;
  const oldLogInfo = log.info;
  const oldMessageBox = log.messageBox;
  const traceLines: string[] = [];

  try {
    CONFIG.MESSAGE_TRACE = true;
    log.info = (message: string) => { traceLines.push(message); };
    log.messageBox = () => {};
    messageReconciler.resetThread(THREAD_ID);
    const url = 'https://example.com/?a=1&b=2';
    const cases = [
      ['mid.$url-only', 'https://google.com', '<a href="https://google.com"><span>https://google.com</span></a>'],
      ['mid.$url-path', 'https://example.com/a/b', '<a href="https://example.com/a/b">https://example.com/a/b</a>'],
      ['mid.$url-query', url, `<a href="${url}">${url}</a>`],
      ['mid.$url-fragment', 'https://example.com/page#section', '<a href="https://example.com/page#section">https://example.com/page#section</a>'],
      ['mid.$url-inline', 'Xem link https://example.com nhé', 'Xem link <a href="https://example.com">https://example.com</a> nhé'],
      ['mid.$url-multiline', 'Dòng 1\nhttps://example.com\nDòng 3', 'Dòng 1<br><a href="https://example.com">https://example.com</a><br>Dòng 3'],
      ['mid.$repeat-1', 'https://google.com', '<a href="https://google.com">https://google.com</a>'],
      ['mid.$repeat-2', 'https://google.com', '<a href="https://google.com">https://google.com</a>'],
      ['mid.$repeat-3', 'https://google.com', '<a href="https://google.com">https://google.com</a>'],
      ['mid.$preview', 'https://example.com/a/b', '<a href="https://example.com/a/b">https://example.com/a/b</a><div data-surface="preview"><a href="https://example.com/a/b">Preview title</a><p>Preview description</p></div>'],
      ['mid.$href-only', 'https://example.com/test', '<a href="https://example.com/test" aria-label="Link"></a>'],
      ['mid.$shim-href', 'https://example.com/product?id=123&utm_source=facebook', '<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fproduct%3Fid%3D123%26utm_source%3Dfacebook" aria-label="Link"></a>'],
    ] as const;

    await page.setContent(`<!doctype html><html><head><script>window.__name = function(fn) { return fn; }; globalThis.__name = window.__name;</script></head><body>
      <a href="https://example.com/navigation">Navigation</a>
      <div role="region" aria-label="Customer details"><a href="https://facebook.com/${CUSTOMER_ID}" aria-label="URL Test Customer">URL Test Customer</a></div>
      <div role="main" aria-label="Message list container with messages, suggestions, and typing indicators" style="width:800px">
        ${cases.map(([mid, , html]) => bubble(mid, html)).join('')}
        <a href="https://example.com/meta-navigation">Meta navigation</a>
      </div></body></html>`);

    const waker = new CycleWaker();
    await setupDomMutationSignal(page, (data: { domSignalAt?: number }) => waker.wake(data), { debounceMs: 20, maxWaitMs: 80 });
    await page.evaluate(() => {
      const main = document.querySelector('[role="main"]')!;
      const node = document.createElement('div');
      node.setAttribute('data-surface', 'message');
      node.innerHTML = '<a href="https://google.com">https://google.com</a>';
      main.appendChild(node);
    });
    assert.equal((await waker.waitForNextCycle(500)).type, 'SIGNAL', 'URL DOM mutation wakes the worker');

    const parsed = await extractActiveThreadMessages(page, PAGE_ID);
    assert.equal(parsed.messages.length, cases.length, 'one logical message per bubble; navigation excluded');
    for (const [mid, expected] of cases) {
      const message = parsed.messages.find((m: any) => m.messageId === mid);
      assert.ok(message, `${mid} reaches reconciler`);
      assert.equal(message.content, expected, `${mid} preserves full content`);
      assert.equal(message.direction, 'INBOUND', `${mid} direction`);
      assert.equal(message.fingerprintVersion, 'meta_mid_v2', `${mid} uses canonical identity`);
    }
    assert.equal(new Set(parsed.messages.map((m: any) => m.fingerprint)).size, cases.length, 'repeated URLs with distinct MIDs have distinct fingerprints');

    const rescan = await extractActiveThreadMessages(page, PAGE_ID);
    assert.deepEqual(rescan.messages.map((m: any) => m.fingerprint), parsed.messages.map((m: any) => m.fingerprint), 'rescan keeps canonical fingerprints');

    const requests: any[] = [];
    const dbMessages = new Map([['legacy-url-with-same-content', 'https://google.com']]);
    CONFIG.FB_WORKER_SECRET = 'local-test-secret';
    globalThis.fetch = (async (_input: unknown, init: any) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      const duplicate = dbMessages.has(payload.external_message_id);
      dbMessages.set(payload.external_message_id, payload.content);
      return { ok: true, status: 200, json: async () => ({ is_duplicate: duplicate, interaction_id: `fixture-${requests.length}` }) } as any;
    }) as typeof fetch;

    for (const message of parsed.messages) syncedFingerprints.delete(message.fingerprint);
    await processThreadData(parsed, PAGE_ID, 'Test Page');
    assert.equal(requests.length, cases.length, 'every canonical URL reaches browser-sync, including content matching historical legacy');
    assert.deepEqual(requests.map(r => r.content), cases.map(([, content]) => content), 'browser-sync receives exact content');
    assert.equal(new Set(requests.map(r => r.external_message_id)).size, cases.length, 'same URL sent three times remains three messages');
    assert.equal([...dbMessages.values()].filter(content => content === 'https://google.com').length, 5, 'historical legacy URL does not suppress four new canonical URL messages');
    await processThreadData(rescan, PAGE_ID, 'Test Page');
    assert.equal(requests.length, cases.length, 'rescan sends no canonical duplicate');
    for (const stage of ['DOM_MESSAGE_RAW', 'PARSER_CANDIDATE', 'PARSER_CONTENT', 'RECONCILER_MESSAGE', 'INBOUND_DETECTED', 'BROWSER_SYNC_REQUEST', 'BROWSER_SYNC_RESPONSE', 'PARSER_SKIP']) {
      assert.ok(traceLines.some(line => line.startsWith(`[${stage}]`) && line.includes('https://google.com')), `${stage} trace recorded for URL message`);
    }

    console.log('PASS: URL DOM mutation, parser, preview, canonical dedupe, and browser-sync request fixtures');
  } finally {
    CONFIG.FB_WORKER_SECRET = oldSecret;
    CONFIG.MESSAGE_TRACE = oldTrace;
    globalThis.fetch = oldFetch;
    log.info = oldLogInfo;
    log.messageBox = oldMessageBox;
    messageReconciler.resetThread(THREAD_ID);
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
