import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Custom Error for Tenant Resolution Failures.
 * Fails closed with standard HTTP-compatible status codes.
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

export interface IZaloOAMappingResolver {
  resolveCompanyId(oaId: string | undefined | null): Promise<string>;
}

export interface ZaloOAMappingServiceOptions {
  customMapping?: Record<string, string>;
  supabase?: SupabaseClient;
  allowTestMockFallback?: boolean;
}

/**
 * Zalo OA to Company Mapping Service.
 *
 * CRITICAL SECURITY INVARIANT - TENANT ISOLATION:
 * - Webhooks from external providers (Zalo OA) must NEVER trust company_id from client payload,
 *   query parameters, or headers.
 * - Multi-tenant isolation is enforced server-side by mapping the verified Zalo Official Account ID (OA ID)
 *   to the corresponding tenant (company_id).
 * - If an event arrives with an unmapped, unknown, or empty OA ID, the system MUST FAIL CLOSED (throw TenantResolutionError).
 * - No DEFAULT_COMPANY_ID fallback in production flows.
 */
export class ZaloOAMappingService implements IZaloOAMappingResolver {
  private readonly mapping: Map<string, string>;
  private readonly supabase?: SupabaseClient;
  private readonly allowTestMockFallback: boolean;

  constructor(options: ZaloOAMappingServiceOptions | Record<string, string> = {}) {
    if ('customMapping' in options || 'supabase' in options || 'allowTestMockFallback' in options) {
      const opts = options as ZaloOAMappingServiceOptions;
      this.mapping = new Map(Object.entries(opts.customMapping || {}));
      this.supabase = opts.supabase;
      this.allowTestMockFallback = opts.allowTestMockFallback ?? false;
    } else {
      this.mapping = new Map(Object.entries(options));
      this.allowTestMockFallback = false;
    }
  }

  /**
   * Registers or updates an OA ID to Company mapping in memory.
   */
  registerMapping(oaId: string, companyId: string): void {
    if (!oaId || !oaId.trim()) {
      throw new TenantResolutionError('OA ID is required to register mapping', 400);
    }
    if (!companyId || !companyId.trim()) {
      throw new TenantResolutionError('companyId is required to register mapping', 400);
    }
    this.mapping.set(oaId.trim(), companyId.trim());
  }

  /**
   * Resolves the companyId for a given Zalo OA ID.
   * Fails closed if the OA ID is not recognized or not associated with any active company.
   */
  async resolveCompanyId(oaId: string | undefined | null): Promise<string> {
    if (!oaId || typeof oaId !== 'string' || !oaId.trim()) {
      throw new TenantResolutionError(
        'Tenant isolation error: Missing or empty Zalo OA ID in webhook event',
        400
      );
    }

    const cleanOaId = oaId.trim();

    // 1. Check in-memory registered mapping
    const mappedCompanyId = this.mapping.get(cleanOaId);
    if (mappedCompanyId) {
      return mappedCompanyId;
    }

    // 2. Query persistent database table (zalo_oa_configs) if Supabase client is available
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('zalo_oa_configs')
          .select('company_id')
          .eq('oa_id', cleanOaId)
          .eq('status', 'ACTIVE')
          .maybeSingle();

        if (!error && data?.company_id) {
          this.mapping.set(cleanOaId, data.company_id);
          return data.company_id;
        }
      } catch {
        // DB query error falls through to fail-closed check
      }
    }

    // 3. ONLY allow test fallback if explicitly configured in an automated test container
    const isTestRuntime =
      process.env.NODE_ENV === 'test' && process.env.IS_TEST_SUITE === 'true';

    if (isTestRuntime && this.allowTestMockFallback && this.mapping.has('__test_fallback__')) {
      return this.mapping.get('__test_fallback__')!;
    }

    // FAIL-CLOSED: Reject unknown or unmapped OA to prevent cross-tenant leakage or spoofing
    throw new TenantResolutionError(
      `Tenant isolation violation: Zalo OA ID "${cleanOaId}" is not associated with any active company`,
      403
    );
  }
}
