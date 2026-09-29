import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ZaloSendResponse,
  ZaloTokenInfo,
  ZaloTokenResponse,
  ZaloUserProfile,
} from './types';
import {
  IZaloTokenStore,
  DatabaseZaloTokenStore,
  InMemoryZaloTokenStore,
  ZaloOACredentials,
} from './token-store';

const ZALO_HTTP_TIMEOUT_MS = 15_000;

export interface ZaloClientOptions {
  companyId?: string;
  oaId?: string;
  appId?: string;
  appSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenStore?: IZaloTokenStore;
  fetchFn?: typeof fetch;
}

/**
 * Outcome of a provider send, from the point of view of "was the message delivered to Zalo?".
 * - ACCEPTED:  Zalo returned error 0 (message_id known).
 * - REJECTED:  Zalo definitively did NOT accept the message (4xx, error != 0, no token). Safe to retry.
 * - UNCERTAIN: the request may have reached Zalo (network error, timeout, 5xx, unreadable body).
 *              MUST NOT be retried automatically — it would risk a duplicate customer message.
 */
export type ZaloSendOutcome = 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';

export interface ZaloSendResult {
  outcome: ZaloSendOutcome;
  providerMsgId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class ZaloProviderError extends Error {
  readonly outcome: Exclude<ZaloSendOutcome, 'ACCEPTED'>;
  readonly errorCode: string;

  constructor(message: string, outcome: Exclude<ZaloSendOutcome, 'ACCEPTED'>, errorCode: string) {
    super(message);
    this.name = 'ZaloProviderError';
    this.outcome = outcome;
    this.errorCode = errorCode;
    Object.setPrototypeOf(this, ZaloProviderError.prototype);
  }
}

/**
 * Zalo OpenAPI Client for one Zalo Official Account (OA), scoped to (companyId, oaId).
 *
 * Security Invariants:
 * - Credentials are accessed exclusively server-side through the token store.
 * - Never logs secrets (appSecret, accessToken, refreshToken).
 * - Fails closed when no credential source is configured: there is no implicit empty client.
 */
export class ZaloClient {
  readonly companyId: string;
  readonly oaId: string;
  readonly tokenStore: IZaloTokenStore;
  private readonly fetchFn: typeof fetch;

  constructor(options: ZaloClientOptions = {}) {
    this.companyId = options.companyId || '';
    this.oaId = options.oaId || '';
    this.fetchFn = options.fetchFn || fetch;

    if (options.tokenStore) {
      this.tokenStore = options.tokenStore;
    } else if (options.accessToken || options.refreshToken) {
      // Explicit static credentials (tests / scripts). Production uses ZaloClientFactory.
      this.tokenStore = new InMemoryZaloTokenStore([
        {
          companyId: this.companyId,
          oaId: this.oaId,
          appId: options.appId || '',
          appSecret: options.appSecret || '',
          accessToken: options.accessToken,
          refreshToken: options.refreshToken,
        },
      ]);
    } else {
      throw new Error(
        'ZaloClient requires a token store or explicit credentials. Use ZaloClientFactory.getClientForOa() in production.'
      );
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    return this.fetchFn(url, { ...init, signal: AbortSignal.timeout(ZALO_HTTP_TIMEOUT_MS) });
  }

  /**
   * Returns a usable access token. Refreshes proactively only when the expiry is known and
   * within 5 minutes; an unknown expiry is refreshed reactively on Zalo error -216.
   */
  async getValidAccessToken(): Promise<string> {
    const tokenInfo = await this.tokenStore.getToken(this.companyId, this.oaId);

    if (!tokenInfo?.accessToken) {
      const refreshed = await this.refreshAccessToken();
      return refreshed.accessToken;
    }

    const fiveMinutes = 5 * 60 * 1000;
    if (tokenInfo.expiresAt > 0 && Date.now() + fiveMinutes >= tokenInfo.expiresAt) {
      const refreshed = await this.refreshAccessToken();
      return refreshed.accessToken;
    }

    return tokenInfo.accessToken;
  }

  /**
   * Refreshes the OA access token through the store's single-flight rotation.
   * Zalo refresh tokens are single-use, so the store guarantees one refresher per OA.
   */
  async refreshAccessToken(): Promise<ZaloTokenInfo> {
    return this.tokenStore.rotateToken(this.companyId, this.oaId, (credentials, refreshToken) =>
      this.fetchTokenFromZalo(credentials, refreshToken)
    );
  }

  private async fetchTokenFromZalo(
    credentials: ZaloOACredentials,
    refreshToken: string
  ): Promise<ZaloTokenInfo> {
    if (!credentials.appId || !credentials.appSecret) {
      throw new Error(`Authentication failure: Missing appId or appSecret for OA "${this.oaId}". Fail-closed.`);
    }

    const params = new URLSearchParams({
      app_id: credentials.appId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await this.request('https://oauth.zaloapp.com/v4/oa/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: credentials.appSecret,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      console.error(`[SECURITY ALERT] Zalo OAuth endpoint returned HTTP ${response.status} for OA "${this.oaId}"`);
      throw new Error(`Zalo OAuth request failed with HTTP status ${response.status}`);
    }

    const data = (await response.json()) as ZaloTokenResponse;
    if (data.error || !data.access_token || !data.refresh_token) {
      console.error(`[SECURITY ALERT] Zalo OAuth token refresh rejected for OA "${this.oaId}": error code ${data.error}`);
      throw new Error(`Failed to refresh Zalo access token: [${data.error || 'AUTH_ERR'}] ${data.message || 'OAuth error'}`);
    }

    const expiresInSeconds = Number(data.expires_in) || 90000;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
  }

  /**
   * Sends a customer-service text message and classifies the outcome for outbox bookkeeping.
   * Never throws: every failure is mapped to REJECTED or UNCERTAIN.
   */
  async sendTextMessageWithOutcome(recipientZaloId: string, text: string): Promise<ZaloSendResult> {
    let accessToken: string;
    try {
      accessToken = await this.getValidAccessToken();
    } catch (err: unknown) {
      return {
        outcome: 'REJECTED',
        errorCode: 'TOKEN_UNAVAILABLE',
        errorMessage: err instanceof Error ? err.message : 'Access token unavailable',
      };
    }

    const attempt = async (token: string): Promise<ZaloSendResult & { tokenExpired?: boolean }> => {
      let response: Response;
      try {
        response = await this.request('https://openapi.zalo.me/v3.0/oa/message/cs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', access_token: token },
          body: JSON.stringify({ recipient: { user_id: recipientZaloId }, message: { text } }),
        });
      } catch (err: unknown) {
        return {
          outcome: 'UNCERTAIN',
          errorCode: 'NETWORK_ERROR',
          errorMessage: err instanceof Error ? err.message : 'Network error',
        };
      }

      if (!response.ok) {
        return {
          outcome: response.status >= 500 ? 'UNCERTAIN' : 'REJECTED',
          errorCode: `HTTP_${response.status}`,
          errorMessage: response.statusText || `HTTP ${response.status}`,
        };
      }

      let body: ZaloSendResponse;
      try {
        body = (await response.json()) as ZaloSendResponse;
      } catch {
        return { outcome: 'UNCERTAIN', errorCode: 'INVALID_PROVIDER_RESPONSE', errorMessage: 'Unreadable Zalo response' };
      }

      if (body.error === 0) {
        const msgId = body.data?.message_id?.trim();
        if (!msgId) {
          return {
            outcome: 'UNCERTAIN',
            errorCode: 'MISSING_PROVIDER_MSG_ID',
            errorMessage: 'Zalo claimed success but omitted stable message_id (fail-closed, no synthetic fallback)',
          };
        }
        return { outcome: 'ACCEPTED', providerMsgId: msgId };
      }
      return {
        outcome: 'REJECTED',
        errorCode: String(body.error),
        errorMessage: body.message || 'Zalo rejected the message',
        tokenExpired: body.error === -216,
      };
    };

    const first = await attempt(accessToken);
    if (!first.tokenExpired) {
      return first;
    }

    // -216: token expired/invalid. The first request was rejected, so a retry cannot duplicate.
    let refreshedToken: string;
    try {
      refreshedToken = (await this.refreshAccessToken()).accessToken;
    } catch (err: unknown) {
      return {
        outcome: 'REJECTED',
        errorCode: 'TOKEN_REFRESH_FAILED',
        errorMessage: err instanceof Error ? err.message : 'Token refresh failed',
      };
    }
    const second = await attempt(refreshedToken);
    return { outcome: second.outcome, providerMsgId: second.providerMsgId, errorCode: second.errorCode, errorMessage: second.errorMessage };
  }

  /**
   * Backward-compatible send API. Throws ZaloProviderError (carrying the outcome) when the
   * message was not accepted.
   */
  async sendTextMessage(recipientZaloId: string, text: string): Promise<ZaloSendResponse> {
    const result = await this.sendTextMessageWithOutcome(recipientZaloId, text);
    if (result.outcome !== 'ACCEPTED') {
      throw new ZaloProviderError(
        `Zalo send ${result.outcome.toLowerCase()} [${result.errorCode}]: ${result.errorMessage}`,
        result.outcome,
        result.errorCode || 'UNKNOWN'
      );
    }
    return { error: 0, message: 'Success', data: { message_id: result.providerMsgId || '' } };
  }

  /**
   * Fetches user profile (display name, avatar) for a Zalo user.
   */
  async getUserProfile(zaloUserId: string): Promise<ZaloUserProfile> {
    const accessToken = await this.getValidAccessToken();
    const queryData = encodeURIComponent(JSON.stringify({ user_id: zaloUserId }));
    const response = await this.request(`https://openapi.zalo.me/v2.0/oa/getprofile?data=${queryData}`, {
      method: 'GET',
      headers: { access_token: accessToken },
    });

    if (!response.ok) {
      throw new Error(`Zalo getprofile HTTP error ${response.status}`);
    }

    const resJson = (await response.json()) as { error: number; message: string; data?: ZaloUserProfile };
    if (resJson.error !== 0 || !resJson.data) {
      return {
        user_id: zaloUserId,
        user_name: `Khách Zalo ${zaloUserId.slice(-4)}`,
        error: resJson.error,
        message: resJson.message,
      };
    }

    return resJson.data;
  }
}

/**
 * Builds a ZaloClient bound to one (companyId, oaId) tenant pair, backed by the database
 * token store. There is no process.env / default-client fallback.
 */
export class ZaloClientFactory {
  static async getClientForOa(
    companyId: string,
    oaId: string,
    options: {
      supabase?: SupabaseClient;
      tokenStore?: IZaloTokenStore;
      fetchFn?: typeof fetch;
    } = {}
  ): Promise<ZaloClient> {
    if (!companyId || !oaId) {
      throw new Error('companyId and oaId are required to retrieve ZaloClient');
    }

    const tokenStore =
      options.tokenStore || (options.supabase ? new DatabaseZaloTokenStore(options.supabase) : undefined);
    if (!tokenStore) {
      throw new Error('ZaloClientFactory requires a Supabase client or token store (fail-closed).');
    }

    const creds = await tokenStore.getCredentials(companyId, oaId);
    if (!creds) {
      throw new Error(`Zalo OA "${oaId}" is not configured or not ACTIVE for this company (fail-closed).`);
    }

    return new ZaloClient({ companyId, oaId, tokenStore, fetchFn: options.fetchFn });
  }
}
