import 'server-only';
import { randomUUID } from 'node:crypto';
import type {
  BrainContextSelector, BrainDelivery, BrainErrorCode, BrainServerContext, BrainService,
  BrainServiceOptions, BrainTurnAudit, BrainTurnRequest, BrainTurnResult,
} from './contracts';
import {
  BrainBoundaryError, boundaryErrorCode, deepFreeze, validateProviderDescriptor,
  validateProviderProposal, validateServerContext, validateUntrustedInput,
} from './validation';

/** No default authorization resolver and no production caller are supplied by this module. */
export function createBrainService(options: BrainServiceOptions): BrainService {
  return { async handleBrainTurn(raw: unknown): Promise<BrainTurnResult> {
    const started = performance.now();
    const turnId = randomUUID();
    const fallbackTrace = randomUUID();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let context: BrainServerContext | undefined;
    let providerId = 'system';
    let modelId = 'none';
    let stage: 'input' | 'context' | 'provider' = 'input';
    const finish = (fields: Pick<BrainTurnResult, 'decision' | 'confidence' | 'handoverRequired'> &
      Partial<Pick<BrainTurnResult, 'draft' | 'delivery' | 'handoverReason' | 'errorCode'>>): BrainTurnResult => {
      const common = {
        version: 'v1' as const, turnId, traceId: context?.traceId ?? fallbackTrace,
        provider: providerId, model: modelId, toolsUsed: [], memoryReferences: [], sourceReferences: [],
        latencyMs: Math.max(0, performance.now() - started), ...fields,
      };
      const audit: BrainTurnAudit = {
        companyId: context?.companyId ?? null, customerId: context?.customerId ?? null,
        conversationId: context?.conversationId ?? null, channel: context?.channel ?? null,
        modality: context?.modality ?? null, turnId, traceId: common.traceId,
        provider: providerId, model: modelId, latencyMs: common.latencyMs,
        decision: common.decision, handoverRequired: common.handoverRequired,
        toolsUsed: [], memoryReferences: [], sourceReferences: [], errorCode: common.errorCode,
      };
      return deepFreeze({ ...common, audit });
    };
    try {
      const input = validateUntrustedInput(raw);
      if (!options || typeof options.resolveContext !== 'function') throw new BrainBoundaryError('BRAIN_INVALID_CONTEXT');
      const budget = options.timeoutMs ?? (input.latency === 'REALTIME' ? 1500 : 5000);
      if (!Number.isFinite(budget) || budget < 1 || budget > 30000) throw new BrainBoundaryError('BRAIN_INVALID_CONTEXT');
      const deadline = started + budget;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BrainBoundaryError('BRAIN_TIMEOUT'));
        }, Math.max(0, deadline - performance.now()));
      });
      const checkDeadline = () => {
        if (controller.signal.aborted || performance.now() >= deadline) {
          controller.abort();
          throw new BrainBoundaryError('BRAIN_TIMEOUT');
        }
      };
      // Promise.race observes late rejections. Every await has a deadline check; a late
      // resolver never continues into provider invocation after the handler times out.
      const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        checkDeadline();
        const value = await Promise.race([Promise.resolve().then(operation), timeout]);
        checkDeadline();
        return value;
      };
      const selector: BrainContextSelector = deepFreeze({
        customerId: input.customerId, conversationId: input.conversationId,
        channel: input.channel, modality: input.modality, sessionId: input.sessionId,
      });
      stage = 'context';
      const resolved = await bounded(() => options.resolveContext(selector, { signal: controller.signal }));
      context = validateServerContext(resolved, selector);
      if (context.conversationState === 'HANDOVER_REQUIRED') {
        return finish({ decision: 'HANDOVER', confidence: 1, handoverRequired: true,
          handoverReason: 'CONVERSATION_STATE_HANDOVER_REQUIRED' });
      }
      if (!context.allowDrafts) return finish({ decision: 'NO_REPLY', confidence: 1, handoverRequired: false });
      if (!options.provider) throw new BrainBoundaryError('BRAIN_UNAVAILABLE');
      const provider = options.provider;
      stage = 'provider';
      const descriptor = validateProviderDescriptor(provider.descriptor);
      providerId = descriptor.id;
      modelId = descriptor.model;
      const request: BrainTurnRequest = deepFreeze({
        version: 'v1', turnId, traceId: context.traceId,
        scope: { companyId: context.companyId, customerId: context.customerId,
          conversationId: context.conversationId, channel: context.channel,
          modality: context.modality, sessionId: context.sessionId },
        policy: { permissionProfile: 'READ_ONLY', conversationState: context.conversationState, allowDrafts: context.allowDrafts },
        input: { text: input.input.text }, latencyProfile: input.latency ?? 'STANDARD',
        ...(context.grounding ? { grounding: context.grounding } : {}),
      });
      // Throws from provider code are always provider failures, including forged internal
      // error classes. Only this service's deadline can select the timeout code.
      let proposalRaw: unknown;
      try { proposalRaw = await bounded(() => provider.runTurn(request, { signal: controller.signal })); }
      catch { throw new BrainBoundaryError(controller.signal.aborted ? 'BRAIN_TIMEOUT' : 'BRAIN_PROVIDER_ERROR'); }
      const proposal = validateProviderProposal(proposalRaw);
      const deliveryMode: BrainDelivery =
        context?.deliveryMode === 'LIVE_SEND' && context.channel === 'ZALO'
          ? 'LIVE_SEND'
          : 'DRAFT_ONLY';
      return finish({
        decision: proposal.decision, confidence: proposal.confidence,
        handoverRequired: proposal.decision === 'HANDOVER', handoverReason: proposal.handoverReason,
        ...(proposal.decision === 'RESPOND' ? { delivery: deliveryMode, draft: proposal.draft } : {}),
      });
    } catch (error: unknown) {
      const code: BrainErrorCode = controller.signal.aborted ? 'BRAIN_TIMEOUT' :
        boundaryErrorCode(error) ?? (
        stage === 'provider' ? 'BRAIN_PROVIDER_ERROR' : 'BRAIN_INVALID_CONTEXT');
      return finish({ decision: 'ERROR', confidence: 0, handoverRequired: true, errorCode: code });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  } };
}
