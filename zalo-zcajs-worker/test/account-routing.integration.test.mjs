import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// Run the actual supervisor HTTP/proxy/process lifecycle against local fake
// provider children. No Zalo credentials or remote provider calls are used.
test('supervisor routes text/media/group requests to the right process and refuses paused accounts', { timeout: 20000 }, async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let accounts = [{ id, revision: 1, label: 'Test', cookie: 'fake', imei: 'fake-imei', userAgent: 'fake-ua' }];
  let legacyVerified = false;
  const crm = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.accountId === null) legacyVerified = body.providerUid === '111111';
      res.end(JSON.stringify({ success: true }));
    } else res.end(JSON.stringify({ success: true, companyId: 'test-company', accounts }));
  });
  crm.listen(0, '127.0.0.1'); await once(crm, 'listening');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'zalo-account-routing-'));
  let child;
  try {
    for (const name of ['supervisor.mjs', 'account-supervisor.mjs']) await copyFile(new URL(`../src/${name}`, import.meta.url), path.join(temp, name));
    await writeFile(path.join(temp, 'index.mjs'), `import http from 'node:http';
      const id=process.env.ZCAJS_ACCOUNT_ID||'legacy';
      const server=http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');
        if(req.url==='/health')return res.end(JSON.stringify({loggedIn:true,listenerConnected:true,queueDurable:true,providerUid:id==='legacy'?'111111':'222222'}));
        let chunks=[];for await(const chunk of req)chunks.push(chunk);
        const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
        res.end(JSON.stringify({success:true,outcome:'ACCEPTED',providerMessageId:'msg-1',providerMessageIds:['media-1'],account:id,recipient:body.recipientZaloId,url:req.url}));
      });server.listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
    child = spawn(process.execPath, [path.join(temp, 'supervisor.mjs')], { env: { ...process.env, PORT: String(port), ZCAJS_COMPANY_ID: 'test-company', ZCAJS_WORKER_SECRET: 'test-secret', ZCAJS_CRM_BASE_URL: `http://127.0.0.1:${crm.address().port}` }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    async function waitFor(check) { for (let n = 0; n < 80; n++) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 50)); } throw new Error('local supervisor did not become ready'); }
    await waitFor(async () => (await fetch(`${base}/ready`)).ok);
    async function send(recipient, endpoint = '/v1/send') {
      const response = await fetch(base + endpoint, { method: 'POST', headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ companyId: 'test-company', recipientZaloId: recipient, text: 'test only' }) });
      return { status: response.status, body: await response.json() };
    }
    let managed;
    await waitFor(async () => { managed = await send(`account:${id}:123456`); return managed.status === 200; });
    assert.equal(legacyVerified, true);
    assert.equal(managed.body.account, id);
    assert.equal(managed.body.recipient, '123456');
    assert.equal(managed.body.providerMessageId, `account:${id}:msg-1`);
    const media = await send(`account:${id}:group:987654`, '/v1/send-media');
    assert.equal(media.body.recipient, 'group:987654');
    assert.deepEqual(media.body.providerMessageIds, [`account:${id}:media-1`]);
    const group = await fetch(`${base}/v1/group-details?accountId=${id}&groupId=987654`, { headers: { authorization: 'Bearer test-secret' } });
    assert.equal((await group.json()).account, id);
    const legacy = await send('123456');
    assert.equal(legacy.body.account, 'legacy');
    assert.equal(legacy.body.providerMessageId, 'msg-1');
    assert.equal((await send('account:bad:123456')).status, 400);
    assert.equal((await send('account:22222222-2222-4222-8222-222222222222:123456')).status, 409);
    accounts = [];
    const paused = await send(`account:${id}:123456`);
    assert.equal(paused.status, 409);
    assert.equal(paused.body.outcome, 'REJECTED');
    assert.equal((await send('123456')).body.account, 'legacy', 'pausing additional account leaves legacy working');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await new Promise((resolve) => crm.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
