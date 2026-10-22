import 'server-only';
import type { BrainProposal, BrainTurnRequest } from './types';

/**
 * Fast deterministic policy evaluation.
 * Aligns strictly with CRM service precedence (features/ai-brain/service.ts):
 * - If conversationState === 'HANDOVER_REQUIRED' => HANDOVER (precedence before allowDrafts)
 * - If allowDrafts === false or conversationState === 'AI_PAUSED' => NO_REPLY (confidence: 1.0)
 * - If HUMAN_ACTIVE or AI_ACTIVE with allowDrafts === true => returns null (proceeds to model)
 */
export function evaluateTurnPolicy(request: BrainTurnRequest): BrainProposal | null {
  if (request.policy.conversationState === 'HANDOVER_REQUIRED') {
    return Object.freeze({
      decision: 'HANDOVER',
      handoverReason: 'CONVERSATION_STATE_HANDOVER_REQUIRED',
      confidence: 1.0,
    });
  }

  if (!request.policy.allowDrafts || request.policy.conversationState === 'AI_PAUSED') {
    return Object.freeze({
      decision: 'NO_REPLY',
      confidence: 1.0,
    });
  }

  return null;
}
