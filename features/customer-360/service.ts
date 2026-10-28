import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';
import { recordingActor } from '../zalo-recordings/access';
import { sanitizeCustomerMemory } from '../ai-brain/memory/sanitizer';
import { sanitizePhoneInText } from '../crm/utils/phone-sanitizer';
import { dossierSnapshotSchema, type DossierSnapshot } from './contracts';
import { z } from 'zod';
import { normalizePhone } from '../crm/services/customer.service';

export class DossierError extends Error {
  constructor(public readonly code: string, public readonly status = 503) { super(code); }
}
export const uuid = z.string().uuid();
export const listFilters = z.object({
  search: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(10000).default(1),
  owner: z.string().uuid().optional(), channel: z.enum(['ZALO','FACEBOOK','PHONE','EMAIL']).optional(),
  stage: z.string().max(80).optional(), sort: z.enum(['updated','name','contact','score','followup']).default('updated'),
  hot: z.enum(['1']).optional(), overdue: z.enum(['1']).optional(), recent: z.enum(['1']).optional(),
}).strict();
export type ListFilters = z.infer<typeof listFilters>;
export type DossierActor = Awaited<ReturnType<typeof recordingActor>>;
export interface CustomerRow {
  id: string; name: string; customer_code: string; stage: string; source: string; updated_at: string;
  zalo_name: string | null; facebook_name: string | null; phone: string | null; email: string | null;
  assigned_sale: string | null; assigned_sale_id: string | null; current_situation: string | null;
  last_interaction: string | null; lead_score: number | null; follow_up_at: string | null; ai_updated_at: string | null;
  assigned_sale_name?: string | null;
  sale_notes?: string | null;
  marketing_notes?: string | null;
  ai_notes?: string | null;
}
export interface TimelineEvent { id: string; kind: string; channel: string; direction: string | null; at: string; content: string | null; source_id: string }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export function sanitizeDossierText(value: string, limit = 2000): string | null {
  const bounded = value.slice(0, Math.min(limit, 4000));
  const text = sanitizePhoneInText(bounded).replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d ().-]{7,}\d/g, '[phone]').trim();
  if (!sanitizeCustomerMemory({ content: text, memoryType: 'AI_INFERENCE', verificationStatus: 'UNVERIFIED' }).safe) return null;
  return text.slice(0, limit);
}
export async function listCustomersForActor(db: SupabaseClient, actor: DossierActor, input: unknown): Promise<Page<CustomerRow>> {
  const f = listFilters.parse(input);
  let search = f.search;
  if (/^[+\d ().-]+$/.test(search)) { try { search = normalizePhone(search); } catch { /* Partial phone search. */ } }
  const { data, error } = await db.rpc('c360_list', {
    p_company_id: actor.companyId, p_search: search, p_page: f.page, p_owner: f.owner ?? null,
    p_channel: f.channel ?? null, p_stage: f.stage ?? null, p_sort: f.sort,
    p_hot: f.hot === '1', p_overdue: f.overdue === '1', p_recent: f.recent === '1',
    p_include_ai: actor.role === 'BOSS_ADMIN',
  });
  if (error || !data || !Array.isArray(data.items) || typeof data.total !== 'number') throw new DossierError('CUSTOMER_LIST_UNAVAILABLE');
  return data as Page<CustomerRow>;
}
export async function listDossierCustomers(input: unknown) {
  const actor = await recordingActor();
  return listCustomersForActor(createAdminClient(), actor, input);
}
export async function customerForActor(db: SupabaseClient, actor: DossierActor, customerId: string) {
  if (!uuid.safeParse(customerId).success) throw new DossierError('NOT_FOUND', 404);
  const { data, error } = await db.from('customers').select('id,name,customer_code,stage,source,created_at,updated_at')
    .eq('company_id', actor.companyId).eq('id', customerId).maybeSingle();
  if (error) throw new DossierError('CUSTOMER_UNAVAILABLE');
  if (!data) throw new DossierError('NOT_FOUND', 404);
  return data as { id: string; name: string; customer_code: string; stage: string; source: string; created_at: string; updated_at: string };
}
export async function getDossier(customerId: string, page = 1, filter = 'ALL') {
  const actor = await recordingActor();
  const db = createAdminClient();
  const customer = await customerForActor(db, actor, customerId);
  const boss = actor.role === 'BOSS_ADMIN';
  const responses = await Promise.all([
    db.from('customer_dossier_profiles').select('address,birth_year,special_notes,assigned_sale_id,assigned_sale_name,sale_notes,marketing_notes,ai_notes,updated_at').eq('company_id', actor.companyId).eq('customer_id', customerId).maybeSingle(),
    db.from('identities').select('channel,display_name,legacy_name:metadata->>display_name,verified').eq('company_id', actor.companyId).eq('customer_id', customerId).order('created_at').limit(30),
    db.rpc('c360_emails', { p_company_id: actor.companyId, p_customer_id: customerId }),
    db.rpc('c360_timeline', { p_company_id: actor.companyId, p_customer_id: customerId, p_page: page, p_filter: filter,
      p_staff_id: boss ? null : actor.userId, p_include_ai: boss }),
    boss ? db.from('customer_ai_snapshots').select('id,version,generated_at,snapshot,lead_score,follow_up_at').eq('company_id', actor.companyId).eq('customer_id', customerId).order('version', { ascending: false }).limit(10) : Promise.resolve({ data: [], error: null }),
    boss ? db.from('customer_dossier_refresh').select('requested_version,completed_version,lock_token,lease_until,error_code,attempts').eq('company_id', actor.companyId).eq('customer_id', customerId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    boss ? db.from('customer_identity_conflicts').select('id,status,created_at').eq('company_id', actor.companyId).eq('customer_id', customerId).eq('status', 'OPEN').limit(20) : Promise.resolve({ data: [], error: null }),
    db.rpc('c360_contacts', { p_company_id: actor.companyId, p_customer_id: customerId }),
  ]);
  if (responses.some(r => r.error)) throw new DossierError('DOSSIER_UNAVAILABLE');
  const [profile, identities, emails, timeline, versions, queue, conflicts, contacts] = responses;
  const history = (versions.data || []) as Array<{ id: string; version: number; generated_at: string; snapshot: DossierSnapshot; lead_score: number | null; follow_up_at: string | null }>;
  // Stored data still crosses a validation boundary. No silently fabricated empty snapshot.
  for (const entry of history) dossierSnapshotSchema.parse(entry.snapshot);
  const owners = await dossierOwners(db, actor.companyId);
  return { customer, profile: profile.data as { address: string | null; birth_year: number | null; special_notes: string | null; assigned_sale_id: string | null; assigned_sale_name?: string | null; sale_notes?: string | null; marketing_notes?: string | null; ai_notes?: string | null } | null,
    identities: (identities.data || []) as { channel: string; display_name: string | null; legacy_name: string | null; verified: boolean }[],
    emails: (emails.data || []) as string[], timeline: timeline.data as Page<TimelineEvent>, history,
    queue: queue.data as { requested_version: number; completed_version: number; lock_token: string | null; lease_until: string | null; error_code: string | null; attempts: number } | null,
    conflicts: (conflicts.data || []) as { id: string; status: string; created_at: string }[], owners, boss,
    contacts: contacts.data as { phone: string | null; assignedSaleId: string | null; lastInteraction: string | null },
    observedAt: new Date().toISOString() };
}
export async function dossierOwners(db: SupabaseClient, companyId: string) {
  const { data, error } = await db.from('company_members').select('user_id,user_profiles(full_name)').eq('company_id', companyId).eq('status', 'ACTIVE').in('role', ['SALE','BOSS_ADMIN']).limit(200);
  if (error) throw new DossierError('OWNERS_UNAVAILABLE');
  return (data || []).map(m => {
    const profile = (Array.isArray(m.user_profiles) ? m.user_profiles[0] : m.user_profiles) as { full_name: string } | null;
    return { id: m.user_id as string, name: profile?.full_name || 'Chưa có tên' };
  });
}
