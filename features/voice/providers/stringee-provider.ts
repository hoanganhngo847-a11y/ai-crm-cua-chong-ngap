import 'server-only';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { CallProvider } from '../../../shared/contracts/sensitive';

type FetchLike = typeof fetch;

interface StringeeResponse {
  r?: number;
  message?: string;
  call_id?: string;
  callId?: string;
  data?: { call_id?: string; callId?: string };
}

export interface StringeeProviderConfig {
  fromNumber: string;
  answerUrl: string;
  aiAgentUserId?: string;
  /** Legacy fixed sale user. New CRM sales use deterministic per-user identities instead. */
  saleAgentUserId?: string;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function signStringeeJwt(apiKey: string, apiSecret: string, payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ typ: 'JWT', alg: 'HS256', cty: 'stringee-api;v=1' }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsigned = `${header}.${encodedPayload}`;
  const signature = createHmac('sha256', apiSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

/** Create the short-lived HS256 token required by Stringee REST APIs. */
export function createStringeeRestToken(
  apiKey: string,
  apiSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  return signStringeeJwt(apiKey, apiSecret, {
    jti: `${apiKey}_${nowSeconds}_${randomUUID()}`,
    iss: apiKey,
    exp: nowSeconds + 300,
    rest_api: true,
  });
}

/**
 * Stable Stringee Web-SDK identity for one authenticated CRM user.
 * Hashing prevents the CRM auth UUID from becoming a provider-visible identifier while preserving
 * deterministic routing between the server-initiated call and the sale's browser softphone.
 */
export function toStringeeSaleUserId(crmUserId: string): string {
  const normalized = crmUserId.trim();
  if (!normalized || normalized.length > 200) throw new Error('Invalid CRM user id for Stringee identity.');
  const digest = createHash('sha256').update(`crm-stringee-sale:${normalized}`).digest('hex').slice(0, 32);
  return `crm_sale_${digest}`;
}

/** Create a short-lived Web-SDK access token. API secret never leaves the server. */
export function createStringeeClientToken(
  apiKey: string,
  apiSecret: string,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (!/^[A-Za-z0-9_.-]{3,120}$/.test(userId)) throw new Error('Invalid Stringee user id.');
  return signStringeeJwt(apiKey, apiSecret, {
    jti: `${apiKey}_${nowSeconds}_${randomUUID()}`,
    iss: apiKey,
    exp: nowSeconds + 3600,
    userId,
  });
}

export function isAllowedCrmStringeeAgentUserId(userId: string, config?: StringeeProviderConfig): boolean {
  if (!userId) return false;
  if (config?.aiAgentUserId && userId === config.aiAgentUserId) return true;
  if (config?.saleAgentUserId && userId === config.saleAgentUserId) return true;
  return /^crm_sale_[a-f0-9]{32}$/.test(userId);
}

/** Provider-specific Stringee details stay behind the generic CallProvider contract. */
export class StringeeProvider implements CallProvider {
  readonly name = 'STRINGEE' as const;
  private readonly fromNumber: string;
  private readonly answerUrl: string;
  private readonly aiAgentUserId?: string;
  private readonly saleAgentUserId?: string;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
    config?: StringeeProviderConfig
  ) {
    this.fromNumber = config?.fromNumber || process.env.STRINGEE_FROM_NUMBER || '';
    this.answerUrl = config?.answerUrl || process.env.STRINGEE_ANSWER_URL || '';
    this.aiAgentUserId = config?.aiAgentUserId || process.env.STRINGEE_AI_AGENT_USER_ID;
    this.saleAgentUserId = config?.saleAgentUserId || process.env.STRINGEE_SALE_AGENT_USER_ID;
    if (!this.fromNumber || !this.answerUrl) throw new Error('Stringee configuration is incomplete.');
  }

  async initiateCall(params: {
    fromStaffUserId: string;
    targetRawPhone: string;
    customerId: string;
    companyId: string;
  }): Promise<{ providerCallId: string; status: string }> {
    const correlationId = `crm_${randomUUID()}`;
    const agentUserId = params.fromStaffUserId === 'AI_WORKER'
      ? this.aiAgentUserId
      : toStringeeSaleUserId(params.fromStaffUserId);
    if (!agentUserId) throw new Error('Stringee agent is not configured.');
    const answerUrl = new URL(this.answerUrl);
    answerUrl.searchParams.set('crmCorrelationId', correlationId);
    answerUrl.searchParams.set('agentUserId', agentUserId);

    const response = await this.fetchImpl('https://api.stringee.com/v1/call2/callout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-stringee-auth': createStringeeRestToken(this.apiKey, this.apiSecret),
      },
      body: JSON.stringify({
        from: { type: 'external', number: this.fromNumber, alias: 'AI CRM' },
        to: [{ type: 'external', number: params.targetRawPhone, alias: 'Khach hang' }],
        answer_url: answerUrl.toString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) throw new Error('Stringee request failed.');
    const body = (await response.json()) as StringeeResponse;
    if (body.r !== 0) throw new Error('Stringee rejected the call.');

    // The documented response only guarantees r/message. The signed answer_url
    // replaces this temporary correlation id with Stringee's canonical callId.
    const providerCallId =
      body.call_id || body.callId || body.data?.call_id || body.data?.callId || correlationId;
    return { providerCallId, status: 'INITIATED' };
  }

  async downloadRecording(recordingId: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    if (!/^[A-Za-z0-9._-]{8,200}$/.test(recordingId)) throw new Error('Invalid recording id.');

    const response = await this.fetchImpl(
      `https://api.stringee.com/v1/call/recording/${encodeURIComponent(recordingId)}`,
      {
        headers: { 'x-stringee-auth': createStringeeRestToken(this.apiKey, this.apiSecret) },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!response.ok) throw new Error('Recording download failed.');

    const maxBytes = Number(process.env.VOICE_MAX_RECORDING_BYTES || 25 * 1024 * 1024);
    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > maxBytes) throw new Error('Recording exceeds configured size limit.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error('Recording exceeds configured size limit.');
    return { bytes, contentType: response.headers.get('content-type') || 'audio/mpeg' };
  }
}
