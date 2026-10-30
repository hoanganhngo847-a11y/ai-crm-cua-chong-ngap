import 'server-only';

import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
} from 'node:crypto';

/**
 * Strictly parses and validates a 32-byte (256-bit) encryption key
 */
export function parseEncryptionKey(rawKey: string | undefined, keyName: string): Buffer {
    if (!rawKey) {
        throw new Error(`MISSING_${keyName}`);
    }
    const trimmed = rawKey.trim();
    if (!trimmed) {
        throw new Error(`MISSING_${keyName}`);
    }

    // Hex format (64 hex characters -> 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }

    // Base64 format (44 characters -> 32 bytes)
    if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) || /^[A-Za-z0-9+/]{44}$/.test(trimmed)) {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length === 32) return buf;
    }

    // Raw 32-character ASCII/UTF8 string
    const rawBuf = Buffer.from(trimmed, 'utf8');
    if (rawBuf.length === 32) {
        return rawBuf;
    }

    throw new Error(
        `INVALID_${keyName}_FORMAT: Key must be 32 bytes (64 hex characters, 44 base64 characters, or 32 raw bytes).`,
    );
}

function primaryEncryptionKey(): Buffer {
    return parseEncryptionKey(process.env.META_TOKEN_ENCRYPTION_KEY, 'META_TOKEN_ENCRYPTION_KEY');
}

function previousEncryptionKey(): Buffer | null {
    const raw = process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY?.trim();
    if (!raw) return null;
    return parseEncryptionKey(raw, 'META_PREVIOUS_TOKEN_ENCRYPTION_KEY');
}

function attemptDecrypt(packed: Buffer, key: Buffer): string {
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return plaintext.toString('utf8');
}

/**
 * Encrypt token using AES-256-GCM with a random IV and authentication tag
 */
export function encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', primaryEncryptionKey(), iv);
    const ciphertext = Buffer.concat([
        cipher.update(token, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Format: iv (12 bytes) + tag (16 bytes) + ciphertext
    return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

/**
 * Decrypt token using AES-256-GCM with key rotation fallback support
 */
export function decryptToken(encrypted: string): string {
    const packed = Buffer.from(encrypted, 'base64url');
    if (packed.length < 28) {
        throw new Error('INVALID_ENCRYPTED_TOKEN');
    }

    // 1. Attempt decryption using primary key
    try {
        return attemptDecrypt(packed, primaryEncryptionKey());
    } catch {
        // 2. Attempt fallback with previous key for seamless rotation
        const prevKey = previousEncryptionKey();
        if (prevKey) {
            try {
                return attemptDecrypt(packed, prevKey);
            } catch {
                // Fall through to failure
            }
        }
        throw new Error('TOKEN_DECRYPTION_FAILED');
    }
}

/**
 * Re-encrypt token using the current primary key (used during key rotation)
 */
export function rotateToken(encrypted: string): string {
    const decrypted = decryptToken(encrypted);
    return encryptToken(decrypted);
}
