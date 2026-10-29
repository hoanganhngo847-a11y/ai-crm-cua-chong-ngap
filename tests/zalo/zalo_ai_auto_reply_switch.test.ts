import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isZaloAiAutoReplyEnabled,
  ZALO_AI_AUTO_REPLY_DISABLED,
} from '../../features/ai-brain/zalo-auto-reply';
import { ZaloInboxService } from '../../features/omnichannel/zalo/inbox-service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const original = process.env.ZALO_AI_AUTO_REPLY_ENABLED;
  if (value === undefined) delete process.env.ZALO_AI_AUTO_REPLY_ENABLED;
  else process.env.ZALO_AI_AUTO_REPLY_ENABLED = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env.ZALO_AI_AUTO_REPLY_ENABLED;
    else process.env.ZALO_AI_AUTO_REPLY_ENABLED = original;
  });
}

test('AI Zalo switch defaults to enabled when unset', async () => {
  await withEnv(undefined, async () => {
    assert.equal(isZaloAiAutoReplyEnabled(), true);
  });
});

test('AI Zalo switch recognises explicit off values', async () => {
  for (const value of ['false', '0', 'OFF', 'no', 'disabled', ' FALSE ']) {
    await withEnv(value, async () => {
      assert.equal(isZaloAiAutoReplyEnabled(), false, `value ${value}`);
    });
  }
  await withEnv('true', async () => {
    assert.equal(isZaloAiAutoReplyEnabled(), true);
  });
});

test('sendSystemZaloReply refuses AI sends while the kill switch is engaged', async () => {
  await withEnv('false', async () => {
    const service = new ZaloInboxService({ supabase: {} as SupabaseClient });
    const result = await service.sendSystemZaloReply(
      {
        conversationId: '33333333-3333-4333-8333-333333333333',
        content: 'Dạ em chào anh ạ',
        commandId: 'ai-live-44444444-4444-4444-8444-444444444444',
      },
      {
        kind: 'SYSTEM_WORKER',
        companyId: COMPANY_ID,
        actorType: 'AI',
        workerName: 'test-worker',
      }
    );

    assert.equal(result.success, false);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error, ZALO_AI_AUTO_REPLY_DISABLED);
  });
});
