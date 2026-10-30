import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface ZaloCredentials { cookie: string; imei: string; userAgent: string }
export class ZaloAccountInputError extends Error {}

export function parseZaloCredentials(input: { cookie: unknown; imei: unknown; userAgent: unknown }): ZaloCredentials {
  if (typeof input.cookie !== 'string' || Buffer.byteLength(input.cookie) > 128 * 1024) throw new ZaloAccountInputError('File cookie phải là JSON và nhỏ hơn 128 KB.');
  let parsed: unknown;
  try { parsed = JSON.parse(input.cookie); } catch { throw new ZaloAccountInputError('Cookie chưa phải JSON hợp lệ. Hãy chọn file xuất từ J2TEAM Cookies.'); }
  const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).cookies : null);
  if (!Array.isArray(rows) || rows.length > 500) throw new ZaloAccountInputError('Không tìm thấy danh sách cookie. Hãy xuất JSON không mã hóa bằng mật khẩu.');
  const cookies = rows.filter((row) => row && typeof row === 'object').filter((row) => {
    const domain = typeof row.domain === 'string' ? row.domain.replace(/^\./, '').toLowerCase() : '';
    return domain === 'zalo.me' || domain.endsWith('.zalo.me') || domain === 'zaloapp.com' || domain.endsWith('.zaloapp.com');
  }).map((row) => {
    if (typeof row.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/.test(row.name) || typeof row.value !== 'string' || row.value.length > 16000 || /[\r\n;]/.test(row.value)) throw new ZaloAccountInputError('Cookie Zalo chứa giá trị không hợp lệ. Hãy xuất lại file.');
    return { name: row.name, value: row.value, domain: row.domain, path: typeof row.path === 'string' ? row.path : '/', secure: true, httpOnly: Boolean(row.httpOnly) };
  });
  if (!cookies.length || !cookies.some((row) => row.value)) throw new ZaloAccountInputError('File không có cookie của Zalo. Hãy xuất khi đang mở chat.zalo.me.');
  const imei = typeof input.imei === 'string' ? input.imei.trim().replace(/^['"]|['"]$/g, '') : '';
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(imei) || /^(null|undefined)$/i.test(imei)) throw new ZaloAccountInputError('IMEI chưa hợp lệ. Hãy lấy lại trong Console của đúng hồ sơ Chrome.');
  const userAgent = typeof input.userAgent === 'string' ? input.userAgent.trim().replace(/^['"]|['"]$/g, '') : '';
  if (userAgent.length < 20 || userAgent.length > 1024 || /[\r\n]/.test(userAgent) || !userAgent.startsWith('Mozilla/')) throw new ZaloAccountInputError('User-Agent chưa hợp lệ. Hãy sao chép kết quả navigator.userAgent.');
  return { cookie: JSON.stringify({ url: 'https://chat.zalo.me', cookies }), imei, userAgent };
}

function encryptionKey() {
  const value = process.env.ZALO_ACCOUNT_ENCRYPTION_KEY || '';
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('ZALO_ACCOUNT_ENCRYPTION_NOT_CONFIGURED');
  return key;
}

export function encryptZaloCredentials(companyId: string, accountId: string, credentials: ZaloCredentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`${companyId}:${accountId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decryptZaloCredentials(companyId: string, accountId: string, encrypted: Record<string, unknown>): ZaloCredentials {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(String(encrypted.iv), 'base64'));
  decipher.setAAD(Buffer.from(`${companyId}:${accountId}`));
  decipher.setAuthTag(Buffer.from(String(encrypted.tag), 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(String(encrypted.ciphertext), 'base64')), decipher.final()]).toString('utf8'));
}

export function credentialsFingerprint(credentials: ZaloCredentials) {
  const cookies = JSON.parse(credentials.cookie).cookies as Array<{ name: string; value: string; domain: string }>;
  const canonical = cookies.map(({ name, value, domain }) => `${domain}:${name}=${value}`).sort().join('\n');
  return createHmac('sha256', encryptionKey()).update(canonical).digest('hex');
}
