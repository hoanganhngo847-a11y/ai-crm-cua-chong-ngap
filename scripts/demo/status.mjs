import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const workerDir = path.resolve(rootDir, 'fb-inbox-worker');
const pidFile = path.resolve(workerDir, '.worker.pid');

const CRM_BASE_URL = 'https://ai-crm-cua-chong-ngap.onrender.com';
const EXPECTED_PAGE_ID = '1389294167596309';
const HEALTH_URL = 'http://127.0.0.1:3099/health';
const READY_URL = 'http://127.0.0.1:3099/ready';

async function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function checkCRM() {
  try {
    const res = await fetch(`${CRM_BASE_URL}/login`, { signal: AbortSignal.timeout(8000) });
    return res.status >= 200 && res.status < 400;
  } catch (_) {
    return false;
  }
}

async function checkHealth() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (res.status === 200) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch (_) {}
  return { ok: false, data: null };
}

async function checkReady() {
  try {
    const res = await fetch(READY_URL, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  } catch (_) {
    return false;
  }
}

async function main() {
  console.log('=== FACEBOOK CRM DEMO STATUS ===\n');

  // 1. Worker process status
  let isWorkerRunning = false;
  let workerPid = null;

  if (fs.existsSync(pidFile)) {
    const rawPid = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(rawPid, 10);
    if (!isNaN(pid) && (await isProcessAlive(pid))) {
      isWorkerRunning = true;
      workerPid = pid;
    }
  }

  // 2. Health & Ready status
  const healthResult = await checkHealth();
  const isHealthy = healthResult.ok;
  const healthData = healthResult.data || {};
  const isReady = await checkReady();

  // 3. CRM status
  const isCrmOnline = await checkCRM();

  // 4. Parse meta inbox state
  const metaInboxState = healthData.meta_inbox_state || (isWorkerRunning ? 'STARTING' : 'OFFLINE');
  const sessionStatus = (metaInboxState === 'READY' || metaInboxState === 'INBOX_READY') 
    ? 'VALID' 
    : (metaInboxState === 'LOGIN_REQUIRED' ? 'REQUIRED' : 'UNKNOWN');
  const pendingOutbox = healthData.pending_outbox_count ?? 0;

  console.log(`Mac worker: ${isWorkerRunning ? `RUNNING (PID ${workerPid})` : 'STOPPED'}`);
  console.log(`CRM production: ${isCrmOnline ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`Local health: ${isHealthy ? 'HEALTHY' : 'DOWN'}`);
  console.log(`Meta Inbox: ${metaInboxState}`);
  console.log(`Facebook session: ${sessionStatus}`);
  console.log(`Page ID: ${EXPECTED_PAGE_ID}`);
  console.log(`Poll interval: 5000ms`);
  console.log(`Pending outbox: ${pendingOutbox}`);
  console.log('');

  const isDemoReady = isWorkerRunning && isCrmOnline && isHealthy && isReady;

  if (isDemoReady) {
    console.log('READY FOR DEMO ✅');
    process.exit(0);
  } else {
    const reasons = [];
    if (!isWorkerRunning) reasons.push('Mac worker is not running (run `npm run demo:start`)');
    if (!isCrmOnline) reasons.push('CRM production is unreachable');
    if (!isHealthy) reasons.push('Local health server port 3099 is not responding');
    if (!isReady) {
      if (metaInboxState === 'LOGIN_REQUIRED') {
        reasons.push('Facebook login is required (login directly in the open Chromium window)');
      } else {
        reasons.push(`Meta Inbox is ${metaInboxState} (waiting for INBOX_READY)`);
      }
    }
    console.log(`NOT READY ❌: ${reasons.join('; ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error checking status:', err.message);
  process.exit(1);
});
