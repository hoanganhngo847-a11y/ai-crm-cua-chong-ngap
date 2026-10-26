import 'server-only';
import type { TranscriptionProvider } from './provider';
import { OpenAITranscriptionProvider } from './provider';
import { PooledGeminiTranscriptionProvider } from './pooled-gemini-provider';

/**
 * Valid transcription provider identifiers.
 * OPENAI: OpenAI Whisper transcription (existing, default for backwards compatibility)
 * GEMINI: Google Gemini dedicated transcription via Interactions API
 */
export type TranscriptionProviderType = 'OPENAI' | 'GEMINI';

/**
 * Validates and normalizes a provider type string.
 * Fails closed on invalid values — never silently defaults.
 *
 * @throws Error with message 'INVALID_TRANSCRIPTION_PROVIDER' (sanitized code, no raw input)
 */
export function validateProviderType(provider: string): TranscriptionProviderType {
  const normalized = typeof provider === 'string' ? provider.trim().toUpperCase() : '';
  if (normalized === 'OPENAI' || normalized === 'GEMINI') {
    return normalized;
  }
  throw new Error('INVALID_TRANSCRIPTION_PROVIDER');
}

/**
 * Resolves the configured transcription provider type from environment.
 *
 * Priority:
 * 1. Default to 'OPENAI' ONLY when TRANSCRIPTION_PROVIDER is undefined (absent).
 * 2. When TRANSCRIPTION_PROVIDER is defined (including blank or whitespace), validate strictly.
 *    Blank or invalid explicit values fail closed with INVALID_TRANSCRIPTION_PROVIDER.
 *
 * IMPORTANT: No automatic fallback from GEMINI to OPENAI.
 * If TRANSCRIPTION_FALLBACK_PROVIDER is needed in the future,
 * it must be explicitly opt-in and absent/disabled by default.
 */
export function resolveProviderType(): TranscriptionProviderType {
  const envProvider = process.env.TRANSCRIPTION_PROVIDER;
  if (envProvider === undefined) {
    // If OPENAI_API_KEY is not configured but GEMINI is available, resolve to GEMINI
    if (!process.env.OPENAI_API_KEY && (process.env.GEMINI_API_KEY || process.env.GEMINI_POOL_ENABLED === 'true')) {
      return 'GEMINI';
    }
    return 'OPENAI';
  }
  return validateProviderType(envProvider);
}

/**
 * Creates a TranscriptionProvider instance based on the given type.
 *
 * Each provider is independently configured via its own env vars:
 * - OPENAI: OPENAI_API_KEY, OPENAI_TRANSCRIPTION_MODEL
 * - GEMINI: GEMINI_API_KEY/Gemini key pool, GEMINI_TRANSCRIPTION_MODEL
 *
 * No fallback: if GEMINI is selected and fails, it fails as GEMINI.
 * It does NOT silently try OpenAI.
 */
export function createTranscriptionProvider(
  providerType?: string
): TranscriptionProvider {
  const type: TranscriptionProviderType =
    providerType !== undefined
      ? validateProviderType(providerType)
      : resolveProviderType();

  switch (type) {
    case 'GEMINI':
      return new PooledGeminiTranscriptionProvider();
    case 'OPENAI':
      return new OpenAITranscriptionProvider();
    default: {
      const _exhaustive: never = type;
      throw new Error('INVALID_TRANSCRIPTION_PROVIDER');
    }
  }
}
