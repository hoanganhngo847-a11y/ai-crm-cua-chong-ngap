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

import { bindingsForCompany, pageBindings, type PageBinding } from './binding';

const STATE_COOKIE = 'fb_connect_state';
const SESSION_COOKIE = 'fb_connect_session';
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
    | 'MESSENGER_CONNECTED'
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
    '/api/facebook/connect/callback',
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

export async function storeFacebookOAuthState(state: string) {
  const store = await cookies();
  store.set(STATE_COOKIE, state, cookieOptions());
}

export async function verifyAndClearFacebookOAuthState(state: string) {
  const store = await cookies();
  const expected = store.get(STATE_COOKIE)?.value || '';
  store.delete(STATE_COOKIE);

  if (!expected || !state || expected.length !== state.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(state));
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
    ? err.message.toLowerCase().replace(/[_-]+/g, ' ').replace(/\\s+/g, ' ').trim()
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

export function configuredFacebookPageIds(companyId: string) {
  return new Set(bindingsForCompany(companyId).map((item) => item.page));
}

export type SubscribePageResult = {
  id: string;
  name: string;
  messengerSubscribed: boolean;
  leadAdsSubscribed: boolean;
  status:
    | 'MESSENGER_CONNECTED'
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
    const listRes = await fetchFn(listUrl.toString(), {
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
        (!appId || String((app as { id?: unknown }).id || '') === appId),
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

export async function subscribeManagedPage(
  userAccessToken: string,
  pageId: string,
  companyId: string,
  customFetch?: typeof fetch,
): Promise<SubscribePageResult> {
  const fetchFn = customFetch || fetch;
  const configured = pageBindings().find(
    (item) => item.company === companyId && item.page === pageId,
  );
  if (!configured) {
    throw new Error('FACEBOOK_PAGE_NOT_ALLOWED_FOR_WORKSPACE');
  }

  const pages = await fetchManagedPagesWithTokens(userAccessToken, fetchFn);
  const page = pages.find((item) => item.id === pageId);
  if (!page) throw new Error('FACEBOOK_PAGE_NOT_MANAGED');

  const version = graphVersion();
  const appId = process.env.META_APP_ID?.trim() || null;

  // 1. Read existing subscriptions reliably before mutating anything
  const initialRead = await readPageSubscribedFields(
    pageId,
    page.accessToken,
    appId,
    fetchFn,
  );

  if (!initialRead.success) {
    // Do not mutate subscriptions when existing subscription state cannot be read reliably
    // Return explicit safe status SUBSCRIPTION_UNKNOWN
    return {
      id: page.id,
      name: page.name,
      messengerSubscribed: false,
      leadAdsSubscribed: false,
      status: 'SUBSCRIPTION_UNKNOWN',
      error: `CANNOT_VERIFY_SUBSCRIPTION_STATE: ${initialRead.reason}`,
    };
  }

  let currentFields = [...initialRead.fields];
  const subUrl = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps`,
  );

  // 2. Ensure Messenger messages subscription and preserve existing fields
  let messengerSubscribed = currentFields.includes('messages');
  if (!messengerSubscribed) {
    const messengerFields = Array.from(new Set([...currentFields, 'messages'])).join(',');
    const msgRes = await fetchFn(subUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${page.accessToken}`,
      },
      body: new URLSearchParams({ subscribed_fields: messengerFields }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!msgRes.ok) throw new Error('FACEBOOK_SUBSCRIBE_FAILED');
    const msgPayload = (await msgRes.json().catch(() => null)) as { success?: unknown } | null;
    if (msgPayload?.success !== true) throw new Error('FACEBOOK_SUBSCRIBE_FAILED');

    // 4. After subscription changes, read back the fields and verify the expected state
    const postRead = await readPageSubscribedFields(
      pageId,
      page.accessToken,
      appId,
      fetchFn,
    );

    if (!postRead.success || !postRead.fields.includes('messages')) {
      // Read-back mismatch: Meta did not confirm messages subscription
      return {
        id: page.id,
        name: page.name,
        messengerSubscribed: false,
        leadAdsSubscribed: false,
        status: 'SUBSCRIPTION_UNKNOWN',
        error: 'SUBSCRIPTION_READBACK_MISMATCH',
      };
    }

    messengerSubscribed = true;
    currentFields = postRead.fields;
  }

  // 3. Decoupled Lead Ads subscription (do not fail Messenger if leadgen fails)
  let leadAdsSubscribed = currentFields.includes('leadgen');
  let leadAdsError: string | undefined;
  let subscriptionUnknown = false;

  if (!leadAdsSubscribed) {
    try {
      const leadAdsFields = Array.from(new Set([...currentFields, 'leadgen'])).join(',');
      const leadRes = await fetchFn(subUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${page.accessToken}`,
        },
        body: new URLSearchParams({ subscribed_fields: leadAdsFields }),
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });

      if (leadRes.ok) {
        const leadPayload = (await leadRes.json().catch(() => null)) as { success?: unknown } | null;
        if (leadPayload?.success === true) {
          // Read-back verification for leadgen
          const postLeadRead = await readPageSubscribedFields(
            pageId,
            page.accessToken,
            appId,
            fetchFn,
          );
          if (postLeadRead.success && postLeadRead.fields.includes('leadgen')) {
            leadAdsSubscribed = true;
            currentFields = postLeadRead.fields;
          } else {
            subscriptionUnknown = true;
            leadAdsError = postLeadRead.success
              ? 'SUBSCRIPTION_READBACK_MISMATCH'
              : 'SUBSCRIPTION_READBACK_UNKNOWN';
          }
        } else {
          leadAdsError = 'LEAD_ADS_NOT_CONNECTED';
        }
      } else {
        leadAdsError = 'LEAD_ADS_NOT_CONNECTED';
      }
    } catch {
      leadAdsError = 'LEAD_ADS_NOT_CONNECTED';
    }
  }

  pageNameCache.set(page.id, {
    name: page.name,
    expiresAt: Date.now() + PAGE_NAME_CACHE_MS,
  });

  return {
    id: page.id,
    name: page.name,
    messengerSubscribed,
    leadAdsSubscribed,
    status: subscriptionUnknown
      ? 'SUBSCRIPTION_UNKNOWN'
      : leadAdsSubscribed
        ? 'ALL_CONNECTED'
        : messengerSubscribed
          ? 'MESSENGER_CONNECTED'
          : 'SUBSCRIPTION_UNKNOWN',
    ...(leadAdsError ? { leadAdsError } : {}),
    ...(subscriptionUnknown && leadAdsError ? { error: leadAdsError } : {}),
  };
}

async function resolveConfiguredPageName(binding: PageBinding): Promise<string | null> {
  if (binding.name) return binding.name;

  const cached = pageNameCache.get(binding.page);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  const token = process.env[binding.tokenEnv]?.trim();
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
  const token = process.env[binding.tokenEnv]?.trim() || null;
  const pageName = await resolveConfiguredPageName(binding);

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

  const subscribedFields = readResult.fields;
  const isSubscribed = readResult.appFound;
  const messengerSubscribed = isSubscribed && (subscribedFields.length === 0 || subscribedFields.includes('messages'));
  const leadAdsSubscribed = isSubscribed && subscribedFields.includes('leadgen');
  const leadAdsStatus: 'MESSENGER_CONNECTED' | 'ALL_CONNECTED' | 'LEAD_ADS_NOT_CONNECTED' =
    leadAdsSubscribed
      ? 'ALL_CONNECTED'
      : (messengerSubscribed ? 'MESSENGER_CONNECTED' : 'LEAD_ADS_NOT_CONNECTED');

  return {
    configured: true,
    pageId: binding.page,
    pageName,
    subscribed: isSubscribed,
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
    bindings = bindingsForCompany(companyId);
  } catch {
    bindings = [];
  }

  if (bindings.length === 0) return [];
  const appId = process.env.META_APP_ID?.trim() || null;
  return Promise.all(
    bindings.map((binding) => configuredConnectionForBinding(binding, appId)),
  );
}

export async function getConfiguredFacebookConnection(
  companyId: string,
): Promise<ConfiguredFacebookConnection> {
  const connections = await getConfiguredFacebookConnections(companyId);
  return connections[0] || {
    configured: false,
    pageId: null,
    pageName: null,
    subscribed: false,
    tokenConfigured: false,
  };
}

export async function getConfiguredFacebookPageLabels(
  companyId: string,
): Promise<Record<string, string>> {
  let bindings: PageBinding[] = [];
  try {
    bindings = bindingsForCompany(companyId);
  } catch {
    bindings = [];
  }

  const entries = await Promise.all(
    bindings.map(async (binding) => [
      binding.page,
      (await resolveConfiguredPageName(binding)) || `Facebook Page ${binding.page}`,
    ] as const),
  );

  return Object.fromEntries(entries);
}
