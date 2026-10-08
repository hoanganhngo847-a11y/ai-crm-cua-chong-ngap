import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { cookies } from 'next/headers';

const STATE_COOKIE = 'fb_connect_state';
const SESSION_COOKIE = 'fb_connect_session';
const COOKIE_MAX_AGE_SECONDS = 10 * 60;

export type ManagedFacebookPage = {
  id: string;
  name: string;
};

type ConnectSession = {
  userAccessToken: string;
  pages: ManagedFacebookPage[];
  companyId: string;
  userId: string;
  expiresAt: number;
};

export type ConfiguredFacebookConnection = {
  configured: boolean;
  pageId: string | null;
  pageName: string | null;
  subscribed: boolean;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function graphVersion() {
  const version = requiredEnv('META_GRAPH_VERSION');
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new Error('Invalid META_GRAPH_VERSION');
  }
  return version;
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

    return { ...parsed, pages };
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

export async function exchangeCodeForUserAccessToken(code: string) {
  const config = facebookOAuthConfig();
  const url = new URL(
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token`,
  );
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('code', code);

  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('FACEBOOK_TOKEN_EXCHANGE_FAILED');
  }
  return payload.access_token;
}

async function fetchManagedPagesWithTokens(userAccessToken: string) {
  const version = graphVersion();
  const url = new URL(`https://graph.facebook.com/${version}/me/accounts`);
  url.searchParams.set('fields', 'id,name,access_token');
  url.searchParams.set('limit', '100');

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${userAccessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error('FACEBOOK_PAGE_LIST_FAILED');
  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown; access_token?: unknown }>;
  };

  return (payload.data || [])
    .filter(
      (page) =>
        typeof page.id === 'string' &&
        /^\d+$/.test(page.id) &&
        typeof page.name === 'string' &&
        typeof page.access_token === 'string',
    )
    .map((page) => ({
      id: page.id as string,
      name: (page.name as string).trim().slice(0, 120),
      accessToken: page.access_token as string,
    }));
}

export async function listManagedFacebookPages(userAccessToken: string) {
  const pages = await fetchManagedPagesWithTokens(userAccessToken);
  return pages.map(({ id, name }) => ({ id, name }));
}

export async function subscribeManagedPage(
  userAccessToken: string,
  pageId: string,
) {
  const configuredPageId = requiredEnv('META_PAGE_ID');
  if (pageId !== configuredPageId) {
    throw new Error('FACEBOOK_PAGE_NOT_ALLOWED_FOR_WORKSPACE');
  }

  const pages = await fetchManagedPagesWithTokens(userAccessToken);
  const page = pages.find((item) => item.id === pageId);
  if (!page) throw new Error('FACEBOOK_PAGE_NOT_MANAGED');

  const version = graphVersion();
  const url = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps`,
  );

  const body = new URLSearchParams({
    subscribed_fields: 'messages',
    access_token: page.accessToken,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error('FACEBOOK_SUBSCRIBE_FAILED');
  const payload = (await response.json()) as { success?: unknown };
  if (payload.success !== true) throw new Error('FACEBOOK_SUBSCRIBE_FAILED');

  return { id: page.id, name: page.name };
}

export async function getConfiguredFacebookConnection(): Promise<ConfiguredFacebookConnection> {
  const pageId = process.env.META_PAGE_ID?.trim() || null;
  const token = process.env.META_PAGE_ACCESS_TOKEN?.trim() || null;
  const appId = process.env.META_APP_ID?.trim() || null;

  if (!pageId || !token || !appId) {
    return { configured: false, pageId, pageName: null, subscribed: false };
  }

  try {
    const version = graphVersion();
    const pageUrl = new URL(
      `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}`,
    );
    pageUrl.searchParams.set('fields', 'id,name');
    pageUrl.searchParams.set('access_token', token);

    const [pageResponse, subscriptionResponse] = await Promise.all([
      fetch(pageUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      }),
      fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps?access_token=${encodeURIComponent(token)}`,
        {
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        },
      ),
    ]);

    const pagePayload = pageResponse.ok
      ? ((await pageResponse.json()) as { name?: unknown })
      : {};
    const subscriptionPayload = subscriptionResponse.ok
      ? ((await subscriptionResponse.json()) as {
          data?: Array<{ id?: unknown }>;
        })
      : {};

    return {
      configured: true,
      pageId,
      pageName:
        typeof pagePayload.name === 'string' ? pagePayload.name : null,
      subscribed: (subscriptionPayload.data || []).some(
        (app) => String(app.id || '') === appId,
      ),
    };
  } catch {
    return { configured: true, pageId, pageName: null, subscribed: false };
  }
}
