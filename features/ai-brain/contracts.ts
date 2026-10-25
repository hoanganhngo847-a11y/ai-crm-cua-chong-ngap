import type { ProviderFailureCode } from './provider-failure';
import 'server-only';

import type { BrainTurnGrounding } from './grounding/contracts';

export type { BrainTurnGrounding };

export type BrainChannel = 'MESSENGER' | 'ZALO' | 'PHONE' | 'WEB' | 'INTERNAL';
export const ALLOWED_BRAIN_CHANNELS: readonly BrainChannel[] = [
  'MESSENGER',
  'ZALO',
  'PHONE',
  'WEB',
  'INTERNAL',
] as const;

export type BrainModality = 'TEXT' | 'VOICE';
export const ALLOWED_BRAIN_MODALITIES: readonly BrainModality[] = [
  'TEXT',
  'VOICE',
] as const;

export type BrainLatencyProfile = 'STANDARD' | 'REALTIME';
export const ALLOWED_BRAIN_LATENCIES: readonly BrainLatencyProfile[] = [
  'STANDARD',
  'REALTIME',
] as const;

export type BrainCapability = 'READ_ONLY' | 'SAFE_WRITE' | 'HUMAN_APPROVAL_REQUIRED';
export const ALLOWED_BRAIN_CAPABILITIES: readonly BrainCapability[] = [
  'READ_ONLY',
  'SAFE_WRITE',
  'HUMAN_APPROVAL_REQUIRED',
] as const;

export type BrainConversationState =
  | 'AI_ACTIVE'
  | 'HUMAN_ACTIVE'
  | 'AI_PAUSED'
  | 'HANDOVER_REQUIRED';
export const ALLOWED_CONVERSATION_STATES: readonly BrainConversationState[] = [
  'AI_ACTIVE',
  'HUMAN_ACTIVE',
  'AI_PAUSED',
  'HANDOVER_REQUIRED',
] as const;

export type BrainDecision = 'RESPOND' | 'HANDOVER' | 'NO_REPLY' | 'ERROR';
export const ALLOWED_BRAIN_DECISIONS: readonly BrainDecision[] = [
  'RESPOND',
  'HANDOVER',
  'NO_REPLY',
  'ERROR',
] as const;

export type BrainDelivery = 'DRAFT_ONLY' | 'LIVE_SEND';
export const ALLOWED_BRAIN_DELIVERIES: readonly BrainDelivery[] = [
  'DRAFT_ONLY',
  'LIVE_SEND',
] as const;

export type BrainErrorCode =
  | ProviderFailureCode
  | 'BRAIN_UNAVAILABLE'
  | 'BRAIN_TIMEOUT'
  | 'BRAIN_POLICY_DENIED'
  | 'BRAIN_INVALID_CONTEXT'
  | 'BRAIN_PROVIDER_ERROR';
export const ALLOWED_BRAIN_ERROR_CODES: readonly BrainErrorCode[] = [
  'BRAIN_CONFIG_MISSING', 'BRAIN_AUTH_FAILED', 'BRAIN_HTTP_ERROR', 'BRAIN_REQUEST_INVALID', 'RUNTIME_REQUEST_INVALID',
  'RUNTIME_AUTH_FAILED', 'RUNTIME_HTTP_ERROR', 'MODEL_PROVIDER_ERROR',
  'MODEL_RATE_LIMIT', 'MODEL_TIMEOUT', 'MODEL_CONFIG_INVALID',
  'BRAIN_UNAVAILABLE',
  'BRAIN_TIMEOUT',
  'BRAIN_POLICY_DENIED',
  'BRAIN_INVALID_CONTEXT',
  'BRAIN_PROVIDER_ERROR',
] as const;

export type BrainActorType = 'USER' | 'SYSTEM' | 'WORKLOAD' | 'AGENT';
export const ALLOWED_ACTOR_TYPES: readonly BrainActorType[] = [
  'USER',
  'SYSTEM',
  'WORKLOAD',
  'AGENT',
] as const;

export interface BrainCallerIdentity {
  readonly actorId: string;
  readonly actorType: BrainActorType;
}

/**
 * Untrusted payload submitted to handleBrainTurn.
 * Strictly validated before any processing.
 */
export interface BrainUntrustedInput {
  readonly customerId: string;
  readonly conversationId: string;
  readonly channel: BrainChannel;
  readonly modality: BrainModality;
  readonly input: {
    readonly text: string;
  };
  readonly sessionId?: string;
  readonly latency?: BrainLatencyProfile;
  readonly requestedCapability?: BrainCapability;
}

/**
 * Narrow selector passed to the trusted server context resolver.
 * Note: Customer input text is EXCLUDED to prevent untrusted content from altering scope.
 */
export interface BrainContextSelector {
  readonly customerId: string;
  readonly conversationId: string;
  readonly channel: BrainChannel;
  readonly modality: BrainModality;
  readonly sessionId?: string;
}

/**
 * Server context returned by the trusted injected resolver.
 */
export interface BrainServerContext {
  readonly companyId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly channel: BrainChannel;
  readonly modality: BrainModality;
  readonly sessionId?: string;
  readonly caller: BrainCallerIdentity;
  readonly permissionProfile: BrainCapability;
  readonly conversationState: BrainConversationState;
  readonly allowDrafts: boolean;
  readonly deliveryMode?: BrainDelivery;
  readonly traceId: string;
  readonly grounding?: BrainTurnGrounding;
}

/**
 * Server context resolver function signature.
 * Injected server function, never supplied by payload or provider.
 */
export type BrainContextResolver = (
  selector: BrainContextSelector,
  options: { readonly signal: AbortSignal }
) => Promise<BrainServerContext>;

/**
 * Normalized immutable request provided to provider.
 * Deeply frozen before passing to runTurn.
 */
export interface BrainTurnRequest {
  readonly version: 'v1';
  readonly turnId: string;
  readonly traceId: string;
  readonly scope: {
    readonly companyId: string;
    readonly customerId: string;
    readonly conversationId: string;
    readonly channel: BrainChannel;
    readonly modality: BrainModality;
    readonly sessionId?: string;
  };
  readonly policy: {
    readonly permissionProfile: 'READ_ONLY';
    readonly conversationState: BrainConversationState;
    readonly allowDrafts: boolean;
  };
  readonly input: {
    readonly text: string;
  };
  readonly latencyProfile: BrainLatencyProfile;
  readonly grounding?: BrainTurnGrounding;
}

/**
 * Server-registered provider descriptor.
 */
export interface BrainProviderDescriptor {
  readonly id: string;
  readonly model: string;
}

/**
 * Validated provider proposal structure.
 */
export interface BrainProposal {
  readonly decision: 'RESPOND' | 'HANDOVER' | 'NO_REPLY';
  readonly draft?: string;
  readonly handoverReason?: string;
  readonly confidence: number;
  readonly toolsUsed?: readonly never[];
  readonly memoryReferences?: readonly never[];
  readonly sourceReferences?: readonly never[];
}

/**
 * Provider interface.
 */
export interface BrainProvider {
  readonly descriptor: BrainProviderDescriptor;
  runTurn(
    request: BrainTurnRequest,
    options: { signal: AbortSignal }
  ): Promise<unknown>;
}

/**
 * Normalized result of handleBrainTurn.
 */
export interface BrainTurnResult {
  readonly audit: BrainTurnAudit;
  readonly version: 'v1';
  readonly turnId: string;
  readonly traceId: string;
  readonly decision: BrainDecision;
  readonly delivery?: BrainDelivery;
  readonly draft?: string;
  readonly confidence: number;
  readonly handoverRequired: boolean;
  readonly handoverReason?: string;
  readonly provider: string;
  readonly model: string;
  readonly toolsUsed: readonly string[];
  readonly memoryReferences: readonly string[];
  readonly sourceReferences: readonly string[];
  readonly errorCode?: BrainErrorCode;
  readonly latencyMs: number;
}

/**
 * Minimal server-owned audit projection.
 * Contains only server IDs and non-sensitive audit metadata.
 * NO raw text, draft, errors, tokens, or CoT.
 */
export interface BrainTurnAudit {
  readonly companyId: string | null;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly channel: BrainChannel | null;
  readonly modality: BrainModality | null;
  readonly turnId: string;
  readonly traceId: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly decision: BrainDecision;
  readonly handoverRequired: boolean;
  readonly toolsUsed: readonly string[];
  readonly memoryReferences: readonly string[];
  readonly sourceReferences: readonly string[];
  readonly errorCode?: BrainErrorCode;
}

export interface BrainServiceOptions {
  readonly resolveContext: BrainContextResolver;
  readonly provider?: BrainProvider;
  readonly timeoutMs?: number;
}

export interface BrainService {
  handleBrainTurn(untrustedInput: unknown): Promise<BrainTurnResult>;
}
