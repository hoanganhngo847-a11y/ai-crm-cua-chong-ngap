import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { isMetaReviewerMfaExempt } from '@/lib/auth/meta-review';
import {
  exchangeCodeForUserAccessToken,
  listManagedAdAccounts,
  listManagedFacebookPages,
  storeFacebookConnectSession,
  verifyAndClearFacebookOAuthState,
} from '@/features/omnichannel/facebook/connect';

export const runtime = 'nodejs';

function publicAdminUrl(request: Request) {
  const configuredOrigin = process.env.WEBSITE_ORIGIN?.trim();
  if (configuredOrigin) {
    return new URL('/admin/facebook', configuredOrigin);
  }

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const host = forwardedHost || request.headers.get('host');
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();
  const protocol = forwardedProto || 'https';

  return host
    ? new URL('/admin/facebook', `${protocol}://${host}`)
    : new URL('/admin/facebook', request.url);
}

function back(request: Request, code: string) {
  const url = publicAdminUrl(request);
  url.searchParams.set('error', code);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId) return back(request, 'NO_COMPANY');
    await requireBossAdmin(actor.companyId, {
      requireAal2: !isMetaReviewerMfaExempt(actor.userId),
    });

    const query = new URL(request.url).searchParams;
    const providerError = query.get('error');
    if (providerError) {
      return back(
        request,
        query.get('error_reason') || 'FACEBOOK_AUTH_CANCELLED',
      );
    }

    const state = query.get('state') || '';
    const validState = await verifyAndClearFacebookOAuthState(state);
    if (!validState) return back(request, 'FACEBOOK_INVALID_STATE');

    const code = query.get('code');
    if (!code) return back(request, 'FACEBOOK_MISSING_CODE');

    const tokenResult = await exchangeCodeForUserAccessToken(code);
    const userAccessToken = tokenResult.accessToken;
    const [pages, adAccounts] = await Promise.all([
      listManagedFacebookPages(userAccessToken),
      listManagedAdAccounts(userAccessToken),
    ]);

    await storeFacebookConnectSession({
      userAccessToken,
      tokenExpiresAt: tokenResult.tokenExpiresAt,
      pages,
      adAccounts,
      companyId: actor.companyId,
      userId: actor.userId,
    });

    const url = publicAdminUrl(request);
    url.searchParams.set('step', 'select');
    return NextResponse.redirect(url);
  } catch (error) {
    const code =
      error instanceof Error && error.message.startsWith('FACEBOOK_')
        ? error.message
        : 'FACEBOOK_CONNECT_CALLBACK_FAILED';
    console.error('[meta-connect] callback_failed', code);
    return back(request, code);
  }
}
