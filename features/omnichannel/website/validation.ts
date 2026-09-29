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
};

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
    };
}