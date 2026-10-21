export type TranscriptionStatus = 'NOT_STARTED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type SpeakerRole = 'STAFF' | 'CUSTOMER';
export type AudioChannel = 'LEFT' | 'RIGHT';

export interface RawUtteranceSegment {
  start_ms: number;
  end_ms: number;
  text: string;
  confidence?: number | null;
  provider_segment_id?: string | null;
}

export interface AudioTranscriptionResult {
  text: string;
  language?: string;
  segments: RawUtteranceSegment[];
  duration_ms?: number;
}

export interface AudioTranscriptionOptions {
  language?: string;
  prompt?: string;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ZaloUtteranceInput {
  sequence: number;
  speaker_role: SpeakerRole;
  channel: AudioChannel;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence?: number | null;
  provider_segment_id?: string | null;
}

export interface ZaloUtterance extends ZaloUtteranceInput {
  id: string;
  transcription_id: string;
  call_id: string;
  company_id: string;
  created_at: string;
}

export interface ZaloCallTranscription {
  id: string;
  company_id: string;
  call_id: string;
  customer_id: string | null;
  status: TranscriptionStatus;
  provider: string;
  language: string;
  raw_channel_layout: string;
  channels_silent: { left?: boolean; right?: boolean };
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  lock_token: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  full_transcript: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimedTranscriptionJob {
  id: string;
  company_id: string;
  call_id: string;
  customer_id: string | null;
  provider: string;
  language: string;
  raw_channel_layout: string;
  attempts: number;
  max_attempts: number;
  lock_token: string;
  recording_path: string;
  audio_validation?: {
    remote_non_silent?: boolean;
    local_non_silent?: boolean;
    duration?: number;
    status?: string;
  };
}
