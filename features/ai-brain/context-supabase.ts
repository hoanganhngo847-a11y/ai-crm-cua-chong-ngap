import 'server-only';

import { createAdminClient } from '../../lib/supabase/admin';
import type {
  BrainAppointmentContext,
  BrainCallHistoryContext,
  BrainCallSummaryContext,
  BrainCompanyKnowledgeContext,
  BrainContextDataSource,
  BrainContextScope,
  BrainConversationContext,
  BrainCustomerMemoryContext,
  BrainCustomerMemoryType,
  BrainCustomerMemoryVerification,
  BrainCustomerProfile,
  BrainInteractionContext,
  BrainStageHistoryContext,
} from './context-contracts';

const MAX_SHORT_TEXT = 512;
const MAX_MESSAGE_TEXT = 2_000;
const MAX_SUMMARY_TEXT = 3_000;
const MAX_MEMORY_TEXT = 4_000;
const MAX_KNOWLEDGE_TEXT = 12_000;
const MAX_JSON_STRING = 1_000;
const MAX_JSON_ARRAY = 20;
const MAX_JSON_KEYS = 32;
const MAX_JSON_DEPTH = 4;
const ALLOWED_MEMORY_TYPES: readonly BrainCustomerMemoryType[] = [
  'FACT', 'PREFERENCE', 'INTENT', 'OBJECTION', 'TEMPORARY_CONTEXT', 'AI_INFERENCE',
];
const ALLOWED_MEMORY_VERIFICATION: readonly BrainCustomerMemoryVerification[] = ['UNVERIFIED', 'CONFIRMED'];

function text(value: unknown, max = MAX_SHORT_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function nullableText(value: unknown, max = MAX_SHORT_TEXT): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function safeJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_JSON_STRING);
  if (Array.isArray(value)) return value.slice(0, MAX_JSON_ARRAY).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value).slice(0, MAX_JSON_KEYS)) {
      if (/token|secret|password|authorization|cookie|credential/i.test(key)) continue;
      output[key.slice(0, 128)] = safeJson(item, depth + 1);
    }
    return output;
  }
  return null;
}

function memoryType(value: unknown): BrainCustomerMemoryType {
  return typeof value === 'string' && ALLOWED_MEMORY_TYPES.includes(value as BrainCustomerMemoryType)
    ? value as BrainCustomerMemoryType
    : 'AI_INFERENCE';
}

function memoryVerification(value: unknown): BrainCustomerMemoryVerification {
  return typeof value === 'string' && ALLOWED_MEMORY_VERIFICATION.includes(value as BrainCustomerMemoryVerification)
    ? value as BrainCustomerMemoryVerification
    : 'UNVERIFIED';
}

function confidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function failClosed(error: unknown): never {
  void error;
  throw new Error('BRAIN_CONTEXT_DATASOURCE_ERROR');
}

/**
 * CRM-owned read-only source. It uses the existing server-only service-role client, but every
 * customer-bearing query explicitly binds BOTH company_id and customer_id. Service role is a DB
 * transport credential, never an authorization decision and never leaves the CRM process.
 */
export function createSupabaseBrainContextDataSource(): BrainContextDataSource {
  return Object.freeze({
    async getCustomerProfile(scope: BrainContextScope): Promise<BrainCustomerProfile | null> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('customers')
        .select('id,customer_code,name,source,stage,created_at,updated_at')
        .eq('company_id', scope.companyId)
        .eq('id', scope.customerId)
        .maybeSingle();
      if (error) failClosed(error);
      if (!data) return null;
      return Object.freeze({
        id: String(data.id),
        customerCode: nullableText(data.customer_code, 128),
        name: text(data.name, 256),
        source: nullableText(data.source, 128),
        stage: nullableText(data.stage, 128),
        createdAt: String(data.created_at),
        updatedAt: String(data.updated_at),
      });
    },

    async getRecentConversations(scope: BrainContextScope): Promise<readonly BrainConversationContext[]> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('conversations')
        .select('id,channel,last_message_at,status,assigned_to,ai_mode,created_at')
        .eq('company_id', scope.companyId)
        .eq('customer_id', scope.customerId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(8);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        channel: text(row.channel, 64),
        lastMessageAt: nullableText(row.last_message_at, 64),
        status: text(row.status, 64),
        assignedTo: nullableText(row.assigned_to, 64),
        aiMode: nullableText(row.ai_mode, 64),
        createdAt: String(row.created_at),
      })));
    },

    async getRecentInteractions(scope: BrainContextScope): Promise<readonly BrainInteractionContext[]> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('interactions')
        .select('id,conversation_id,channel,type,direction,sanitized_content,actor_type,created_at')
        .eq('company_id', scope.companyId)
        .eq('customer_id', scope.customerId)
        .in('sanitization_status', ['SUCCEEDED', 'NOT_REQUIRED'])
        .not('sanitized_content', 'is', null)
        .order('created_at', { ascending: false })
        .limit(16);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        conversationId: nullableText(row.conversation_id, 64),
        channel: text(row.channel, 64),
        type: text(row.type, 64),
        direction: text(row.direction, 64),
        content: text(row.sanitized_content, MAX_MESSAGE_TEXT),
        actorType: text(row.actor_type, 64),
        createdAt: String(row.created_at),
        untrustedContent: true as const,
      })));
    },

    async getCustomerStageHistory(scope: BrainContextScope): Promise<readonly BrainStageHistoryContext[]> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('customer_stage_histories')
        .select('id,from_stage,to_stage,actor_type,reason,changed_at')
        .eq('company_id', scope.companyId)
        .eq('customer_id', scope.customerId)
        .order('changed_at', { ascending: false })
        .limit(10);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        fromStage: nullableText(row.from_stage, 128),
        toStage: text(row.to_stage, 128),
        actorType: text(row.actor_type, 64),
        reason: nullableText(row.reason, 512),
        changedAt: String(row.changed_at),
      })));
    },

    async getUpcomingAppointments(scope: BrainContextScope): Promise<readonly BrainAppointmentContext[]> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('appointments')
        .select('id,type,start_time,assignee_id,status')
        .eq('company_id', scope.companyId)
        .eq('customer_id', scope.customerId)
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true })
        .limit(8);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        type: text(row.type, 128),
        startTime: String(row.start_time),
        assigneeId: nullableText(row.assignee_id, 64),
        status: text(row.status, 64),
      })));
    },

    async getCallHistory(scope: BrainContextScope): Promise<BrainCallHistoryContext> {
      const admin = createAdminClient();
      const [phoneResult, zaloResult] = await Promise.all([
        admin
          .from('calls')
          .select('id,direction,agent_type,started_at,ended_at,status,transcript_status')
          .eq('company_id', scope.companyId)
          .eq('customer_id', scope.customerId)
          .order('created_at', { ascending: false })
          .limit(8),
        admin
          .from('zalo_personal_calls')
          .select('id,direction,started_at,ended_at,duration_seconds,matching_status,transcript_status,summary_status')
          .eq('company_id', scope.companyId)
          .eq('customer_id', scope.customerId)
          .order('started_at', { ascending: false })
          .limit(8),
      ]);
      if (phoneResult.error) failClosed(phoneResult.error);
      if (zaloResult.error) failClosed(zaloResult.error);
      return Object.freeze({
        phone: Object.freeze((phoneResult.data || []).map((row) => Object.freeze({
          id: String(row.id),
          source: 'PHONE' as const,
          direction: text(row.direction, 64),
          agentType: text(row.agent_type, 64),
          startedAt: nullableText(row.started_at, 64),
          endedAt: nullableText(row.ended_at, 64),
          status: text(row.status, 64),
          transcriptStatus: nullableText(row.transcript_status, 64),
        }))),
        zalo: Object.freeze((zaloResult.data || []).map((row) => Object.freeze({
          id: String(row.id),
          source: 'ZALO' as const,
          direction: text(row.direction, 64),
          startedAt: String(row.started_at),
          endedAt: String(row.ended_at),
          durationSeconds: Number(row.duration_seconds || 0),
          matchingStatus: text(row.matching_status, 64),
          transcriptStatus: text(row.transcript_status, 64),
          summaryStatus: text(row.summary_status, 64),
        }))),
      });
    },

    async getRecentCallSummaries(scope: BrainContextScope): Promise<readonly BrainCallSummaryContext[]> {
      const admin = createAdminClient();
      const { data: transcriptions, error: transcriptionError } = await admin
        .from('zalo_call_transcriptions')
        .select('id,call_id,completed_at')
        .eq('company_id', scope.companyId)
        .eq('customer_id', scope.customerId)
        .eq('status', 'COMPLETED')
        .order('completed_at', { ascending: false, nullsFirst: false })
        .limit(8);
      if (transcriptionError) failClosed(transcriptionError);
      const transcriptionIds = (transcriptions || []).map((row) => String(row.id));
      if (transcriptionIds.length === 0) return Object.freeze([]);

      const { data, error } = await admin
        .from('zalo_call_ai_summaries')
        .select('id,call_id,summary,customer_needs,objections,next_actions,key_points,lead_temperature,follow_up_required,follow_up_suggested_time,follow_up_reason,confidence,completed_at')
        .eq('company_id', scope.companyId)
        .eq('status', 'COMPLETED')
        .in('transcription_id', transcriptionIds)
        .order('completed_at', { ascending: false, nullsFirst: false })
        .limit(5);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        callId: String(row.call_id),
        summary: text(row.summary, MAX_SUMMARY_TEXT),
        customerNeeds: safeJson(row.customer_needs),
        objections: safeJson(row.objections),
        nextActions: safeJson(row.next_actions),
        keyPoints: safeJson(row.key_points),
        leadTemperature: nullableText(row.lead_temperature, 64),
        followUpRequired: row.follow_up_required === true,
        followUpSuggestedTime: nullableText(row.follow_up_suggested_time, 256),
        followUpReason: nullableText(row.follow_up_reason, 1_000),
        confidence: nullableText(row.confidence, 64),
        completedAt: nullableText(row.completed_at, 64),
      })));
    },

    async getCustomerMemory(scope: BrainContextScope): Promise<readonly BrainCustomerMemoryContext[]> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('ai_customer_memories')
        .select('id,memory_type,memory_key,content,structured_value,confidence,verification_status,source_kind,source_channel,source_occurred_at,last_verified_at,updated_at')
        .eq('company_id', scope.companyId)
        .eq('customer_id', scope.customerId)
        .eq('lifecycle_status', 'ACTIVE')
        .neq('verification_status', 'REJECTED')
        .order('updated_at', { ascending: false })
        .limit(30);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        memoryType: memoryType(row.memory_type),
        memoryKey: nullableText(row.memory_key, 120),
        content: text(row.content, MAX_MEMORY_TEXT),
        structuredValue: safeJson(row.structured_value),
        confidence: confidence(row.confidence),
        verificationStatus: memoryVerification(row.verification_status),
        sourceKind: text(row.source_kind, 64),
        sourceChannel: nullableText(row.source_channel, 64),
        sourceOccurredAt: nullableText(row.source_occurred_at, 64),
        lastVerifiedAt: nullableText(row.last_verified_at, 64),
        updatedAt: String(row.updated_at),
        untrustedContent: true as const,
      })));
    },

    async searchCompanyKnowledge(scope: BrainContextScope, query: string): Promise<readonly BrainCompanyKnowledgeContext[]> {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('ai_company_knowledge')
        .select('id,category,title,content,source_type,version,updated_at')
        .eq('company_id', scope.companyId)
        .eq('verification_status', 'VERIFIED')
        .eq('lifecycle_status', 'ACTIVE')
        .textSearch('search_document', query, { type: 'websearch', config: 'simple' })
        .order('updated_at', { ascending: false })
        .limit(12);
      if (error) failClosed(error);
      return Object.freeze((data || []).map((row) => Object.freeze({
        id: String(row.id),
        category: text(row.category, 64),
        title: text(row.title, 300),
        content: text(row.content, MAX_KNOWLEDGE_TEXT),
        sourceType: text(row.source_type, 64),
        version: Number(row.version || 1),
        updatedAt: String(row.updated_at),
        verified: true as const,
      })));
    },
  });
}
