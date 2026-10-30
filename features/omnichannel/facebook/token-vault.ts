import 'server-only';

import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from 'node:crypto';

function encryptionKey(): Buffer {
    const secret =
        process.env.META_TOKEN_ENCRYPTION_KEY?.trim() ||
        process.env.META_APP_SECRET?.trim();
    if (!secret) {
        throw new Error('MISSING_META_ENCRYPTION_SECRET');
    }
    return createHash('sha256').update(secret).digest();
}

/**
 * Encrypt token using AES-256-GCM with a random IV and authentication tag
 */
export function encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(token, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Format: iv (12 bytes) + tag (16 bytes) + ciphertext
    return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

/**
 * Decrypt token using AES-256-GCM
 */
export function decryptToken(encrypted: string): string {
    const packed = Buffer.from(encrypted, 'base64url');
    if (packed.length < 28) {
        throw new Error('INVALID_ENCRYPTED_TOKEN');
    }

    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return plaintext.toString('utf8');
}
