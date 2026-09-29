import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Tenant resolution failure for an unknown / inactive OA. Fails closed (403 by default).
 */
export class TenantResolutionError extends Error {
  readonly code = 'TENANT_NOT_FOUND';
  readonly httpStatus: number;

  constructor(message: string, httpStatus = 403) {
    super(message);
    this.name = 'TenantResolutionError';
    this.httpStatus = httpStatus;
  }
}

/**
 * The tenant lookup itself failed (DB unavailable). Not a verdict on the OA: the webhook must
 * answer 503 so Zalo retries, instead of 403 which would drop the event permanently.
 */
export class TenantLookupUnavailableError extends Error {
  readonly code = 'TENANT_LOOKUP_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(message: string) {
    super(message);
    this.name = 'TenantLookupUnavailableError';
  }
}

export interface ZaloOATenant {
  companyId: string;
  oaId: string;
  appId: string | null;
  webhookSecret: string | null;
}

export interface IZaloOAMappingResolver {
  resolveTenant(oaId: string | undefined | null): Promise<ZaloOATenant>;
  resolveCompanyId(oaId: string | undefined | null): Promise<string>;
}

interface ResolveTenantRow {
  company_id: string;
  app_id: string | null;
  webhook_secret: string | null;
}

/**
 * Zalo OA → Company mapping.
 *
 * CRITICAL SECURITY INVARIANT - TENANT ISOLATION:
 * - company_id is NEVER taken from the payload, query string or headers.
 * - The verified OA id is mapped server-side via zalo_oa_configs (ACTIVE OA, ACTIVE company).
 * - Unknown / empty OA fails closed (TenantResolutionError). There is no default company.
 */
export class ZaloOAMappingService implements IZaloOAMappingResolver {
  private readonly staticTenants: Map<string, ZaloOATenant>;

  /**
   * @param supabase service-role client used for the zalo_resolve_oa_tenant RPC.
   * @param staticTenants optional explicit OA → tenant entries (tests / fixtures only).
   */
  constructor(
    private readonly supabase: SupabaseClient | null,
    staticTenants: ZaloOATenant[] = []
  ) {
    this.staticTenants = new Map(staticTenants.map((t) => [t.oaId, t]));
  }

  async resolveTenant(oaId: string | undefined | null): Promise<ZaloOATenant> {
    if (!oaId || typeof oaId !== 'string' || !oaId.trim()) {
      throw new TenantResolutionError('Tenant isolation error: Missing or empty Zalo OA ID in webhook event', 400);
    }
    const cleanOaId = oaId.trim();

    const staticTenant = this.staticTenants.get(cleanOaId);
    if (staticTenant) {
      return staticTenant;
    }

    if (!this.supabase) {
      throw new TenantResolutionError(`Zalo OA "${cleanOaId}" is not associated with any active company`, 403);
    }

    const { data, error } = await this.supabase.rpc('zalo_resolve_oa_tenant', { p_oa_id: cleanOaId });
    if (error) {
      throw new TenantLookupUnavailableError(`Zalo OA tenant lookup failed: ${error.message}`);
    }

    const row = (Array.isArray(data) ? data[0] : data) as ResolveTenantRow | undefined;
    if (!row?.company_id) {
      throw new TenantResolutionError(
        `Tenant isolation violation: Zalo OA ID "${cleanOaId}" is not associated with any active company`,
        403
      );
    }

    return {
      companyId: row.company_id,
      oaId: cleanOaId,
      appId: row.app_id,
      webhookSecret: row.webhook_secret,
    };
  }

  async resolveCompanyId(oaId: string | undefined | null): Promise<string> {
    return (await this.resolveTenant(oaId)).companyId;
  }
}
