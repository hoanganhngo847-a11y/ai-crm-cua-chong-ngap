const PORT = Number(process.env.PORT || 10000);
const COMPANY_ID = (process.env.ZCAJS_COMPANY_ID || '').trim();
const CRM_BASE_URL = (process.env.ZCAJS_CRM_BASE_URL || '').trim().replace(/\/$/, '');
const WORKER_SECRET = process.env.ZCAJS_WORKER_SECRET || '';
const POLL_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.ZCAJS_OUTBOUND_POLL_MS || 2000) || 2000
);
const DISPATCH_BATCH_LIMIT = Math.max(
  1,
  Math.min(20, Number(process.env.ZCAJS_OUTBOUND_BATCH_LIMIT || 5) || 5)
);
const CONTACT_SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.ZCAJS_CONTACT_SYNC_MS || 300_000) || 300_000
);

let stopping = false;
let nextContactSyncAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLocalWorkerReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function syncContacts() {
  if (!COMPANY_ID || !CRM_BASE_URL || !WORKER_SECRET) return;
  if (Date.now() < nextContactSyncAt) return;

  const ready = await isLocalWorkerReady();
  if (!ready) {
    // Retry shortly if local worker is not ready yet instead of waiting a full cycle
    nextContactSyncAt = Date.now() + 5000;
    return;
  }

  // Schedule next routine sync
  nextContactSyncAt = Date.now() + CONTACT_SYNC_INTERVAL_MS;

  try {
    const directoryResponse = await fetch(
      `http://127.0.0.1:${PORT}/v1/contacts?companyId=${encodeURIComponent(COMPANY_ID)}`,
      {
        headers: { authorization: `Bearer ${WORKER_SECRET}` },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!directoryResponse.ok) {
      console.warn(`[ZCAJS] contact directory read failed: local HTTP ${directoryResponse.status}`);
      return;
    }
    const directory = await directoryResponse.json().catch(() => null);
    const contacts = Array.isArray(directory?.contacts) ? directory.contacts : [];

    const response = await fetch(`${CRM_BASE_URL}/api/inbox/zalo-zcajs/contacts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_SECRET}`,
      },
      body: JSON.stringify({ companyId: COMPANY_ID, contacts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => null);
      console.warn(
        `[ZCAJS] contact sync failed: CRM HTTP ${response.status} error=${errBody?.error || 'UNKNOWN'}`
      );
      return;
    }
    const result = await response.json().catch(() => null);
    console.log(
      `[ZCAJS] contact sync: seen=${Number(result?.seen || 0)} autoLinked=${Number(result?.autoLinked || 0)}`
    );
  } catch (error) {
    console.warn(
      '[ZCAJS] contact sync error:',
      error instanceof Error ? error.message : 'unknown'
    );
  }
}

async function dispatchPending() {
  if (!CRM_BASE_URL || !WORKER_SECRET) return;
  if (!(await isLocalWorkerReady())) return;

  try {
    const response = await fetch(`${CRM_BASE_URL}/api/inbox/zalo-zcajs/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WORKER_SECRET}`,
      },
      body: JSON.stringify({ limit: DISPATCH_BATCH_LIMIT }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      console.warn(`[ZCAJS] outbound dispatch tick failed: CRM HTTP ${response.status}`);
      return;
    }

    const result = await response.json().catch(() => null);
    if (result?.dispatched > 0) {
      console.log(
        `[ZCAJS] outbound dispatch: dispatched=${result.dispatched} sent=${result.sent} failed=${result.failed} uncertain=${result.uncertain} skipped=${result.skipped}`
      );
    }
  } catch (error) {
    console.warn(
      '[ZCAJS] outbound dispatch tick error:',
      error instanceof Error ? error.message : 'unknown'
    );
  }
}

async function main() {
  while (!stopping) {
    await syncContacts();
    await dispatchPending();
    if (!stopping) await sleep(POLL_INTERVAL_MS);
  }
}

process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

void main();
