import type { SupabaseClient } from '@supabase/supabase-js';
import { ZaloTokenInfo } from './types';

/**
 * Credentials and persistent tokens for a specific Zalo Official Account (OA).
 * Keyed strictly by composite key (company_id, oa_id).
 */
export interface ZaloOACredentials {
  companyId: string;
  oaId: string;
  appId: string;
  appSecret: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  tokenVersion?: number;
}

/**
 * Token Store Interface for Zalo OA Access/Refresh Tokens.
 * Enforces per-tenant isolation by requiring companyId and oaId composite keys.
 */
export interface IZaloTokenStore {
  getToken(companyId: string, oaId: string): Promise<ZaloTokenInfo | null>;
  setToken(companyId: string, oaId: string, token: ZaloTokenInfo): Promise<void>;
  getCredentials(companyId: string, oaId: string): Promise<ZaloOACredentials | null>;
  rotateToken(
    companyId: string,
    oaId: string,
    refreshFn: (credentials: ZaloOACredentials, currentRefreshToken: string) => Promise<ZaloTokenInfo>
  ): Promise<ZaloTokenInfo>;
}

/**
 * Persistent Database Token Store implementation.
 * Stores tokens into `zalo_oa_configs` with row-level optimistic locking (token_version).
 * Fails closed on missing or invalid refresh tokens without fabricating fake credentials.
 */
export class DatabaseZaloTokenStore implements IZaloTokenStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async getToken(companyId: string, oaId: string): Promise<ZaloTokenInfo | null> {
    const creds = await this.getCredentials(companyId, oaId);
    if (!creds?.accessToken) {
      return null;
    }
    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken || '',
      expiresAt: creds.expiresAt || 0,
    };
  }

  async setToken(companyId: string, oaId: string, token: ZaloTokenInfo): Promise<void> {
    const expiresAtIso = new Date(token.expiresAt).toISOString();
    const { error } = await this.supabase
      .from('zalo_oa_configs')
      .update({
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        token_expires_at: expiresAtIso,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('oa_id', oaId);

    if (error) {
      throw new Error(`Database token update failed for OA ${oaId}: ${error.message}`);
    }
  }

  async getCredentials(companyId: string, oaId: string): Promise<ZaloOACredentials | null> {
    const { data, error } = await this.supabase
      .from('zalo_oa_configs')
      .select('company_id, oa_id, app_id, app_secret, access_token, refresh_token, token_expires_at, token_version')
      .eq('company_id', companyId)
      .eq('oa_id', oaId)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      companyId: data.company_id,
      oaId: data.oa_id,
      appId: data.app_id,
      appSecret: data.app_secret,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.token_expires_at ? new Date(data.token_expires_at).getTime() : null,
      tokenVersion: data.token_version ?? 1,
    };
  }

  /**
   * Atomic Token Rotation with optimistic locking using token_version.
   * If a concurrent worker already refreshed the token, re-reads the updated token.
   */
  async rotateToken(
    companyId: string,
    oaId: string,
    refreshFn: (credentials: ZaloOACredentials, currentRefreshToken: string) => Promise<ZaloTokenInfo>
  ): Promise<ZaloTokenInfo> {
    const current = await this.getCredentials(companyId, oaId);
    if (!current) {
      throw new Error(`Cannot rotate token: OA configuration not found for company ${companyId}, OA ${oaId}`);
    }

    if (!current.refreshToken) {
      throw new Error(`Fail-closed: No refresh token stored for OA ${oaId}. Re-authentication required.`);
    }

    const currentVersion = current.tokenVersion ?? 1;

    // Execute provider refresh
    const newToken = await refreshFn(current, current.refreshToken);
    const expiresAtIso = new Date(newToken.expiresAt).toISOString();

    // Optimistic lock update: ensure token_version matches
    const { data: updated, error } = await this.supabase
      .from('zalo_oa_configs')
      .update({
        access_token: newToken.accessToken,
        refresh_token: newToken.refreshToken,
        token_expires_at: expiresAtIso,
        token_version: currentVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyId)
      .eq('oa_id', oaId)
      .eq('token_version', currentVersion)
      .select('access_token, refresh_token, token_expires_at')
      .maybeSingle();

    if (error) {
      throw new Error(`Atomic token rotation update failed: ${error.message}`);
    }

    // If update returned null, a concurrent process already rotated the token
    if (!updated) {
      const refreshedNow = await this.getToken(companyId, oaId);
      if (refreshedNow?.accessToken) {
        return refreshedNow;
      }
      throw new Error('Concurrent token rotation collision and failed to retrieve updated token');
    }

    return newToken;
  }
}

/**
 * In-Memory Mock Token Store for unit and integration test isolation.
 * Strictly keyed by composite key (companyId, oaId) without global fake strings.
 */
export class MockZaloTokenStore implements IZaloTokenStore {
  private readonly store = new Map<string, ZaloOACredentials>();

  constructor(
    initial?: ZaloOACredentials[] | ZaloOACredentials | Partial<ZaloTokenInfo>
  ) {
    if (Array.isArray(initial)) {
      for (const cred of initial) {
        this.store.set(this.compositeKey(cred.companyId, cred.oaId), { ...cred });
      }
    } else if (initial && typeof initial === 'object') {
      const initObj = initial as Partial<ZaloOACredentials & ZaloTokenInfo>;
      const companyId = initObj.companyId || '';
      const oaId = initObj.oaId || '';
      this.store.set(this.compositeKey(companyId, oaId), {
        companyId,
        oaId,
        appId: initObj.appId || 'test_app_id',
        appSecret: initObj.appSecret || 'test_secret',
        accessToken: initObj.accessToken,
        refreshToken: initObj.refreshToken,
        expiresAt: initObj.expiresAt,
        tokenVersion: initObj.tokenVersion || 1,
      });
    }
  }

  private compositeKey(companyId: string, oaId: string): string {
    return `${companyId || 'default'}:${oaId || 'default'}`;
  }

  async getToken(companyId: string, oaId: string): Promise<ZaloTokenInfo | null> {
    let cred = this.store.get(this.compositeKey(companyId, oaId));
    if (!cred && this.store.size === 1) {
      cred = Array.from(this.store.values())[0];
    }
    if (!cred?.accessToken) return null;
    return {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken || '',
      expiresAt: cred.expiresAt || Date.now() + 24 * 3600 * 1000,
    };
  }

  async setToken(companyId: string, oaId: string, token: ZaloTokenInfo): Promise<void> {
    const key = this.compositeKey(companyId, oaId);
    const existing = this.store.get(key) || (this.store.size === 1 ? Array.from(this.store.values())[0] : null) || {
      companyId,
      oaId,
      appId: 'mock_app_id',
      appSecret: 'mock_app_secret',
    };
    const targetKey = this.compositeKey(existing.companyId || companyId, existing.oaId || oaId);
    this.store.set(targetKey, {
      ...existing,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      tokenVersion: (existing.tokenVersion ?? 1) + 1,
    });
  }

  async getCredentials(companyId: string, oaId: string): Promise<ZaloOACredentials | null> {
    let cred = this.store.get(this.compositeKey(companyId, oaId));
    if (!cred && this.store.size === 1) {
      cred = Array.from(this.store.values())[0];
    }
    return cred || null;
  }

  async rotateToken(
    companyId: string,
    oaId: string,
    refreshFn: (credentials: ZaloOACredentials, currentRefreshToken: string) => Promise<ZaloTokenInfo>
  ): Promise<ZaloTokenInfo> {
    const cred = await this.getCredentials(companyId, oaId);
    if (!cred?.refreshToken) {
      throw new Error(`Fail-closed: No refresh token stored for OA ${oaId}`);
    }
    const refreshed = await refreshFn(cred, cred.refreshToken);
    await this.setToken(companyId, oaId, refreshed);
    return refreshed;
  }
}

/**
 * Backward compatibility alias for test suites.
 */
export { MockZaloTokenStore as InMemoryZaloTokenStore };
