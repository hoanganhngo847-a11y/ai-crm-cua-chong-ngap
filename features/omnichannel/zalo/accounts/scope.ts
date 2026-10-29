export const ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_THREAD = /^account:([0-9a-f-]{36}):((?:group:)?[0-9]{5,40})$/i;

export function scopeZaloThread(accountId: string, thread: string) {
  if (!ACCOUNT_UUID.test(accountId) || !/^(?:group:)?[0-9]{5,40}$/.test(thread)) throw new Error('INVALID_ZALO_ACCOUNT_THREAD');
  return `account:${accountId}:${thread}`;
}
export function splitZaloThread(thread: string) {
  if (!thread.startsWith('account:')) return { accountId: undefined, peer: thread };
  const match = ACCOUNT_THREAD.exec(thread);
  if (!match || !ACCOUNT_UUID.test(match[1])) throw new Error('INVALID_ZALO_ACCOUNT_THREAD');
  return { accountId: match[1], peer: match[2] };
}
export function scopedZaloMessageId(accountId: string, id: string) {
  if (!ACCOUNT_UUID.test(accountId) || !id.trim()) throw new Error('INVALID_ZALO_ACCOUNT_MESSAGE');
  return `account:${accountId}:${id}`;
}
