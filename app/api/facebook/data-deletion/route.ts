import { createHash } from 'node:crypto';
import {
    ChannelError,
    parseSignedRequest,
} from '@/features/omnichannel/facebook/core';
import {
    env,
    errorResponse,
} from '@/features/omnichannel/facebook/server';

export const runtime = 'nodejs';

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

        const codeHash = createHash('sha256')
            .update(`${userId}:${Date.now()}:${secret}`)
            .digest('hex')
            .slice(0, 16);
        const confirmationCode = `del_${codeHash}`;

        const origin = resolveWebsiteOrigin(request);
        const statusUrl = `${origin}/data-deletion?code=${confirmationCode}`;

        return Response.json({
            url: statusUrl,
            confirmation_code: confirmationCode,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function GET(request: Request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const origin = resolveWebsiteOrigin(request);

    if (code) {
        return Response.json({
            confirmation_code: code,
            status: 'RECEIVED',
            message: 'Yêu cầu xóa dữ liệu đã được tiếp nhận và đang được xử lý theo quy định.',
            url: `${origin}/data-deletion?code=${encodeURIComponent(code)}`,
        });
    }

    return Response.redirect(`${origin}/data-deletion`, 302);
}
