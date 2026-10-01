import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import {
  executeAiResponseRuntime,
  type ExecuteAiResponseRuntimeResult,
  type AiResponseModel,
  type OutboundProviderSender,
} from './ai-response-runtime';

export interface ProcessDueResponseSlaOptions {
  limit?: number;
  companyId?: string;
  model?: AiResponseModel;
  providerSender?: OutboundProviderSender;
}

export interface ProcessDueResponseSlaSummary {
  totalDue: number;
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{
    windowId: string;
    companyId: string;
    success: boolean;
    providerStatus?: string;
    error?: string;
  }>;
}

/**
 * Production Automation Worker:
 * Scans for overdue OPEN Response SLA windows and executes canonical AI response runtime.
 *
 * Lifecycle:
 * due OPEN SLA window -> trusted worker -> claimResponseSlaForAi -> execute AI generation -> canonical outbound dispatch
 */
export async function processDueResponseSlaWindows(
  options: ProcessDueResponseSlaOptions = {}
): Promise<ProcessDueResponseSlaSummary> {
  const admin = createAdminClient();
  const limit = options.limit || 20;

  // 1. Query due OPEN SLA windows via security definer RPC
  const { data: dueWindows, error: queryErr } = await admin.rpc(
    'get_due_response_sla_windows' as never,
    {
      p_company_id: options.companyId || null,
      p_limit: limit,
    } as never
  );

  if (queryErr) {
    throw new Error(`Failed to query due Response SLA windows: ${queryErr.message}`);
  }

  const windows = (dueWindows as Array<{
    id: string;
    company_id: string;
    conversation_id: string;
    customer_id: string;
    deadline_at: string;
    ai_claim_expires_at: string | null;
  }>) || [];

  const summary: ProcessDueResponseSlaSummary = {
    totalDue: windows.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    results: [],
  };

  for (const win of windows) {
    summary.processed++;
    try {
      const res: ExecuteAiResponseRuntimeResult = await executeAiResponseRuntime({
        companyId: win.company_id,
        windowId: win.id,
        model: options.model,
        providerSender: options.providerSender,
        client: admin,
      });

      if (res.success) {
        summary.succeeded++;
      } else {
        summary.failed++;
      }

      summary.results.push({
        windowId: win.id,
        companyId: win.company_id,
        success: res.success,
        providerStatus: res.providerStatus,
        error: res.error,
      });
    } catch (err: unknown) {
      summary.failed++;
      summary.results.push({
        windowId: win.id,
        companyId: win.company_id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
