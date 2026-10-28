export { classifyCustomerStage, STAGE_CLASSIFIER_VERSION } from './classify';
export { STAGE_SIGNALS, OBJECTION_SIGNALS } from './lexicon';
export {
  normalizeVietnamese,
  containsNormalizedPhrase,
  extractSentenceContaining,
  detectSignalContext,
} from './normalize';
export type {
  StageClassification,
  StageClassifierEvidence,
  StageClassifierInput,
  StageClassifierSource,
  StageClassifierSourceType,
  StageClassifierSpeaker,
  StageSignalDefinition,
} from './types';
