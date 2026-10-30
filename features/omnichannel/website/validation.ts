import {
    ChannelError,
    normalizePhone,
    object,
    text,
    uuid,
} from '../facebook/core';

export type WebsiteLead = {
    requestId: string;
    name: string;
    phone: string;
    need: string;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmContent?: string | null;
    utmTerm?: string | null;
    fbclid?: string | null;
};

function optionalBoundedText(value: unknown, max: number): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.trim().slice(0, max);
}

export function validateLead(value: unknown): WebsiteLead {
    const input = object(value);

    // Trường ẩn chống bot phải để trống.
    if (input.website !== undefined && input.website !== '') {
        throw new ChannelError('INVALID_INPUT');
    }

    // Người dùng phải đồng ý cho phép liên hệ tư vấn.
    if (input.consent !== true) {
        throw new ChannelError('CONSENT_REQUIRED');
    }

    return {
        requestId: uuid(input.request_id),
        name: text(input.name, 100, 2),
        phone: normalizePhone(text(input.phone, 40)),
        need: text(input.need, 2000, 5),
        utmSource: optionalBoundedText(input.utm_source, 100),
        utmMedium: optionalBoundedText(input.utm_medium, 100),
        utmCampaign: optionalBoundedText(input.utm_campaign, 100),
        utmContent: optionalBoundedText(input.utm_content, 100),
        utmTerm: optionalBoundedText(input.utm_term, 100),
        fbclid: optionalBoundedText(input.fbclid, 250),
    };
}