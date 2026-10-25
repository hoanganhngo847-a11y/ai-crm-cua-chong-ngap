import 'server-only';
import { providerDiagnostic } from '../../features/ai-brain/provider-failure';
import { dossierContextSchema, validateDossierSnapshot, type DossierSnapshot, type DossierContext } from '../../features/customer-360/contracts';
import http from 'node:http';
import { validateProviderProposal } from '../../features/ai-brain/validation';
import { evaluateTurnPolicy } from './policy';
import type {
  BrainProposal,
  HealthResponse,
  ModelBackend,
  SafeAuditLog,
  TurnResponse,
} from './types';
import {
  CONTRACT_HEADER,
  CONTRACT_VERSION,
  findDuplicateHeaders,
  MAX_BODY_BYTES,
  RequestValidationError,
  validateAuthorization,
  validateBrainTurnRequest,
} from './validation';

export interface JavisBrainServerOptions {
  readonly authToken: string;
  readonly modelBackend: ModelBackend;
  readonly modelName?: string;
  readonly maxConcurrency?: number;
  readonly standardDeadlineMs?: number;
  readonly realtimeDeadlineMs?: number;
  readonly outerTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
  readonly onAuditLog?: (log: SafeAuditLog) => void;
}

const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_STANDARD_DEADLINE_MS = 3500;
const DEFAULT_REALTIME_DEADLINE_MS = 1000;
const DEFAULT_OUTER_TIMEOUT_MS = 5000;
const DEFAULT_HEADERS_TIMEOUT_MS = 2000;
const DEFAULT_BODY_TIMEOUT_MS = 3000;

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parsePath(url: string | undefined): string {
  if (!url) return '';
  const questionIndex = url.indexOf('?');
  const path = questionIndex === -1 ? url : url.slice(0, questionIndex);
  return path.replace(/\/+$/, '') || '/';
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return mime === 'application/json';
}

export function createJavisBrainServer(options: JavisBrainServerOptions): http.Server {
  const authToken = options.authToken;
  if (!authToken || typeof authToken !== 'string' || authToken.length < 32) {
    throw new Error('JAVIS_BRAIN_AUTH_TOKEN_INVALID');
  }

  const modelBackend = options.modelBackend;
  const modelName = options.modelName || 'gemini-2.5-flash';
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const standardDeadlineMs = options.standardDeadlineMs ?? DEFAULT_STANDARD_DEADLINE_MS;
  const realtimeDeadlineMs = options.realtimeDeadlineMs ?? DEFAULT_REALTIME_DEADLINE_MS;
  const outerTimeoutMs = options.outerTimeoutMs ?? DEFAULT_OUTER_TIMEOUT_MS;
  const headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const emitAudit = options.onAuditLog ?? ((log) => console.log(JSON.stringify(log)));

  let activeModelCalls = 0;
  const activeAbortControllers = new Set<AbortController>();

  const server = http.createServer(
    {
      connectionsCheckingInterval: Math.max(50, Math.min(500, Math.floor(headersTimeoutMs / 2))),
    },
    async (req, res) => {
      const startTime = performance.now();
      let turnId: string | null = null;
      let traceId: string | null = null;
      let decision: 'RESPOND' | 'HANDOVER' | 'NO_REPLY' | 'ERROR' | null = null;
      let logged = false;
      let upstream: ReturnType<typeof providerDiagnostic>;

      const finalizeLog = (status: number) => {
        if (logged) return;
        logged = true;
        emitAudit({
          ...(upstream ? { upstream } : {}),
          turnId,
          traceId,
          latencyMs: Math.max(0, performance.now() - startTime),
          decision,
          status,
          provider: 'javis-brain-service',
          model: modelName,
        });
      };

      try {
        // 1. Duplicate headers check
        const duplicateHeaders = findDuplicateHeaders(req.rawHeaders, [
          'authorization',
          'x-ai-brain-contract',
          'content-type',
          'content-length',
          'content-encoding',
        ]);
        if (duplicateHeaders.length > 0) {
          sendJson(res, 400, { error: 'BAD_REQUEST' });
          finalizeLog(400);
          return;
        }

        // 2. Path routing & method check
        const path = parsePath(req.url);
        if (path === '/health') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
            finalizeLog(405);
            return;
          }
        } else if (path === '/v1/brain/turn' || path === '/v1/brain/dossier') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
            finalizeLog(405);
            return;
          }
        } else {
          sendJson(res, 404, { error: 'NOT_FOUND' });
          finalizeLog(404);
          return;
        }

        // 3. Strict Bearer token authentication
        const authHeader = req.headers.authorization;
        if (!validateAuthorization(authHeader, authToken)) {
          sendJson(res, 401, { error: 'UNAUTHORIZED' });
          finalizeLog(401);
          return;
        }

        // 4. Strict X-AI-Brain-Contract header
        const contractHeader = req.headers[CONTRACT_HEADER];
        if (contractHeader !== CONTRACT_VERSION) {
          sendJson(res, 400, { error: 'BAD_REQUEST' });
          finalizeLog(400);
          return;
        }

        // 5. GET /health handler
        if (path === '/health') {
          const healthPayload: HealthResponse = {
            ok: true,
            service: 'javis-brain',
            version: 'v1',
          };
          sendJson(res, 200, healthPayload);
          finalizeLog(200);
          return;
        }

        // 6. POST /v1/brain/turn handling
        // Validate Content-Type
        const contentType = req.headers['content-type'];
        if (!isJsonContentType(contentType)) {
          sendJson(res, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
          finalizeLog(415);
          return;
        }

        // Validate Content-Encoding (reject non-identity)
        const contentEncoding = req.headers['content-encoding'];
        if (contentEncoding && contentEncoding !== 'identity') {
          sendJson(res, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
          finalizeLog(415);
          return;
        }

        // Validate Content-Length header if present
        const contentLengthHeader = req.headers['content-length'];
        if (contentLengthHeader !== undefined) {
          const length = parseInt(contentLengthHeader, 10);
          if (Number.isNaN(length) || length < 0 || length > MAX_BODY_BYTES) {
            sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
            finalizeLog(413);
            return;
          }
        }

        // Read streaming body with size & time limits
        // Buffer bounded chunks and decode ONCE with strict UTF8 decoder
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let bodyTimeout: NodeJS.Timeout | undefined;

        const bodyPromise = new Promise<string>((resolve, reject) => {
          const cleanupBodyListeners = () => {
            if (bodyTimeout) {
              clearTimeout(bodyTimeout);
              bodyTimeout = undefined;
            }
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
          };

          const onData = (chunk: Buffer | string) => {
            const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
            receivedBytes += chunkBuf.length;
            if (receivedBytes > MAX_BODY_BYTES) {
              cleanupBodyListeners();
              req.pause();
              reject(new Error('BODY_TOO_LARGE'));
              return;
            }
            chunks.push(chunkBuf);
          };

          const onEnd = () => {
            cleanupBodyListeners();
            const fullBuffer = Buffer.concat(chunks, receivedBytes);
            try {
              const decoder = new TextDecoder('utf-8', { fatal: true });
              const bodyText = decoder.decode(fullBuffer);
              resolve(bodyText);
            } catch {
              reject(new Error('MALFORMED_UTF8'));
            }
          };

          const onError = (err: unknown) => {
            cleanupBodyListeners();
            reject(err);
          };

          bodyTimeout = setTimeout(() => {
            cleanupBodyListeners();
            req.pause();
            reject(new Error('BODY_TIMEOUT'));
          }, bodyTimeoutMs);

          req.on('data', onData);
          req.on('end', onEnd);
          req.on('error', onError);
        });

        let bodyText: string;
        try {
          bodyText = await bodyPromise;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'BODY_TOO_LARGE') {
            res.setHeader('Connection', 'close');
            sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
            finalizeLog(413);
            res.on('finish', () => {
              req.destroy();
            });
            return;
          }
          if (msg === 'BODY_TIMEOUT') {
            res.setHeader('Connection', 'close');
            sendJson(res, 408, { error: 'REQUEST_TIMEOUT' });
            finalizeLog(408);
            res.on('finish', () => {
              req.destroy();
            });
            return;
          }
          if (msg === 'MALFORMED_UTF8') {
            res.setHeader('Connection', 'close');
            sendJson(res, 400, { error: 'BAD_REQUEST' });
            finalizeLog(400);
            res.on('finish', () => {
              req.destroy();
            });
            return;
          }
          sendJson(res, 400, { error: 'BAD_REQUEST' });
          finalizeLog(400);
          return;
        }

        // Parse JSON body
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          sendJson(res, 400, { error: 'BAD_REQUEST' });
          finalizeLog(400);
          return;
        }

        // Validate BrainTurnRequest
        let turnRequest;
        let dossierContext: DossierContext | undefined;
        try {
          if (path === '/v1/brain/dossier') {
            dossierContext = dossierContextSchema.parse(parsedBody);
          } else {
            turnRequest = validateBrainTurnRequest(parsedBody);
          }
        } catch (err: unknown) {
          if (err instanceof RequestValidationError) {
            sendJson(res, 400, { error: 'BAD_REQUEST' });
            finalizeLog(400);
            return;
          }
          sendJson(res, 400, { error: 'BAD_REQUEST' });
          finalizeLog(400);
          return;
        }

        turnId = turnRequest?.turnId ?? null;
        traceId = turnRequest?.traceId ?? null;

        // Policy check: short-circuit if allowDrafts === false, AI_PAUSED, or HANDOVER_REQUIRED
        const policyProposal = turnRequest ? evaluateTurnPolicy(turnRequest) : null;
        if (policyProposal !== null) {
          decision = policyProposal.decision;
          const turnResponse: TurnResponse = {
            ok: true,
            version: 'v1',
            proposal: policyProposal,
          };
          sendJson(res, 200, turnResponse);
          finalizeLog(200);
          return;
        }

        // Concurrency check before entering model backend
        if (activeModelCalls >= maxConcurrency) {
          decision = 'ERROR';
          sendJson(res, 503, { error: 'SERVICE_UNAVAILABLE' });
          finalizeLog(503);
          return;
        }

        activeModelCalls++;
        let slotReleased = false;
        const releaseSlot = () => {
          if (!slotReleased) {
            slotReleased = true;
            activeModelCalls--;
          }
        };

        const abortController = new AbortController();
        activeAbortControllers.add(abortController);

        let clientDisconnected = false;
        const onClientDisconnect = () => {
          if (!res.writableEnded) {
            clientDisconnected = true;
            abortController.abort();
          }
        };
        res.on('close', onClientDisconnect);

        const disconnectPromise = new Promise<never>((_, reject) => {
          if (clientDisconnected || abortController.signal.aborted) {
            reject(new Error('CLIENT_DISCONNECTED'));
            return;
          }
          abortController.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('CLIENT_DISCONNECTED'));
            },
            { once: true }
          );
        });

        let backendPromise: Promise<BrainProposal | DossierSnapshot>;
        try {
          if (dossierContext) {
            if (!modelBackend.generateDossier) throw new Error('DOSSIER_BACKEND_UNAVAILABLE');
            backendPromise = modelBackend.generateDossier(dossierContext, { signal: abortController.signal });
          } else if (turnRequest) {
            backendPromise = modelBackend.generate(turnRequest.input.text, {
              signal: abortController.signal,
              latencyProfile: turnRequest.latencyProfile,
              grounding: turnRequest.grounding,
            });
          } else { throw new Error('INVALID_TASK'); }
        } catch (syncErr) {
          releaseSlot();
          activeAbortControllers.delete(abortController);
          res.off('close', onClientDisconnect);
          throw syncErr;
        }

        // Retain capacity slot until the underlying promise settles (observed then/catch; no unhandled)
        backendPromise.then(
          () => {
            releaseSlot();
            activeAbortControllers.delete(abortController);
          },
          () => {
            releaseSlot();
            activeAbortControllers.delete(abortController);
          }
        );

        let deadlineTimer: NodeJS.Timeout | undefined;
        try {
          const deadlineMs =
            turnRequest?.latencyProfile === 'REALTIME' ? realtimeDeadlineMs : standardDeadlineMs;

          const timeoutPromise = new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
              abortController.abort();
              reject(new Error('DEADLINE_EXCEEDED'));
            }, deadlineMs);
          });

          const proposalRaw = await Promise.race([
            backendPromise,
            timeoutPromise,
            disconnectPromise,
          ]);

          if (dossierContext) {
            const snapshot = validateDossierSnapshot(proposalRaw, dossierContext);
            sendJson(res, 200, { ok: true, version: 'dossier-v1', snapshot });
            finalizeLog(200);
            return;
          }
          // Output boundary runtime validation
          const proposal = validateProviderProposal(proposalRaw);

          decision = proposal.decision;
          const turnResponse: TurnResponse = {
            ok: true,
            version: 'v1',
            proposal,
          };
          sendJson(res, 200, turnResponse);
          finalizeLog(200);
        } catch (err: unknown) {
          upstream = providerDiagnostic(err);
          if (upstream && !res.headersSent && !clientDisconnected) {
            res.setHeader('X-AI-Brain-Error', upstream.code);
            res.setHeader('X-AI-Brain-Phase', upstream.phase);
            if (upstream.httpStatus) res.setHeader('X-AI-Brain-Upstream-Status', upstream.httpStatus);
          }
          decision = 'ERROR';
          if (clientDisconnected) {
            // True client disconnect: prompt settlement, do not write to closed socket
            finalizeLog(499);
          } else if (
            abortController.signal.aborted ||
            (err instanceof Error && err.message === 'DEADLINE_EXCEEDED')
          ) {
            sendJson(res, 504, { error: 'GATEWAY_TIMEOUT' });
            finalizeLog(504);
          } else {
            sendJson(res, 500, { error: 'INTERNAL_SERVER_ERROR' });
            finalizeLog(500);
          }
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          res.off('close', onClientDisconnect);
        }
      } catch {
        decision = 'ERROR';
        sendJson(res, 500, { error: 'INTERNAL_SERVER_ERROR' });
        finalizeLog(500);
      }
    }
  );

  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = outerTimeoutMs;

  const originalClose = server.close.bind(server);
  server.close = function (callback?: (err?: Error) => void) {
    for (const controller of activeAbortControllers) {
      controller.abort();
    }
    activeAbortControllers.clear();
    return originalClose(callback);
  };

  return server;
}
