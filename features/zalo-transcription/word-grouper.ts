import 'server-only';
import type { RawUtteranceSegment } from './types';

/**
 * Maximum timestamp supported for Gemini transcription (30 minutes).
 * Any word annotation exceeding 30 minutes (1,800,000 ms) fails permanently
 * with GEMINI_AUDIO_TOO_LONG.
 */
export const GEMINI_MAX_TIMESTAMP_MS = 30 * 60 * 1000;

/** Milliseconds of silence between words that triggers a new segment */
export const PAUSE_THRESHOLD_MS = 1500;

/** Maximum number of words in a single grouped segment */
export const MAX_WORDS_PER_SEGMENT = 40;

/** Sentence-ending punctuation pattern (covers Vietnamese and common Latin/CJK punctuation) */
const SENTENCE_ENDING_PATTERN = /[.?!;。？！]$/;

/**
 * Parsed word annotation from Gemini transcription response.
 * Represents a single word with its timing information.
 */
export interface GeminiWordAnnotation {
  text: string;
  /** Start offset as a duration string, e.g. "0.100s", "1.500s" */
  start_offset: string;
  /** End offset as a duration string, e.g. "0.200s", "1.700s" */
  end_offset: string;
}

/**
 * Parse a Gemini duration string (e.g. "0.100s", "1.500s", "120s") to milliseconds.
 * Returns null if the format is invalid, missing, or negative.
 *
 * Official format: non-negative floating-point seconds followed by 's', e.g. "0.100s".
 */
export function parseDurationToMs(duration: string | undefined | null): number | null {
  if (!duration || typeof duration !== 'string') return null;

  const trimmed = duration.trim();
  // Match non-negative digits with optional decimal part, strictly followed by 's'
  const match = trimmed.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;

  const seconds = parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.round(seconds * 1000);
}

/**
 * Deterministically groups word annotations into phrase/utterance segments.
 *
 * Strict validation:
 * - Rejects reversed timestamps (start > end) with GEMINI_TIMESTAMP_MISSING
 * - Rejects out-of-order timestamps (start < prevStartMs) with GEMINI_TIMESTAMP_MISSING
 * - Rejects missing/malformed timestamps with GEMINI_TIMESTAMP_MISSING
 * - Rejects invalid or blank/empty text with GEMINI_INVALID_RESPONSE
 * - Rejects timestamp overflow (> 30 minutes) with GEMINI_AUDIO_TOO_LONG
 *
 * Grouping rules (deterministic, unit-testable):
 * 1. Preserve chronological order of words.
 * 2. Group adjacent words into phrases.
 * 3. Split at:
 *    a. Clear punctuation boundaries (sentence-ending: . ? ! ; etc.)
 *    b. Meaningful pauses (gap > PAUSE_THRESHOLD_MS between consecutive words)
 *    c. Maximum phrase length (40 words)
 * 4. Preserve start_ms of first word in group.
 * 5. Preserve end_ms of last word in group.
 * 6. Never invent text — only concatenate actual word texts.
 */
export function groupWordsIntoSegments(
  words: GeminiWordAnnotation[]
): RawUtteranceSegment[] {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  let prevStartMs = -1;
  const validatedWords: Array<{ text: string; startMs: number; endMs: number }> = [];

  for (const word of words) {
    if (!word || typeof word !== 'object') {
      throw new Error('GEMINI_INVALID_RESPONSE');
    }

    // 1. Text validation: must be a non-blank string
    if (typeof word.text !== 'string') {
      throw new Error('GEMINI_INVALID_RESPONSE');
    }

    const text = word.text.trim();
    if (!text) {
      throw new Error('GEMINI_INVALID_RESPONSE');
    }

    // 2. Timestamp parse validation
    const startMs = parseDurationToMs(word.start_offset);
    const endMs = parseDurationToMs(word.end_offset);

    if (startMs === null || endMs === null) {
      throw new Error('GEMINI_TIMESTAMP_MISSING');
    }

    // 3. Overflow validation: max 30 minutes
    if (startMs > GEMINI_MAX_TIMESTAMP_MS || endMs > GEMINI_MAX_TIMESTAMP_MS) {
      throw new Error('GEMINI_AUDIO_TOO_LONG');
    }

    // 4. Reversed interval validation: startMs cannot exceed endMs
    if (startMs > endMs) {
      throw new Error('GEMINI_TIMESTAMP_MISSING');
    }

    // 5. Monotonic start order validation
    if (startMs < prevStartMs) {
      throw new Error('GEMINI_TIMESTAMP_MISSING');
    }

    prevStartMs = startMs;

    validatedWords.push({ text, startMs, endMs });
  }

  const segments: RawUtteranceSegment[] = [];
  let currentWords: string[] = [];
  let segmentStartMs: number | null = null;
  let segmentEndMs: number | null = null;
  let lastWordEndMs: number | null = null;

  for (let i = 0; i < validatedWords.length; i++) {
    const { text, startMs, endMs } = validatedWords[i];

    const shouldSplit =
      currentWords.length > 0 &&
      (
        // Meaningful pause between words
        (lastWordEndMs !== null && startMs - lastWordEndMs > PAUSE_THRESHOLD_MS) ||
        // Max words threshold reached
        currentWords.length >= MAX_WORDS_PER_SEGMENT ||
        // Previous word ended with sentence punctuation
        SENTENCE_ENDING_PATTERN.test(currentWords[currentWords.length - 1])
      );

    if (shouldSplit && currentWords.length > 0 && segmentStartMs !== null && segmentEndMs !== null) {
      segments.push({
        start_ms: segmentStartMs,
        end_ms: segmentEndMs,
        text: currentWords.join(' '),
        confidence: null,
        provider_segment_id: null,
      });
      currentWords = [];
      segmentStartMs = null;
      segmentEndMs = null;
    }

    if (segmentStartMs === null) {
      segmentStartMs = startMs;
    }
    segmentEndMs = endMs;
    lastWordEndMs = endMs;
    currentWords.push(text);
  }

  // Flush remaining words in segment
  if (currentWords.length > 0 && segmentStartMs !== null && segmentEndMs !== null) {
    segments.push({
      start_ms: segmentStartMs,
      end_ms: segmentEndMs,
      text: currentWords.join(' '),
      confidence: null,
      provider_segment_id: null,
    });
  }

  return segments;
}
