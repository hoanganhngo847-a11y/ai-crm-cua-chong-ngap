import {
  ZaloSendResponse,
  ZaloTokenInfo,
  ZaloTokenResponse,
  ZaloUserProfile,
} from './types';
import { IZaloTokenStore, InMemoryZaloTokenStore } from './token-store';

export interface ZaloClientOptions {
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
 * - Never logs or leaks secrets (ZALO_APP_SECRET, ZALO_ACCESS_TOKEN, ZALO_REFRESH_TOKEN).
 * - Fails closed on token expiration or refresh failure.
 */
export class ZaloClient {
  readonly oaId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly tokenStore: IZaloTokenStore;
  private readonly fetchFn: typeof fetch;

  constructor(options: ZaloClientOptions = {}) {
    this.oaId = options.oaId || process.env.ZALO_OA_ID || '';
    this.appId = options.appId || process.env.ZALO_APP_ID || '';
    this.appSecret = options.appSecret || process.env.ZALO_APP_SECRET || '';
    this.tokenStore =
      options.tokenStore ||
      new InMemoryZaloTokenStore({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken,
      });
    this.fetchFn = options.fetchFn || fetch;
  }

  /**
   * Retrieves an active, valid access token.
   * Auto-refreshes token if it's within 5 minutes of expiring.
   */
  async getValidAccessToken(): Promise<string> {
    const tokenInfo = await this.tokenStore.getToken();

    if (!tokenInfo) {
      const directToken = await this.tokenStore.getAccessToken();
      if (directToken) return directToken;
      throw new Error(
        'Authentication failure: No Zalo access token available. Please configure ZALO_ACCESS_TOKEN or refresh token.'
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
    const refreshToken = await this.tokenStore.getRefreshToken();
    if (!refreshToken) {
      throw new Error('Authentication failure: ZALO_REFRESH_TOKEN is not configured.');
    }

    if (!this.appId || !this.appSecret) {
      throw new Error('Authentication failure: ZALO_APP_ID or ZALO_APP_SECRET is missing.');
    }

    const url = 'https://oauth.zaloapp.com/v4/oa/access_token';
    const params = new URLSearchParams({
      app_id: this.appId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: this.appSecret,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Zalo OAuth request failed with HTTP status ${response.status}`);
    }

    const data = (await response.json()) as ZaloTokenResponse;

    if (data.error || !data.access_token || !data.refresh_token) {
      throw new Error(
        `Failed to refresh Zalo access token: [${data.error || 'AUTH_ERR'}] ${data.message || 'OAuth error'}`
      );
    }

    const expiresInSeconds = Number(data.expires_in) || 90000; // Default 25h in Zalo
    const newTokenInfo: ZaloTokenInfo = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };

    await this.tokenStore.setToken(newTokenInfo);
    return newTokenInfo;
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
