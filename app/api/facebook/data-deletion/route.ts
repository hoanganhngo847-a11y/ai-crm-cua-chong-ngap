import { createHash, randomBytes } from 'node:crypto';
import {
    ChannelError,
    parseSignedRequest,
} from '@/features/omnichannel/facebook/core';
import {
    env,
    errorResponse,
    rpc,
} from '@/features/omnichannel/facebook/server';

export const runtime = 'nodejs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveWebsiteOrigin(request: Request): string {
    const configured = process.env.WEBSITE_ORIGIN?.trim();
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwardedHost || request.headers.get('host');
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const protocol = forwardedProto || 'https';
    return host ? `${protocol}://${host}` : new URL(request.url).origin;
}

function resolveTargetCompany(): string {
    const configuredCompany = process.env.META_DATA_DELETION_COMPANY_ID?.trim();
    if (!configuredCompany || !UUID_REGEX.test(configuredCompany)) {
        throw new ChannelError('MISCONFIGURED_DELETION_TENANT', 503);
    }
    return configuredCompany;
}

export async function POST(request: Request) {
    try {
        const secret = env('META_APP_SECRET');
        const contentType = request.headers.get('content-type') || '';
        let signedRequest = '';

        if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            signedRequest = String(formData.get('signed_request') || '').trim();
        } else if (contentType.includes('application/json')) {
            const json = await request.json();
            signedRequest = String(json?.signed_request || '').trim();
        } else {
            const raw = await request.text();
            try {
                const parsed = JSON.parse(raw);
                signedRequest = String(parsed?.signed_request || '').trim();
            } catch {
                const params = new URLSearchParams(raw);
                signedRequest = String(params.get('signed_request') || '').trim();
            }
        }

        if (!signedRequest) {
            const url = new URL(request.url);
            signedRequest = url.searchParams.get('signed_request') || '';
        }

        if (!signedRequest) {
            throw new ChannelError('INVALID_SIGNED_REQUEST', 400);
        }

        const payload = parseSignedRequest(signedRequest, secret);
        const userId = String(payload.userId || payload.user_id || 'unknown');

        if (!userId || userId === 'unknown') {
            throw new ChannelError('INVALID_SIGNED_REQUEST', 400);
        }

        const companyId = resolveTargetCompany();
        const issuedAt = String(payload.issued_at ?? payload.issuedAt ?? '');
        const requestFingerprint = createHash('sha256')
            .update(`${companyId}:${userId}:${issuedAt}:${signedRequest}`)
            .digest('hex');

        const candidateConfirmationCode = `del_${randomBytes(16).toString('hex')}`;

        // Persist or retrieve the deletion request via atomic idempotent RPC
        const recorded = (await rpc('han_record_data_deletion_request', {
            p_company: companyId,
            p_meta_user_id: userId,
            p_confirmation_code: candidateConfirmationCode,
            p_raw: payload,
            p_request_fingerprint: requestFingerprint,
        })) as {
            confirmation_code?: string;
            status?: string;
            resolution_strategy?: string;
            customer_id?: string | null;
            created_at?: string;
            processed_at?: string | null;
        } | null;

        const activeConfirmationCode = recorded?.confirmation_code || candidateConfirmationCode;
        const origin = resolveWebsiteOrigin(request);
        const statusUrl = `${origin}/data-deletion?code=${activeConfirmationCode}`;

        return Response.json({
            url: statusUrl,
            confirmation_code: activeConfirmationCode,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const code = url.searchParams.get('code')?.trim();
        const origin = resolveWebsiteOrigin(request);

        if (!code) {
            return Response.redirect(`${origin}/data-deletion`, 302);
        }

        if (!/^del_[a-f0-9]{8,64}$/.test(code)) {
            return Response.json(
                { error: 'INVALID_CODE', message: 'Mã xác nhận không đúng định dạng.' },
                { status: 400 },
            );
        }

        const record = await rpc('han_get_data_deletion_status', {
            p_confirmation_code: code,
        });

        if (!record) {
            return Response.json(
                {
                    error: 'NOT_FOUND',
                    message: 'Không tìm thấy yêu cầu xóa dữ liệu với mã xác nhận này.',
                },
                { status: 404 },
            );
        }

        return Response.json({
            confirmation_code: record.confirmation_code,
            status: record.status,
            resolution_strategy: record.resolution_strategy,
            created_at: record.created_at,
            processed_at: record.processed_at,
            url: `${origin}/data-deletion?code=${encodeURIComponent(code)}`,
        });
    } catch (error) {
        return errorResponse(error);
    }
}
