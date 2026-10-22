import 'server-only';
import { DEFAULT_JAVIS_ROUTER_MODEL, GeminiModelBackend, JavisRuntimeBackend } from './model';
import { createJavisBrainServer } from './server';
import type { JavisBrainConfig, ModelBackend } from './types';
import { MIN_AUTH_TOKEN_BYTES } from './validation';

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): JavisBrainConfig {
  const authToken = (env.JAVIS_BRAIN_AUTH_TOKEN || env.JAVIS_BRAIN_INTERNAL_TOKEN || '').trim();
  if (!authToken || authToken.length < MIN_AUTH_TOKEN_BYTES || /\s/.test(authToken)) {
    throw new Error('MISSING_OR_INVALID_AUTH_TOKEN');
  }

  const runtimeBaseUrl = (env.JAVIS_RUNTIME_BASE_URL || '').trim().replace(/\/+$/, '');
  const runtimeInternalToken = (env.JAVIS_RUNTIME_INTERNAL_TOKEN || '').trim();
  const geminiApiKey = (env.GEMINI_API_KEY || '').trim();

  if (!runtimeBaseUrl && !geminiApiKey) {
    throw new Error('MISSING_BACKEND_CONFIGURATION');
  }

  if (runtimeBaseUrl && (!runtimeInternalToken || runtimeInternalToken.length < 16)) {
    throw new Error('MISSING_OR_INVALID_RUNTIME_INTERNAL_TOKEN');
  }

  const defaultModel = runtimeBaseUrl ? DEFAULT_JAVIS_ROUTER_MODEL : 'gemini-2.5-flash';
  const model = (env.JAVIS_BRAIN_MODEL || defaultModel).trim();
  if (!model) {
    throw new Error('MISSING_JAVIS_BRAIN_MODEL');
  }

  const rawPort = env.PORT ? parseInt(env.PORT, 10) : 8080;
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 8080;
  const host = '0.0.0.0';

  const defaultStdDeadline = runtimeBaseUrl ? 25000 : 3500;
  const rawStdDeadline = env.STANDARD_DEADLINE_MS ? parseInt(env.STANDARD_DEADLINE_MS, 10) : NaN;
  const standardDeadlineMs =
    Number.isFinite(rawStdDeadline) && rawStdDeadline > 0 ? rawStdDeadline : defaultStdDeadline;

  const defaultRtDeadline = runtimeBaseUrl ? 5000 : 1000;
  const rawRtDeadline = env.REALTIME_DEADLINE_MS ? parseInt(env.REALTIME_DEADLINE_MS, 10) : NaN;
  const realtimeDeadlineMs =
    Number.isFinite(rawRtDeadline) && rawRtDeadline > 0 ? rawRtDeadline : defaultRtDeadline;

  const defaultOuterTimeout = runtimeBaseUrl ? 30000 : 5000;
  const rawOuterTimeout = env.OUTER_TIMEOUT_MS ? parseInt(env.OUTER_TIMEOUT_MS, 10) : NaN;
  const outerTimeoutMs =
    Number.isFinite(rawOuterTimeout) && rawOuterTimeout > 0 ? rawOuterTimeout : defaultOuterTimeout;

  return {
    port,
    host,
    authToken,
    runtimeBaseUrl: runtimeBaseUrl || undefined,
    runtimeInternalToken: runtimeInternalToken || undefined,
    geminiApiKey: geminiApiKey || undefined,
    model,
    maxConcurrency: 2,
    standardDeadlineMs,
    realtimeDeadlineMs,
    outerTimeoutMs,
  };
}

export function main(): void {
  let config: JavisBrainConfig;
  try {
    config = loadConfigFromEnv(process.env);
  } catch {
    console.error(
      JSON.stringify({
        event: 'STARTUP_ERROR',
        reason: 'MISSING_OR_INVALID_CONFIGURATION',
      })
    );
    process.exit(1);
  }

  const modelBackend: ModelBackend = config.runtimeBaseUrl
    ? new JavisRuntimeBackend({
        baseUrl: config.runtimeBaseUrl,
        internalToken: config.runtimeInternalToken!,
        authToken: config.authToken,
        modelName: config.model,
      })
    : new GeminiModelBackend({
        apiKey: config.geminiApiKey!,
        model: config.model,
        authToken: config.authToken,
      });

  const server = createJavisBrainServer({
    authToken: config.authToken,
    modelBackend,
    modelName: config.model,
    maxConcurrency: config.maxConcurrency,
    standardDeadlineMs: config.standardDeadlineMs,
    realtimeDeadlineMs: config.realtimeDeadlineMs,
    outerTimeoutMs: config.outerTimeoutMs,
  });

  server.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        event: 'SERVICE_STARTED',
        service: 'javis-brain',
        port: config.port,
        host: config.host,
        version: 'v1',
      })
    );
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main();
}
