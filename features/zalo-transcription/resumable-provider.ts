import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { logTranscriptionEvent } from './logger';
import type { TranscriptionProvider } from './provider';
import type {
  AudioChannel,
  AudioTranscriptionOptions,
  AudioTranscriptionResult,
  ClaimedTranscriptionJob,
  RawUtteranceSegment,
} from './types';

interface ChannelCheckpointRow {
  channel: AudioChannel;
  segments: RawUtteranceSegment[];
  language?: string;
  provider: string;
  model: string;
}

function fileNameToChannel(fileName: string): AudioChannel | null {
  if (fileName === 'customer_left.m4a') return 'LEFT';
  if (fileName === 'staff_right.m4a') return 'RIGHT';
  return null;
}

function normalizeCheckpointSegments(value: unknown): RawUtteranceSegment[] {
  if (!Array.isArray(value) || value.length > 10000) {
    throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
  }

  return value.map((segment) => {
    if (!segment || typeof segment !== 'object') {
      throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
    }

    const raw = segment as Record<string, unknown>;
    const startMs = Number(raw.start_ms);
    const endMs = Number(raw.end_ms);
    const text = raw.text;
    const confidence = raw.confidence;
    const providerSegmentId = raw.provider_segment_id;

    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs < startMs ||
      typeof text !== 'string' ||
      (confidence !== undefined && confidence !== null &&
        (!Number.isFinite(Number(confidence)) || Number(confidence) < 0 || Number(confidence) > 1)) ||
      (providerSegmentId !== undefined && providerSegmentId !== null && typeof providerSegmentId !== 'string')
    ) {
      throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
    }

    return {
      start_ms: Math.round(startMs),
      end_ms: Math.round(endMs),
      text,
      confidence: confidence === undefined || confidence === null ? null : Number(confidence),
      provider_segment_id:
        providerSegmentId === undefined || providerSegmentId === null ? null : providerSegmentId,
    };
  });
}

function isLockLost(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string' &&
      (error as { message: string }).message.includes('TRANSCRIPTION_LOCK_LOST')
  );
}

async function loadMatchingCheckpoints(options: {
  client: SupabaseClient;
  job: ClaimedTranscriptionJob;
  provider: string;
  model: string;
}): Promise<Map<AudioChannel, ChannelCheckpointRow>> {
  const { data, error } = await options.client.rpc('zalo_get_transcription_channel_checkpoints', {
    p_company: options.job.company_id,
    p_transcription_id: options.job.id,
    p_lock_token: options.job.lock_token,
  });

  if (error) {
    if (isLockLost(error)) throw new Error('TRANSCRIPTION_LOCK_LOST');
    throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
  }

  const rows = Array.isArray(data) ? data : [];
  const checkpoints = new Map<AudioChannel, ChannelCheckpointRow>();

  for (const value of rows) {
    if (!value || typeof value !== 'object') {
      throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
    }

    const row = value as Record<string, unknown>;
    if (row.provider !== options.provider || row.model !== options.model) {
      continue;
    }
    if (row.channel !== 'LEFT' && row.channel !== 'RIGHT') {
      throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
    }
    if (row.language !== null && row.language !== undefined && typeof row.language !== 'string') {
      throw new Error('LOAD_CHANNEL_CHECKPOINT_FAILED');
    }

    checkpoints.set(row.channel, {
      channel: row.channel,
      segments: normalizeCheckpointSegments(row.segments),
      language: typeof row.language === 'string' ? row.language : undefined,
      provider: options.provider,
      model: options.model,
    });
  }

  return checkpoints;
}

async function persistCheckpoint(options: {
  client: SupabaseClient;
  job: ClaimedTranscriptionJob;
  channel: AudioChannel;
  result: AudioTranscriptionResult;
  provider: string;
  model: string;
}): Promise<void> {
  const { data, error } = await options.client.rpc('zalo_upsert_transcription_channel_checkpoint', {
    p_company: options.job.company_id,
    p_transcription_id: options.job.id,
    p_lock_token: options.job.lock_token,
    p_channel: options.channel,
    p_segments: options.result.segments,
    p_language: options.result.language || null,
    p_provider: options.provider,
    p_model: options.model,
  });

  if (error || data !== true) {
    if (isLockLost(error)) throw new Error('TRANSCRIPTION_LOCK_LOST');
    throw new Error('PERSIST_CHANNEL_CHECKPOINT_FAILED');
  }

  logTranscriptionEvent({
    action: 'channel_checkpoint_saved',
    company_id: options.job.company_id,
    call_id: options.job.call_id,
    transcription_id: options.job.id,
    channel: options.channel,
    provider: options.provider,
    model: options.model,
    utterances_count: options.result.segments.length,
  });
}

/**
 * Decorates the provider with durable per-channel resume semantics.
 * A completed LEFT/RIGHT result is checkpointed before returning to the service,
 * so a later failure on the other channel does not consume provider quota again.
 */
export async function createResumableTranscriptionProvider(options: {
  client: SupabaseClient;
  job: ClaimedTranscriptionJob;
  provider: TranscriptionProvider;
  safeProvider: string;
  safeModel: string;
}): Promise<TranscriptionProvider> {
  const checkpoints = await loadMatchingCheckpoints({
    client: options.client,
    job: options.job,
    provider: options.safeProvider,
    model: options.safeModel,
  });

  return {
    name: options.provider.name,
    model: options.provider.model,
    async transcribe(
      audioBuffer: Buffer,
      fileName: string,
      mimeType: string,
      transcriptionOptions?: AudioTranscriptionOptions
    ): Promise<AudioTranscriptionResult> {
      const channel = fileNameToChannel(fileName);
      if (!channel) {
        return options.provider.transcribe(audioBuffer, fileName, mimeType, transcriptionOptions);
      }

      const checkpoint = checkpoints.get(channel);
      if (checkpoint) {
        logTranscriptionEvent({
          action: 'channel_checkpoint_reused',
          company_id: options.job.company_id,
          call_id: options.job.call_id,
          transcription_id: options.job.id,
          channel,
          provider: options.safeProvider,
          model: options.safeModel,
          utterances_count: checkpoint.segments.length,
        });
        return {
          text: checkpoint.segments.map((segment) => segment.text).join(' ').trim(),
          language: checkpoint.language,
          segments: checkpoint.segments,
        };
      }

      const result = await options.provider.transcribe(
        audioBuffer,
        fileName,
        mimeType,
        transcriptionOptions
      );

      await persistCheckpoint({
        client: options.client,
        job: options.job,
        channel,
        result,
        provider: options.safeProvider,
        model: options.safeModel,
      });

      checkpoints.set(channel, {
        channel,
        segments: result.segments,
        language: result.language,
        provider: options.safeProvider,
        model: options.safeModel,
      });

      return result;
    },
  };
}
