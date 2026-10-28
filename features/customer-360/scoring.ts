import type { DossierContext } from './contracts';
import { tryToCanonicalStage } from '../crm/types/customer.types';

/** CRM rubric v1, an estimate only. Profile names and AI classifications never add points.
 * Recent inbound +20; 3 recent inbound +10; explicit purchase expression +30;
 * canonical CRM interested/deep-research/high-potential/contract stage +20/+20/+30/+40;
 * inactivity >30d -10.
 */
export function dossierLeadScore(context: DossierContext, now: number): number | null {
  const inbound = context.sources.filter(s => s.kind === 'interaction' && s.direction === 'INBOUND');
  if (!inbound.length) return null;
  const recent = inbound.filter(s => now - Date.parse(s.at) <= 7 * 86400000 && now >= Date.parse(s.at));
  let score = recent.length ? 20 : 0;
  if (recent.length >= 3) score += 10;
  if (recent.some(s => /(?:đồng ý (?:mua|đăng ký|lắp đặt)|muốn đặt (?:cọc|hàng)|tôi (?:đăng ký|chốt đơn))/i.test(s.text))) score += 30;

  const canonicalStage = tryToCanonicalStage(context.stage);
  if (canonicalStage === 'low_potential') return 0;
  if (canonicalStage === 'interested' || canonicalStage === 'deep_research') score += 20;
  if (canonicalStage === 'high_potential') score += 30;
  if (canonicalStage === 'contract_signed') score += 40;

  if (inbound.every(s => now - Date.parse(s.at) > 30 * 86400000)) score -= 10;
  return Math.max(0, Math.min(100, score));
}
