/** Read-only offline verification. Ciphertexts arrive on stdin, secrets via env.
 * Prints counts/status only; no key, digest, token, ciphertext, URL or error body.
 * Run with: node --conditions=react-server --import tsx scripts/meta-ads/verify-token-key.ts
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decryptToken, encryptToken, parseEncryptionKey } from '../../features/omnichannel/facebook/token-vault';

try {
    const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
    if (!Array.isArray(input) || !input.every(v => typeof v === 'string')) throw new Error();
    const primary = parseEncryptionKey(process.env.META_TOKEN_ENCRYPTION_KEY, 'META_TOKEN_ENCRYPTION_KEY');
    const probe = 'offline-key-format-verification';
    if (decryptToken(encryptToken(probe)) !== probe) throw new Error();
    let legacyVerified = 0;
    const legacy = process.env.META_LEGACY_TOKEN_ENCRYPTION_SECRET?.trim();
    if (legacy) {
        const digest = createHash('sha256').update(legacy).digest();
        const previous = parseEncryptionKey(process.env.META_PREVIOUS_TOKEN_ENCRYPTION_KEY, 'META_PREVIOUS_TOKEN_ENCRYPTION_KEY');
        if (!timingSafeEqual(previous, digest)) throw new Error();
        for (const encrypted of input) {
            const packed = Buffer.from(encrypted, 'base64url');
            const decipher = createDecipheriv('aes-256-gcm', digest, packed.subarray(0, 12));
            decipher.setAuthTag(packed.subarray(12, 28));
            const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
            if (decryptToken(encrypted) !== plaintext) throw new Error();
            legacyVerified++;
        }
    } else {
        for (const encrypted of input) decryptToken(encrypted);
    }
    // Referencing this avoids retaining an unused key binding; the length itself is not secret.
    if (primary.length !== 32) throw new Error();
    console.info(JSON.stringify({ status: input.length ? 'VERIFIED' : 'NO_CIPHERTEXT_ROWS', checked: input.length, legacyVerified }));
} catch {
    console.error('META_TOKEN_KEY_VERIFICATION_FAILED');
    process.exitCode = 1;
}
