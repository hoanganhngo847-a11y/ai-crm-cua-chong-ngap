import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { cookies } from 'next/headers';

import { fetchMetaPages, graphVersion, marketingVersion } from './graph-api';

import { type PageBinding } from './binding';
import { leadAdsPageBindings } from './lead-ads-binding';
import { getMetaPageToken } from './page-token-vault';

const STATE_COOKIE = 'fb_lead_ads_state';
const SESSION_COOKIE = 'fb_lead_ads_session';
const COOKIE_MAX_AGE_SECONDS = 10 * 60;
const PAGE_NAME_CACHE_MS = 5 * 60 * 1000;

const pageNameCache = new Map<string, { name: string; expiresAt: number }>();

export type ManagedFacebookPage = {
  id: string;
  name: string;
};

export type ManagedAdAccount = {
  id: string;
  name: string;
  currency: string;
  accountStatus: number;
};

type ConnectSession = {
  userAccessToken: string;
  tokenExpiresAt?: string | null;
  tokenType?: 'long_lived' | 'short_lived_fallback';
  isLongLived?: boolean;
  pages: ManagedFacebookPage[];
  adAccounts?: ManagedAdAccount[];
  companyId: string;
  userId: string;
  expiresAt: number;
};

export type ConfiguredFacebookConnection = {
  configured: boolean;
  pageId: string | null;
  pageName: string | null;
  subscribed: boolean;
  leadAdsSubscribed?: boolean;
  leadAdsStatus?:
    | 'ALL_CONNECTED'
    | 'LEAD_ADS_NOT_CONNECTED'
    | 'SUBSCRIPTION_UNKNOWN';
  tokenConfigured?: boolean;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function redirectUri() {
  return new URL(
    '/api/facebook/lead-ads/connect/callback',
    requiredEnv('WEBSITE_ORIGIN'),
  ).toString();
}

function cryptoKey() {
  return createHash('sha256')
    .update(requiredEnv('META_APP_SECRET'))
    .digest();
}

function seal(payload: ConnectSession) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function unseal(value: string): ConnectSession | null {
  try {
    const packed = Buffer.from(value, 'base64url');
    if (packed.length < 29) return null;

    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', cryptoKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    const parsed = JSON.parse(plaintext) as ConnectSession;
    if (
      !parsed ||
      typeof parsed.userAccessToken !== 'string' ||
      typeof parsed.companyId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt < Date.now() ||
      !Array.isArray(parsed.pages)
    ) {
      return null;
    }

    const pages = parsed.pages.filter(
      (page) =>
        page &&
        typeof page.id === 'string' &&
        /^\d+$/.test(page.id) &&
        typeof page.name === 'string' &&
        page.name.trim().length > 0,
    );

    const adAccounts = Array.isArray(parsed.adAccounts)
      ? parsed.adAccounts.filter(
          (acc) =>
            acc &&
            typeof acc.id === 'string' &&
            typeof acc.name === 'string',
        )
      : [];

    const tokenExpiresAt =
      typeof parsed.tokenExpiresAt === 'string' && parsed.tokenExpiresAt.trim().length > 0
        ? parsed.tokenExpiresAt.trim()
        : null;

    const tokenType =
      parsed.tokenType === 'long_lived' || parsed.tokenType === 'short_lived_fallback'
        ? parsed.tokenType
        : undefined;

    const isLongLived =
      typeof parsed.isLongLived === 'boolean' ? parsed.isLongLived : undefined;

    return { ...parsed, tokenExpiresAt, tokenType, isLongLived, pages, adAccounts };
  } catch {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}

export function facebookOAuthConfig() {
  return {
    appId: requiredEnv('META_APP_ID'),
    appSecret: requiredEnv('META_APP_SECRET'),
    graphVersion: graphVersion(),
    redirectUri: redirectUri(),
    loginConfigId: process.env.META_LOGIN_CONFIG_ID?.trim() || null,
  };
}

export function createFacebookOAuthState() {
  return randomBytes(32).toString('base64url');
}

type OAuthActor = { companyId: string; userId: string };

function actorState(state: string, actor: OAuthActor): string {
  return [state, actor.companyId, actor.userId].join('.');
}

export async function storeFacebookOAuthState(state: string, actor: OAuthActor) {
  const store = await cookies();
  store.set(STATE_COOKIE, actorState(state, actor), cookieOptions());
}

export async function verifyAndClearFacebookOAuthState(state: string, actor: OAuthActor) {
  const store = await cookies();
  const expected = Buffer.from(store.get(STATE_COOKIE)?.value || '');
  store.delete(STATE_COOKIE);

  const actual = Buffer.from(actorState(state, actor));
  return Boolean(state) && expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function storeFacebookConnectSession(
  input: Omit<ConnectSession, 'expiresAt'>,
) {
  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    seal({
      ...input,
      expiresAt: Date.now() + COOKIE_MAX_AGE_SECONDS * 1000,
    }),
    cookieOptions(),
  );
}

export async function readFacebookConnectSession() {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  return unseal(value);
}

export async function clearFacebookConnectSession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export function parseTokenExpiration(expiresIn?: unknown, now = Date.now()): {
  expiresIn: number | null;
  tokenExpiresAt: string | null;
  isExpired: boolean;
} {
  if (expiresIn == null) {
    return { expiresIn: null, tokenExpiresAt: null, isExpired: false };
  }
  const parsed = typeof expiresIn === 'number' ? expiresIn : parseInt(String(expiresIn), 10);
  if (!Number.isFinite(parsed)) {
    return { expiresIn: null, tokenExpiresAt: null, isExpired: false };
  }
  if (parsed <= 0) {
    return { expiresIn: parsed, tokenExpiresAt: new Date(now).toISOString(), isExpired: true };
  }
  return {
    expiresIn: parsed,
    tokenExpiresAt: new Date(now + parsed * 1000).toISOString(),
    isExpired: false,
  };
}

export type FacebookTokenExchangeResult = {
  accessToken: string;
  tokenExpiresAt: string | null;
  expiresIn: number | null;
  tokenType: 'long_lived' | 'short_lived_fallback';
  isLongLived: boolean;
};

export function isExplicitlyUnsupportedExchangeError(
  status: number,
  payload: unknown,
): boolean {
  // Only a clearly unsupported OAuth grant may use the short-lived fallback.
  // Permission errors (403), invalid parameters, and ambiguous code-100 errors must fail closed.
  if (status !== 400) return false;
  if (!payload || typeof payload !== 'object') return false;

  const err = (payload as { error?: { message?: unknown; type?: unknown } }).error;
  if (!err || typeof err !== 'object') return false;
  if (err.type !== 'OAuthException') return false;

  const message = typeof err.message === 'string'
    ? err.message.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';

  const referencesExchangeGrant =
    message.includes('fb exchange token') ||
    message.includes('grant type') ||
    message.includes('exchange flow');
  const explicitlyUnsupported =
    message.includes('unsupported') || message.includes('not supported');

  return referencesExchangeGrant && explicitlyUnsupported;
}

export async function exchangeLongLivedUserAccessToken(
  shortLivedToken: string,
  fetchDouble?: typeof fetch,
): Promise<FacebookTokenExchangeResult | null> {
  const config = facebookOAuthConfig();
  const url = new URL(
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token`,
  );
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('fb_exchange_token', shortLivedToken);

  const fetchFn = fetchDouble || fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Treat timeout, network failure, or transport errors as exchange failures
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  // Treat HTTP 429 and HTTP 5xx as exchange failures
  if (response.status === 429 || response.status >= 500) {
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // Malformed response (non-JSON)
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  if (response.ok) {
    const successPayload = payload as { access_token?: unknown; expires_in?: unknown };
    if (
      typeof successPayload.access_token !== 'string' ||
      !successPayload.access_token.trim()
    ) {
      // Malformed response: 200 OK without valid access_token
      throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
    }
    const { expiresIn, tokenExpiresAt, isExpired } = parseTokenExpiration(
      successPayload.expires_in,
    );
    if (isExpired) {
      throw new Error('FACEBOOK_TOKEN_EXPIRED');
    }
    return {
      accessToken: successPayload.access_token,
      tokenExpiresAt,
      expiresIn,
      tokenType: 'long_lived',
      isLongLived: true,
    };
  }

  // If not ok, only permit fallback for recognized unsupported-flow responses
  if (isExplicitlyUnsupportedExchangeError(response.status, payload)) {
    return null;
  }

  // All other errors (unrecognized 4xx, code 190, malformed error payload) are exchange failures
  throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
}

export async function exchangeCodeForUserAccessToken(
  code: string,
  fetchDouble?: typeof fetch,
): Promise<FacebookTokenExchangeResult> {
  const config = facebookOAuthConfig();
  const url = new URL(
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token`,
  );
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('code', code);

  const fetchFn = fetchDouble || fetch;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Transport errors can include the OAuth URL with client_secret/code.
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  if (!response.ok) throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  const successPayload = payload as { access_token?: unknown; expires_in?: unknown };
  if (
    typeof successPayload.access_token !== 'string' ||
    !successPayload.access_token.trim()
  ) {
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }

  const shortLivedToken = successPayload.access_token;
  const initialExp = parseTokenExpiration(successPayload.expires_in);

  if (initialExp.isExpired) {
    throw new Error('FACEBOOK_TOKEN_EXPIRED');
  }

  // Attempt long-lived token exchange.
  // Throws on timeout, 429, 500, malformed, or invalid exchange.
  // Returns null ONLY when fb_exchange_token is explicitly recognized as unsupported.
  const longLived = await exchangeLongLivedUserAccessToken(shortLivedToken, fetchFn);
  if (longLived) {
    return longLived;
  }

  // Fallback permitted only for recognized unsupported fb_exchange_token configs.
  // Exposes safe tokenType: 'short_lived_fallback', isLongLived: false, preserving actual expires_in.
  return {
    accessToken: shortLivedToken,
    tokenExpiresAt: initialExp.tokenExpiresAt,
    expiresIn: initialExp.expiresIn,
    tokenType: 'short_lived_fallback',
    isLongLived: false,
  };
}

async function fetchManagedPagesWithTokens(userAccessToken: string, customFetch?: typeof fetch) {
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/me/accounts?fields=id,name,access_token&limit=100`);
  const pages = await fetchMetaPages<{ id?: unknown; name?: unknown; access_token?: unknown }>(url, userAccessToken, customFetch);
  return pages.filter(page => typeof page.id === 'string' && /^\d+$/.test(page.id) && typeof page.name === 'string' && typeof page.access_token === 'string')
    .map(page => ({ id: page.id as string, name: (page.name as string).trim().slice(0, 120), accessToken: page.access_token as string }));
}

export async function listManagedFacebookPages(userAccessToken: string, customFetch?: typeof fetch) {
  return (await fetchManagedPagesWithTokens(userAccessToken, customFetch)).map(({ id, name }) => ({ id, name }));
}

export async function listManagedAdAccounts(userAccessToken: string, customFetch?: typeof fetch): Promise<ManagedAdAccount[]> {
  const url = new URL(`https://graph.facebook.com/${marketingVersion()}/me/adaccounts?fields=id,account_id,name,account_status,currency&limit=100`);
  const accounts = await fetchMetaPages<{ id?: unknown; name?: unknown; currency?: unknown; account_status?: unknown }>(url, userAccessToken, customFetch);
  return accounts.filter(acc => typeof acc.id === 'string' && typeof acc.name === 'string').map(acc => ({
    id: String(acc.id), name: String(acc.name).trim().slice(0, 120),
    currency: typeof acc.currency === 'string' ? acc.currency : 'VND',
    accountStatus: typeof acc.account_status === 'number' ? acc.account_status : 1,
  }));
}

export function configuredLeadAdsPageIds(companyId: string) {
  return new Set(leadAdsPageBindings().filter(item => item.company === companyId).map(item => item.page));
}

export type SubscribePageResult = {
  id: string;
  name: string;
  messengerSubscribed: boolean;
  leadAdsSubscribed: boolean;
  status:
    | 'ALL_CONNECTED'
    | 'LEAD_ADS_NOT_CONNECTED'
    | 'SUBSCRIPTION_UNKNOWN';
  leadAdsError?: string;
  error?: string;
};

export async function readPageSubscribedFields(
  pageId: string,
  pageAccessToken: string,
  appId: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<{ success: true; fields: string[]; appFound: boolean } | { success: false; reason: string }> {
  const version = graphVersion();
  const listUrl = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps`,
  );
  try {
    if (!appId) return { success: false, reason: 'APP_ID_UNAVAILABLE' };
    const listRes = await fetchFn(listUrl.toString(), {
      redirect: 'error',
      method: 'GET',
      headers: { Authorization: `Bearer ${pageAccessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });

    if (!listRes.ok) {
      return { success: false, reason: `HTTP_${listRes.status}` };
    }

    let payload: unknown;
    try {
      payload = await listRes.json();
    } catch {
      return { success: false, reason: 'MALFORMED_JSON' };
    }

    if (!payload || typeof payload !== 'object') {
      return { success: false, reason: 'MALFORMED_PAYLOAD' };
    }

    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { success: false, reason: 'MALFORMED_DATA_ARRAY' };
    }

    const appEntry = data.find(
      (app) =>
        app &&
        typeof app === 'object' &&
        String((app as { id?: unknown }).id || '') === appId,
    ) as { subscribed_fields?: unknown } | undefined;

    if (!appEntry) {
      // App not found in a successful GET response -> app currently has no subscriptions
      return { success: true, fields: [], appFound: false };
    }

    if (!Array.isArray(appEntry.subscribed_fields)) {
      return { success: false, reason: 'MALFORMED_SUBSCRIBED_FIELDS' };
    }

    return {
      success: true,
      fields: appEntry.subscribed_fields.map(String),
      appFound: true,
    };
  } catch {
    return { success: false, reason: 'TRANSPORT_ERROR' };
  }
}

export async function verifyManagedLeadAdsPage(
  userAccessToken: string,
  pageId: string,
  companyId: string,
  customFetch?: typeof fetch,
  persistPageToken?: (accessToken: string, pageName: string) => Promise<void>,
): Promise<SubscribePageResult> {
  if (!configuredLeadAdsPageIds(companyId).has(pageId)) {
    throw new Error('FACEBOOK_PAGE_NOT_ALLOWED_FOR_WORKSPACE');
  }

  const fetchFn = customFetch || fetch;
  const pages = await fetchManagedPagesWithTokens(userAccessToken, fetchFn);
  const page = pages.find(item => item.id === pageId);
  if (!page) throw new Error('FACEBOOK_PAGE_NOT_MANAGED');

  const status = await readPageSubscribedFields(pageId, page.accessToken, process.env.META_APP_ID?.trim() || null, fetchFn);
  const leadAdsSubscribed = status.success && status.fields.includes('leadgen');
  if (leadAdsSubscribed) await persistPageToken?.(page.accessToken, page.name);

  return {
    id: page.id,
    name: page.name,
    messengerSubscribed: status.success && status.fields.includes('messages'),
    leadAdsSubscribed,
    status: !status.success ? 'SUBSCRIPTION_UNKNOWN' : leadAdsSubscribed ? 'ALL_CONNECTED' : 'LEAD_ADS_NOT_CONNECTED',
  };
}

async function resolveConfiguredPageName(binding: PageBinding, suppliedToken?: string | null): Promise<string | null> {
  if (binding.name) return binding.name;

  const cached = pageNameCache.get(binding.page);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  let token = suppliedToken || null;
  if (!token) {
    try {
      token = await getMetaPageToken(binding.company, binding.page, binding.tokenEnv);
    } catch {
      return null;
    }
  }
  if (!token) return null;

  try {
    const version = graphVersion();
    const url = new URL(
      `https://graph.facebook.com/${version}/${encodeURIComponent(binding.page)}`,
    );
    url.searchParams.set('fields', 'id,name');


    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { name?: unknown };
    if (typeof payload.name !== 'string' || !payload.name.trim()) return null;

    const name = payload.name.trim().slice(0, 120);
    pageNameCache.set(binding.page, {
      name,
      expiresAt: Date.now() + PAGE_NAME_CACHE_MS,
    });
    return name;
  } catch {
    return null;
  }
}

async function configuredConnectionForBinding(
  binding: PageBinding,
  appId: string | null,
): Promise<ConfiguredFacebookConnection> {
  let token: string | null = null;
  try {
    token = await getMetaPageToken(binding.company, binding.page, binding.tokenEnv);
  } catch {
    token = null;
  }
  const pageName = await resolveConfiguredPageName(binding, token);

  if (!token || !appId) {
    return {
      configured: true,
      pageId: binding.page,
      pageName,
      subscribed: false,
      leadAdsSubscribed: false,
      leadAdsStatus: 'LEAD_ADS_NOT_CONNECTED',
      tokenConfigured: Boolean(token),
    };
  }

  const readResult = await readPageSubscribedFields(
    binding.page,
    token,
    appId,
    fetch,
  );

  if (!readResult.success) {
    return {
      configured: true,
      pageId: binding.page,
      pageName,
      subscribed: false,
      leadAdsSubscribed: false,
      leadAdsStatus: 'SUBSCRIPTION_UNKNOWN',
      tokenConfigured: true,
    };
  }

  const leadAdsSubscribed = readResult.fields.includes('leadgen');
  const leadAdsStatus: 'ALL_CONNECTED' | 'LEAD_ADS_NOT_CONNECTED' =
    leadAdsSubscribed ? 'ALL_CONNECTED' : 'LEAD_ADS_NOT_CONNECTED';

  return {
    configured: true,
    pageId: binding.page,
    pageName,
    subscribed: leadAdsSubscribed,
    leadAdsSubscribed,
    leadAdsStatus,
    tokenConfigured: true,
  };
}

export async function getConfiguredFacebookConnections(
  companyId: string,
): Promise<ConfiguredFacebookConnection[]> {
  let bindings: PageBinding[] = [];
  try {
    bindings = leadAdsPageBindings().filter(binding => binding.company === companyId);
  } catch {
    bindings = [];
  }

  if (bindings.length === 0) return [];
  const appId = process.env.META_APP_ID?.trim() || null;
  return Promise.all(
    bindings.map((binding) => configuredConnectionForBinding(binding, appId)),
  );
}
