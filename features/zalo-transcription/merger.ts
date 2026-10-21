import 'server-only';
import type { RawUtteranceSegment, ZaloUtteranceInput } from './types';

export function formatTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');

  if (hours > 0) {
    const hh = hours.toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export interface MergeChannelsInput {
  customerSegments: RawUtteranceSegment[];
  staffSegments: RawUtteranceSegment[];
}

export interface MergedTranscriptResult {
  utterances: ZaloUtteranceInput[];
  fullTranscript: string;
}

/**
 * Deterministically merges speech segments from Left (CUSTOMER) and Right (STAFF)
 * channels into a unified chronological sequence.
 *
 * Rules:
 * - Left channel is unconditionally mapped to CUSTOMER.
 * - Right channel is unconditionally mapped to STAFF.
 * - Ordered by start_ms ASC, then end_ms ASC, with deterministic tie-break.
 * - Sequences are 1-based sequential integers without gaps.
 * - Formats full chronological text in the CRM presentation format:
 *   "MM:SS  Staff\n[text]\n\nMM:SS  Customer\n[text]"
 */
export function mergeUtterances(input: MergeChannelsInput): MergedTranscriptResult {
  type IntermediateSegment = {
    start_ms: number;
    end_ms: number;
    text: string;
    speaker_role: 'STAFF' | 'CUSTOMER';
    channel: 'LEFT' | 'RIGHT';
    confidence?: number | null;
    provider_segment_id?: string | null;
  };

  const combined: IntermediateSegment[] = [];

  for (const seg of input.customerSegments) {
    const text = seg.text.trim();
    if (!text) continue;
    combined.push({
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      text,
      speaker_role: 'CUSTOMER',
      channel: 'LEFT',
      confidence: seg.confidence,
      provider_segment_id: seg.provider_segment_id,
    });
  }

  for (const seg of input.staffSegments) {
    const text = seg.text.trim();
    if (!text) continue;
    combined.push({
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      text,
      speaker_role: 'STAFF',
      channel: 'RIGHT',
      confidence: seg.confidence,
      provider_segment_id: seg.provider_segment_id,
    });
  }

  combined.sort((a, b) => {
    if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
    if (a.end_ms !== b.end_ms) return a.end_ms - b.end_ms;
    // Deterministic tie-break: STAFF before CUSTOMER
    return a.speaker_role === 'STAFF' ? -1 : 1;
  });

  const utterances: ZaloUtteranceInput[] = combined.map((seg, idx) => ({
    sequence: idx + 1,
    speaker_role: seg.speaker_role,
    channel: seg.channel,
    start_ms: seg.start_ms,
    end_ms: seg.end_ms,
    text: seg.text,
    confidence: seg.confidence,
    provider_segment_id: seg.provider_segment_id,
  }));

  const fullTranscript = utterances
    .map(
      (u) =>
        `${formatTimestamp(u.start_ms)}  ${u.speaker_role === 'STAFF' ? 'Staff' : 'Customer'}\n${u.text}`
    )
    .join('\n\n');

  return {
    utterances,
    fullTranscript,
  };
}
