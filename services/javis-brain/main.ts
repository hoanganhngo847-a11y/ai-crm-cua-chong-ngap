import 'server-only';
import { GeminiModelBackend } from './model';
import { createJavisBrainServer } from './server';
import type { JavisBrainConfig } from './types';
import { MIN_AUTH_TOKEN_BYTES } from './validation';

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JavisBrainConfig {
  const authToken = (env.JAVIS_BRAIN_AUTH_TOKEN || env.JAVIS_BRAIN_INTERNAL_TOKEN || '').trim();
  if (!authToken || authToken.length < MIN_AUTH_TOKEN_BYTES || /\s/.test(authToken)) {
    throw new Error('MISSING_OR_INVALID_AUTH_TOKEN');
  }

  const geminiApiKey = (env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('MISSING_GEMINI_API_KEY');
  }

  const model = (env.JAVIS_BRAIN_MODEL || '').trim();
  if (!model) {
    throw new Error('MISSING_JAVIS_BRAIN_MODEL');
  }

  const rawPort = env.PORT ? parseInt(env.PORT, 10) : 8080;
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 8080;
  const host = '0.0.0.0';

  return {
    port,
    host,
    authToken,
    geminiApiKey,
    model,
    maxConcurrency: 2,
    standardDeadlineMs: 3500,
    realtimeDeadlineMs: 1000,
    outerTimeoutMs: 5000,
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

  const modelBackend = new GeminiModelBackend({
    apiKey: config.geminiApiKey,
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
