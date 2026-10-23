import type { DossierContext } from './contracts';

/** CRM rubric v1, an estimate only. Profile names and AI classifications never add points.
 * Recent inbound +20; 3 recent inbound +10; explicit purchase expression +30;
 * canonical CRM survey/offer/order stage +20/+30/+40; inactivity >30d -10.
 */
export function dossierLeadScore(context: DossierContext, now: number): number | null {
  const inbound = context.sources.filter(s => s.kind === 'interaction' && s.direction === 'INBOUND');
  if (!inbound.length) return null;
  const recent = inbound.filter(s => now - Date.parse(s.at) <= 7 * 86400000 && now >= Date.parse(s.at));
  let score = recent.length ? 20 : 0;
  if (recent.length >= 3) score += 10;
  if (recent.some(s => /(?:đồng ý (?:mua|đăng ký|lắp đặt)|muốn đặt (?:cọc|hàng)|tôi (?:đăng ký|chốt đơn))/i.test(s.text))) score += 30;
  if (['SURVEY_REQUESTED','SURVEY_SCHEDULED','SURVEY_COMPLETED'].includes(context.stage)) score += 20;
  if (['PRICE_CALCULATED','PRICE_OFFERED','NEGOTIATING'].includes(context.stage)) score += 30;
  if (['ORDER_CREATED','DEPOSIT_CONFIRMED','CONTRACT_SIGNED'].includes(context.stage)) score += 40;
  if (inbound.every(s => now - Date.parse(s.at) > 30 * 86400000)) score -= 10;
  if (context.stage === 'LOST') return 0;
  return Math.max(0, Math.min(100, score));
}
