import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import { StringeeProvider } from '../providers/stringee-provider';
import type { VoiceWebhookPayload, WebhookProcessResult } from './webhook-processor';
import { extractAndStoreCallIntake } from './intake-extractor';
import { resolveCompanyVoiceIntegration } from './integration-resolver';

type JobType = 'RECORDING_IMPORT' | 'TRANSCRIPTION' | 'INTAKE_EXTRACTION';

interface VoiceMediaJob {
  id: string;
  company_id: string;
  call_id: string;
  job_type: JobType;
  source_ref: string | null;
  attempts: number;
  max_attempts: number;
}

const BUCKET = 'call-recordings';

export function getVoiceMediaRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function getVoiceMediaFailureOutcome(currentAttempts: number, maxAttempts: number) {
  const attempts = currentAttempts + 1;
  return {
    attempts,
    terminal: attempts >= maxAttempts,
    nextRunDelayMs: getVoiceMediaRetryDelayMs(attempts),
  };
}

async function enqueueJob(
  companyId: string,
  callId: string,
  jobType: JobType,
  sourceRef: string | null
): Promise<void> {
  if (sourceRef && /^https?:\/\//i.test(sourceRef)) {
    throw new ServerAuthError('Provider URL cannot be persisted.', 400, 'INTERNAL_ERROR');
  }
  const adminClient = createAdminClient();
  const { error } = await adminClient.from('voice_media_jobs').upsert({
    company_id: companyId,
    call_id: callId,
    job_type: jobType,
    status: 'PENDING',
    source_ref: sourceRef,
    next_run_at: new Date().toISOString(),
    locked_at: null,
    last_error_code: null,
  }, { onConflict: 'company_id,call_id,job_type' });
  if (error) throw new ServerAuthError('Cannot enqueue voice media job.', 500, 'INTERNAL_ERROR');
}

/** Persist only an opaque provider recording id; provider URLs are deliberately discarded. */
export async function processRecordingReady(
  payload: VoiceWebhookPayload,
  companyId: string,
  provider: 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON' = 'STRINGEE'
): Promise<WebhookProcessResult> {
  const providerCallId = payload.provider_call_id || payload.call_id;
  if (!providerCallId) return { handled: false, message: 'provider call id missing' };

  const adminClient = createAdminClient();
  const { data: call } = await adminClient
    .from('calls')
    .select('id, company_id, provider')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .eq('provider_call_id', providerCallId)
    .maybeSingle();
  if (!call) return { handled: false, message: 'call not found' };

  const recordingId = payload.recording_id || providerCallId;
  await enqueueJob(companyId, call.id as string, 'RECORDING_IMPORT', recordingId);
  return { handled: true, message: 'recording import queued' };
}

async function importRecording(job: VoiceMediaJob): Promise<void> {
  if (!job.source_ref) throw new Error('RECORDING_SOURCE_MISSING');
  const integration = await resolveCompanyVoiceIntegration(job.company_id, 'STRINGEE');
  if (!integration?.apiKey || !integration.apiSecret || !integration.fromNumber || !integration.answerUrl) {
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }
  const provider = new StringeeProvider(integration.apiKey, integration.apiSecret, fetch, {
    fromNumber: integration.fromNumber,
    answerUrl: integration.answerUrl,
    aiAgentUserId: integration.aiAgentUserId,
    saleAgentUserId: integration.saleAgentUserId,
  });
  const recording = await provider.downloadRecording(job.source_ref);
  const extension = recording.contentType.includes('ogg') ? 'ogg'
    : recording.contentType.includes('wav') ? 'wav'
      : recording.contentType.includes('webm') ? 'webm'
        : 'mp3';
  const objectPath = `${job.company_id}/${job.call_id}/recording.${extension}`;
  const adminClient = createAdminClient();
  const { error: uploadError } = await adminClient.storage
    .from(BUCKET)
    .upload(objectPath, recording.bytes, {
      contentType: recording.contentType,
      upsert: true,
    });
  if (uploadError) throw new Error('STORAGE_UPLOAD_FAILED');

  const { error: callError } = await adminClient
    .from('calls')
    .update({ recording_ref: objectPath, transcript_status: 'PENDING' })
    .eq('id', job.call_id)
    .eq('company_id', job.company_id);
  if (callError) throw new Error('CALL_UPDATE_FAILED');
  await enqueueJob(job.company_id, job.call_id, 'TRANSCRIPTION', null);
}

interface DiarizedTranscription {
  text?: string;
  segments?: Array<{ speaker?: string; start?: number; end?: number; text?: string }>;
  language?: string;
}

async function transcribeRecording(job: VoiceMediaJob): Promise<void> {
  const integration = await resolveCompanyVoiceIntegration(job.company_id, 'OPENAI_REALTIME');
  const apiKey = integration?.apiKey;
  if (!apiKey) throw new Error('TRANSCRIPTION_NOT_CONFIGURED');
  const adminClient = createAdminClient();
  const { data: call } = await adminClient
    .from('calls')
    .select('recording_ref')
    .eq('id', job.call_id)
    .eq('company_id', job.company_id)
    .maybeSingle();
  if (!call?.recording_ref) throw new Error('RECORDING_NOT_READY');

  await adminClient.from('calls').update({ transcript_status: 'PROCESSING' })
    .eq('id', job.call_id).eq('company_id', job.company_id);
  const { data: audio, error: downloadError } = await adminClient.storage
    .from(BUCKET)
    .download(call.recording_ref as string);
  if (downloadError || !audio) throw new Error('STORAGE_DOWNLOAD_FAILED');

  const form = new FormData();
  form.set('file', audio, (call.recording_ref as string).split('/').at(-1) || 'recording.mp3');
  form.set('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe-diarize');
  form.set('language', 'vi');
  form.set('response_format', 'diarized_json');
  form.set('chunking_strategy', 'auto');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error('TRANSCRIPTION_PROVIDER_FAILED');
  const result = (await response.json()) as DiarizedTranscription;
  if (!result.text?.trim()) throw new Error('TRANSCRIPTION_EMPTY');

  const { error: transcriptError } = await adminClient.rpc('upsert_call_transcript', {
    p_company_id: job.company_id,
    p_call_id: job.call_id,
    p_transcript: result.text,
    p_speakers: result.segments || [],
    p_language: result.language || 'vi',
  });
  if (transcriptError) throw new Error('TRANSCRIPT_WRITE_FAILED');
  await adminClient.from('calls').update({ transcript_status: 'COMPLETED' })
    .eq('id', job.call_id).eq('company_id', job.company_id);
  await enqueueJob(job.company_id, job.call_id, 'INTAKE_EXTRACTION', null);
}

async function extractIntake(job: VoiceMediaJob): Promise<void> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('get_call_transcript_for_voice_worker', {
    p_company_id: job.company_id,
    p_call_id: job.call_id,
  });
  if (error) throw new Error('TRANSCRIPT_READ_FAILED');
  const row = Array.isArray(data) ? data[0] : data;
  const transcript = (row as { transcript?: string } | null)?.transcript;
  if (!transcript) throw new Error('TRANSCRIPT_NOT_READY');
  const integration = await resolveCompanyVoiceIntegration(job.company_id, 'OPENAI_REALTIME');
  if (!integration?.apiKey) throw new Error('INTAKE_EXTRACTION_NOT_CONFIGURED');
  await extractAndStoreCallIntake(job.company_id, job.call_id, transcript, integration.apiKey);
}

async function markJobFailure(job: VoiceMediaJob, error: unknown): Promise<void> {
  const adminClient = createAdminClient();
  const { attempts, terminal, nextRunDelayMs } = getVoiceMediaFailureOutcome(job.attempts, job.max_attempts);
  const code = error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)
    ? error.message
    : 'VOICE_MEDIA_JOB_FAILED';
  await adminClient.from('voice_media_jobs').update({
    status: terminal ? 'FAILED' : 'PENDING',
    attempts,
    locked_at: null,
    last_error_code: code,
    next_run_at: new Date(Date.now() + nextRunDelayMs).toISOString(),
  }).eq('id', job.id);
  if (terminal && job.job_type === 'TRANSCRIPTION') {
    await adminClient.from('calls').update({ transcript_status: 'FAILED' })
      .eq('id', job.call_id).eq('company_id', job.company_id);
  }
}

/** Claim and process due jobs. Optimistic status update prevents duplicate workers. */
export async function processDueVoiceMediaJobs(limit = 10): Promise<{ processed: number; failed: number }> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc('claim_voice_media_jobs', { p_limit: limit });
  if (error) throw new Error('VOICE_MEDIA_QUEUE_READ_FAILED');

  let processed = 0;
  let failed = 0;
  for (const row of (data || []) as VoiceMediaJob[]) {
    try {
      if (row.job_type === 'RECORDING_IMPORT') await importRecording(row);
      else if (row.job_type === 'TRANSCRIPTION') await transcribeRecording(row);
      else await extractIntake(row);
      await adminClient.from('voice_media_jobs').update({
        status: 'COMPLETED', completed_at: new Date().toISOString(), locked_at: null,
      }).eq('id', row.id);
      processed++;
    } catch (jobError) {
      await markJobFailure(row, jobError);
      failed++;
    }
  }
  return { processed, failed };
}
