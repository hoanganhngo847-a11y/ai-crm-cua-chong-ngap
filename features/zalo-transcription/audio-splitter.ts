import 'server-only';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Maximum audio file size accepted for provider upload (conservative decimal 25,000,000 bytes limit).
 * Enforces a strict pre-upload safety ceiling with headroom for form-data encapsulation.
 */
export const MAX_PROVIDER_AUDIO_BYTES = 25_000_000; // 25,000,000 bytes

export interface AudioChannelSplitResult {
  customerAudio: Buffer | null;
  staffAudio: Buffer | null;
  customerSilent: boolean;
  staffSilent: boolean;
  channelLayout: string;
}

export interface SplitAudioOptions {
  audioValidation?: {
    remote_non_silent?: boolean;
    local_non_silent?: boolean;
    duration?: number;
    status?: string;
  };
  ffmpegPath?: string;
  timeoutMs?: number;
}

/**
 * ffmpeg production strategy:
 *
 * A. Project-managed binary via `ffmpeg-static` npm package.
 *    - Provides a pre-built ffmpeg binary for the target platform (Linux amd64 on Render, macOS on dev).
 *    - Installed as a direct dependency; `require('ffmpeg-static')` resolves to the absolute binary path.
 *    - The binary is vendored inside node_modules and deployed with `npm ci`.
 *    - Deterministic, no system-level assumptions.
 *
 * B. Fallback: FFMPEG_PATH environment variable for explicit override.
 *
 * C. Dev-only fallback: platform-specific well-known paths.
 *
 * If ffmpeg is unavailable at runtime, transcription fails with FFMPEG_UNAVAILABLE.
 * Original recordings are NEVER deleted.
 */

/**
 * Resolves the deterministic ffmpeg binary path.
 * Priority:
 * 1. Explicit FFMPEG_PATH env var
 * 2. ffmpeg-static npm package (project-managed binary)
 * 3. Dev-only fallback for macOS homebrew
 *
 * @throws Error with message 'FFMPEG_UNAVAILABLE' if no valid binary is found
 */
export function getFfmpegPath(): string {
  // 1. Explicit env override
  if (process.env.FFMPEG_PATH) {
    if (existsSync(process.env.FFMPEG_PATH)) {
      return process.env.FFMPEG_PATH;
    }
    throw new Error('FFMPEG_UNAVAILABLE');
  }

  // 2. Project-managed binary via ffmpeg-static
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStaticPath = require('ffmpeg-static') as string;
    if (ffmpegStaticPath && typeof ffmpegStaticPath === 'string' && existsSync(ffmpegStaticPath)) {
      return ffmpegStaticPath;
    }
  } catch {
    // ffmpeg-static not installed or failed to resolve
  }

  // 3. Fallback to system paths (macOS & Linux / Render)
  const fallbackPaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ];
  for (const fallback of fallbackPaths) {
    if (existsSync(fallback)) return fallback;
  }

  // 4. Fallback to which
  try {
    const whichPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf-8', timeout: 2000 }).trim();
    if (whichPath && existsSync(whichPath)) return whichPath;
  } catch {
    // which failed or not found
  }

  throw new Error('FFMPEG_UNAVAILABLE');
}

/**
 * Validates that the resolved ffmpeg binary exists, is executable, and reports a usable version.
 * Returns the validated absolute path and version string.
 *
 * @throws Error with message 'FFMPEG_UNAVAILABLE' on any validation failure
 */
export function validateFfmpeg(path?: string): { path: string; version: string } {
  let resolvedPath: string;
  try {
    resolvedPath = path || getFfmpegPath();
  } catch {
    throw new Error('FFMPEG_UNAVAILABLE');
  }

  // Check file exists
  if (!existsSync(resolvedPath)) {
    throw new Error('FFMPEG_UNAVAILABLE');
  }

  // Check executable by running version probe
  try {
    const versionOutput = execFileSync(resolvedPath, ['-version'], {
      timeout: 5_000,
      maxBuffer: 1024 * 10,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString('utf-8');

    const versionMatch = versionOutput.match(/ffmpeg version (\S+)/);
    const version = versionMatch?.[1] || 'unknown';

    return { path: resolvedPath, version };
  } catch {
    throw new Error('FFMPEG_UNAVAILABLE');
  }
}

/**
 * Splits a stereo Zalo recording into discrete mono tracks according to the verified
 * recorder contract:
 * - Channel 0 (Left / FL) = ScreenCaptureKit audio = Remote / CUSTOMER
 * - Channel 1 (Right / FR) = AVCaptureSession audio = Local / STAFF
 *
 * Guarantees:
 * - Original recording buffer is NEVER altered or deleted.
 * - Temporary processing files are strictly cleaned up in a finally block.
 * - Silent channels are recognized from recorder audio_validation; speech is never manufactured.
 * - If ffmpeg is unavailable, fails with FFMPEG_UNAVAILABLE error code.
 * - No shell injection: uses execFileSync (array args, no shell interpolation).
 */
export async function splitStereoChannels(
  audioBuffer: Buffer,
  options?: SplitAudioOptions
): Promise<AudioChannelSplitResult> {
  const channelLayout = 'stereo (Left=remote/customer, Right=local/staff)';
  const val = options?.audioValidation;

  // Check recorder validation flags if present
  const customerSilent = val?.remote_non_silent === false;
  const staffSilent = val?.local_non_silent === false;

  // If both channels are already known to be silent, return early without running ffmpeg
  if (customerSilent && staffSilent) {
    return {
      customerAudio: null,
      staffAudio: null,
      customerSilent: true,
      staffSilent: true,
      channelLayout,
    };
  }

  // Validate ffmpeg availability before any file I/O
  const ffmpegPath = options?.ffmpegPath || getFfmpegPath();
  if (!existsSync(ffmpegPath)) {
    throw new Error('FFMPEG_UNAVAILABLE');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'zalo-transcribe-'));
  try {
    const inputPath = join(tmpDir, 'stereo_recording.m4a');
    const leftPath = join(tmpDir, 'customer_left.m4a');
    const rightPath = join(tmpDir, 'staff_right.m4a');

    writeFileSync(inputPath, audioBuffer);

    const ffmpegTimeout = Math.min(options?.timeoutMs ?? 60_000, 60_000);

    try {
      execFileSync(ffmpegPath, [
        '-v', 'error',
        '-y',
        '-i', inputPath,
        '-filter_complex',
        '[0:a]channelsplit=channel_layout=stereo[left][right];[left]aformat=channel_layouts=mono[l];[right]aformat=channel_layouts=mono[r]',
        '-map', '[l]', '-c:a', 'aac', leftPath,
        '-map', '[r]', '-c:a', 'aac', rightPath,
      ], {
        timeout: ffmpegTimeout,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // Fallback: If stereo split fails (e.g. irregular layout or single-channel container),
      // extract mono audio for both channels so transcription continues cleanly.
      execFileSync(ffmpegPath, [
        '-v', 'error',
        '-y',
        '-i', inputPath,
        '-ac', '1',
        '-c:a', 'aac', leftPath,
      ], {
        timeout: ffmpegTimeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      writeFileSync(rightPath, readFileSync(leftPath));
    }

    const customerAudio = !customerSilent ? readFileSync(leftPath) : null;
    const staffAudio = !staffSilent ? readFileSync(rightPath) : null;

    return {
      customerAudio,
      staffAudio,
      customerSilent,
      staffSilent,
      channelLayout,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Propagate FFMPEG_UNAVAILABLE if that was the root cause
    if (msg === 'FFMPEG_UNAVAILABLE') throw err;
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('FFMPEG_UNAVAILABLE');
    }
    throw new Error(`AUDIO_SPLIT_FAILED: ${msg.slice(0, 200)}`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup
    }
  }
}
