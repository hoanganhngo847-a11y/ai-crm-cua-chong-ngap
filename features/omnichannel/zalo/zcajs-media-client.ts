import 'server-only';

const MEDIA_TIMEOUT_MS = 90_000;

export interface ZcaJsMediaFilePayload {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface ZcaJsMediaSendResult {
  outcome: 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';
  providerMessageIds?: string[];
  errorCode?: string;
  errorMessage?: string;
}

interface WorkerResponse {
  outcome?: 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';
  providerMessageIds?: Array<string | number>;
  errorCode?: string;
  errorMessage?: string;
}

function requireConfig(companyId: string) {
  const configuredCompanyId = (process.env.ZALO_ZCAJS_COMPANY_ID || '').trim();
  const workerUrl = (process.env.ZALO_ZCAJS_WORKER_URL || '').trim();
  const workerSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';

  if (!configuredCompanyId || !workerUrl || !workerSecret) {
    throw new Error('ZCAJS media transport is not configured.');
  }
  if (configuredCompanyId !== companyId) {
    throw new Error('ZCAJS media transport is not configured for this company.');
  }

  let parsed: URL;
  try {
    parsed = new URL(workerUrl);
  } catch {
    throw new Error('ZALO_ZCAJS_WORKER_URL is invalid.');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('ZALO_ZCAJS_WORKER_URL must use HTTPS in production.');
  }

  return {
    companyId: configuredCompanyId,
    workerUrl: parsed.toString(),
    workerSecret,
  };
}

export async function sendZcaJsMediaMessage(
  companyId: string,
  recipientZaloId: string,
  text: string,
  files: ZcaJsMediaFilePayload[],
  options: { fetchFn?: typeof fetch } = {}
): Promise<ZcaJsMediaSendResult> {
  const recipient = recipientZaloId.trim();
  if (!recipient || !Array.isArray(files) || files.length === 0) {
    return {
      outcome: 'REJECTED',
      errorCode: 'INVALID_ARGUMENT',
      errorMessage: 'Recipient and at least one media file are required.',
    };
  }

  const config = requireConfig(companyId);
  const fetchFn = options.fetchFn || fetch;

  let response: Response;
  try {
    response = await fetchFn(new URL('/v1/send-media', config.workerUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.workerSecret}`,
      },
      body: JSON.stringify({
        companyId: config.companyId,
        recipientZaloId: recipient,
        text: text.trim(),
        files,
      }),
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {
      outcome: 'UNCERTAIN',
      errorCode: 'ZCAJS_MEDIA_NETWORK_ERROR',
      errorMessage: error instanceof Error ? error.message : 'ZCAJS media request failed.',
    };
  }

  let body: WorkerResponse | null = null;
  try {
    body = (await response.json()) as WorkerResponse;
  } catch {
    // Once the upload leaves this process, an unreadable response is ambiguous.
  }

  if (response.ok && body?.outcome === 'ACCEPTED') {
    const providerMessageIds = (body.providerMessageIds || [])
      .map((value) => String(value).trim())
      .filter(Boolean);
    if (providerMessageIds.length === 0) {
      return {
        outcome: 'UNCERTAIN',
        errorCode: 'MISSING_PROVIDER_MSG_ID',
        errorMessage: 'ZCAJS reported media success without provider message ids.',
      };
    }
    return { outcome: 'ACCEPTED', providerMessageIds };
  }

  if (body?.outcome === 'REJECTED' || (response.status >= 400 && response.status < 500)) {
    return {
      outcome: 'REJECTED',
      errorCode: body?.errorCode || `HTTP_${response.status}`,
      errorMessage: body?.errorMessage || 'ZCAJS worker rejected the media message.',
    };
  }

  return {
    outcome: 'UNCERTAIN',
    errorCode: body?.errorCode || `HTTP_${response.status}`,
    errorMessage: body?.errorMessage || 'ZCAJS media delivery outcome is uncertain.',
  };
}
