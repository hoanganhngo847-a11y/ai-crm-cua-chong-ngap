import { NextResponse } from 'next/server';

import { isLeadAdsAdAccountAllowed } from '@/features/omnichannel/facebook/lead-ads-binding';
import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import {
  configuredLeadAdsPageIds,
  exchangeCodeForUserAccessToken,
  listManagedAdAccounts,
  listManagedFacebookPages,
  storeFacebookConnectSession,
  verifyAndClearFacebookOAuthState,
} from '@/features/omnichannel/facebook/lead-ads-connect';

export const runtime = 'nodejs';

function publicAdminUrl(request: Request) {
  return new URL('/admin/facebook/lead-ads', process.env.WEBSITE_ORIGIN?.trim() || request.url);
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
    const { companyId, userId } = actor;
    await requireBossAdmin(companyId, {
      requireAal2: true,
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
    const validState = await verifyAndClearFacebookOAuthState(state, { companyId, userId });
    if (!validState) return back(request, 'FACEBOOK_INVALID_STATE');

    const code = query.get('code');
    if (!code) return back(request, 'FACEBOOK_MISSING_CODE');

    const tokenResult = await exchangeCodeForUserAccessToken(code);
    const userAccessToken = tokenResult.accessToken;
    const [pages, adAccounts] = await Promise.all([
      listManagedFacebookPages(userAccessToken),
      listManagedAdAccounts(userAccessToken),
    ]);

    const allowedPages = configuredLeadAdsPageIds(companyId);
    await storeFacebookConnectSession({
      userAccessToken,
      tokenExpiresAt: tokenResult.tokenExpiresAt,
      tokenType: tokenResult.tokenType,
      isLongLived: tokenResult.isLongLived,
      pages: pages.filter(page => allowedPages.has(page.id)),
      adAccounts: adAccounts.filter(account => isLeadAdsAdAccountAllowed(companyId, account.id)),
      companyId,
      userId,
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
