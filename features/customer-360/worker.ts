import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import { JavisBrainProvider } from '../ai-brain/javis-provider';
import { DOSSIER_CONTRACT, dossierContextSchema, freezeDossierContext, validateDossierSnapshot, type DossierContext, type DossierSnapshot, type DossierSource } from './contracts';
import { sanitizeDossierText } from './service';
import { dossierLeadScore } from './scoring';

export async function buildDossierContext(db: SupabaseClient, companyId: string, customerId: string, watermark: number): Promise<DossierContext> {
  const [customer, messages, transcripts, previous, profile] = await Promise.all([
    db.from('customers').select('name,stage,updated_at').eq('company_id', companyId).eq('id', customerId).single(),
    db.from('interactions').select('id,sanitized_content,created_at,direction').eq('company_id', companyId).eq('customer_id', customerId)
      .in('sanitization_status', ['SUCCEEDED','NOT_REQUIRED']).not('sanitized_content', 'is', null).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(20),
    db.from('zalo_call_transcriptions').select('id,call_id,full_transcript,completed_at,zalo_personal_calls!inner(customer_id)')
      .eq('company_id', companyId).eq('customer_id', customerId).eq('zalo_personal_calls.customer_id', customerId).eq('status', 'COMPLETED')
      .order('completed_at', { ascending: false }).limit(3),
    db.from('customer_ai_snapshots').select('id,snapshot,generated_at').eq('company_id', companyId).eq('customer_id', customerId).order('version', { ascending: false }).limit(1),
    db.from('customer_dossier_profiles').select('special_notes,updated_at').eq('company_id', companyId).eq('customer_id', customerId).maybeSingle(),
  ]);
  if ([customer, messages, transcripts, previous, profile].some(r => r.error) || !customer.data) throw new Error('DOSSIER_CONTEXT_UNAVAILABLE');
  const sources: DossierSource[] = [];
  function add(id: string, kind: DossierSource['kind'], raw: string | null, at: string, limit: number, direction?: 'INBOUND' | 'OUTBOUND') {
    const text = raw ? sanitizeDossierText(raw, limit) : null;
    if (text) sources.push({ id, kind, text, at, ...(direction ? { direction } : {}) });
  }
  add(`profile:${customerId}`, 'profile', customer.data.name, customer.data.updated_at, 200);
  if (profile.data) add(`profile-note:${customerId}`, 'profile', profile.data.special_notes, profile.data.updated_at, 1000);
  const prior = previous.data?.[0];
  if (prior) add(`snapshot:${prior.id}`, 'snapshot', JSON.stringify(prior.snapshot), prior.generated_at, 2000);
  for (const m of messages.data || []) add(`interaction:${m.id}`, 'interaction', m.sanitized_content, m.created_at, 700, m.direction as 'INBOUND' | 'OUTBOUND');
  for (const t of transcripts.data || []) add(`transcript:${t.id}`, 'transcript', t.full_transcript, t.completed_at, 1600);
  const result = dossierContextSchema.parse({ version: DOSSIER_CONTRACT, companyId, customerId, watermark, stage: customer.data.stage, sources });
  if (Buffer.byteLength(JSON.stringify(result)) > 30 * 1024) throw new Error('DOSSIER_CONTEXT_TOO_LARGE');
  return freezeDossierContext(result);
}
export interface DossierProvider { runDossier(context: DossierContext, options: { signal: AbortSignal }): Promise<DossierSnapshot> }
export async function processDossierRefresh(options: { db?: SupabaseClient; companyId?: string; customerId?: string; provider?: DossierProvider } = {}) {
  // Separate opt-in from all messaging/shadow settings. Never call a provider while disabled.
  if (process.env.CUSTOMER_DOSSIER_ENABLED !== 'true') return { status: 'DISABLED' } as const;
  const db = options.db ?? createAdminClient();
  const { data, error } = await db.rpc('c360_claim_refresh', { p_company_id: options.companyId ?? null, p_customer_id: options.customerId ?? null });
  if (error) throw new Error('DOSSIER_CLAIM_FAILED');
  const job = data?.[0];
  if (!job) return { status: 'IDLE' } as const;
  let snapshot: DossierSnapshot | null = null;
  let leadScore: number | null = null;
  try {
    const context = await buildDossierContext(db, job.company_id, job.customer_id, Number(job.claimed_version));
    leadScore = dossierLeadScore(context, Date.now());
    const provider = options.provider ?? new JavisBrainProvider({ baseUrl: process.env.JAVIS_BRAIN_BASE_URL || '', authToken: process.env.JAVIS_BRAIN_AUTH_TOKEN || process.env.JAVIS_BRAIN_INTERNAL_TOKEN || '' });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('DOSSIER_TIMEOUT')); }, 30000); });
      snapshot = validateDossierSnapshot(await Promise.race([provider.runDossier(context, { signal: controller.signal }), timeout]), context);
    } finally { if (timer) clearTimeout(timer); }
  } catch { /* Preserve prior snapshot; never log model/customer/error text. */ }
  const finished = await db.rpc('c360_finish_refresh', { p_company_id: job.company_id, p_customer_id: job.customer_id,
    p_token: job.lock_token, p_version: job.claimed_version, p_snapshot: snapshot, p_model: 'javis-router-v1', p_lead_score: leadScore });
  if (finished.error) throw new Error('DOSSIER_FINISH_FAILED');
  return { status: finished.data === true ? 'COMPLETED' : snapshot ? 'SUPERSEDED' : 'FAILED' } as const;
}
