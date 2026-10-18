const PORT = Number(process.env.PORT || 10000);
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

let stopping = false;

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
