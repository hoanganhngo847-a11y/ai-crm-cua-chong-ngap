import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SalesStyleLearningInput,
  SalesStyleOutput,
  SalesStyleProfileRecord,
  SalesStyleSourceRef,
} from '@/shared/contracts/sales-style';
import { fetchSalesStyleLearningInput, persistSalesStyleProfile } from './sales-style-store';
import { validateSalesStyleOutput } from './validate-sales-style';

/**
 * Dependency injection boundary for Sales Style Learning Model implementations.
 * Enforces trusted provenance: modelVersion is an immutable, environment-governed property,
 * never generated, inferred, or accepted from untrusted model output.
 */
export interface SalesStyleModel {
  readonly modelVersion: string;
  learnStyle(input: SalesStyleLearningInput): Promise<unknown>;
}

export interface RunSalesStyleLearningPipelineParams {
  model: SalesStyleModel;
  companyId: string;
  saleUserId: string;
  client: SupabaseClient;
  limit?: number;
}

export class NoStyleLearningSourcesError extends Error {
  constructor(message = 'No sanitized outbound messages available for target sale to learn style') {
    super(message);
    this.name = 'NoStyleLearningSourcesError';
  }
}

/**
 * Orchestrates the secure end-to-end sales style learning pipeline:
 * 1. Reads bounded, sanitized outbound messages via service_role RPC.
 * 2. Invokes the model boundary.
 * 3. Strictly validates the untrusted model output fail-closed (omits/ignores any forged modelVersion).
 * 4. Extracts audit-safe source_refs from input interactions.
 * 5. Persists the DRAFT profile via bounded record_sales_style_profile RPC using trusted model.modelVersion.
 */
export async function runSalesStyleLearningPipeline(
  params: RunSalesStyleLearningPipelineParams
): Promise<SalesStyleProfileRecord> {
  const { model, companyId, saleUserId, client, limit } = params;

  // 1. Fetch bounded input
  const input = await fetchSalesStyleLearningInput(client, {
    companyId,
    saleUserId,
    limit,
  });

  if (input.sources.length === 0) {
    throw new NoStyleLearningSourcesError(
      `Sale ${saleUserId} has no sanitized outbound messages available for style learning.`
    );
  }

  // 2. Untrusted model execution
  const rawOutput = await model.learnStyle(input);

  // 3. Strict schema and business firewall validation
  const validatedStyle: SalesStyleOutput = validateSalesStyleOutput(rawOutput);

  // 4. Construct audit-safe source references from sanitized interactions
  const sourceRefs: SalesStyleSourceRef[] = input.sources.map((source) => ({
    type: 'INTERACTION',
    id: source.interactionId,
  }));

  // 5. Append-only persistence via bounded RPC using trusted model.modelVersion
  return persistSalesStyleProfile(client, {
    companyId,
    saleUserId,
    sourceRefs,
    styleOutput: validatedStyle,
    modelVersion: model.modelVersion,
  });
}

/**
 * Deterministic fake model for unit and integration testing without external API calls.
 */
export class FakeDeterministicSalesStyleModel implements SalesStyleModel {
  constructor(
    public readonly modelVersion: string,
    private readonly responseOrFactory:
      | unknown
      | ((input: SalesStyleLearningInput) => unknown | Promise<unknown>)
  ) {}

  async learnStyle(input: SalesStyleLearningInput): Promise<unknown> {
    if (typeof this.responseOrFactory === 'function') {
      return (this.responseOrFactory as (input: SalesStyleLearningInput) => unknown | Promise<unknown>)(
        input
      );
    }
    return this.responseOrFactory;
  }
}
