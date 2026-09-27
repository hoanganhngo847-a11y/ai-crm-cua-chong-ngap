import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AiAnalysisInput,
  AiAnalysisRecord,
  AiAnalysisSourceRef,
  AiCustomerAnalysisOutput,
} from '@/shared/contracts/ai-analysis';
import { fetchAiAnalysisInput, persistAiAnalysis } from './ai-analysis-store';
import { validateAiAnalysisOutput } from './validate-ai-analysis';

/**
 * Dependency injection boundary for AI Analysis Model implementations.
 * Enforces trusted provenance: modelVersion is an immutable, environment-governed property,
 * never generated, inferred, or trusted from untrusted model output.
 */
export interface AiAnalysisModel {
  readonly modelVersion: string;
  analyze(input: AiAnalysisInput): Promise<unknown>;
}

export interface RunCustomerAnalysisPipelineParams {
  model: AiAnalysisModel;
  companyId: string;
  customerId: string;
  client: SupabaseClient;
  limit?: number;
}

export class NoAnalyzableSourcesError extends Error {
  constructor(message = 'No sanitized interactions available to perform AI customer analysis') {
    super(message);
    this.name = 'NoAnalyzableSourcesError';
  }
}

/**
 * Orchestrates the secure end-to-end customer analysis pipeline:
 * 1. Reads bounded, sanitized interaction data via service_role RPC.
 * 2. Invokes the model boundary.
 * 3. Strictly validates the untrusted model output fail-closed (omits/ignores any forged modelVersion).
 * 4. Extracts audit-safe source_refs from input interactions.
 * 5. Persists the analysis via the bounded record_ai_analysis RPC using trusted model.modelVersion.
 */
export async function runCustomerAnalysisPipeline(
  params: RunCustomerAnalysisPipelineParams
): Promise<AiAnalysisRecord> {
  const { model, companyId, customerId, client, limit } = params;

  // 1. Fetch bounded input
  const input = await fetchAiAnalysisInput(client, {
    companyId,
    customerId,
    limit,
  });

  if (input.sources.length === 0) {
    throw new NoAnalyzableSourcesError(
      `Customer ${customerId} has no sanitized interactions available for evidence-based analysis.`
    );
  }

  // 2. Untrusted model execution
  const rawOutput = await model.analyze(input);

  // 3. Strict schema and business validation (modelVersion is excluded from this result)
  const validatedAnalysis: AiCustomerAnalysisOutput = validateAiAnalysisOutput(rawOutput);

  // 4. Construct audit-safe source references from sanitized interactions
  const sourceRefs: AiAnalysisSourceRef[] = input.sources.map((source) => ({
    type: 'INTERACTION',
    id: source.interactionId,
  }));

  // 5. Append-only persistence via bounded RPC using trusted model.modelVersion
  return persistAiAnalysis(client, {
    companyId,
    customerId,
    sourceRefs,
    analysis: validatedAnalysis,
    modelVersion: model.modelVersion,
  });
}

/**
 * Fake deterministic model for unit and integration testing without external API calls.
 */
export class FakeDeterministicAiModel implements AiAnalysisModel {
  constructor(
    public readonly modelVersion: string,
    private readonly responseOrFactory:
      | unknown
      | ((input: AiAnalysisInput) => unknown | Promise<unknown>)
  ) {}

  async analyze(input: AiAnalysisInput): Promise<unknown> {
    if (typeof this.responseOrFactory === 'function') {
      return (this.responseOrFactory as (input: AiAnalysisInput) => unknown | Promise<unknown>)(
        input
      );
    }
    return this.responseOrFactory;
  }
}
