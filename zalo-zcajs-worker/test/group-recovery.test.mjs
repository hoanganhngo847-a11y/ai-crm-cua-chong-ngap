import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { normalizeZaloMessage } from '../src/message-normalizer.mjs';

// Fixture is the exact upstream listener at Docker's pinned commit
// 0d99d7d025f5183822d627088fac89d1f55ef691 (license alongside the fixture).
const workerRoot = new URL('../', import.meta.url);
async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcajs-history-'));
  try {
    await fs.mkdir(path.join(dir, 'src/apis'), { recursive: true });
    await fs.copyFile(new URL('test/fixtures/zcajs-listen.ts.txt', workerRoot), path.join(dir, 'src/apis/listen.ts'));
    execFileSync('git', ['apply', new URL('patches/zcajs-old-direct-messages.patch', workerRoot).pathname], { cwd: dir });
    const patch = new URL('patches/patch-zcajs-group-recovery.mjs', workerRoot).pathname;
    execFileSync(process.execPath, [patch], { cwd: dir });
    const source = await fs.readFile(path.join(dir, 'src/apis/listen.ts'), 'utf8');
    execFileSync(process.execPath, [patch], { cwd: dir });
    assert.equal(await fs.readFile(path.join(dir, 'src/apis/listen.ts'), 'utf8'), source);
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const sockets = [];
    const frames = [];
    class Socket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      constructor() { sockets.push(this); }
      send(frame) { frames.push({ command: frame.readUInt16LE(1), body: JSON.parse(frame.subarray(4).toString()) }); }
    }
    class Message {
      type = 0;
      constructor(data) { this.data = data; this.isSelf = data.uidFrom === '0'; this.threadId = this.isSelf ? data.idTo : data.uidFrom; }
    }
    class GroupMessage extends Message {
      type = 1;
      constructor(data) { super(data); this.threadId = data.idTo; }
    }
    const fakeRequire = (name) => {
      if (name === 'events') return EventEmitter;
      if (name === 'ws') return Socket;
      if (name.endsWith('context.js')) return { appContext: { cookie: 'fixture', userAgent: 'fixture', options: { selfListen: true } } };
      if (name.endsWith('models/index.js')) return { Message, GroupMessage };
      if (name.endsWith('utils.js')) return { decodeEventData: async (parsed) => ({ data: parsed }), logger: { error() {} } };
      return {};
    };
    const exports = {};
    new Function('require', 'exports', 'setTimeout', 'setInterval', 'clearInterval', compiled)(fakeRequire, exports, () => ({}), () => ({}), () => {});
    const listener = new exports.Listener('wss://fixture.test');
    const messages = [];
    listener.on('message', (message) => messages.push(normalizeZaloMessage(message)));
    listener.on('error', (error) => { throw error; });
    listener.start();
    const socket = sockets.at(-1);
    const receive = async (command, body) => {
      const header = Buffer.from([1, 0, 0, 1]); header.writeUInt16LE(command, 1);
      await socket.onmessage({ data: Buffer.concat([header, Buffer.from(JSON.stringify(body))]) });
    };
    return { listener, frames, messages, receive };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('reconnect scan requests both direct and group history commands', async () => {
  const { listener, frames } = await harness();
  listener.requestOldDirectMessages();
  assert.deepEqual(frames.map((frame) => frame.command), [510, 511]);
});

test('group history re-enters durable ingestion with its author, thread and recovery flag', async () => {
  const { listener, frames, messages, receive } = await harness();
  listener.requestOldDirectMessages();
  const raw = { msgId: '123', idTo: '123456789012345678', uidFrom: '99999', dName: 'Chị Lan', content: 'Tin trong nhóm', ts: String(Date.now() - 2 * 86400000) };
  await receive(511, { groupMsgs: [raw] });
  assert.equal(messages[0].externalUserId, 'group:123456789012345678');
  assert.equal(messages[0].senderId, '99999');
  assert.equal(messages[0].senderDisplayName, 'Chị Lan');
  assert.equal(messages[0].recovered, true);
  assert.equal(frames.at(-1).body.lastId, '123');
  const before = frames.length;
  await receive(511, { groupMsgs: [raw] });
  assert.equal(frames.length, before, 'a repeated cursor must stop pagination');
});

test('old and deleted history records do not produce messages or unbounded pagination', async () => {
  const { messages, frames, receive } = await harness();
  await receive(511, { groupMsgs: [{ msgId: '1', idTo: '123456', uidFrom: '99999', content: 'expired', ts: String(Date.now() - 8 * 86400000) }] });
  assert.equal(messages.length, 0);
  assert.equal(frames.length, 0);
  await receive(510, { msgs: [{ msgId: '2', idTo: '0', uidFrom: '99999', content: { deleteMsg: true }, ts: String(Date.now()) }] });
  assert.equal(messages.length, 0);
});
