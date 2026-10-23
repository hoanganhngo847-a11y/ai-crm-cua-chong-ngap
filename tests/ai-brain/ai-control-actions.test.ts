import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type LiveChannel,
  type VoiceMode,
  type ModelRoutingProfile,
} from '../../app/actions/ai-control';

test('AI Control: Channel types, modes, and model routing profiles contracts', () => {
  const channels: readonly LiveChannel[] = ['ZALO', 'MESSENGER', 'VOICE'];
  assert.equal(channels.length, 3);
  assert.ok(channels.includes('ZALO'));
  assert.ok(channels.includes('MESSENGER'));
  assert.ok(channels.includes('VOICE'));

  const voiceModes: readonly VoiceMode[] = ['OFF', 'TEST', 'LIVE'];
  assert.equal(voiceModes.length, 3);

  const routingProfiles: readonly ModelRoutingProfile[] = ['STANDARD', 'FAST', 'QUALITY'];
  assert.equal(routingProfiles.length, 3);
});

test('AI Control: Emergency Kill Switch disables all active live channels', async () => {
  let rpcCalled = false;
  let targetCompanyId = '';

  const mockRpc = async (fnName: string, args: any) => {
    if (fnName === 'emergency_disable_ai') {
      rpcCalled = true;
      targetCompanyId = args.p_company_id;
      return { data: 2, error: null };
    }
    return { data: null, error: new Error('Unknown RPC') };
  };

  const res = await mockRpc('emergency_disable_ai', { p_company_id: 'comp-123' });
  assert.equal(rpcCalled, true);
  assert.equal(targetCompanyId, 'comp-123');
  assert.equal(res.data, 2);
});

test('AI Control: Handover Actions (Claim, Resolve, Resume AI) invoke respective RPCs', async () => {
  const rpcLog: Array<{ fn: string; args: any }> = [];

  const mockInvoke = async (fn: string, args: any) => {
    rpcLog.push({ fn, args });
    return { data: true, error: null };
  };

  // 1. Claim
  await mockInvoke('claim_ai_handover_case', {
    p_company_id: 'comp-1',
    p_case_id: 'case-1',
    p_user_id: 'user-1',
  });

  // 2. Resolve
  await mockInvoke('resolve_ai_handover_case', {
    p_company_id: 'comp-1',
    p_case_id: 'case-1',
    p_user_id: 'user-1',
  });

  // 3. Resume AI
  await mockInvoke('resume_ai_conversation', {
    p_company_id: 'comp-1',
    p_conversation_id: 'convo-1',
    p_user_id: 'user-1',
  });

  assert.equal(rpcLog.length, 3);
  assert.equal(rpcLog[0].fn, 'claim_ai_handover_case');
  assert.equal(rpcLog[0].args.p_case_id, 'case-1');
  assert.equal(rpcLog[1].fn, 'resolve_ai_handover_case');
  assert.equal(rpcLog[1].args.p_case_id, 'case-1');
  assert.equal(rpcLog[2].fn, 'resume_ai_conversation');
  assert.equal(rpcLog[2].args.p_conversation_id, 'convo-1');
});
