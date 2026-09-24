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
  MockZaloTokenStore,
  ZaloOACredentials,
} from './token-store';

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
 * Zalo OpenAPI Client for Zalo Official Account (OA).
 * Handles token lifecycle (auto-refresh), sending messages, and querying profiles.
 *
 * Security Invariants:
 * - Credentials and tokens are accessed exclusively server-side.
 * - Never logs or leaks secrets (appSecret, accessToken, refreshToken).
 * - Fails closed on token expiration or refresh failure.
 * - Multi-tenant isolation: tokens and secrets belong strictly to (companyId, oaId).
 */
export class ZaloClient {
  readonly companyId: string;
  readonly oaId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly tokenStore: IZaloTokenStore;
  private readonly fetchFn: typeof fetch;

  constructor(options: ZaloClientOptions = {}) {
    this.companyId = options.companyId || '';
    this.oaId = options.oaId || '';
    this.appId = options.appId || '';
    this.appSecret = options.appSecret || '';
    this.fetchFn = options.fetchFn || fetch;

    if (options.tokenStore) {
      this.tokenStore = options.tokenStore;
    } else {
      // Create isolated in-memory token store for this specific client
      const initialCred: ZaloOACredentials = {
        companyId: this.companyId,
        oaId: this.oaId,
        appId: this.appId,
        appSecret: this.appSecret,
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
      };
      this.tokenStore = new MockZaloTokenStore([initialCred]);
    }
  }

  /**
   * Retrieves an active, valid access token.
   * Auto-refreshes token if it's within 5 minutes of expiring.
   */
  async getValidAccessToken(): Promise<string> {
    const tokenInfo = await this.tokenStore.getToken(this.companyId, this.oaId);

    if (!tokenInfo || !tokenInfo.accessToken) {
      const creds = await this.tokenStore.getCredentials(this.companyId, this.oaId);
      if (creds?.accessToken) {
        return creds.accessToken;
      }
      throw new Error(
        `Authentication failure: No Zalo access token available for company "${this.companyId}", OA "${this.oaId}". Fail-closed.`
      );
    }

    const fiveMinutes = 5 * 60 * 1000;
    const isNearlyExpired = Date.now() + fiveMinutes >= tokenInfo.expiresAt;

    if (isNearlyExpired) {
      const refreshed = await this.refreshAccessToken();
      return refreshed.accessToken;
    }

    return tokenInfo.accessToken;
  }

  /**
   * Refreshes the Zalo OA access token using the stored refresh token.
   * Calls Zalo OAuth v4 endpoint securely.
   */
  async refreshAccessToken(): Promise<ZaloTokenInfo> {
    const creds = await this.tokenStore.getCredentials(this.companyId, this.oaId);
    const appId = creds?.appId || this.appId;
    const appSecret = creds?.appSecret || this.appSecret;
    const refreshToken = creds?.refreshToken;

    if (!appId || !appSecret) {
      throw new Error(
        `Authentication failure: Missing appId or appSecret for OA "${this.oaId}". Fail-closed.`
      );
    }

    if (!refreshToken) {
      console.error(`[SECURITY ALERT] Zalo OA Token Refresh Failed: No refresh token for OA "${this.oaId}"`);
      throw new Error(
        `Authentication failure: No refresh token found for OA "${this.oaId}". Re-authentication required.`
      );
    }

    const fetchTokenFromZalo = async (
      credentials: ZaloOACredentials,
      tokenToUse: string
    ): Promise<ZaloTokenInfo> => {
      const url = 'https://oauth.zaloapp.com/v4/oa/access_token';
      const params = new URLSearchParams({
        app_id: credentials.appId,
        grant_type: 'refresh_token',
        refresh_token: tokenToUse,
      });

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          secret_key: credentials.appSecret,
        },
        body: params.toString(),
      });

      if (!response.ok) {
        console.error(`[SECURITY ALERT] Zalo OAuth endpoint returned HTTP ${response.status} for OA "${credentials.oaId}"`);
        throw new Error(`Zalo OAuth request failed with HTTP status ${response.status}`);
      }

      const data = (await response.json()) as ZaloTokenResponse;

      if (data.error || !data.access_token || !data.refresh_token) {
        console.error(
          `[SECURITY ALERT] Zalo OAuth token refresh rejected for OA "${credentials.oaId}": error code ${data.error}`
        );
        throw new Error(
          `Failed to refresh Zalo access token: [${data.error || 'AUTH_ERR'}] ${data.message || 'OAuth error'}`
        );
      }

      const expiresInSeconds = Number(data.expires_in) || 90000;
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + expiresInSeconds * 1000,
      };
    };

    return await this.tokenStore.rotateToken(
      this.companyId,
      this.oaId,
      (c, r) => fetchTokenFromZalo(c, r)
    );
  }

  /**
   * Sends a customer service text message to a Zalo user.
   * Retries automatically once on token expiration (error code -216).
   */
  async sendTextMessage(recipientZaloId: string, text: string): Promise<ZaloSendResponse> {
    const accessToken = await this.getValidAccessToken();

    const sendRequest = async (token: string): Promise<ZaloSendResponse> => {
      const response = await this.fetchFn('https://openapi.zalo.me/v3.0/oa/message/cs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          access_token: token,
        },
        body: JSON.stringify({
          recipient: {
            user_id: recipientZaloId,
          },
          message: {
            text,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Zalo Send API HTTP error ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as ZaloSendResponse;
    };

    let result = await sendRequest(accessToken);

    // Error -216: Access token expired or invalid -> refresh and retry
    if (result.error === -216) {
      const refreshed = await this.refreshAccessToken();
      result = await sendRequest(refreshed.accessToken);
    }

    return result;
  }

  /**
   * Fetches user profile (display name, avatar) for a Zalo user.
   */
  async getUserProfile(zaloUserId: string): Promise<ZaloUserProfile> {
    const accessToken = await this.getValidAccessToken();
    const queryData = encodeURIComponent(JSON.stringify({ user_id: zaloUserId }));
    const url = `https://openapi.zalo.me/v2.0/oa/getprofile?data=${queryData}`;

    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        access_token: accessToken,
      },
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
 * Factory for creating ZaloClient scoped to a specific (companyId, oaId) tenant pair.
 * Eliminates global process.env credentials leakage between tenants.
 */
export class ZaloClientFactory {
  private static readonly clientCache = new Map<string, ZaloClient>();

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

    const cacheKey = `${companyId}:${oaId}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const tokenStore =
      options.tokenStore ||
      (options.supabase ? new DatabaseZaloTokenStore(options.supabase) : undefined);

    const creds = tokenStore
      ? await tokenStore.getCredentials(companyId, oaId)
      : null;

    const client = new ZaloClient({
      companyId,
      oaId,
      appId: creds?.appId || '',
      appSecret: creds?.appSecret || '',
      accessToken: creds?.accessToken || undefined,
      refreshToken: creds?.refreshToken || undefined,
      tokenStore,
      fetchFn: options.fetchFn,
    });

    this.clientCache.set(cacheKey, client);
    return client;
  }

  static clearCache(): void {
    this.clientCache.clear();
  }
}
