import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeVietnamesePhoneCandidate } from './phone-intake';

/**
 * A Messenger lead form arrives as a normal customer text message, but it is
 * pre-filled by Meta. The AI must stay silent for these messages and the CRM
 * should keep the submitted data instead of treating it as a chat turn.
 *
 * Detection is intentionally conservative: three recognised field labels, or
 * one recognised field next to an explicit "form submitted" phrase.
 */
export type LeadFormFieldKey =
    | 'phone'
    | 'email'
    | 'full_name'
    | 'date_of_birth'
    | 'city'
    | 'gpa'
    | 'address'
    | 'country'
    | 'school'
    | 'graduation_year'
    | 'major'
    | 'english_level'
    | 'budget'
    | 'note';

export interface LeadFormField {
    key: LeadFormFieldKey | null;
    label: string;
    value: string;
}

export interface LeadFormDetection {
    fields: LeadFormField[];
    knownKeys: LeadFormFieldKey[];
    hasIntro: boolean;
    phone: string | null;
    email: string | null;
    fullName: string | null;
    dateOfBirth: string | null;
    birthYear: number | null;
    city: string | null;
    address: string | null;
    gpa: string | null;
}

export interface PersistLeadFormInput {
    companyId: string;
    sourceInteractionId: string;
    form: LeadFormDetection;
}

export interface PersistLeadFormResult {
    status: 'CREATED' | 'EXISTING' | 'SKIPPED';
    noteInteractionId: string | null;
    profileUpdated: boolean;
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the interaction id returned by han_ingest without trusting its shape. */
export function readIngestedInteractionId(result: unknown): string | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }

    const id = (result as Record<string, unknown>).interaction_id;
    return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
}

const FIELD_DEFINITIONS: Array<{
    key: LeadFormFieldKey;
    labels: string[];
}> = [
    {
        key: 'phone',
        labels: [
            'phone number',
            'phone',
            'mobile number',
            'mobile',
            'so dien thoai',
            'so dien thoai lien he',
            'so dt',
            'sdt',
            'dien thoai',
        ],
    },
    {
        key: 'email',
        labels: ['email', 'e mail', 'email address', 'dia chi email'],
    },
    {
        key: 'full_name',
        labels: [
            'full name',
            'fullname',
            'name',
            'ho va ten',
            'ho ten',
            'ten day du',
        ],
    },
    {
        key: 'date_of_birth',
        labels: [
            'date of birth',
            'dob',
            'birth date',
            'birthday',
            'birth year',
            'year of birth',
            'ngay sinh',
            'sinh nhat',
            'nam sinh',
        ],
    },
    {
        key: 'city',
        labels: ['city', 'thanh pho', 'tinh thanh', 'tinh thanh pho'],
    },
    {
        key: 'gpa',
        labels: ['gpa', 'diem gpa', 'diem trung binh'],
    },
    {
        key: 'address',
        labels: ['address', 'dia chi'],
    },
    {
        key: 'country',
        labels: ['country', 'quoc gia'],
    },
    {
        key: 'school',
        labels: ['school', 'truong', 'truong hoc'],
    },
    {
        key: 'graduation_year',
        labels: [
            'graduation year',
            'year of graduation',
            'nam tot nghiep',
        ],
    },
    {
        key: 'major',
        labels: ['intended major', 'major', 'nganh hoc', 'nganh'],
    },
    {
        key: 'english_level',
        labels: [
            'english level',
            'trinh do tieng anh',
            'ielts',
            'toefl',
        ],
    },
    {
        key: 'budget',
        labels: ['budget', 'ngan sach'],
    },
    {
        key: 'note',
        labels: ['note', 'notes', 'ghi chu'],
    },
];

type PhoneRedaction = 'none' | 'vn' | 'aggressive';

const NOTE_FIELD_ORDER: Array<{
    key: LeadFormFieldKey;
    label: string;
    redactPhone: PhoneRedaction;
}> = [
    { key: 'full_name', label: 'Họ tên', redactPhone: 'aggressive' },
    { key: 'date_of_birth', label: 'Ngày sinh', redactPhone: 'vn' },
    { key: 'email', label: 'Email', redactPhone: 'aggressive' },
    { key: 'phone', label: 'SĐT', redactPhone: 'none' },
    { key: 'city', label: 'Thành phố', redactPhone: 'aggressive' },
    { key: 'address', label: 'Địa chỉ', redactPhone: 'aggressive' },
    { key: 'gpa', label: 'GPA', redactPhone: 'vn' },
    { key: 'school', label: 'Trường', redactPhone: 'aggressive' },
    { key: 'major', label: 'Ngành', redactPhone: 'aggressive' },
    { key: 'graduation_year', label: 'Năm tốt nghiệp', redactPhone: 'vn' },
    { key: 'english_level', label: 'Trình độ tiếng Anh', redactPhone: 'aggressive' },
    { key: 'budget', label: 'Ngân sách', redactPhone: 'vn' },
    { key: 'country', label: 'Quốc gia', redactPhone: 'aggressive' },
    { key: 'note', label: 'Ghi chú', redactPhone: 'aggressive' },
];

const PHONE_LIKE_GLOBAL = /(?:\+|00)?\d(?:[\s()./_,:\-]*\d){6,}/g;
const VIETNAMESE_PHONE_GLOBAL =
    /(?:\+?84|0)(?:(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-46-9])(?:[.\-\s]?\d){7}|2(?:[.\-\s]?\d){8,9})\b/g;

const LEAD_FORM_INTRO =
    /(?:da dien (?:mau|form)|dien (?:mau|form)|hoan thanh (?:bieu )?mau|bieu mau da (?:duoc )?dien|form da (?:duoc )?dien|gui form|form (?:submitted|completed)|submitted (?:a |the )?(?:lead )?form|completed (?:a |the )?(?:lead )?form|lead form|form response)/;

function normalizeLabel(value: string): string {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/đ/g, 'd')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const LABEL_TO_KEY = new Map<string, LeadFormFieldKey>();
for (const definition of FIELD_DEFINITIONS) {
    for (const label of definition.labels) {
        LABEL_TO_KEY.set(normalizeLabel(label), definition.key);
    }
}

function labelKey(value: string): LeadFormFieldKey | null {
    const normalized = normalizeLabel(value);
    const direct = LABEL_TO_KEY.get(normalized);
    if (direct) return direct;

    return (
        LABEL_TO_KEY.get(
            normalized.replace(
                /\s+(?:required|optional|bat buoc|khong bat buoc)$/,
                '',
            ),
        ) ?? null
    );
}

function parseLeadFormFields(content: string): LeadFormField[] {
    const lines = content
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .split('\n');
    const fields: LeadFormField[] = [];
    let pendingLabel: string | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const withoutBullet = line
            .replace(/^[\s•·*\-–—]+/, '')
            .trim();
        if (!withoutBullet) continue;

        if (pendingLabel) {
            const pendingKey = labelKey(pendingLabel);
            const looksLikeLabel =
                /^.{1,80}?\s*[:：]/.test(withoutBullet) ||
                labelKey(withoutBullet) !== null;

            if (!looksLikeLabel) {
                if (pendingKey) {
                    fields.push({
                        key: pendingKey,
                        label: pendingLabel,
                        value: withoutBullet,
                    });
                }
                pendingLabel = null;
                continue;
            }

            pendingLabel = null;
        }

        const colonMatch = withoutBullet.match(/^(.{1,80}?)\s*[:：]\s*(.*)$/);
        if (colonMatch) {
            const label = colonMatch[1].trim();
            const value = colonMatch[2].trim();
            const key = labelKey(label);

            if (value) {
                fields.push({ key, label, value });
            } else if (key) {
                pendingLabel = label;
            }
            continue;
        }

        // Some form renderers use a dash between the label and the value.
        const dashMatch = withoutBullet.match(/^(.{1,80}?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
            const label = dashMatch[1].trim();
            const key = labelKey(label);
            if (key) {
                fields.push({ key, label, value: dashMatch[2].trim() });
                continue;
            }
        }

        const key = labelKey(withoutBullet);
        if (key) pendingLabel = withoutBullet;
    }

    return fields;
}

function normalizeLeadFormPhone(value: string): string | null {
    if (!value) return null;

    const candidate =
        value.match(/(?:\+|00)?\d(?:[\s()./_,:\-]*\d){6,}/)?.[0] ?? value;
    const vietnamese = normalizeVietnamesePhoneCandidate(candidate);
    if (vietnamese) return vietnamese;

    let compact = candidate
        .normalize('NFKC')
        .replace(/[\s()./_,:\-]/g, '');

    if (compact.startsWith('00')) {
        compact = `+${compact.slice(2)}`;
    }
    if (/^0\d{9,10}$/.test(compact)) {
        compact = `+84${compact.slice(1)}`;
    }
    if (/^84\d{9,10}$/.test(compact)) {
        compact = `+${compact}`;
    }

    return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

function normalizeLeadFormEmail(value: string): string | null {
    const match = value.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
    if (!match) return null;

    const email = match[0].normalize('NFKC').trim().toLowerCase();
    return email.length <= 254 ? email : null;
}

function parseBirthYear(value: string): number | null {
    const years = value.match(/\b(?:19\d{2}|20\d{2})\b/g);
    if (!years?.length) return null;

    const year = Number(years[0]);
    const currentYear = new Date().getUTCFullYear();
    return year >= 1900 && year <= currentYear ? year : null;
}

function sanitizeFormValue(
    value: string,
    options: { max?: number; redactPhone?: PhoneRedaction } = {},
): string {
    let text = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) return '';

    if (options.redactPhone === 'aggressive') {
        text = text.replace(PHONE_LIKE_GLOBAL, '[số liên hệ đã ẩn]');
    } else if (options.redactPhone === 'vn') {
        text = text.replace(VIETNAMESE_PHONE_GLOBAL, '[số liên hệ đã ẩn]');
    }

    if (
        /(?:password|mật\s*khẩu|mat\s*khau|pwd|otp|mã\s*xác\s*(?:thực|nhận)|ma\s*xac\s*(?:thuc|nhan)|verification\s*code|bearer\s+[A-Za-z0-9._~+/-]{20,}|(?:sk|ghp|xoxb|xoxp)-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/i.test(
            text,
        ) ||
        /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b/.test(text)
    ) {
        return '';
    }

    return text.slice(0, options.max ?? 500);
}

export function detectLeadForm(content: string): LeadFormDetection | null {
    if (!content || typeof content !== 'string' || content.length > 10000) {
        return null;
    }

    const fields = parseLeadFormFields(content);
    if (!fields.length) return null;

    const knownKeys = [
        ...new Set(
            fields
                .map((field) => field.key)
                .filter((key): key is LeadFormFieldKey => key !== null),
        ),
    ];
    const hasIntro = LEAD_FORM_INTRO.test(normalizeLabel(content));

    if (knownKeys.length < 3 && !(hasIntro && knownKeys.length >= 1)) {
        return null;
    }

    const byKey = new Map<LeadFormFieldKey, string>();
    for (const field of fields) {
        if (field.key && !byKey.has(field.key)) {
            byKey.set(field.key, field.value);
        }
    }

    const phoneField = byKey.get('phone');
    const emailField = byKey.get('email');
    const dateOfBirth = byKey.get('date_of_birth') ?? null;

    return {
        fields,
        knownKeys,
        hasIntro,
        phone: phoneField ? normalizeLeadFormPhone(phoneField) : null,
        email: emailField ? normalizeLeadFormEmail(emailField) : null,
        fullName: byKey.get('full_name') ?? null,
        dateOfBirth,
        birthYear: dateOfBirth ? parseBirthYear(dateOfBirth) : null,
        city: byKey.get('city') ?? null,
        address: byKey.get('address') ?? null,
        gpa: byKey.get('gpa') ?? null,
    };
}

export function formatLeadFormNote(form: LeadFormDetection): string {
    const lines: string[] = ['[Biểu mẫu khách điền]'];
    const byKey = new Map<LeadFormFieldKey, string>();

    for (const field of form.fields) {
        if (field.key && !byKey.has(field.key)) {
            byKey.set(field.key, field.value);
        }
    }

    for (const definition of NOTE_FIELD_ORDER) {
        if (definition.key === 'phone') {
            if (!byKey.has('phone')) continue;
            lines.push(
                form.phone
                    ? 'SĐT: đã tiếp nhận, kiểm tra tại liên hệ riêng (chưa xác minh)'
                    : 'SĐT: chưa hợp lệ, cần xin lại',
            );
            continue;
        }

        const value = byKey.get(definition.key);
        if (!value) continue;

        const safe = sanitizeFormValue(value, {
            redactPhone: definition.redactPhone,
        });
        if (safe) lines.push(`${definition.label}: ${safe}`);
    }

    const knownKeys = new Set(NOTE_FIELD_ORDER.map((item) => item.key));
    for (const field of form.fields) {
        if (field.key !== null && knownKeys.has(field.key)) continue;

        const label = sanitizeFormValue(field.label, {
            max: 80,
            redactPhone: 'aggressive',
        });
        const value = sanitizeFormValue(field.value, {
            redactPhone: 'aggressive',
        });
        if (label && value) lines.push(`${label}: ${value}`);
    }

    return lines.join('\n').slice(0, 2000);
}

function isDuplicateError(
    error: { code?: string; message?: string } | null,
): boolean {
    return (
        error?.code === '23505' ||
        /duplicate key|unique constraint/i.test(error?.message ?? '')
    );
}

/**
 * Persist a detected lead form as one idempotent Customer 360 note. The phone
 * itself is never copied into the note; it is stored in private contacts by
 * han_ingest. Dossier fields are only filled when they are still empty.
 */
export async function persistLeadFormToCustomer360(
    client: SupabaseClient,
    input: PersistLeadFormInput,
): Promise<PersistLeadFormResult> {
    const { data: source, error: sourceError } = await client
        .from('interactions')
        .select('customer_id,conversation_id,created_at')
        .eq('company_id', input.companyId)
        .eq('id', input.sourceInteractionId)
        .maybeSingle();

    if (sourceError) {
        throw new Error('LEAD_FORM_SOURCE_LOOKUP_FAILED');
    }

    const customerId = source?.customer_id as string | undefined;
    if (!customerId) {
        return {
            status: 'SKIPPED',
            noteInteractionId: null,
            profileUpdated: false,
        };
    }

    const occurredAt =
        typeof source?.created_at === 'string' &&
        Number.isFinite(Date.parse(source.created_at))
            ? new Date(source.created_at).toISOString()
            : new Date().toISOString();
    const externalRef = `lead-form:${input.sourceInteractionId}`;
    const note = formatLeadFormNote(input.form);

    const { data: existing, error: existingError } = await client
        .from('interactions')
        .select('id')
        .eq('company_id', input.companyId)
        .eq('channel', 'FACEBOOK')
        .eq('external_ref', externalRef)
        .maybeSingle();

    if (existingError) {
        throw new Error('LEAD_FORM_NOTE_LOOKUP_FAILED');
    }

    let noteInteractionId = (existing?.id as string | undefined) ?? null;
    let status: 'CREATED' | 'EXISTING' = noteInteractionId
        ? 'EXISTING'
        : 'CREATED';

    if (!noteInteractionId) {
        const { data: inserted, error: insertError } = await client
            .from('interactions')
            .insert({
                company_id: input.companyId,
                customer_id: customerId,
                conversation_id: source?.conversation_id ?? null,
                channel: 'FACEBOOK',
                type: 'NOTE',
                direction: 'OUTBOUND',
                sanitized_content: note,
                sanitization_status: 'SUCCEEDED',
                sanitized_at: new Date().toISOString(),
                sanitizer_version: 'lead-form-v1',
                external_ref: externalRef,
                actor_type: 'SYSTEM',
                created_at: occurredAt,
            })
            .select('id')
            .single();

        if (insertError) {
            if (!isDuplicateError(insertError)) {
                throw new Error('LEAD_FORM_NOTE_INSERT_FAILED');
            }

            status = 'EXISTING';
            const { data: duplicate } = await client
                .from('interactions')
                .select('id')
                .eq('company_id', input.companyId)
                .eq('channel', 'FACEBOOK')
                .eq('external_ref', externalRef)
                .maybeSingle();
            noteInteractionId = (duplicate?.id as string | undefined) ?? null;
        } else {
            noteInteractionId = (inserted?.id as string | undefined) ?? null;
        }
    }

    const desiredProfileFields: Array<{
        field: 'birth_year' | 'address';
        value: number | string;
    }> = [];

    if (input.form.birthYear) {
        desiredProfileFields.push({
            field: 'birth_year',
            value: input.form.birthYear,
        });
    }

    const address = input.form.address?.trim() || input.form.city?.trim() || '';
    if (address) {
        desiredProfileFields.push({
            field: 'address',
            value: address.slice(0, 1000),
        });
    }

    let profileUpdated = false;

    if (desiredProfileFields.length) {
        const { data: profile, error: profileError } = await client
            .from('customer_dossier_profiles')
            .select('birth_year,address')
            .eq('company_id', input.companyId)
            .eq('customer_id', customerId)
            .maybeSingle();

        if (profileError) {
            throw new Error('LEAD_FORM_PROFILE_LOOKUP_FAILED');
        }

        const now = new Date().toISOString();
        let insertedNewProfile = false;

        if (!profile) {
            const payload: Record<string, unknown> = {
                company_id: input.companyId,
                customer_id: customerId,
                updated_at: now,
            };
            for (const item of desiredProfileFields) {
                payload[item.field] = item.value;
            }

            const { error: insertError } = await client
                .from('customer_dossier_profiles')
                .insert(payload);

            if (!insertError) {
                insertedNewProfile = true;
                profileUpdated = true;
            } else if (!isDuplicateError(insertError)) {
                throw new Error('LEAD_FORM_PROFILE_INSERT_FAILED');
            }
        }

        if (!insertedNewProfile) {
            for (const item of desiredProfileFields) {
                const current = profile
                    ? (profile as Record<string, unknown>)[item.field]
                    : null;

                if (profile && current !== null && current !== '') continue;

                let query = client
                    .from('customer_dossier_profiles')
                    .update({ [item.field]: item.value, updated_at: now })
                    .eq('company_id', input.companyId)
                    .eq('customer_id', customerId);

                query =
                    current === ''
                        ? query.eq(item.field, '')
                        : query.is(item.field, null);

                const { data: rows, error: updateError } = await query.select(
                    'customer_id',
                );

                if (updateError) {
                    throw new Error('LEAD_FORM_PROFILE_UPDATE_FAILED');
                }
                if (Array.isArray(rows) && rows.length > 0) {
                    profileUpdated = true;
                }
            }
        }
    }

    return {
        status,
        noteInteractionId,
        profileUpdated,
    };
}
