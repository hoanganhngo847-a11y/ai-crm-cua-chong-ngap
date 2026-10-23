import 'server-only';
import {
  ALLOWED_ACTOR_TYPES, ALLOWED_BRAIN_CHANNELS, ALLOWED_BRAIN_DELIVERIES, ALLOWED_BRAIN_LATENCIES,
  ALLOWED_BRAIN_MODALITIES, ALLOWED_CONVERSATION_STATES,
  type BrainContextSelector, type BrainDelivery, type BrainErrorCode, type BrainProposal,
  type BrainProviderDescriptor, type BrainServerContext, type BrainTurnGrounding, type BrainUntrustedInput,
} from './contracts';

const boundaryCodes = new WeakMap<object, BrainErrorCode>();
export class BrainBoundaryError extends Error {
  constructor(readonly code: BrainErrorCode) { super(code); boundaryCodes.set(this, code); }
}
export function boundaryErrorCode(error: unknown): BrainErrorCode | undefined {
  return error !== null && typeof error === 'object' ? boundaryCodes.get(error) : undefined;
}
function deny(code: BrainErrorCode): never { throw new BrainBoundaryError(code); }
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}
function record(value: unknown, code: BrainErrorCode, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny(code);
  // Snapshot own data fields without invoking getters or accepting inherited authority.
  const snapshot: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) deny(code);
  for (const key of fields ?? Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property) continue;
    if (!('value' in property)) deny(code);
    snapshot[key] = property.value;
  }
  return snapshot;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], code: BrainErrorCode) {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) deny(code);
}
function member<T extends string>(value: unknown, values: readonly T[], code: BrainErrorCode): T {
  if (typeof value !== 'string' || !values.includes(value as T)) deny(code);
  return value as T;
}
function text(value: unknown, code: BrainErrorCode): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 ||
      Buffer.byteLength(value, 'utf8') > 12000) deny(code);
  return value;
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function validateUntrustedInput(raw: unknown): BrainUntrustedInput {
  const code = 'BRAIN_INVALID_CONTEXT';
  const p = record(raw, code);
  keys(p, ['customerId','conversationId','channel','modality','input','sessionId','latency','requestedCapability'], code);
  if (!isUuid(p.customerId) || !isUuid(p.conversationId) ||
      (p.sessionId !== undefined && !isUuid(p.sessionId))) deny(code);
  const input = record(p.input, code);
  keys(input, ['text'], code);
  const channel = member(p.channel, ALLOWED_BRAIN_CHANNELS, code);
  const modality = member(p.modality, ALLOWED_BRAIN_MODALITIES, code);
  const latency = p.latency === undefined ? 'STANDARD' : member(p.latency, ALLOWED_BRAIN_LATENCIES, code);
  if (p.requestedCapability !== undefined && p.requestedCapability !== 'READ_ONLY') deny('BRAIN_POLICY_DENIED');
  return deepFreeze({
    customerId: p.customerId, conversationId: p.conversationId, channel, modality,
    input: { text: text(input.text, code) }, sessionId: p.sessionId as string | undefined,
    latency, requestedCapability: 'READ_ONLY',
  });
}
export function validateServerContext(raw: unknown, selector: BrainContextSelector): BrainServerContext {
  const code = 'BRAIN_INVALID_CONTEXT';
  const p = record(raw, code);
  const caller = record(p.caller, code);
  if (!isUuid(p.companyId) || !isUuid(caller.actorId) || !isUuid(p.traceId)) deny(code);
  const actorType = member(caller.actorType, ALLOWED_ACTOR_TYPES, code);
  for (const key of ['customerId','conversationId','channel','modality','sessionId'] as const) {
    if (p[key] !== selector[key]) deny(code);
  }
  if (p.permissionProfile !== 'READ_ONLY') deny('BRAIN_POLICY_DENIED');
  const conversationState = member(p.conversationState, ALLOWED_CONVERSATION_STATES, code);
  if (typeof p.allowDrafts !== 'boolean') deny(code);
  let deliveryMode: BrainDelivery | undefined;
  if (p.deliveryMode !== undefined) {
    deliveryMode = member(p.deliveryMode, ALLOWED_BRAIN_DELIVERIES, code);
  }
  return deepFreeze({
    companyId: p.companyId, customerId: selector.customerId, conversationId: selector.conversationId,
    channel: selector.channel, modality: selector.modality, sessionId: selector.sessionId,
    caller: { actorId: caller.actorId, actorType }, permissionProfile: 'READ_ONLY',
    conversationState, allowDrafts: p.allowDrafts, deliveryMode, traceId: p.traceId,
    ...(p.grounding && typeof p.grounding === 'object' ? { grounding: p.grounding as BrainTurnGrounding } : {}),
  });
}
export function validateProviderDescriptor(raw: unknown): BrainProviderDescriptor {
  const code = 'BRAIN_PROVIDER_ERROR';
  const p = record(raw, code, ['id','model']);
  const label = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(value) ||
        /(?:^sk-|^gh[pousr]_|^AIza|^sb_secret_|^eyJ|secret|token|bearer|password)/i.test(value)) deny(code);
    return value;
  };
  // Descriptor is registered server configuration. Unknown fields are never copied or read.
  return Object.freeze({ id: label(p.id), model: label(p.model) });
}
export function validateProviderProposal(raw: unknown): BrainProposal {
  const code = 'BRAIN_PROVIDER_ERROR';
  const p = record(raw, code);
  keys(p, ['decision','draft','confidence','handoverReason','toolsUsed','memoryReferences','sourceReferences'], code);
  const decision = member(p.decision, ['RESPOND','HANDOVER','NO_REPLY'] as const, code);
  if (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1) deny(code);
  for (const key of ['toolsUsed','memoryReferences','sourceReferences']) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key].length !== 0)) deny(code);
  }
  let draft: string | undefined;
  if (decision === 'RESPOND') draft = text(p.draft, code);
  else if (p.draft !== undefined) deny(code);
  let handoverReason: string | undefined;
  if (decision === 'HANDOVER') {
    if (p.handoverReason !== undefined &&
        (typeof p.handoverReason !== 'string' || !/^[A-Z][A-Z_]{0,63}$/.test(p.handoverReason))) deny(code);
    handoverReason = (p.handoverReason as string | undefined) ?? 'PROVIDER_REQUESTED_HANDOVER';
  } else if (p.handoverReason !== undefined) deny(code);
  return deepFreeze({ decision, draft, confidence: p.confidence, handoverReason });
}
