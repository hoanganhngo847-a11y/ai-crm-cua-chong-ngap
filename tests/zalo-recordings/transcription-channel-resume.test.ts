import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';
import { sha256 } from '../../features/zalo-recordings/metadata';
import { uploadRecording } from '../../features/zalo-recordings/upload';
import { audioFixture, metadataFixture, uploadRequest } from './fixture';
import type { TranscriptionProvider } from '../../features/zalo-transcription/provider';
import type { AudioTranscriptionOptions, AudioTranscriptionResult } from '../../features/zalo-transcription/types';
import {
  getTranscriptionRetryDelayMs,
  processZaloTranscriptionJob,
} from '../../features/zalo-transcription/service';

class FirstAttemptProvider implements TranscriptionProvider {
  readonly name = 'GEMINI';
  readonly model = 'gemini-3.5-transcribe';
  calls: string[] = [];

  async transcribe(
    _audioBuffer: Buffer,
    fileName: string,
    _mimeType: string,
    _options?: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResult> {
    this.calls.push(fileName);
    if (fileName === 'staff_right.m4a') {
      throw new Error('GEMINI_RATE_LIMITED');
    }
    return {
      text: 'Khách cần tư vấn',
      language: 'vi',
      segments: [
        {
          start_ms: 1000,
          end_ms: 2200,
          text: 'Khách cần tư vấn',
          confidence: 0.94,
          provider_segment_id: 'left-1',
        },
      ],
    };
  }
}

class RetryProvider implements TranscriptionProvider {
  readonly name = 'GEMINI';
  readonly model = 'gemini-3.5-transcribe';
  calls: string[] = [];

  async transcribe(
    _audioBuffer: Buffer,
    fileName: string,
    _mimeType: string,
    _options?: AudioTranscriptionOptions
  ): Promise<AudioTranscriptionResult> {
    this.calls.push(fileName);
    if (fileName === 'customer_left.m4a') {
      throw new Error('LEFT_SHOULD_NOT_BE_RETRANSCRIBED');
    }
    return {
      text: 'Nhân viên đã tiếp nhận',
      language: 'vi',
      segments: [
        {
          start_ms: 3000,
          end_ms: 4300,
          text: 'Nhân viên đã tiếp nhận',
          confidence: 0.97,
          provider_segment_id: 'right-1',
        },
      ],
    };
  }
}

async function main() {
  console.log('--- Zalo Transcription Durable Channel Resume Tests ---');

  assert.equal(getTranscriptionRetryDelayMs(1), 30_000);
  assert.equal(getTranscriptionRetryDelayMs(2), 60_000);
  assert.equal(getTranscriptionRetryDelayMs(1, 'GEMINI_RATE_LIMITED'), 75_000);
  assert.equal(getTranscriptionRetryDelayMs(2, 'GEMINI_RATE_LIMITED'), 150_000);
  assert.equal(getTranscriptionRetryDelayMs(20, 'GEMINI_RATE_LIMITED'), 60 * 60 * 1000);
  console.log('[PASS] Rate-limit backoff is 75s/150s while ordinary retry remains 30s/60s');

  const harness = await createPgliteSupabase();
  const db = harness.db;

  try {
    const companyId = randomUUID();
    const bossId = randomUUID();
    const saleId = randomUUID();
    const deviceId = randomUUID();
    const deviceSecret = 'r'.repeat(44);

    await db.query(`INSERT INTO companies(id, name) VALUES($1, 'Resume Test Company')`, [companyId]);
    for (const [userId, role] of [
      [bossId, 'BOSS_ADMIN'],
      [saleId, 'SALE'],
    ]) {
      await db.query(`INSERT INTO auth.users(id) VALUES($1)`, [userId]);
      await db.query(
        `INSERT INTO user_profiles(id, full_name) VALUES($1, 'Resume User') ON CONFLICT(id) DO NOTHING`,
        [userId]
      );
      await db.query(
        `INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')`,
        [companyId, userId, role]
      );
    }

    const register = await harness.client.rpc('zalo_manage_device', {
      p_company: companyId,
      p_actor: bossId,
      p_device: deviceId,
      p_name: 'Resume Test Mac',
      p_hash: sha256(deviceSecret),
      p_staff: saleId,
    });
    assert.ifError(register.error);

    const objects = new Map<string, Buffer>();
    const adminClient = Object.assign(harness.client, {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: Buffer) => {
            objects.set(path, body);
            await db.query(
              `INSERT INTO storage.objects(bucket_id, name, metadata) VALUES($1, $2, $3)`,
              [bucket, path, JSON.stringify({ size: body.length })]
            );
            return { error: null };
          },
          download: async (path: string) => {
            const object = objects.get(path);
            if (!object) return { data: null, error: { message: 'Object not found' } };
            return { data: new Blob([new Uint8Array(object)]), error: null };
          },
        }),
      },
    }) as unknown as SupabaseClient;

    const recording = audioFixture();
    const metadata = metadataFixture(deviceId, 'Khách Resume');
    const uploaded = await uploadRecording(uploadRequest(metadata, recording, deviceSecret), adminClient);
    const callId = uploaded.call_id;

    const firstClaim = (await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 1,
      p_locked_by: 'resume_test_first',
      p_lease_seconds: 300,
    })).data as any[];
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0].call_id, callId);
    const transcriptionId = firstClaim[0].id as string;

    const firstProvider = new FirstAttemptProvider();
    const failureStartedAt = Date.now();
    await assert.rejects(
      processZaloTranscriptionJob(firstClaim[0], {
        client: adminClient,
        provider: firstProvider,
        splitAudioFn: async () => ({
          customerAudio: Buffer.from('left-audio'),
          staffAudio: Buffer.from('right-audio'),
          customerSilent: false,
          staffSilent: false,
          channelLayout: 'stereo (Left=remote/customer, Right=local/staff)',
        }),
      }),
      /GEMINI_RATE_LIMITED/
    );
    assert.deepEqual(firstProvider.calls, ['customer_left.m4a', 'staff_right.m4a']);

    const checkpointRows = (await db.query<{
      channel: string;
      provider: string;
      model: string;
      segments: unknown;
    }>(
      `SELECT channel, provider, model, segments
       FROM public.zalo_call_transcription_channel_checkpoints
       WHERE company_id = $1 AND transcription_id = $2
       ORDER BY channel`,
      [companyId, transcriptionId]
    )).rows;
    assert.equal(checkpointRows.length, 1, 'LEFT must be durably checkpointed before RIGHT failure');
    assert.equal(checkpointRows[0].channel, 'LEFT');
    assert.equal(checkpointRows[0].provider, 'GEMINI');
    assert.equal(checkpointRows[0].model, 'gemini-3.5-transcribe');

    const failedAttempt = (await db.query<{
      status: string;
      attempts: number;
      error_code: string;
      next_run_at: string;
    }>(
      `SELECT status, attempts, error_code, next_run_at
       FROM public.zalo_call_transcriptions WHERE id = $1`,
      [transcriptionId]
    )).rows[0];
    assert.equal(failedAttempt.status, 'PENDING');
    assert.equal(failedAttempt.attempts, 1);
    assert.equal(failedAttempt.error_code, 'GEMINI_RATE_LIMITED');
    const retryDelay = new Date(failedAttempt.next_run_at).getTime() - failureStartedAt;
    assert.ok(retryDelay >= 70_000, `Rate-limit retry must wait about 75s, got ${retryDelay}ms`);
    assert.ok(retryDelay <= 95_000, `Rate-limit retry unexpectedly too far away: ${retryDelay}ms`);
    console.log('[PASS] LEFT checkpoint survives RIGHT rate limit and schedules longer retry');

    await db.query(`UPDATE public.zalo_call_transcriptions SET next_run_at = now() WHERE id = $1`, [transcriptionId]);
    const secondClaim = (await adminClient.rpc('zalo_claim_transcription_jobs', {
      p_limit: 1,
      p_locked_by: 'resume_test_second',
      p_lease_seconds: 300,
    })).data as any[];
    assert.equal(secondClaim.length, 1);
    assert.equal(secondClaim[0].id, transcriptionId);

    const secondProvider = new RetryProvider();
    await processZaloTranscriptionJob(secondClaim[0], {
      client: adminClient,
      provider: secondProvider,
      splitAudioFn: async () => ({
        customerAudio: Buffer.from('left-audio'),
        staffAudio: Buffer.from('right-audio'),
        customerSilent: false,
        staffSilent: false,
        channelLayout: 'stereo (Left=remote/customer, Right=local/staff)',
      }),
    });

    assert.deepEqual(
      secondProvider.calls,
      ['staff_right.m4a'],
      'Retry must reuse LEFT checkpoint and call the provider only for RIGHT'
    );

    const finalTx = (await db.query<{ status: string; full_transcript: string }>(
      `SELECT status, full_transcript FROM public.zalo_call_transcriptions WHERE id = $1`,
      [transcriptionId]
    )).rows[0];
    assert.equal(finalTx.status, 'COMPLETED');
    assert.match(finalTx.full_transcript, /Khách cần tư vấn/);
    assert.match(finalTx.full_transcript, /Nhân viên đã tiếp nhận/);

    const utterances = (await db.query<{
      sequence: number;
      speaker_role: string;
      channel: string;
      text: string;
    }>(
      `SELECT sequence, speaker_role, channel, text
       FROM public.zalo_call_transcript_utterances
       WHERE transcription_id = $1 ORDER BY sequence`,
      [transcriptionId]
    )).rows;
    assert.deepEqual(
      utterances.map((row) => [row.sequence, row.speaker_role, row.channel, row.text]),
      [
        [1, 'CUSTOMER', 'LEFT', 'Khách cần tư vấn'],
        [2, 'STAFF', 'RIGHT', 'Nhân viên đã tiếp nhận'],
      ]
    );
    console.log('[PASS] Retry calls only unfinished RIGHT and final transcript merges both channels correctly');

    for (const role of ['anon', 'authenticated', 'service_role']) {
      const privileges = (await db.query<{ can_select: boolean; can_insert: boolean; can_update: boolean }>(
        `SELECT
           has_table_privilege($1, 'public.zalo_call_transcription_channel_checkpoints', 'select') AS can_select,
           has_table_privilege($1, 'public.zalo_call_transcription_channel_checkpoints', 'insert') AS can_insert,
           has_table_privilege($1, 'public.zalo_call_transcription_channel_checkpoints', 'update') AS can_update`,
        [role]
      )).rows[0];
      assert.equal(privileges.can_select, false, `${role} must not SELECT checkpoint table directly`);
      assert.equal(privileges.can_insert, false, `${role} must not INSERT checkpoint table directly`);
      assert.equal(privileges.can_update, false, `${role} must not UPDATE checkpoint table directly`);
    }

    for (const signature of [
      'public.zalo_get_transcription_channel_checkpoints(uuid,uuid,uuid)',
      'public.zalo_upsert_transcription_channel_checkpoint(uuid,uuid,uuid,text,jsonb,text,text,text)',
    ]) {
      const privileges = (await db.query<{ service_exec: boolean; anon_exec: boolean; auth_exec: boolean }>(
        `SELECT
           has_function_privilege('service_role', $1, 'execute') AS service_exec,
           has_function_privilege('anon', $1, 'execute') AS anon_exec,
           has_function_privilege('authenticated', $1, 'execute') AS auth_exec`,
        [signature]
      )).rows[0];
      assert.equal(privileges.service_exec, true);
      assert.equal(privileges.anon_exec, false);
      assert.equal(privileges.auth_exec, false);
    }

    const staleCheckpoint = await adminClient.rpc('zalo_upsert_transcription_channel_checkpoint', {
      p_company: companyId,
      p_transcription_id: transcriptionId,
      p_lock_token: secondClaim[0].lock_token,
      p_channel: 'RIGHT',
      p_segments: [],
      p_language: 'vi',
      p_provider: 'GEMINI',
      p_model: 'gemini-3.5-transcribe',
    });
    assert.ok(staleCheckpoint.error);
    assert.match(staleCheckpoint.error!.message, /TRANSCRIPTION_LOCK_LOST/);
    console.log('[PASS] Checkpoint RPCs are service-only and stale lock tokens are fenced');

    console.log('ALL TRANSCRIPTION CHANNEL RESUME TESTS PASSED');
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  console.error('FATAL CHANNEL RESUME TEST ERROR:', error);
  process.exit(1);
});
