/**
 * Durable-ish inbound delivery to the CRM.
 *
 * Zalo is the source of truth for customer messages. Dropping a payload after a
 * fixed number of retries loses that message from the CRM forever, so transient
 * failures (CRM deploy, network partition, 5xx, auth misconfiguration) keep
 * retrying with capped exponential backoff for the lifetime of the worker.
 *
 * A process restart used to drop every message that was still waiting for the
 * CRM. The pending payloads are therefore written to an append/rewrite queue on
 * disk before the first HTTP attempt and only removed after the CRM confirms
 * success. On boot the queue is replayed before the listener starts receiving
 * new traffic.
 *
 * The worker also re-scans Zalo's recent-DM REST endpoint on every reconnect,
 * which recovers messages that were never observed by the WebSocket listener.
 */

import fs from 'fs/promises';
import path from 'path';

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_QUEUE_MAX_ENTRIES = 20_000;

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

function defaultQueueFile() {
  const configured = String(process.env.ZCAJS_INBOX_QUEUE_FILE || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), 'data', 'zcajs-inbound-queue.jsonl');
}

function serializePayloads(payloads) {
  return payloads.map((payload) => JSON.stringify(payload)).join('\n') + (payloads.length ? '\n' : '');
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
    preparePayload = async (payload) => payload,
    queueFile = defaultQueueFile(),
    queueMaxEntries = DEFAULT_QUEUE_MAX_ENTRIES,
  } = options || {};

  if (!crmBaseUrl) throw new Error('crmBaseUrl is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  const endpoint = `${String(crmBaseUrl).replace(/\/$/, '')}/api/inbox/zalo-zcajs/inbound`;
  const inFlight = new Map();
  const pending = new Map();
  const timers = new Set();
  let stopped = false;
  let writeChain = Promise.resolve();
  let resumeStarted = false;
  let persistenceError = null;
  let recoveryBlocked = false;

  function schedule(payload, attempt, delayMs) {
    if (stopped) return;
    const timer = setTimeoutImpl(() => {
      timers.delete(timer);
      void attemptDelivery(payload, attempt);
    }, delayMs);
    timer?.unref?.();
    timers.add(timer);
  }

  function persist() {
    if (!queueFile || recoveryBlocked) return writeChain;
    const snapshot = serializePayloads([...pending.values()]);
    const target = queueFile;
    const temp = `${target}.tmp`;
    writeChain = writeChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const handle = await fs.open(temp, 'w', 0o600);
        try {
          await handle.writeFile(snapshot, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, target);
        persistenceError = null;
      })
      .catch((error) => {
        persistenceError = error.message;
        logger.warn(
          '[ZCAJS] inbound queue persistence failed:',
          error instanceof Error ? error.message : 'unknown'
        );
      });
    return writeChain;
  }

  async function attemptDelivery(payload, attempt) {
    const key = payloadKey(payload);
    if (stopped) {
      inFlight.delete(key);
      return false;
    }

    if (pending.size > queueMaxEntries && attempt === 0) {
      logger.error(
        `[ZCAJS] inbound queue exceeds ${queueMaxEntries} entries; retaining ALL unacknowledged messages`
      );
    }

    try {
      // Persist the original event before any slow metadata/network lookup.
      // A failed disk write remains visible and retries without claiming durability.
      if (persistenceError) {
        await persist();
        if (persistenceError) throw new Error('INBOUND_QUEUE_NOT_DURABLE');
      }
      const prepared = await preparePayload({ ...payload });
      if (stopped) return false;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify(prepared),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      const body = await response.json().catch(() => null);
      if (response.ok && body?.success === true) {
        inFlight.delete(key);
        if (pending.delete(key)) void persist();
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

  async function deliver(payload) {
    const key = payloadKey(payload);
    if (stopped || inFlight.has(key)) return false;
    inFlight.set(key, true);
    pending.set(key, payload);
    // Persist before the first HTTP attempt. If the process is restarted while
    // the CRM is down (or immediately after receipt), resume() can replay it.
    await persist();
    if (stopped) {
      inFlight.delete(key);
      return false;
    }
    return attemptDelivery(payload, 0);
  }

  async function resume() {
    if (!queueFile || resumeStarted) return false;
    resumeStarted = true;
    let raw = '';
    try {
      raw = await fs.readFile(queueFile, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        persistenceError = error.message;
        recoveryBlocked = true;
        logger.warn(
          '[ZCAJS] inbound queue could not be read:',
          error instanceof Error ? error.message : 'unknown'
        );
      }
      if (error?.code === 'ENOENT') await persist();
      return false;
    }

    let restored = 0;
    let malformed = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        malformed = true;
        logger.warn('[ZCAJS] malformed inbound queue record; preserving the original file for recovery');
        continue;
      }
      if (!payload?.messageId || !payload?.externalUserId) { malformed = true; continue; }
      const key = payloadKey(payload);
      if (pending.has(key)) continue;
      pending.set(key, payload);
      restored += 1;
    }

    if (malformed) {
      try {
        await fs.copyFile(queueFile, `${queueFile}.quarantine-${Date.now()}`);
      } catch (error) {
        recoveryBlocked = true;
        persistenceError = error.message;
        return false;
      }
    }

    if (restored === 0) return false;

    logger.log(`[ZCAJS] replaying ${restored} pending inbound message(s) from disk`);
    for (const [key, payload] of pending.entries()) {
      if (stopped) break;
      if (inFlight.has(key)) continue;
      inFlight.set(key, true);
      void attemptDelivery(payload, 0);
    }
    return true;
  }

  function stop() {
    stopped = true;
    for (const timer of timers) clearTimeoutImpl(timer);
    timers.clear();
    inFlight.clear();
    // Keep the on-disk queue (if enabled) so a restart can replay it; drop only
    // the in-memory bookkeeping for this process.
    pending.clear();
  }

  return {
    deliver,
    resume,
    stop,
    pendingCount: () => pending.size,
    persistenceError: () => persistenceError,
    /** Await queued disk writes (tests and graceful shutdown). */
    flush: () => writeChain,
  };
}
