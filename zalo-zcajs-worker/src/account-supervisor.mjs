import path from 'node:path';

export const ACCOUNT_PREFIX = /^account:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):((?:group:)?[0-9]{5,40})$/i;
export function splitAccountRecipient(recipient) {
  if (typeof recipient !== 'string') throw new Error('INVALID_RECIPIENT');
  if (!recipient.startsWith('account:')) return { accountId: null, peer: recipient };
  const match = ACCOUNT_PREFIX.exec(recipient);
  if (!match) throw new Error('INVALID_ACCOUNT_RECIPIENT');
  return { accountId: match[1], peer: match[2] };
}
export function accountChildEnvironment(base, account, port) {
  if (!/^[0-9a-f-]{36}$/i.test(account.id) || !Number.isSafeInteger(account.revision) || account.revision < 1) throw new Error('INVALID_ACCOUNT_CONFIG');
  return {
    ...base, PORT: String(port), ZCAJS_BIND_HOST: '127.0.0.1', ZCAJS_ACCOUNT_ID: account.id,
    ZCAJS_ACCOUNT_REVISION: String(account.revision), ZCAJS_COOKIE: account.cookie,
    ZCAJS_IMEI: account.imei, ZCAJS_USER_AGENT: account.userAgent,
    ZCAJS_INBOX_QUEUE_FILE: path.join(path.dirname(base.ZCAJS_INBOX_QUEUE_FILE || '/app/data/zcajs-inbound-queue.jsonl'), 'accounts', account.id, 'inbound-queue.jsonl'),
  };
}

// One provider session per OS process: the pinned SDK has global appContext.
// An account refresh/restart never reuses another account's cookie, port, or queue.
export function createAccountRegistry({ launch, baseEnv, now = Date.now, maxAccounts = 3 }) {
  const slots = new Map();
  let nextPort = 11001;
  let stopped = false;
  function stopSlot(slot) { slot.removed = true; slot.child?.kill('SIGTERM'); }
  function start(account, previous) {
    const slot = { id: account.id, revision: account.revision, port: nextPort++, child: null, removed: false, failures: previous?.failures || 0, retryAt: 0, connected: false };
    const child = launch(accountChildEnvironment(baseEnv, account, slot.port));
    slot.child = child;
    child.once('exit', () => {
      slot.child = null;
      if (!slot.removed) { slot.failures++; slot.retryAt = now() + Math.min(600000, 30000 * 2 ** Math.min(slot.failures, 5)); }
    });
    slots.set(account.id, slot);
    return slot;
  }
  return {
    reconcile(accounts) {
      if (stopped) return;
      if (!Array.isArray(accounts) || accounts.length > maxAccounts) throw new Error('ACCOUNT_CONFIG_LIMIT');
      // Validate every row before stopping or starting any process.
      for (const account of accounts) accountChildEnvironment(baseEnv, account, 11001);
      if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new Error('DUPLICATE_ACCOUNT_CONFIG');
      const ids = new Set(accounts.map((account) => account.id));
      for (const [id, slot] of slots) if (!ids.has(id)) { stopSlot(slot); if (!slot.child) slots.delete(id); }
      for (const account of accounts) {
        const slot = slots.get(account.id);
        if (!slot) start(account);
        else if (slot.revision !== account.revision || slot.removed) {
          // Let the previous process finish flushing its durable queue before
          // another process opens the same account file or Zalo Web session.
          if (slot.child) stopSlot(slot); else start(account);
        }
        else if (!slot.child && slot.retryAt <= now()) start(account, slot);
      }
    },
    get: (id) => slots.get(id),
    values: () => [...slots.values()],
    stop() { stopped = true; for (const slot of slots.values()) stopSlot(slot); },
  };
}
