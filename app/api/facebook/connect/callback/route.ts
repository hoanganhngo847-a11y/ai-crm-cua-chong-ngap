import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import {
  exchangeCodeForUserAccessToken,
  listManagedFacebookPages,
  storeFacebookConnectSession,
  verifyAndClearFacebookOAuthState,
} from '@/features/omnichannel/facebook/connect';

export const runtime = 'nodejs';

function back(request: Request, code: string) {
  const url = new URL('/admin/facebook', request.url);
  url.searchParams.set('error', code);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId) return back(request, 'NO_COMPANY');
    await requireBossAdmin(actor.companyId, { requireAal2: true });

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

    const userAccessToken = await exchangeCodeForUserAccessToken(code);
    const pages = await listManagedFacebookPages(userAccessToken);

    await storeFacebookConnectSession({
      userAccessToken,
      pages,
      companyId: actor.companyId,
      userId: actor.userId,
    });

    const url = new URL('/admin/facebook', request.url);
    url.searchParams.set('step', 'select');
    return NextResponse.redirect(url);
  } catch {
    return back(request, 'FACEBOOK_CONNECT_CALLBACK_FAILED');
  }
}
