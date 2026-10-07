import { sanitize } from './core';

const PHONE_CANDIDATE_SOURCE = String.raw`(?:\+|00)?[0-9](?:[\s()./_,:\-]*[0-9]){3,}`;
const PHONE_INTENT_REGEX = /(?:sđt|sdt|số\s*(?:điện\s*thoại|dt)|điện\s*thoại|phone|liên\s*hệ|zalo)/iu;
const PHONE_INTENT_GLOBAL_REGEX = /(?:sđt|sdt|số\s*(?:điện\s*thoại|dt)|điện\s*thoại|phone|liên\s*hệ|zalo)/giu;
const VIETNAM_MOBILE_NATIONAL = /^(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-46-9])\d{7}$/;
const VIETNAM_LANDLINE_NATIONAL = /^2\d{8,9}$/;

export type InboundPhoneStatus = 'NONE' | 'VALID' | 'INVALID' | 'AMBIGUOUS';

export interface FacebookInboundPhonePrivacy {
    phone: string | null;
    status: InboundPhoneStatus;
    validPhones: string[];
    invalidCandidates: string[];
    safeContent: string | null;
    safeStatus: 'SUCCEEDED' | 'FAILED';
}

function compactCandidate(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\s()./_,:\-]/g, '');
}

function isCalendarValue(value: string): boolean {
    const candidate = value.trim();
    const date = candidate.match(
        /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/,
    );
    if (!date) return false;
    const [, day, month, year, hour = '0', minute = '0'] = date;
    const parsed = new Date(Date.UTC(+year, +month - 1, +day));
    return (
        +year >= 1900 &&
        +year <= 2100 &&
        parsed.getUTCMonth() === +month - 1 &&
        parsed.getUTCDate() === +day &&
        +hour < 24 &&
        +minute < 60
    );
}

export function normalizeVietnamesePhoneCandidate(value: string): string | null {
    if (!value || typeof value !== 'string' || isCalendarValue(value)) return null;

    let compact = compactCandidate(value);
    if (!compact) return null;

    if (compact.startsWith('0084')) {
        compact = `+84${compact.slice(4)}`;
    } else if (compact.startsWith('84')) {
        compact = `+${compact}`;
    } else if (compact.startsWith('0')) {
        compact = `+84${compact.slice(1)}`;
    }

    if (!compact.startsWith('+84')) return null;

    const national = compact.slice(3);
    if (
        !VIETNAM_MOBILE_NATIONAL.test(national) &&
        !VIETNAM_LANDLINE_NATIONAL.test(national)
    ) {
        return null;
    }

    return `+84${national}`;
}

function looksLikePhoneIntent(
    candidate: string,
    messageHasPhoneIntent: boolean,
): boolean {
    if (isCalendarValue(candidate)) return false;
    if (messageHasPhoneIntent) return true;
    const compact = compactCandidate(candidate);
    return /^(?:0|84|\+84|0084)/.test(compact);
}

function classifyCandidates(content: string) {
    const normalized = content
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '');
    const hasPhoneIntent = PHONE_INTENT_REGEX.test(normalized);
    const matches = normalized.match(new RegExp(PHONE_CANDIDATE_SOURCE, 'g')) || [];
    const validPhones = new Set<string>();
    const invalidCandidates = new Set<string>();

    for (const candidate of matches) {
        const phone = normalizeVietnamesePhoneCandidate(candidate);
        if (phone) {
            validPhones.add(phone);
        } else if (looksLikePhoneIntent(candidate, hasPhoneIntent)) {
            invalidCandidates.add(candidate.trim());
        }
    }

    const valid = [...validPhones];
    const invalid = [...invalidCandidates];
    const status: InboundPhoneStatus =
        valid.length > 1
            ? 'AMBIGUOUS'
            : valid.length === 1
              ? 'VALID'
              : invalid.length > 0
                ? 'INVALID'
                : 'NONE';

    return { valid, invalid, status };
}

function numberToken(index: number): string {
    return `INVALIDNUMBERTOKEN${String.fromCharCode(65 + (index % 26))}${'Q'.repeat(Math.floor(index / 26) + 1)}`;
}

function labelToken(index: number): string {
    return `CONTACTLABELTOKEN${String.fromCharCode(65 + (index % 26))}${'R'.repeat(Math.floor(index / 26) + 1)}`;
}

function sanitizePreservingInvalidPhones(
    content: string,
    validPhones: Set<string>,
): { content: string | null; status: 'SUCCEEDED' | 'FAILED' } {
    const normalized = content
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '');
    const protectedValues: string[] = [];
    const protectedLabels: string[] = [];

    // Core sanitizer historically redacts every long number and every explicit contact field.
    // Protect non-phone numeric values and the contact label first so invalid phone attempts,
    // prices, dates and codes remain visible to Sale/AI. Valid phones are removed up front.
    const preparedNumbers = normalized.replace(
        new RegExp(PHONE_CANDIDATE_SOURCE, 'g'),
        (candidate) => {
            const phone = normalizeVietnamesePhoneCandidate(candidate);
            if (phone && validPhones.has(phone)) {
                return '[số điện thoại đã ẩn]';
            }
            const token = numberToken(protectedValues.length);
            protectedValues.push(candidate);
            return token;
        },
    );

    const prepared = preparedNumbers.replace(PHONE_INTENT_GLOBAL_REGEX, (label) => {
        const token = labelToken(protectedLabels.length);
        protectedLabels.push(label);
        return token;
    });

    const safe = sanitize(prepared);
    if (safe.status !== 'SUCCEEDED' || safe.content === null) return safe;

    let restored = safe.content;
    protectedValues.forEach((value, index) => {
        restored = restored.replace(numberToken(index), value);
    });
    protectedLabels.forEach((value, index) => {
        restored = restored.replace(labelToken(index), value);
    });

    return { content: restored, status: 'SUCCEEDED' };
}

/**
 * Facebook intake policy:
 * - exactly one structurally valid Vietnamese phone => normalize to E.164 for private CRM storage;
 * - valid phone is removed from the public/sale chat text;
 * - invalid phone-like number stays visible and receives a system note so Sale/AI can ask again;
 * - multiple valid numbers are all hidden but none is auto-selected for CRM.
 *
 * A structurally valid number is still stored as UNVERIFIED by han_ingest; this function does
 * not claim that the SIM is active or owned by the sender.
 */
export function processFacebookInboundPhonePrivacy(
    content: string,
): FacebookInboundPhonePrivacy {
    if (content.length > 10000) {
        return {
            phone: null,
            status: 'NONE',
            validPhones: [],
            invalidCandidates: [],
            safeContent: null,
            safeStatus: 'FAILED',
        };
    }

    const { valid, invalid, status } = classifyCandidates(content);
    const safe = sanitizePreservingInvalidPhones(content, new Set(valid));

    let safeContent = safe.content;
    if (safe.status === 'SUCCEEDED' && safeContent !== null) {
        if (status === 'INVALID') {
            safeContent += '\n[Hệ thống: Số điện thoại khách cung cấp chưa hợp lệ. Vui lòng xin lại số đúng.]';
        } else if (status === 'AMBIGUOUS') {
            safeContent += '\n[Hệ thống: Khách cung cấp nhiều số điện thoại. Vui lòng xác nhận số cần lưu.]';
        } else if (status === 'VALID' && invalid.length > 0) {
            safeContent += '\n[Hệ thống: Đã ghi nhận một số hợp lệ; vẫn có chuỗi số khác chưa hợp lệ trong tin nhắn.]';
        }
    }

    return {
        phone: valid.length === 1 ? valid[0] : null,
        status,
        validPhones: valid,
        invalidCandidates: invalid,
        safeContent,
        safeStatus: safe.status,
    };
}
