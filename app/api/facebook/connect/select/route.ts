import { NextResponse } from 'next/server';

import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { isMetaReviewerMfaExempt } from '@/lib/auth/meta-review';
import {
  clearFacebookConnectSession,
  configuredFacebookPageIds,
  readFacebookConnectSession,
  subscribeManagedPage,
} from '@/features/omnichannel/facebook/connect';
import { encryptToken } from '@/features/omnichannel/facebook/token-vault';
import { syncCompanyMetaAds } from '@/features/omnichannel/facebook/marketing-sync';
import { createAdminClient } from '@/lib/supabase/admin';

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

export async function POST(request: Request) {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId) return back(request, 'NO_COMPANY');
    await requireBossAdmin(actor.companyId, {
      requireAal2: !isMetaReviewerMfaExempt(actor.userId),
    });

    const session = await readFacebookConnectSession();
    if (
      !session ||
      session.companyId !== actor.companyId ||
      session.userId !== actor.userId
    ) {
      return back(request, 'FACEBOOK_CONNECT_SESSION_EXPIRED');
    }

    const form = await request.formData();
    const requestedPageIds = Array.from(
      new Set(
        form
          .getAll('page_id')
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );

    const requestedAdAccountIds = Array.from(
      new Set(
        form
          .getAll('ad_account_id')
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );

    if (
      (requestedPageIds.length === 0 && requestedAdAccountIds.length === 0) ||
      requestedPageIds.length > 100 ||
      requestedPageIds.some((pageId) => !/^\d+$/.test(pageId))
    ) {
      return back(request, 'INVALID_PAGE');
    }

    const managedPageIds = new Set(session.pages.map((page) => page.id));
    if (requestedPageIds.some((pageId) => !managedPageIds.has(pageId))) {
      return back(request, 'FACEBOOK_PAGE_NOT_MANAGED');
    }

    const allowedPageIds = configuredFacebookPageIds(actor.companyId);
    if (requestedPageIds.some((pageId) => !allowedPageIds.has(pageId))) {
      return back(request, 'FACEBOOK_PAGE_NOT_ALLOWED_FOR_WORKSPACE');
    }

    const connectedPages: Array<{ id: string; name: string }> = [];
    for (const pageId of requestedPageIds) {
      connectedPages.push(
        await subscribeManagedPage(
          session.userAccessToken,
          pageId,
          actor.companyId,
        ),
      );
    }

    // Save and sync selected Ad Accounts
    let connectedAdAccountsCount = 0;
    if (requestedAdAccountIds.length > 0 && session.adAccounts) {
      const managedAccountsMap = new Map(session.adAccounts.map((a) => [a.id, a]));
      const encryptedToken = encryptToken(session.userAccessToken);
      const supabase = createAdminClient();

      const accountRows = requestedAdAccountIds
        .filter((id) => managedAccountsMap.has(id))
        .map((id) => {
          const acc = managedAccountsMap.get(id)!;
          return {
            company_id: actor.companyId,
            ad_account_id: acc.id,
            name: acc.name,
            currency: acc.currency,
            account_status: acc.accountStatus,
            access_token: encryptedToken,
            token_expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
            sync_status: 'PENDING',
            updated_at: new Date().toISOString(),
          };
        });

      if (accountRows.length > 0) {
        await supabase
          .from('meta_ad_accounts')
          .upsert(accountRows, { onConflict: 'company_id,ad_account_id' });
        connectedAdAccountsCount = accountRows.length;

        // Trigger background initial sync
        syncCompanyMetaAds(actor.companyId, { token: session.userAccessToken }).catch((err) => {
          console.warn('[meta-connect] initial_ad_sync_background_error', err);
        });
      }
    }

    await clearFacebookConnectSession();

    const url = publicAdminUrl(request);
    url.searchParams.set('connected', '1');
    url.searchParams.set('count', String(connectedPages.length));
    url.searchParams.set('ad_accounts_count', String(connectedAdAccountsCount));
    url.searchParams.set(
      'pages',
      connectedPages.map((page) => page.name).join(', ').slice(0, 500),
    );
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
