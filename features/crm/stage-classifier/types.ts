import type { CanonicalCustomerStage } from '../../crm/types/customer.types';

export const STAGE_CLASSIFIER_VERSION = 'stage-rules-v1';

export type StageClassifierSpeaker = 'CUSTOMER' | 'STAFF' | 'UNKNOWN';

export type StageClassifierSourceType = 'INTERACTION' | 'CALL_TRANSCRIPT_UTTERANCE';

/**
 * Một nguồn dữ liệu đã được làm sạch để phân loại.
 * `content` phải là nội dung đã sanitize, không chứa số điện thoại hay raw payload.
 */
export interface StageClassifierSource {
  id: string;
  sourceType: StageClassifierSourceType;
  channel: string;
  speaker: StageClassifierSpeaker;
  content: string;
  occurredAt: string;
}

export interface StageClassifierCustomer {
  stage: string;
  source: string;
}

export interface StageClassifierInput {
  customer: StageClassifierCustomer;
  sources: StageClassifierSource[];
}

export interface StageClassifierEvidence {
  quote: string;
  source: string;
  occurredAt: string | null;
  speaker: StageClassifierSpeaker;
  signal: string;
  stage: CanonicalCustomerStage;
  weight: number;
}

export interface StageClassification {
  suggestedStage: CanonicalCustomerStage;
  currentStage: CanonicalCustomerStage | null;
  confidence: number;
  reason: string;
  evidence: string;
  evidenceItems: StageClassifierEvidence[];
  objections: string[];
  nextAction: string;
  requiresVerification: boolean;
  sourceRuleApplied: boolean;
  classifierVersion: string;
  scores: Record<CanonicalCustomerStage, number>;
}

export interface StageSignalDefinition {
  id: string;
  stage: CanonicalCustomerStage;
  weight: number;
  kind: 'INTENT' | 'RESEARCH' | 'COMMITMENT' | 'CONTRACT' | 'NEGATIVE' | 'OBJECTION' | 'SOURCE';
  patterns: string[];
  description: string;
}
