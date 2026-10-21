import 'server-only';

export type CallSummaryStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type LeadTemperature = 'HOT' | 'WARM' | 'COLD';

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FollowUpSummary {
  required: boolean;
  suggested_time: string | null;
  reason: string | null;
}

export interface CallSummaryStructuredOutput {
  summary: string;
  customer_needs: string[];
  objections: string[];
  next_actions: string[];
  lead_temperature: LeadTemperature;
  follow_up: FollowUpSummary;
  key_points: string[];
  confidence: ConfidenceLevel;
}

export interface SummaryUtterance {
  sequence: number;
  speaker_role: 'STAFF' | 'CUSTOMER';
  channel: 'LEFT' | 'RIGHT';
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number | null;
}

export interface ClaimedSummaryJob {
  id: string;
  company_id: string;
  call_id: string;
  transcription_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  attempts: number;
  max_attempts: number;
  lock_token: string;
  full_transcript: string | null;
  utterances: SummaryUtterance[];
}

export interface SummaryGenerationOptions {
  signal?: AbortSignal;
  deadline?: number;
  language?: string;
  fetch?: typeof fetch;
}

export interface SummaryProvider {
  readonly name: string;
  readonly model: string;
  generateSummary(
    utterances: SummaryUtterance[],
    options?: SummaryGenerationOptions
  ): Promise<CallSummaryStructuredOutput>;
}
