import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const MAGIC = Buffer.from('CRM-SYNTHETIC-BACKUP-v1\n');

/** Authenticated encryption for the synthetic rehearsal only. Production key
 * custody/rotation and a real staging backup require separate owner approval. */
export function encryptSyntheticBackup(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('BACKUP_KEY_MUST_BE_32_BYTES');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSyntheticBackup(envelope: Buffer, key: Buffer): Buffer {
  if (key.length !== 32 || envelope.length < MAGIC.length + 28 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('BACKUP_ENVELOPE_INVALID');
  const nonce = envelope.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = envelope.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(envelope.subarray(MAGIC.length + 28)), decipher.final()]); }
  catch { throw new Error('BACKUP_AUTHENTICATION_FAILED'); }
}

export const backupDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
