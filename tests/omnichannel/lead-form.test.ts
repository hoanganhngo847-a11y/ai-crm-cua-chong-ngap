import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
    detectLeadForm,
    formatLeadFormNote,
    persistLeadFormToCustomer360,
    readIngestedInteractionId,
} from '../../features/omnichannel/facebook/lead-form';
import { processFacebookInboundPhonePrivacy } from '../../features/omnichannel/facebook/phone-intake';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const SOURCE_INTERACTION = '44444444-4444-4444-8444-444444444444';

const ENGLISH_FORM = [
    'Đã điền mẫu',
    'Phone number: 0912345678',
    'Date of birth: 15/05/2001',
    'Email: lan@example.com',
    'Full name: Lan Pham',
    'GPA: 8.5',
    'City: Hà Nội',
].join('\n');

const VIETNAMESE_FORM = [
    'Họ và tên: Nguyễn Văn A',
    'Số điện thoại: 0987 654 321',
    'Ngày sinh: 02/03/1999',
    'Thành phố: Đà Nẵng',
].join('\n');

type Row = Record<string, unknown>;

function pick(row: Row, fields: string): Row {
    if (!fields || fields === '*') return { ...row };
    const selected: Row = {};
    for (const field of fields.split(',').map((value) => value.trim())) {
        selected[field] = row[field];
    }
    return selected;
}

function createMockSupabase(initial: {
    interactions?: Row[];
    profiles?: Row[];
} = {}) {
    const interactions: Row[] = [...(initial.interactions ?? [])];
    const profiles: Row[] = [...(initial.profiles ?? [])];
    let sequence = 0;

    const client = {
        from(table: string) {
            const filters: Array<{
                kind: 'eq' | 'is';
                column: string;
                value: unknown;
            }> = [];
            let operation: 'select' | 'insert' | 'update' = 'select';
            let payload: Row = {};
            let selectedFields = '';

            const rows = () => (table === 'interactions' ? interactions : profiles);
            const matches = (row: Row) =>
                filters.every((filter) =>
                    filter.kind === 'eq'
                        ? row[filter.column] === filter.value
                        : row[filter.column] === null ||
                          row[filter.column] === undefined,
                );

            const execute = () => {
                if (operation === 'select') {
                    return {
                        data: rows().filter(matches).map((row) => pick(row, selectedFields)),
                        error: null,
                    };
                }

                if (operation === 'insert') {
                    if (
                        table === 'interactions' &&
                        typeof payload.external_ref === 'string' &&
                        rows().some(
                            (row) =>
                                row.company_id === payload.company_id &&
                                row.channel === payload.channel &&
                                row.external_ref === payload.external_ref,
                        )
                    ) {
                        return {
                            data: null,
                            error: {
                                code: '23505',
                                message:
                                    'duplicate key value violates unique constraint "uq_interactions_company_channel_ext_ref"',
                            },
                        };
                    }

                    const inserted = {
                        id: `note-${++sequence}`,
                        ...payload,
                    };
                    rows().push(inserted);
                    return {
                        data: selectedFields ? pick(inserted, selectedFields) : null,
                        error: null,
                    };
                }

                const updated: Row[] = [];
                for (const row of rows()) {
                    if (!matches(row)) continue;
                    Object.assign(row, payload);
                    updated.push(row);
                }

                return {
                    data: selectedFields
                        ? updated.map((row) => pick(row, selectedFields))
                        : null,
                    error: null,
                };
            };

            const builder: Record<string, unknown> = {
                select(fields: string) {
                    selectedFields = fields;
                    return builder;
                },
                insert(values: Row) {
                    operation = 'insert';
                    payload = values;
                    return builder;
                },
                update(values: Row) {
                    operation = 'update';
                    payload = values;
                    return builder;
                },
                eq(column: string, value: unknown) {
                    filters.push({ kind: 'eq', column, value });
                    return builder;
                },
                is(column: string, value: unknown) {
                    filters.push({ kind: 'is', column, value });
                    return builder;
                },
                async maybeSingle() {
                    const result = execute();
                    const first = Array.isArray(result.data)
                        ? (result.data[0] ?? null)
                        : result.data;
                    return { data: first, error: result.error };
                },
                async single() {
                    const result = execute();
                    return {
                        data: Array.isArray(result.data)
                            ? (result.data[0] ?? null)
                            : result.data,
                        error: result.error,
                    };
                },
                then(
                    onFulfilled?: (value: unknown) => unknown,
                    onRejected?: (reason: unknown) => unknown,
                ) {
                    return Promise.resolve(execute()).then(
                        onFulfilled,
                        onRejected,
                    );
                },
            };

            return builder;
        },
    };

    return Object.assign(client, {
        __interactions: interactions,
        __profiles: profiles,
    }) as unknown as SupabaseClient & {
        __interactions: Row[];
        __profiles: Row[];
    };
}

test('detectLeadForm parses a pre-filled Messenger lead form', () => {
    const form = detectLeadForm(ENGLISH_FORM);

    assert.ok(form);
    assert.equal(form.phone, '+84912345678');
    assert.equal(form.email, 'lan@example.com');
    assert.equal(form.fullName, 'Lan Pham');
    assert.equal(form.dateOfBirth, '15/05/2001');
    assert.equal(form.birthYear, 2001);
    assert.equal(form.city, 'Hà Nội');
    assert.equal(form.gpa, '8.5');
    assert.equal(form.hasIntro, true);
    assert.deepEqual(form.knownKeys, [
        'phone',
        'date_of_birth',
        'email',
        'full_name',
        'gpa',
        'city',
    ]);
});

test('detectLeadForm recognises Vietnamese field labels', () => {
    const form = detectLeadForm(VIETNAMESE_FORM);

    assert.ok(form);
    assert.equal(form.phone, '+84987654321');
    assert.equal(form.fullName, 'Nguyễn Văn A');
    assert.equal(form.birthYear, 1999);
    assert.equal(form.city, 'Đà Nẵng');
});

test('detectLeadForm tolerates required/optional suffixes on field labels', () => {
    const form = detectLeadForm(
        [
            'Phone number (required): 0912345678',
            'Email (optional): lan@example.com',
            'Full name: Lan Pham',
        ].join('\n'),
    );

    assert.ok(form);
    assert.equal(form.phone, '+84912345678');
    assert.equal(form.email, 'lan@example.com');
    assert.equal(form.fullName, 'Lan Pham');
});

test('detectLeadForm still recognises the form after phone and email sanitisation', () => {
    const privacy = processFacebookInboundPhonePrivacy(ENGLISH_FORM);
    assert.equal(privacy.safeStatus, 'SUCCEEDED');
    assert.ok(privacy.safeContent);
    assert.ok(!privacy.safeContent.includes('0912345678'));
    assert.ok(!privacy.safeContent.includes('lan@example.com'));

    const form = detectLeadForm(privacy.safeContent);

    assert.ok(form);
    assert.equal(form.phone, null);
    assert.equal(form.email, null);
    assert.equal(form.fullName, 'Lan Pham');
    assert.equal(form.birthYear, 2001);
    assert.equal(form.city, 'Hà Nội');
});

test('detectLeadForm stays conservative for ordinary chat messages', () => {
    assert.equal(
        detectLeadForm('Chào shop, mình muốn hỏi giá cửa chống ngập. SĐT 0912345678'),
        null,
    );
    assert.equal(
        detectLeadForm('Tên: Lan\nSĐT: 0912345678'),
        null,
    );
    assert.equal(
        detectLeadForm('Mình muốn tư vấn du học Đức, shop gọi lại giúp mình nhé.'),
        null,
    );
});

test('detectLeadForm accepts an explicit form intro with one known field', () => {
    const form = detectLeadForm('Mình đã điền mẫu\nEmail: lan@example.com');

    assert.ok(form);
    assert.equal(form.hasIntro, true);
    assert.equal(form.email, 'lan@example.com');
});

test('formatLeadFormNote never copies the phone number into the note', () => {
    const form = detectLeadForm(ENGLISH_FORM);
    assert.ok(form);

    const note = formatLeadFormNote(form);

    assert.ok(note.includes('SĐT: đã tiếp nhận, kiểm tra tại liên hệ riêng'));
    assert.ok(note.includes('Email: lan@example.com'));
    assert.ok(!note.includes('0912345678'));
    assert.ok(!note.includes('+84912345678'));
    assert.ok(!note.includes('84912345678'));
});

test('formatLeadFormNote redacts phone-like values from other fields without destroying dates or amounts', () => {
    const form = detectLeadForm(
        [
            'Phone number: 0912345678',
            'Date of birth: 15/05/2001',
            'Email: lan@example.com',
            'Full name: Lan Pham',
            'Budget: 10.000.000',
            'Note: Gọi lại 0987654321 nhé',
        ].join('\n'),
    );
    assert.ok(form);

    const note = formatLeadFormNote(form);

    assert.ok(!note.includes('0912345678'));
    assert.ok(!note.includes('0987654321'));
    assert.ok(note.includes('15/05/2001'));
    assert.ok(note.includes('10.000.000'));
});

test('persistLeadFormToCustomer360 creates one idempotent note and fills empty dossier fields', async () => {
    const client = createMockSupabase({
        interactions: [
            {
                id: SOURCE_INTERACTION,
                company_id: COMPANY,
                customer_id: CUSTOMER,
                conversation_id: CONVERSATION,
                created_at: '2026-10-29T10:00:00.000Z',
            },
        ],
    });
    const form = detectLeadForm(ENGLISH_FORM);
    assert.ok(form);

    const first = await persistLeadFormToCustomer360(client, {
        companyId: COMPANY,
        sourceInteractionId: SOURCE_INTERACTION,
        form,
    });
    const second = await persistLeadFormToCustomer360(client, {
        companyId: COMPANY,
        sourceInteractionId: SOURCE_INTERACTION,
        form,
    });

    assert.equal(first.status, 'CREATED');
    assert.equal(first.profileUpdated, true);
    assert.equal(second.status, 'EXISTING');
    assert.equal(second.noteInteractionId, first.noteInteractionId);

    const notes = client.__interactions.filter(
        (row) => row.external_ref === `lead-form:${SOURCE_INTERACTION}`,
    );
    assert.equal(notes.length, 1);
    assert.ok(!String(notes[0].sanitized_content).includes('0912345678'));
    assert.ok(!String(notes[0].sanitized_content).includes('84912345678'));

    const profile = client.__profiles.find(
        (row) => row.customer_id === CUSTOMER,
    );
    assert.ok(profile);
    assert.equal(profile.birth_year, 2001);
    assert.equal(profile.address, 'Hà Nội');
});

test('persistLeadFormToCustomer360 does not overwrite existing dossier values', async () => {
    const client = createMockSupabase({
        interactions: [
            {
                id: SOURCE_INTERACTION,
                company_id: COMPANY,
                customer_id: CUSTOMER,
                conversation_id: CONVERSATION,
                created_at: '2026-10-29T10:00:00.000Z',
            },
        ],
        profiles: [
            {
                company_id: COMPANY,
                customer_id: CUSTOMER,
                birth_year: 1990,
                address: 'Địa chỉ cũ',
            },
        ],
    });
    const form = detectLeadForm(ENGLISH_FORM);
    assert.ok(form);

    const result = await persistLeadFormToCustomer360(client, {
        companyId: COMPANY,
        sourceInteractionId: SOURCE_INTERACTION,
        form,
    });

    assert.equal(result.status, 'CREATED');
    assert.equal(result.profileUpdated, false);

    const profile = client.__profiles[0];
    assert.equal(profile.birth_year, 1990);
    assert.equal(profile.address, 'Địa chỉ cũ');
});

test('readIngestedInteractionId only accepts canonical UUID values', () => {
    assert.equal(
        readIngestedInteractionId({ status: 'ACCEPTED', interaction_id: SOURCE_INTERACTION }),
        SOURCE_INTERACTION,
    );
    assert.equal(readIngestedInteractionId({ interaction_id: 'not-a-uuid' }), null);
    assert.equal(readIngestedInteractionId(null), null);
    assert.equal(readIngestedInteractionId('nope'), null);
});
