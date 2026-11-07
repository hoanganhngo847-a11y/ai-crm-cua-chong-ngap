import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import {
  createFacebookOAuthState,
  facebookOAuthConfig,
  storeFacebookOAuthState,
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
    await requireBossAdmin(actor.companyId, {
      requireAal2: true,
    });

    const config = facebookOAuthConfig();
    const state = createFacebookOAuthState();
    await storeFacebookOAuthState(state, { companyId: actor.companyId, userId: actor.userId });

    const url = new URL(
      `https://www.facebook.com/${config.graphVersion}/dialog/oauth`,
    );
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      'pages_show_list,pages_manage_metadata,pages_read_engagement,ads_read,leads_retrieval',
    );
    if (config.loginConfigId) {
      url.searchParams.set('config_id', config.loginConfigId);
    }

    return NextResponse.redirect(url);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'FACEBOOK_CONNECT_START_FAILED';
    return back(request, code);
  }
}
