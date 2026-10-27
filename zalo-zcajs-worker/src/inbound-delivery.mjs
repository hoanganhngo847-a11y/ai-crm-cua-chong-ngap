/**
 * Durable-ish inbound delivery to the CRM.
 *
 * Zalo is the source of truth for customer messages. Dropping a payload after a
 * fixed number of retries loses that message from the CRM forever, so transient
 * failures (CRM deploy, network partition, 5xx, auth misconfiguration) keep
 * retrying with capped exponential backoff for the lifetime of the worker.
 *
 * The worker also re-scans Zalo's recent-DM REST endpoint on every reconnect,
 * which recovers messages that were queued in memory when the process restarted.
 */

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function payloadKey(payload) {
  return `${payload?.externalUserId || ''}:${payload?.messageId || ''}`;
}

function retryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const exponential = baseDelayMs * 2 ** Math.min(Math.max(attempt, 0), 10);
  const capped = Math.min(maxDelayMs, exponential);
  // Small jitter avoids a thundering herd after a CRM restart.
  const jitter = Math.floor(Math.random() * Math.min(1_000, capped * 0.2));
  return capped + jitter;
}

export function createInboundDelivery(options) {
  const {
    crmBaseUrl,
    workerSecret,
    fetchImpl = globalThis.fetch,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    logger = console,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onDelivered,
  } = options || {};

  if (!crmBaseUrl) throw new Error('crmBaseUrl is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const endpoint = `${String(crmBaseUrl).replace(/\/$/, '')}/api/inbox/zalo-zcajs/inbound`;
  const inFlight = new Map();
  const timers = new Set();
  let stopped = false;

  function schedule(payload, attempt, delayMs) {
    if (stopped) return;
    const timer = setTimeoutImpl(() => {
      timers.delete(timer);
      void attemptDelivery(payload, attempt);
    }, delayMs);
    timer?.unref?.();
    timers.add(timer);
  }

  async function attemptDelivery(payload, attempt) {
    const key = payloadKey(payload);
    if (stopped) {
      inFlight.delete(key);
      return false;
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      const body = await response.json().catch(() => null);
      if (response.ok && body?.success !== false) {
        inFlight.delete(key);
        onDelivered?.(payload, body);
        return true;
      }

      const error = new Error(`CRM_HTTP_${response.status}`);
      error.status = response.status;
      throw error;
    } catch (error) {
      if (stopped) {
        inFlight.delete(key);
        return false;
      }

      const message = error instanceof Error ? error.message : 'unknown';
      // Keep logs useful without flooding them while the CRM is down for hours.
      if (attempt === 0 || attempt % 10 === 0) {
        logger.warn(
          `[ZCAJS] inbound delivery failed (attempt ${attempt + 1}); will retry:`,
          message
        );
      }

      schedule(payload, attempt + 1, retryDelayMs(attempt, baseDelayMs, maxDelayMs));
      return false;
    }
  }

  function deliver(payload) {
    const key = payloadKey(payload);
    if (stopped || inFlight.has(key)) return Promise.resolve(false);
    inFlight.set(key, true);
    return attemptDelivery(payload, 0);
  }

  function stop() {
    stopped = true;
    for (const timer of timers) clearTimeoutImpl(timer);
    timers.clear();
    inFlight.clear();
  }

  return {
    deliver,
    stop,
    pendingCount: () => inFlight.size,
  };
}
