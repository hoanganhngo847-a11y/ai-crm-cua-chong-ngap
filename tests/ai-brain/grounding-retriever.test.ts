import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type {
  BrainContextDataSource,
  BrainContextScope,
  BrainConversationContext,
  BrainCustomerMemoryContext,
  BrainCustomerProfile,
  BrainInteractionContext,
  BrainCompanyKnowledgeContext,
} from '../../features/ai-brain/context-contracts';
import { resolveGroundingContext } from '../../features/ai-brain/grounding/retriever';

const FIXTURE_COMPANY_ID = '00000000-0000-4000-8000-000000000078';
const FIXTURE_CUSTOMER_ID = '00000000-0000-4000-8000-000000000079';
const FIXTURE_CONVERSATION_ID = '00000000-0000-4000-8000-00000000007a';

function createMockDataSource(overrides: Partial<BrainContextDataSource> = {}): BrainContextDataSource {
  return {
    async getCustomerProfile(scope: BrainContextScope): Promise<BrainCustomerProfile | null> {
      if (scope.companyId !== FIXTURE_COMPANY_ID || scope.customerId !== FIXTURE_CUSTOMER_ID) return null;
      return {
        id: FIXTURE_CUSTOMER_ID,
        customerCode: 'CUST-001',
        name: 'Nguyễn Văn A',
        source: 'ZALO',
        stage: 'LEAD_NEW',
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
      };
    },
    async getRecentConversations(scope: BrainContextScope): Promise<readonly BrainConversationContext[]> {
      if (scope.companyId !== FIXTURE_COMPANY_ID || scope.customerId !== FIXTURE_CUSTOMER_ID) return [];
      return [
        {
          id: scope.conversationId,
          channel: 'ZALO',
          lastMessageAt: '2026-10-23T01:00:00.000Z',
          status: 'OPEN',
          assignedTo: null,
          aiMode: 'ACTIVE',
          createdAt: '2026-10-23T00:00:00.000Z',
        },
      ];
    },
    async getRecentInteractions(scope: BrainContextScope): Promise<readonly BrainInteractionContext[]> {
      if (scope.companyId !== FIXTURE_COMPANY_ID || scope.customerId !== FIXTURE_CUSTOMER_ID) return [];
      // Returned in descending order (newest first)
      return [
        {
          id: 'int-3',
          conversationId: scope.conversationId,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: 'INBOUND',
          content: 'Giá máy ép Hurom H400 bao nhiêu?',
          actorType: 'CUSTOMER',
          createdAt: '2026-10-23T01:02:00.000Z',
          untrustedContent: true,
        },
        {
          id: 'int-2',
          conversationId: scope.conversationId,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: 'OUTBOUND',
          content: 'Chào anh, em có thể hỗ trợ gì cho anh ạ?',
          actorType: 'AI',
          createdAt: '2026-10-23T01:01:00.000Z',
          untrustedContent: true,
        },
        {
          id: 'int-1',
          conversationId: scope.conversationId,
          channel: 'ZALO',
          type: 'MESSAGE',
          direction: 'INBOUND',
          content: 'Alo shop ơi',
          actorType: 'CUSTOMER',
          createdAt: '2026-10-23T01:00:00.000Z',
          untrustedContent: true,
        },
      ];
    },
    async getCustomerStageHistory(): Promise<readonly never[]> {
      return [];
    },
    async getUpcomingAppointments(): Promise<readonly never[]> {
      return [];
    },
    async getCallHistory(): Promise<{ readonly phone: readonly never[]; readonly zalo: readonly never[] }> {
      return { phone: [], zalo: [] };
    },
    async getRecentCallSummaries(): Promise<readonly never[]> {
      return [];
    },
    async getCustomerMemory(): Promise<readonly BrainCustomerMemoryContext[]> {
      return [
        {
          id: 'mem-1',
          memoryType: 'PREFERENCE',
          memoryKey: 'color_preference',
          content: 'Khách thích màu xám titan hoặc đen',
          structuredValue: { color: 'gray' },
          confidence: 0.9,
          verificationStatus: 'CONFIRMED',
          sourceKind: 'INTERACTION',
          sourceChannel: 'ZALO',
          sourceOccurredAt: '2026-10-23T00:00:00.000Z',
          lastVerifiedAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-23T00:00:00.000Z',
          untrustedContent: true,
        },
        {
          id: 'mem-leak',
          memoryType: 'FACT',
          memoryKey: 'secret_info',
          content: 'Mật khẩu wifi nhà khách: Pass123456',
          structuredValue: null,
          confidence: 0.8,
          verificationStatus: 'UNVERIFIED',
          sourceKind: 'MANUAL',
          sourceChannel: null,
          sourceOccurredAt: null,
          lastVerifiedAt: null,
          updatedAt: '2026-10-23T00:00:00.000Z',
          untrustedContent: true,
        },
      ];
    },
    async searchCompanyKnowledge(_scope, query: string): Promise<readonly BrainCompanyKnowledgeContext[]> {
      if (query.toLowerCase().includes('hurom')) {
        return [
          {
            id: 'know-1',
            category: 'PRODUCT',
            title: 'Máy ép chậm Hurom H400',
            content: 'Hurom H400 động cơ 150W, công nghệ ép chậm 90 vòng/phút, giá niêm yết 11.500.000 VNĐ, bảo hành 10 năm.',
            sourceType: 'CRM',
            version: 1,
            updatedAt: '2026-10-23T00:00:00.000Z',
            verified: true,
          },
        ];
      }
      return [
        {
          id: 'know-default',
          category: 'COMPANY_PROFILE',
          title: 'Giới thiệu công ty',
          content: 'Công ty phân phối gia dụng cao cấp chính hãng, mở cửa từ 8:00 đến 21:00 hàng ngày.',
          sourceType: 'CRM',
          version: 1,
          updatedAt: '2026-10-23T00:00:00.000Z',
          verified: true,
        },
      ];
    },
    ...overrides,
  };
}

test('Grounding Retriever: builds complete authoritative context from scoped data sources', async () => {
  const scope: BrainContextScope = {
    companyId: FIXTURE_COMPANY_ID,
    customerId: FIXTURE_CUSTOMER_ID,
    conversationId: FIXTURE_CONVERSATION_ID,
    channel: 'ZALO',
    traceId: randomUUID(),
  };

  const dataSource = createMockDataSource();
  const grounding = await resolveGroundingContext({
    scope,
    inputText: 'Cho mình hỏi giá máy ép Hurom H400 nhé',
    dataSource,
  });

  // 1. Customer verification
  assert.equal(grounding.customer?.id, FIXTURE_CUSTOMER_ID);
  assert.equal(grounding.customer?.name, 'Nguyễn Văn A');
  assert.equal(grounding.customer?.stage, 'LEAD_NEW');

  // 2. Conversation verification
  assert.equal(grounding.conversation?.id, FIXTURE_CONVERSATION_ID);
  assert.equal(grounding.conversation?.aiMode, 'ACTIVE');
  assert.equal(grounding.conversation?.channel, 'ZALO');

  // 3. Chronological recent messages (oldest -> newest)
  assert.equal(grounding.recentMessages.length, 3);
  assert.equal(grounding.recentMessages[0].content, 'Alo shop ơi');
  assert.equal(grounding.recentMessages[1].content, 'Chào anh, em có thể hỗ trợ gì cho anh ạ?');
  assert.equal(grounding.recentMessages[2].content, 'Giá máy ép Hurom H400 bao nhiêu?');

  // 4. Company knowledge matches query
  assert.equal(grounding.knowledge.length, 1);
  assert.equal(grounding.knowledge[0].title, 'Máy ép chậm Hurom H400');
  assert.match(grounding.knowledge[0].content, /11\.500\.000 VNĐ/);

  // 5. Customer memories filtered: password leak is blocked
  assert.equal(grounding.memories.length, 1);
  assert.equal(grounding.memories[0].key, 'color_preference');
  assert.match(grounding.memories[0].content, /màu xám titan/);
  assert.equal(grounding.memories[0].verified, true);
});

test('Grounding Retriever: falls back to company profile when specific search returns zero results', async () => {
  const scope: BrainContextScope = {
    companyId: FIXTURE_COMPANY_ID,
    customerId: FIXTURE_CUSTOMER_ID,
    conversationId: FIXTURE_CONVERSATION_ID,
    channel: 'ZALO',
    traceId: randomUUID(),
  };

  const dataSource = createMockDataSource({
    async searchCompanyKnowledge(_scope, query: string): Promise<readonly BrainCompanyKnowledgeContext[]> {
      if (query === 'công ty') {
        return [
          {
            id: 'know-profile',
            category: 'COMPANY_PROFILE',
            title: 'Hồ sơ công ty',
            content: 'Giờ làm việc: 8:00 - 17:30',
            sourceType: 'CRM',
            version: 1,
            updatedAt: '2026-10-23T00:00:00.000Z',
            verified: true,
          },
        ];
      }
      return [];
    },
  });

  const grounding = await resolveGroundingContext({
    scope,
    inputText: 'Xin chào',
    dataSource,
  });

  assert.equal(grounding.knowledge.length, 1);
  assert.equal(grounding.knowledge[0].title, 'Hồ sơ công ty');
  assert.match(grounding.knowledge[0].content, /8:00 - 17:30/);
});

test('Grounding Retriever: isolates tenant and customer scope (returns null/empty for mismatched scope)', async () => {
  const mismatchedScope: BrainContextScope = {
    companyId: '00000000-0000-4000-8000-999999999999',
    customerId: '00000000-0000-4000-8000-999999999999',
    conversationId: randomUUID(),
    channel: 'ZALO',
    traceId: randomUUID(),
  };

  const dataSource = createMockDataSource();
  const grounding = await resolveGroundingContext({
    scope: mismatchedScope,
    inputText: 'Alo',
    dataSource,
  });

  assert.equal(grounding.customer, undefined);
  assert.equal(grounding.conversation?.aiMode, 'ACTIVE');
  assert.equal(grounding.recentMessages.length, 0);
});
