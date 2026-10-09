import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { isMetaReviewerMfaExempt } from '@/lib/auth/meta-review';
import {
  createFacebookOAuthState,
  facebookOAuthConfig,
  storeFacebookOAuthState,
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

    const config = facebookOAuthConfig();
    const state = createFacebookOAuthState();
    await storeFacebookOAuthState(state);

    const url = new URL(
      `https://www.facebook.com/${config.graphVersion}/dialog/oauth`,
    );
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      'pages_show_list,pages_manage_metadata,pages_messaging',
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
