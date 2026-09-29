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
  getCredentials(companyId: string, oaId: string): Promise<ZaloOACredentials | null>;
  rotateToken(
    companyId: string,
    oaId: string,
    refreshFn: (credentials: ZaloOACredentials, currentRefreshToken: string) => Promise<ZaloTokenInfo>
  ): Promise<ZaloTokenInfo>;
}

interface CredentialRow {
  company_id: string;
  oa_id: string;
  app_id: string;
  app_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  token_version: number | null;
}

interface RefreshLeaseRow {
  acquired: boolean;
  lease_token: string | null;
  token_version: number;
  app_id: string;
  app_secret: string | null;
  refresh_token: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Database token store. Secrets live only in private.zalo_oa_secrets and are reached through
 * service-role SECURITY DEFINER RPCs (the private schema is not exposed through PostgREST).
 *
 * Rotation is single-flight per OA: Zalo refresh tokens are single-use, so exactly one worker
 * holds the refresh lease; the others wait for the new token version instead of burning the
 * refresh token concurrently. Every rotation (success or failure) is audited in the DB.
 */
export class DatabaseZaloTokenStore implements IZaloTokenStore {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly options: { leaseWaitMs?: number; leaseWaitAttempts?: number } = {}
  ) {}

  async getCredentials(companyId: string, oaId: string): Promise<ZaloOACredentials | null> {
    const { data, error } = await this.supabase.rpc('zalo_get_oa_credentials', {
      p_company_id: companyId,
      p_oa_id: oaId,
    });
    if (error) {
      throw new Error(`Failed to load Zalo OA credentials: ${error.message}`);
    }
    const row = (Array.isArray(data) ? data[0] : data) as CredentialRow | undefined;
    if (!row) {
      return null;
    }
    return {
      companyId: row.company_id,
      oaId: row.oa_id,
      appId: row.app_id,
      appSecret: row.app_secret || '',
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.token_expires_at ? new Date(row.token_expires_at).getTime() : null,
      tokenVersion: row.token_version ?? 1,
    };
  }

  async getToken(companyId: string, oaId: string): Promise<ZaloTokenInfo | null> {
    const creds = await this.getCredentials(companyId, oaId);
    if (!creds?.accessToken) {
      return null;
    }
    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken || '',
      expiresAt: creds.expiresAt ?? 0,
    };
  }

  async rotateToken(
    companyId: string,
    oaId: string,
    refreshFn: (credentials: ZaloOACredentials, currentRefreshToken: string) => Promise<ZaloTokenInfo>
  ): Promise<ZaloTokenInfo> {
    const { data, error } = await this.supabase.rpc('zalo_begin_token_refresh', {
      p_company_id: companyId,
      p_oa_id: oaId,
      p_lease_seconds: 60,
    });
    if (error) {
      throw new Error(`Cannot rotate Zalo token: ${error.message}`);
    }
    const lease = (Array.isArray(data) ? data[0] : data) as RefreshLeaseRow | undefined;
    if (!lease) {
      throw new Error(`Cannot rotate Zalo token: OA ${oaId} not configured (fail-closed).`);
    }

    if (!lease.acquired) {
      return this.waitForConcurrentRotation(companyId, oaId, lease.token_version);
    }

    const leaseToken = lease.lease_token as string;
    if (!lease.refresh_token) {
      await this.abort(companyId, oaId, leaseToken, 'NO_REFRESH_TOKEN');
      throw new Error(`Fail-closed: No refresh token stored for OA ${oaId}. Re-authentication required.`);
    }

    let newToken: ZaloTokenInfo;
    try {
      newToken = await refreshFn(
        {
          companyId,
          oaId,
          appId: lease.app_id,
          appSecret: lease.app_secret || '',
          refreshToken: lease.refresh_token,
          tokenVersion: lease.token_version,
        },
        lease.refresh_token
      );
    } catch (err: unknown) {
      await this.abort(companyId, oaId, leaseToken, 'PROVIDER_REFRESH_FAILED');
      throw err;
    }

    const { error: completeError } = await this.supabase.rpc('zalo_complete_token_refresh', {
      p_company_id: companyId,
      p_oa_id: oaId,
      p_lease_token: leaseToken,
      p_access_token: newToken.accessToken,
      p_refresh_token: newToken.refreshToken,
      p_expires_at: new Date(newToken.expiresAt).toISOString(),
    });
    if (completeError) {
      // The provider already consumed the old refresh token; surface loudly for re-auth.
      console.error(`[SECURITY ALERT] Zalo token rotation could not be persisted for OA "${oaId}": ${completeError.message}`);
      throw new Error(`Zalo token rotation not persisted for OA ${oaId}. Re-authentication may be required.`);
    }

    return newToken;
  }

  private async abort(companyId: string, oaId: string, leaseToken: string, errorCode: string): Promise<void> {
    const { error } = await this.supabase.rpc('zalo_abort_token_refresh', {
      p_company_id: companyId,
      p_oa_id: oaId,
      p_lease_token: leaseToken,
      p_error_code: errorCode,
    });
    if (error) {
      console.error(`[Zalo TokenStore] Failed to release refresh lease for OA "${oaId}": ${error.message}`);
    }
  }

  private async waitForConcurrentRotation(
    companyId: string,
    oaId: string,
    observedVersion: number
  ): Promise<ZaloTokenInfo> {
    const attempts = this.options.leaseWaitAttempts ?? 10;
    const waitMs = this.options.leaseWaitMs ?? 500;

    for (let i = 0; i < attempts; i++) {
      await sleep(waitMs);
      const creds = await this.getCredentials(companyId, oaId);
      if (creds?.accessToken && (creds.tokenVersion ?? 0) > observedVersion) {
        return {
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken || '',
          expiresAt: creds.expiresAt ?? 0,
        };
      }
    }
    throw new Error(`Zalo token refresh for OA ${oaId} is in progress elsewhere; retry later.`);
  }
}

/**
 * In-memory token store for tests and scripts. Strictly keyed by (companyId, oaId); an unknown
 * key returns null (no cross-tenant fallback).
 */
export class InMemoryZaloTokenStore implements IZaloTokenStore {
  private readonly store = new Map<string, ZaloOACredentials>();

  constructor(initial: ZaloOACredentials[] = []) {
    for (const cred of initial) {
      this.store.set(this.compositeKey(cred.companyId, cred.oaId), { tokenVersion: 1, ...cred });
    }
  }

  private compositeKey(companyId: string, oaId: string): string {
    return `${companyId}:${oaId}`;
  }

  async getCredentials(companyId: string, oaId: string): Promise<ZaloOACredentials | null> {
    return this.store.get(this.compositeKey(companyId, oaId)) || null;
  }

  async getToken(companyId: string, oaId: string): Promise<ZaloTokenInfo | null> {
    const cred = await this.getCredentials(companyId, oaId);
    if (!cred?.accessToken) return null;
    return {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken || '',
      expiresAt: cred.expiresAt ?? 0,
    };
  }

  async rotateToken(
    companyId: string,
    oaId: string,
    refreshFn: (credentials: ZaloOACredentials, currentRefreshToken: string) => Promise<ZaloTokenInfo>
  ): Promise<ZaloTokenInfo> {
    const key = this.compositeKey(companyId, oaId);
    const cred = this.store.get(key);
    if (!cred?.refreshToken) {
      throw new Error(`Fail-closed: No refresh token stored for OA ${oaId}`);
    }
    const refreshed = await refreshFn(cred, cred.refreshToken);
    this.store.set(key, {
      ...cred,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      tokenVersion: (cred.tokenVersion ?? 1) + 1,
    });
    return refreshed;
  }
}

/**
 * @deprecated Use InMemoryZaloTokenStore.
 */
export { InMemoryZaloTokenStore as MockZaloTokenStore };
