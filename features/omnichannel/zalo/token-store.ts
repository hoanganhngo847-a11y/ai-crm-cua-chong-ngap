import { ZaloTokenInfo } from './types';

/**
 * Token Store Interface for Zalo OA Access/Refresh Tokens.
 * Allows safe in-memory caching and plugging in persistent storage (e.g. database/Redis)
 * without leaking credentials to client components.
 */
export interface IZaloTokenStore {
  getToken(): Promise<ZaloTokenInfo | null>;
  setToken(token: ZaloTokenInfo): Promise<void>;
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
}

/**
 * In-Memory Token Store implementation with fallback to environment variables.
 */
export class InMemoryZaloTokenStore implements IZaloTokenStore {
  private currentToken: ZaloTokenInfo | null = null;

  constructor(initialToken?: Partial<ZaloTokenInfo>) {
    const accessToken = initialToken?.accessToken || process.env.ZALO_ACCESS_TOKEN;
    const refreshToken = initialToken?.refreshToken || process.env.ZALO_REFRESH_TOKEN;
    const expiresAt = initialToken?.expiresAt || Date.now() + 25 * 3600 * 1000; // Default 25h if not specified

    if (accessToken) {
      this.currentToken = {
        accessToken,
        refreshToken: refreshToken || 'default_refresh_token',
        expiresAt,
      };
    }
  }

  async getToken(): Promise<ZaloTokenInfo | null> {
    return this.currentToken;
  }

  async setToken(token: ZaloTokenInfo): Promise<void> {
    this.currentToken = { ...token };
  }

  async getAccessToken(): Promise<string | null> {
    return this.currentToken?.accessToken || process.env.ZALO_ACCESS_TOKEN || null;
  }

  async getRefreshToken(): Promise<string | null> {
    return this.currentToken?.refreshToken || process.env.ZALO_REFRESH_TOKEN || null;
  }
}
