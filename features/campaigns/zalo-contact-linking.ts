import 'server-only';
import { createAdminClient } from '../../lib/supabase/admin';
import { fetchZcaJsContacts, getZaloTransportMode } from '../omnichannel/zalo/zcajs-client';
import { recordingActor } from '../zalo-recordings/access';

export interface PersonalZaloContactCandidate {
  id: string;
  display_name: string | null;
  last_seen_at: string;
}

async function listUnlinked(companyId: string): Promise<PersonalZaloContactCandidate[]> {
  const { data, error } = await createAdminClient()
    .from('zalo_personal_contact_candidates')
    .select('id,display_name,last_seen_at')
    .eq('company_id', companyId)
    .eq('status', 'UNLINKED')
    .is('linked_customer_id', null)
    .order('last_seen_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error('ZALO_CONTACT_CANDIDATES_UNAVAILABLE');
  return (data || []).map((row) => ({
    id: row.id,
    display_name: row.display_name || null,
    last_seen_at: row.last_seen_at,
  }));
}

export async function syncPersonalZaloContactCandidates(): Promise<{
  candidates: PersonalZaloContactCandidate[];
  seen: number;
  autoLinked: number;
}> {
  const actor = await recordingActor(true);
  if (getZaloTransportMode() !== 'ZCAJS') throw new Error('ZCAJS_TRANSPORT_DISABLED');

  const contacts = await fetchZcaJsContacts(actor.companyId);
  const { data, error } = await createAdminClient().rpc('sync_zalo_personal_contacts', {
    p_company: actor.companyId,
    p_contacts: contacts,
  });
  if (error) throw new Error('ZALO_CONTACT_SYNC_FAILED');

  const result = (data || {}) as Record<string, unknown>;
  return {
    candidates: await listUnlinked(actor.companyId),
    seen: Number(result.seen || 0),
    autoLinked: Number(result.auto_linked || 0),
  };
}

export async function listPersonalZaloContactCandidates(): Promise<PersonalZaloContactCandidate[]> {
  const actor = await recordingActor(true);
  return listUnlinked(actor.companyId);
}

export async function linkPersonalZaloContactToCustomer(input: {
  candidateId: string;
  customerId: string;
}): Promise<{ identityId: string; conversationId: string }> {
  const actor = await recordingActor(true);
  const candidateId = input.candidateId.trim();
  const customerId = input.customerId.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(candidateId) || !uuid.test(customerId)) throw new Error('INVALID_LINK_REQUEST');

  const { data, error } = await createAdminClient().rpc('link_zalo_personal_contact', {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_candidate: candidateId,
    p_customer: customerId,
  });
  if (error || !data) {
    const code = String(error?.message || 'ZALO_CONTACT_LINK_FAILED');
    if (code.includes('IDENTITY_CONFLICT') || code.includes('CONVERSATION_CONFLICT')) {
      throw new Error('ZALO_CONTACT_ALREADY_LINKED_ELSEWHERE');
    }
    throw new Error('ZALO_CONTACT_LINK_FAILED');
  }

  const result = data as Record<string, unknown>;
  const identityId = typeof result.identity_id === 'string' ? result.identity_id : '';
  const conversationId = typeof result.conversation_id === 'string' ? result.conversation_id : '';
  if (!identityId || !conversationId) throw new Error('ZALO_CONTACT_LINK_FAILED');
  return { identityId, conversationId };
}
