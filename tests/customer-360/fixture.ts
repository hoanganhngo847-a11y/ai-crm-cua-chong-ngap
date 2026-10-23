import type { DossierContext, DossierSnapshot } from '../../features/customer-360/contracts';
export const companyId = 'cc360000-0000-4000-8000-000000000001';
export const customerId = 'cc360000-0000-4000-8000-000000000002';
export const context: DossierContext = { version: 'dossier-v1', companyId, customerId, watermark: 1, stage: 'LEAD_NEW', sources: [
  { id: 'interaction:cc360000-0000-4000-8000-000000000003', kind: 'interaction', text: 'Tôi quan tâm cửa chống ngập. Tôi lo chi phí lắp đặt.', at: '2026-10-23T10:00:00Z', direction: 'INBOUND' },
] };
export const snapshot: DossierSnapshot = {
  summary: { text: 'Tôi quan tâm cửa chống ngập.', sourceId: context.sources[0].id },
  currentSituation: { text: 'Tôi lo chi phí lắp đặt.', sourceId: context.sources[0].id },
  intent: [{ text: 'cửa chống ngập', sourceId: context.sources[0].id }],
  interests: [], painPoints: [], objections: [{ text: 'lo chi phí', sourceId: context.sources[0].id }],
  positiveSignals: [], customerCommitments: [], salesCommitments: [], riskFlags: [],
  nextActions: [{ action: 'REVIEW_BLOCKER', sourceId: context.sources[0].id }], confidence: 0.7,
  evidence: [context.sources[0].id],
};
