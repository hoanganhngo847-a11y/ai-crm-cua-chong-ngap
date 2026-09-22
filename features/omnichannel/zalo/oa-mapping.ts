/**
 * Zalo OA to Company Mapping Service.
 *
 * CRITICAL SECURITY INVARIANT - TENANT ISOLATION:
 * - Webhooks from external providers (Zalo OA) must NEVER trust company_id from client payload,
 *   query parameters, or headers.
 * - Multi-tenant isolation is enforced server-side by mapping the verified Zalo Official Account ID (OA ID)
 *   to the corresponding tenant (company_id).
 * - If an event arrives with an unmapped, unknown, or empty OA ID, the system MUST FAIL CLOSED (reject).
 */

export interface IZaloOAMappingResolver {
  resolveCompanyId(oaId: string | undefined | null): Promise<string>;
}

export class ZaloOAMappingService implements IZaloOAMappingResolver {
  private readonly mapping: Map<string, string>;
  private readonly defaultCompanyId?: string;

  constructor(customMapping?: Record<string, string>, defaultCompanyId?: string) {
    this.mapping = new Map(Object.entries(customMapping || {}));
    this.defaultCompanyId = defaultCompanyId || process.env.DEFAULT_COMPANY_ID;

    // Auto-configure from environment variables if present
    const envOaId = process.env.ZALO_OA_ID?.trim();
    const envCompanyId = this.defaultCompanyId?.trim();

    if (envOaId && envCompanyId && !this.mapping.has(envOaId)) {
      this.mapping.set(envOaId, envCompanyId);
    }
  }

  /**
   * Registers or updates an OA ID to Company mapping.
   */
  registerMapping(oaId: string, companyId: string): void {
    if (!oaId || !companyId) {
      throw new Error('OA ID and companyId are required to register mapping');
    }
    this.mapping.set(oaId.trim(), companyId.trim());
  }

  /**
   * Resolves the companyId for a given Zalo OA ID.
   * Fails closed if the OA ID is not recognized or not associated with any active company.
   */
  async resolveCompanyId(oaId: string | undefined | null): Promise<string> {
    if (!oaId || !oaId.trim()) {
      throw new Error('Tenant isolation error: Missing Zalo OA ID in webhook event');
    }

    const cleanOaId = oaId.trim();
    const mappedCompanyId = this.mapping.get(cleanOaId);

    if (mappedCompanyId) {
      return mappedCompanyId;
    }

    // Fallback if a default company was explicitly provided in single-tenant environment / test setup
    if (this.defaultCompanyId) {
      return this.defaultCompanyId;
    }

    // FAIL-CLOSED: Reject unknown OA to prevent cross-tenant leakage or spoofing
    throw new Error(
      `Tenant isolation violation: Zalo OA ID "${cleanOaId}" is not associated with any active company`
    );
  }
}
