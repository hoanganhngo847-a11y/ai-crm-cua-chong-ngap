import 'server-only';

import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AiAnalysisInput, AiAnalysisRecord } from '@/shared/contracts/ai-analysis';
import {
  type AiAnalysisModel,
  runCustomerAnalysisPipeline,
  NoAnalyzableSourcesError,
} from './ai-analysis-engine';
import {
  AI_CUSTOMER_ANALYSIS_SYSTEM_PROMPT,
  buildAiAnalysisUserPrompt,
} from './analysis-prompt';

export { NoAnalyzableSourcesError };

/**
 * Production OpenAI implementation for Customer Journey Analysis.
 * Model version is strictly governed by environment or constructor option,
 * never inferred or trusted from LLM output.
 */
export class OpenAiCustomerAnalysisModel implements AiAnalysisModel {
  public readonly modelVersion: string;
  private readonly openai: OpenAI;

  constructor(options?: { modelVersion?: string; apiKey?: string; client?: OpenAI }) {
    this.modelVersion =
      options?.modelVersion ||
      process.env.AI_ANALYSIS_MODEL_VERSION ||
      'gpt-4o-mini';
    this.openai =
      options?.client ||
      new OpenAI({
        apiKey: options?.apiKey || process.env.OPENAI_API_KEY || 'dummy_test_key',
      });
  }

  async analyze(input: AiAnalysisInput): Promise<unknown> {
    const userPrompt = buildAiAnalysisUserPrompt(input);

    const response = await this.openai.chat.completions.create({
      model: this.modelVersion,
      messages: [
        { role: 'system', content: AI_CUSTOMER_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned empty analysis content');
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`Failed to parse OpenAI JSON output: ${content}`);
    }
  }
}

export interface ExecuteCustomerAnalysisParams {
  companyId: string;
  customerId: string;
  model?: AiAnalysisModel;
  limit?: number;
  client?: SupabaseClient;
}

/**
 * Server-only trusted entrypoint executing customer analysis pipeline.
 *
 * Enforces:
 * 1. Multi-tenant companyId + customerId scoping.
 * 2. Ingestion of sanitized customer MESSAGE interactions only.
 * 3. Customer stage immutability: customers.stage is never mutated.
 * 4. Model-forged modelVersion is rejected and overwritten with trusted model.modelVersion.
 */
export async function executeCustomerAnalysis(
  params: ExecuteCustomerAnalysisParams
): Promise<AiAnalysisRecord> {
  const {
    companyId,
    customerId,
    model = new OpenAiCustomerAnalysisModel(),
    limit = 50,
    client = createAdminClient(),
  } = params;

  return runCustomerAnalysisPipeline({
    companyId,
    customerId,
    model,
    limit,
    client,
  });
}
