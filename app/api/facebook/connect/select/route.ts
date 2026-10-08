import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import {
  clearFacebookConnectSession,
  readFacebookConnectSession,
  subscribeManagedPage,
} from '@/features/omnichannel/facebook/connect';

export const runtime = 'nodejs';

function back(request: Request, code: string) {
  const url = new URL('/admin/facebook', request.url);
  url.searchParams.set('error', code);
  return NextResponse.redirect(url);
}

export async function POST(request: Request) {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId) return back(request, 'NO_COMPANY');
    await requireBossAdmin(actor.companyId, { requireAal2: true });

    const session = await readFacebookConnectSession();
    if (
      !session ||
      session.companyId !== actor.companyId ||
      session.userId !== actor.userId
    ) {
      return back(request, 'FACEBOOK_CONNECT_SESSION_EXPIRED');
    }

    const form = await request.formData();
    const pageId = String(form.get('page_id') || '').trim();
    if (!/^\d+$/.test(pageId)) return back(request, 'INVALID_PAGE');
    if (!session.pages.some((page) => page.id === pageId)) {
      return back(request, 'FACEBOOK_PAGE_NOT_MANAGED');
    }

    const page = await subscribeManagedPage(session.userAccessToken, pageId);
    await clearFacebookConnectSession();

    const url = new URL('/admin/facebook', request.url);
    url.searchParams.set('connected', '1');
    url.searchParams.set('page', page.name);
    return NextResponse.redirect(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const allowed = new Set([
      'FACEBOOK_PAGE_NOT_ALLOWED_FOR_WORKSPACE',
      'FACEBOOK_PAGE_NOT_MANAGED',
      'FACEBOOK_SUBSCRIBE_FAILED',
    ]);
    return back(
      request,
      allowed.has(message) ? message : 'FACEBOOK_CONNECT_SELECT_FAILED',
    );
  }
}
