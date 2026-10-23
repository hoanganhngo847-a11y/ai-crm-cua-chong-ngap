import 'server-only';

import type { BrainContextDataSource, BrainContextScope } from '../context-contracts';
import { sanitizeCustomerMemory } from '../memory/sanitizer';
import type {
  BrainTurnGrounding,
  GroundingBusinessFacts,
  GroundingKnowledgeItem,
  GroundingMemoryItem,
  GroundingMessageItem,
} from './contracts';

const MAX_KNOWLEDGE_ITEMS = 5;
const MAX_KNOWLEDGE_CONTENT_CHARS = 1200;
const MAX_MEMORY_ITEMS = 8;
const MAX_RECENT_MESSAGES = 6;

const STOP_WORDS = new Set([
  'cho', 'mình', 'tôi', 'em', 'anh', 'chị', 'bạn', 'shop', 'ơi', 'ạ',
  'có', 'không', 'được', 'và', 'với', 'về', 'ở', 'tại', 'là', 'của',
  'nhé', 'nha', 'hỏi', 'xin', 'cần', 'muốn', 'tư', 'vấn', 'bao', 'nhiêu',
  'như', 'thế', 'nào', 'gì', 'sao', 'sẵn', 'hàng', 'đây', 'đó'
]);

/**
 * Extracts alphanumeric search terms suitable for Postgres websearch from natural language text.
 */
function extractSearchTerms(rawText: string): string {
  const words = rawText
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, 8);

  if (words.length === 0) return 'công ty';
  return words.join(' or ');
}

/**
 * Resolves authoritative grounding context for a single Brain turn using the CRM Context Gateway.
 * Strictly scoped by company_id, customer_id, and conversation_id to guarantee zero cross-tenant leakage.
 */
export async function resolveGroundingContext(options: {
  readonly scope: BrainContextScope;
  readonly inputText: string;
  readonly dataSource: BrainContextDataSource;
}): Promise<BrainTurnGrounding> {
  const { scope, inputText, dataSource } = options;

  const searchQuery = extractSearchTerms(inputText);

  // Parallel retrieval across scoped CRM endpoints
  const [
    profile,
    conversations,
    interactions,
    memoriesRaw,
    knowledgeRaw,
    callSummaries,
    appointments,
  ] = await Promise.all([
    dataSource.getCustomerProfile(scope).catch(() => null),
    dataSource.getRecentConversations(scope).catch(() => []),
    dataSource.getRecentInteractions(scope).catch(() => []),
    dataSource.getCustomerMemory(scope).catch(() => []),
    dataSource.searchCompanyKnowledge(scope, searchQuery).catch(() => []),
    dataSource.getRecentCallSummaries(scope).catch(() => []),
    dataSource.getUpcomingAppointments(scope).catch(() => []),
  ]);

  // 1. Conversation state
  const currentConversation = (conversations || []).find((c) => c.id === scope.conversationId);
  const conversationGrounding = {
    id: scope.conversationId,
    channel: scope.channel,
    status: currentConversation?.status || 'OPEN',
    aiMode: currentConversation?.aiMode || 'ACTIVE',
    assignedTo: currentConversation?.assignedTo || null,
  };

  // 2. Customer profile
  const customerGrounding = profile
    ? {
        id: profile.id,
        name: profile.name,
        customerCode: profile.customerCode,
        stage: profile.stage,
      }
    : undefined;

  // 3. Recent messages (chronological order: oldest -> newest, max 6)
  const recentMessages: GroundingMessageItem[] = (interactions || [])
    .filter((item) => item.content && item.content.trim().length > 0)
    .slice(0, MAX_RECENT_MESSAGES)
    .map((item) => ({
      direction: item.direction === 'INBOUND' ? ('INBOUND' as const) : ('OUTBOUND' as const),
      actorType: item.actorType,
      content: item.content.trim(),
      createdAt: item.createdAt,
    }))
    .reverse(); // interactions are returned descending, so reverse to chronological

  // 4. Company knowledge (max 5 verified items)
  let knowledgeItems: GroundingKnowledgeItem[] = (knowledgeRaw || [])
    .slice(0, MAX_KNOWLEDGE_ITEMS)
    .map((k) => ({
      category: k.category,
      title: k.title,
      content: k.content.slice(0, MAX_KNOWLEDGE_CONTENT_CHARS),
    }));

  // If search returned 0 items, attempt a fallback search for general profile/policy
  if (knowledgeItems.length === 0 && searchQuery !== 'công ty') {
    try {
      const fallbackKnowledge = await dataSource.searchCompanyKnowledge(scope, 'công ty');
      knowledgeItems = (fallbackKnowledge || [])
        .slice(0, 3)
        .map((k) => ({
          category: k.category,
          title: k.title,
          content: k.content.slice(0, MAX_KNOWLEDGE_CONTENT_CHARS),
        }));
    } catch {}
  }

  // 5. Customer memories (filtered through sanitizer, max 8 items)
  const memories: GroundingMemoryItem[] = (memoriesRaw || [])
    .filter((m) => {
      const sanitized = sanitizeCustomerMemory(m);
      return sanitized.safe;
    })
    .sort((a, b) => {
      // Prioritize CONFIRMED over UNVERIFIED
      if (a.verificationStatus === 'CONFIRMED' && b.verificationStatus !== 'CONFIRMED') return -1;
      if (b.verificationStatus === 'CONFIRMED' && a.verificationStatus !== 'CONFIRMED') return 1;
      return 0;
    })
    .slice(0, MAX_MEMORY_ITEMS)
    .map((m) => ({
      type: m.memoryType,
      key: m.memoryKey,
      content: m.content,
      confidence: m.confidence,
      verified: m.verificationStatus === 'CONFIRMED',
    }));

  // 6. Business facts
  const businessFacts: GroundingBusinessFacts = {
    upcomingAppointmentsCount: appointments ? appointments.length : 0,
    lastCallSummary: callSummaries && callSummaries.length > 0 ? callSummaries[0].summary : null,
  };

  return Object.freeze({
    customer: customerGrounding,
    conversation: Object.freeze(conversationGrounding),
    recentMessages: Object.freeze(recentMessages),
    knowledge: Object.freeze(knowledgeItems),
    memories: Object.freeze(memories),
    businessFacts: Object.freeze(businessFacts),
  });
}
