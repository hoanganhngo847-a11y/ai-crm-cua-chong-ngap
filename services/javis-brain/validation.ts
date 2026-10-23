import 'server-only';
import crypto from 'node:crypto';
import {
  ALLOWED_BRAIN_CHANNELS,
  ALLOWED_BRAIN_LATENCIES,
  ALLOWED_BRAIN_MODALITIES,
  ALLOWED_CONVERSATION_STATES,
  type BrainTurnGrounding,
  type BrainTurnRequest,
} from '../../features/ai-brain/contracts';
import { deepFreeze, isUuid } from '../../features/ai-brain/validation';

export const MAX_BODY_BYTES = 32 * 1024; // 32 KiB
export const MAX_INPUT_TEXT_CHARS = 4000;
export const MAX_INPUT_TEXT_BYTES = 12000;
export const MIN_AUTH_TOKEN_BYTES = 32;
export const MAX_AUTH_TOKEN_BYTES = 512;
export const CONTRACT_HEADER = 'x-ai-brain-contract';
export const CONTRACT_VERSION = 'v1';
export const MAX_MODEL_RESPONSE_BYTES = 16 * 1024; // 16 KiB
export const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024; // 64 KiB

export class RequestValidationError extends Error {
  constructor(message = 'BAD_REQUEST') {
    super(message);
    this.name = 'RequestValidationError';
  }
}

function deny(msg = 'BAD_REQUEST'): never {
  throw new RequestValidationError(msg);
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    deny('Expected plain object');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') deny('Symbol keys not allowed');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      deny('Accessor property not allowed');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[]
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      deny(`Unknown key: ${key}`);
    }
  }
  for (const req of required) {
    if (!Object.prototype.hasOwnProperty.call(record, req) || record[req] === undefined) {
      deny(`Missing required key: ${req}`);
    }
  }
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    deny(`Invalid enum for ${field}`);
  }
  return value as T;
}

function validateText(value: unknown): string {
  if (typeof value !== 'string') deny('Text must be a string');
  if (!value.trim()) deny('Text must not be blank');
  if (value.length > MAX_INPUT_TEXT_CHARS) deny('Text exceeds maximum character limit');
  if (Buffer.byteLength(value, 'utf8') > MAX_INPUT_TEXT_BYTES) {
    deny('Text exceeds maximum UTF-8 byte limit');
  }
  return value;
}

function validateGrounding(raw: unknown): BrainTurnGrounding {
  const g = snapshotPlainRecord(raw);
  assertExactKeys(
    g,
    ['company', 'customer', 'conversation', 'recentMessages', 'knowledge', 'memories', 'businessFacts'],
    ['recentMessages', 'knowledge', 'memories']
  );
  if (!Array.isArray(g.recentMessages) || !Array.isArray(g.knowledge) || !Array.isArray(g.memories)) {
    deny('grounding arrays must be valid lists');
  }
  const recentMessages = g.recentMessages.slice(0, 10).map((item) => {
    const rec = snapshotPlainRecord(item);
    return {
      direction: rec.direction === 'INBOUND' ? ('INBOUND' as const) : ('OUTBOUND' as const),
      actorType: typeof rec.actorType === 'string' ? rec.actorType.slice(0, 64) : 'UNKNOWN',
      content: typeof rec.content === 'string' ? rec.content.slice(0, 2000) : '',
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt.slice(0, 64) : '',
    };
  });
  const knowledge = g.knowledge.slice(0, 10).map((item) => {
    const rec = snapshotPlainRecord(item);
    return {
      category: typeof rec.category === 'string' ? rec.category.slice(0, 64) : 'OTHER',
      title: typeof rec.title === 'string' ? rec.title.slice(0, 300) : '',
      content: typeof rec.content === 'string' ? rec.content.slice(0, 2000) : '',
    };
  });
  const memories = g.memories.slice(0, 10).map((item) => {
    const rec = snapshotPlainRecord(item);
    return {
      type: typeof rec.type === 'string' ? rec.type.slice(0, 64) : 'FACT',
      key: typeof rec.key === 'string' ? rec.key.slice(0, 120) : null,
      content: typeof rec.content === 'string' ? rec.content.slice(0, 2000) : '',
      confidence: typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? Math.max(0, Math.min(1, rec.confidence)) : 0.5,
      verified: rec.verified === true,
    };
  });
  let customer;
  if (g.customer && typeof g.customer === 'object') {
    const c = snapshotPlainRecord(g.customer);
    customer = {
      id: typeof c.id === 'string' ? c.id.slice(0, 64) : undefined,
      name: typeof c.name === 'string' ? c.name.slice(0, 128) : undefined,
      customerCode: typeof c.customerCode === 'string' ? c.customerCode.slice(0, 128) : null,
      stage: typeof c.stage === 'string' ? c.stage.slice(0, 64) : null,
    };
  }
  let conversation;
  if (g.conversation && typeof g.conversation === 'object') {
    const cv = snapshotPlainRecord(g.conversation);
    conversation = {
      id: typeof cv.id === 'string' ? cv.id.slice(0, 64) : '',
      channel: typeof cv.channel === 'string' ? cv.channel.slice(0, 64) : '',
      status: typeof cv.status === 'string' ? cv.status.slice(0, 64) : '',
      aiMode: typeof cv.aiMode === 'string' ? cv.aiMode.slice(0, 64) : null,
      assignedTo: typeof cv.assignedTo === 'string' ? cv.assignedTo.slice(0, 64) : null,
    };
  }
  let businessFacts;
  if (g.businessFacts && typeof g.businessFacts === 'object') {
    const bf = snapshotPlainRecord(g.businessFacts);
    businessFacts = {
      upcomingAppointmentsCount: typeof bf.upcomingAppointmentsCount === 'number' ? bf.upcomingAppointmentsCount : 0,
      lastCallSummary: typeof bf.lastCallSummary === 'string' ? bf.lastCallSummary.slice(0, 1000) : null,
    };
  }
  return {
    customer,
    conversation,
    recentMessages,
    knowledge,
    memories,
    businessFacts,
  };
}

export function validateBrainTurnRequest(raw: unknown): BrainTurnRequest {
  const root = snapshotPlainRecord(raw);
  assertExactKeys(
    root,
    ['version', 'turnId', 'traceId', 'scope', 'policy', 'input', 'latencyProfile', 'grounding'],
    ['version', 'turnId', 'traceId', 'scope', 'policy', 'input', 'latencyProfile']
  );

  if (root.version !== CONTRACT_VERSION) {
    deny(`Invalid contract version: expected ${CONTRACT_VERSION}`);
  }

  if (!isUuid(root.turnId)) deny('turnId must be an RFC 4122 UUID');
  if (!isUuid(root.traceId)) deny('traceId must be an RFC 4122 UUID');

  // Scope
  const scope = snapshotPlainRecord(root.scope);
  assertExactKeys(
    scope,
    ['companyId', 'customerId', 'conversationId', 'channel', 'modality', 'sessionId'],
    ['companyId', 'customerId', 'conversationId', 'channel', 'modality']
  );
  if (!isUuid(scope.companyId)) deny('scope.companyId must be an RFC 4122 UUID');
  if (!isUuid(scope.customerId)) deny('scope.customerId must be an RFC 4122 UUID');
  if (!isUuid(scope.conversationId)) deny('scope.conversationId must be an RFC 4122 UUID');
  if (scope.sessionId !== undefined && !isUuid(scope.sessionId)) {
    deny('scope.sessionId must be an RFC 4122 UUID if provided');
  }
  const channel = member(scope.channel, ALLOWED_BRAIN_CHANNELS, 'scope.channel');
  const modality = member(scope.modality, ALLOWED_BRAIN_MODALITIES, 'scope.modality');

  // Policy
  const policy = snapshotPlainRecord(root.policy);
  assertExactKeys(
    policy,
    ['permissionProfile', 'conversationState', 'allowDrafts'],
    ['permissionProfile', 'conversationState', 'allowDrafts']
  );
  if (policy.permissionProfile !== 'READ_ONLY') {
    deny('policy.permissionProfile must be READ_ONLY');
  }
  const conversationState = member(
    policy.conversationState,
    ALLOWED_CONVERSATION_STATES,
    'policy.conversationState'
  );
  if (typeof policy.allowDrafts !== 'boolean') {
    deny('policy.allowDrafts must be a boolean');
  }

  // Input
  const input = snapshotPlainRecord(root.input);
  assertExactKeys(input, ['text'], ['text']);
  const text = validateText(input.text);

  // Latency
  const latencyProfile = member(root.latencyProfile, ALLOWED_BRAIN_LATENCIES, 'latencyProfile');

  return deepFreeze({
    version: CONTRACT_VERSION,
    turnId: root.turnId as string,
    traceId: root.traceId as string,
    scope: {
      companyId: scope.companyId as string,
      customerId: scope.customerId as string,
      conversationId: scope.conversationId as string,
      channel,
      modality,
      sessionId: scope.sessionId as string | undefined,
    },
    policy: {
      permissionProfile: 'READ_ONLY',
      conversationState,
      allowDrafts: policy.allowDrafts as boolean,
    },
    input: {
      text,
    },
    latencyProfile,
    ...(root.grounding !== undefined ? { grounding: validateGrounding(root.grounding) } : {}),
  });
}

/**
 * Constant-time comparison between provided bearer token and expected server token.
 */
export function constantTimeTokenMatch(providedToken: string, expectedToken: string): boolean {
  if (typeof providedToken !== 'string' || typeof expectedToken !== 'string') {
    return false;
  }
  const providedHash = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expectedToken, 'utf8').digest();
  const hashesMatch = crypto.timingSafeEqual(providedHash, expectedHash);
  return hashesMatch && providedToken.length === expectedToken.length;
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match) return null;
  return match[1];
}

export function validateAuthorization(
  authHeader: string | undefined,
  expectedToken: string
): boolean {
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  return constantTimeTokenMatch(token, expectedToken);
}

export function findDuplicateHeaders(
  rawHeaders: readonly string[],
  targetHeaders: readonly string[]
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const targetSet = new Set(targetHeaders.map((h) => h.toLowerCase()));

  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (targetSet.has(name)) {
      if (seen.has(name)) {
        duplicates.add(name);
      } else {
        seen.add(name);
      }
    }
  }
  return Array.from(duplicates);
}
