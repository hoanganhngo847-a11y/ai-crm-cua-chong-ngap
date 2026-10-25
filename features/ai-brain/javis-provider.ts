import 'server-only';
import { diagnosticFromHeaders, httpProviderFailure } from './provider-failure';

import type { BrainProposal, BrainProvider, BrainProviderDescriptor, BrainTurnRequest } from './contracts';
import { validateProviderProposal } from './validation';
import { dossierContextSchema, validateDossierSnapshot, type DossierContext, type DossierSnapshot } from '../customer-360/contracts';

const TURN_PATH = '/v1/brain/turn';
const HEALTH_PATH = '/health';
const CONTRACT_VERSION = 'v1';
const SERVICE_NAME = 'javis-brain';
const PROVIDER_ID = 'javis-brain-service';
const MODEL_ID = 'javis-router-v1';

export type JavisFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface JavisBrainProviderOptions {
  /** Server-owned HTTPS origin for the future Javis-compatible Brain Service. */
  readonly baseUrl: string;
  /** Server-only bearer credential. Never copied into provider metadata, request bodies or errors. */
  readonly authToken: string;
  /** Test seam only. Production callers should leave this unset and use global fetch. */
  readonly fetchImpl?: JavisFetch;
}

export interface JavisBrainHealth {
  readonly ok: true;
  readonly service: 'javis-brain';
  readonly version: 'v1';
}

class JavisAdapterError extends Error {
  constructor() {
    // Deliberately constant. Never include URL, response body, token, provider text or headers.
    super('JAVIS_BRAIN_ADAPTER_ERROR');
  }
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new JavisAdapterError();
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new JavisAdapterError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new JavisAdapterError();
    output[key] = descriptor.value;
  }
  return output;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new JavisAdapterError();
  }
}

function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2048) throw new JavisAdapterError();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new JavisAdapterError();
  }
  // Phase 1B deliberately accepts HTTPS only. Private-network HTTP may be introduced later
  // behind an explicit deployment decision rather than silently weakening transport security.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new JavisAdapterError();
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeToken(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 24 || raw.length > 512 || /\s/.test(raw)) {
    throw new JavisAdapterError();
  }
  return raw;
}

function parseTurnEnvelope(raw: unknown): BrainProposal {
  const envelope = snapshotRecord(raw);
  exactKeys(envelope, ['ok', 'version', 'proposal']);
  if (envelope.ok !== true || envelope.version !== CONTRACT_VERSION) throw new JavisAdapterError();
  // Validate at the transport boundary and again in BrainService. The second validation protects
  // callers even if this adapter is replaced; this one prevents malformed remote data travelling farther.
  return validateProviderProposal(envelope.proposal);
}

function parseHealthEnvelope(raw: unknown): JavisBrainHealth {
  const envelope = snapshotRecord(raw);
  exactKeys(envelope, ['ok', 'service', 'version']);
  if (envelope.ok !== true || envelope.service !== SERVICE_NAME || envelope.version !== CONTRACT_VERSION) {
    throw new JavisAdapterError();
  }
  return Object.freeze({ ok: true, service: SERVICE_NAME, version: CONTRACT_VERSION });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    // Do not inspect response.text(): upstream bodies may contain stack traces or credentials.
    await response.body?.cancel().catch(() => undefined);
    throw diagnosticFromHeaders(response.headers) ?? httpProviderFailure('JAVIS_BRAIN', response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new JavisAdapterError();
  }
}

/**
 * Provider adapter for a future Javis-compatible internal Brain Service.
 *
 * This does NOT call Javis OS /chat directly. The companion service must expose a narrow,
 * structured contract and may internally delegate to Javis. CRM remains the authority for
 * tenant scope and policy; this provider receives an already-authorized, immutable READ_ONLY turn.
 */
export class JavisBrainProvider implements BrainProvider {
  readonly descriptor: BrainProviderDescriptor = Object.freeze({ id: PROVIDER_ID, model: MODEL_ID });

  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: JavisFetch;

  constructor(options: JavisBrainProviderOptions) {
    this.#baseUrl = normalizeBaseUrl(options?.baseUrl);
    this.#token = normalizeToken(options?.authToken);
    this.#fetch = options?.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new JavisAdapterError();
  }

  #headers(contentType = false): HeadersInit {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.#token}`,
      'X-AI-Brain-Contract': CONTRACT_VERSION,
      ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch {
      // fetch/network exceptions often embed hostnames, DNS details or proxy text. Collapse them
      // before they cross the adapter boundary. BrainService still distinguishes deadline aborts
      // through its own AbortSignal state and maps those to BRAIN_TIMEOUT.
      throw new JavisAdapterError();
    }
  }

  async runTurn(request: BrainTurnRequest, options: { signal: AbortSignal }): Promise<BrainProposal> {
    const response = await this.#request(`${this.#baseUrl}${TURN_PATH}`, {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify(request),
      signal: options.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    return parseTurnEnvelope(await readJsonResponse(response));
  }

  /** Task extension on the existing Brain provider. CRM alone owns source selection and persistence. */
  async runDossier(context: DossierContext, options: { signal: AbortSignal }): Promise<DossierSnapshot> {
    dossierContextSchema.parse(context);
    const response = await this.#request(`${this.#baseUrl}/v1/brain/dossier`, {
      method: 'POST', headers: this.#headers(true), body: JSON.stringify(context),
      signal: options.signal, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok || !response.body) throw new JavisAdapterError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 24 * 1024) throw new JavisAdapterError();
        chunks.push(value);
      }
      const envelope = snapshotRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      exactKeys(envelope, ['ok', 'version', 'snapshot']);
      if (envelope.ok !== true || envelope.version !== 'dossier-v1') throw new JavisAdapterError();
      return validateDossierSnapshot(envelope.snapshot, context);
    } catch { throw new JavisAdapterError(); }
    finally { await reader.cancel().catch(() => undefined); }
  }

  /** Explicit readiness probe for deployment/operations. No CRM payload is sent. */
  async checkHealth(options: { signal: AbortSignal }): Promise<JavisBrainHealth> {
    const response = await this.#request(`${this.#baseUrl}${HEALTH_PATH}`, {
      method: 'GET',
      headers: this.#headers(false),
      signal: options.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    return parseHealthEnvelope(await readJsonResponse(response));
  }
}
