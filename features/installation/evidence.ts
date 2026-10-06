import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OperationsError } from '../operations/server';
import { PRODUCT_UPLOAD_MAX_BYTES } from '@/config/upload-policy';
export const EVIDENCE_MAX_BYTES = PRODUCT_UPLOAD_MAX_BYTES;
const formats: Record<string, { type: 'photo' | 'handover'; extensions: string[]; extension: string }> = {
 'image/jpeg': { type: 'photo', extensions: ['jpg','jpeg'], extension: 'jpg' },
 'image/png': { type: 'photo', extensions: ['png'], extension: 'png' },
 'image/webp': { type: 'photo', extensions: ['webp'], extension: 'webp' },
 'application/pdf': { type: 'handover', extensions: ['pdf'], extension: 'pdf' },
};
export function prepareEvidence(companyId: string, installationId: string, evidenceType: string, file: File) {
 if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(installationId).success || !(file instanceof File)) throw new OperationsError('INVALID_INPUT');
 const type = evidenceType.toLowerCase();
 const format = formats[file.type];
 const extension = file.name.split('.').pop()?.toLowerCase() || '';
 if (!format || format.type !== type || !format.extensions.includes(extension) || file.size <= 0 || file.size > EVIDENCE_MAX_BYTES) throw new OperationsError('INVALID_INPUT');
 return { type: format.type, contentType: file.type, path: `${companyId}/installations/${installationId}/${type}/${randomUUID()}.${format.extension}` };
}
export function isValidCanonicalInstallationStorageRef(companyId: string, installationId: string, ref: string, type?: string): boolean {
 if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(installationId).success || typeof ref !== 'string') return false;
 const prefix = `${companyId}/installations/${installationId}/`;
 if (!ref.startsWith(prefix)) return false;
 const suffix = ref.slice(prefix.length);
 return (type !== 'handover' && /^photo\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(suffix)) ||
 (type !== 'photo' && /^handover\/[0-9a-f-]{36}\.pdf$/.test(suffix));
}
