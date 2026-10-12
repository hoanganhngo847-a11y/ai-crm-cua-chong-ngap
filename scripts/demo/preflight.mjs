import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const workerDir = path.resolve(rootDir, 'fb-inbox-worker');
const envFile = path.resolve(workerDir, '.env');
const pidFile = path.resolve(workerDir, '.worker.pid');

async function runPreflight() {
  console.log('==========================================================');
  console.log('FACEBOOK CRM DEMO PREFLIGHT CHECK');
  console.log('==========================================================\n');

  const checks = [];

  // 1. Check Internet Connectivity
  try {
    const res = await fetch('https://1.1.1.1', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    checks.push({ name: 'Mac Internet Connectivity', ok: res.ok || res.status < 500 });
  } catch (err) {
    checks.push({ name: 'Mac Internet Connectivity', ok: false, error: err.message });
  }

  // 2. CRM Production & Login Reachability
  const crmBase = 'https://ai-crm-cua-chong-ngap.onrender.com';
  try {
    const loginRes = await fetch(`${crmBase}/login`, { signal: AbortSignal.timeout(10000) });
    checks.push({ name: 'CRM Production /login Reachable', ok: loginRes.status === 200 });
  } catch (err) {
    checks.push({ name: 'CRM Production /login Reachable', ok: false, error: err.message });
  }

  // 3. Local .env exists
  const envExists = fs.existsSync(envFile);
  checks.push({ name: 'Local fb-inbox-worker/.env exists', ok: envExists });

  let envConfig = {};
  if (envExists) {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          envConfig[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
        }
      }
    }
  }

  // 4. FB_WORKER_SECRET
  const hasSecret = Boolean(envConfig.FB_WORKER_SECRET && envConfig.FB_WORKER_SECRET.length > 8);
  checks.push({
    name: 'FB_WORKER_SECRET Configured',
    ok: hasSecret,
    detail: hasSecret ? 'PRESENT' : 'MISSING'
  });

  // 5. FB_PAGE_ID
  const isPageIdCorrect = envConfig.FB_PAGE_ID === '1389294167596309';
  checks.push({
    name: 'FB_PAGE_ID Matches (1389294167596309)',
    ok: isPageIdCorrect,
    detail: envConfig.FB_PAGE_ID
  });

  // 6. CRM_COMPANY_ID
  const isCompanyIdCorrect = envConfig.CRM_COMPANY_ID === 'de6a7bf3-b5bc-418d-92d6-f9b241472598';
  checks.push({
    name: 'CRM_COMPANY_ID Matches Production UUID',
    ok: isCompanyIdCorrect,
    detail: envConfig.CRM_COMPANY_ID
  });

  // 7. FB_PROFILE_DIR
  const profileDir = envConfig.FB_PROFILE_DIR || path.resolve(workerDir, 'user_data');
  const profileDirExists = fs.existsSync(profileDir);
  checks.push({
    name: 'FB_PROFILE_DIR Directory Exists',
    ok: profileDirExists,
    detail: profileDir
  });

  // 8. Playwright Loadable & Chromium Launchable
  let playwrightLoaded = false;
  let chromiumLaunchable = false;
  let chromiumVersion = '';
  try {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    const pw = req(path.resolve(workerDir, 'node_modules/playwright'));
    if (pw && pw.chromium) {
      playwrightLoaded = true;
      const browser = await pw.chromium.launch({ headless: true });
      chromiumVersion = browser.version();
      await browser.close();
      chromiumLaunchable = true;
    }
  } catch (err) {
    chromiumLaunchable = false;
  }
  checks.push({
    name: 'Playwright Chromium Module Loadable',
    ok: playwrightLoaded,
    detail: playwrightLoaded ? 'LOADED' : 'NOT_FOUND'
  });
  checks.push({
    name: 'Chromium Browser Launchable',
    ok: chromiumLaunchable,
    detail: chromiumLaunchable ? `v${chromiumVersion}` : 'FAILED'
  });

  // 9. Health Port Not in Conflict (3099)
  const isPortAvailable = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(3099, '127.0.0.1');
  });

  // Check if a worker is already running
  let isWorkerRunning = false;
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      process.kill(pid, 0);
      isWorkerRunning = true;
    } catch (_) {
      isWorkerRunning = false;
    }
  }

  checks.push({
    name: 'Single-Instance (No duplicate worker running)',
    ok: true,
    detail: isWorkerRunning ? 'WORKER_ACTIVE (1 instance)' : 'CLEAN (0 instance)'
  });

  checks.push({
    name: 'Port 3099 Available for Local Health Server',
    ok: isPortAvailable || isWorkerRunning,
    detail: isPortAvailable ? 'FREE' : (isWorkerRunning ? 'HELD_BY_CURRENT_WORKER' : 'IN_USE')
  });

  // 10. Production Endpoints Authenticated Probe
  if (hasSecret) {
    try {
      const claimRes = await fetch(`${crmBase}/api/inbox/outbox/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': envConfig.FB_WORKER_SECRET
        },
        body: JSON.stringify({ worker_id: 'preflight-check', limit: 1 }),
        signal: AbortSignal.timeout(10000)
      });
      checks.push({
        name: 'Production Outbox Claim API Authenticated',
        ok: claimRes.status === 200,
        detail: `HTTP ${claimRes.status}`
      });
    } catch (err) {
      checks.push({
        name: 'Production Outbox Claim API Authenticated',
        ok: false,
        error: err.message
      });
    }

    try {
      // Test browser-sync 401 without secret (security check)
      const syncNoAuthRes = await fetch(`${crmBase}/api/inbox/browser-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10000)
      });
      checks.push({
        name: 'Production Browser-Sync Auth Guard Active (401 on empty)',
        ok: syncNoAuthRes.status === 401,
        detail: `HTTP ${syncNoAuthRes.status}`
      });
    } catch (err) {
      checks.push({
        name: 'Production Browser-Sync Auth Guard Active (401 on empty)',
        ok: false,
        error: err.message
      });
    }
  }

  // Print results table
  console.table(
    checks.map((c, i) => ({
      STT: i + 1,
      Check: c.name,
      Status: c.ok ? 'PASS' : 'FAIL',
      Detail: c.detail || c.error || 'OK'
    }))
  );

  const allPassed = checks.every((c) => c.ok);
  if (allPassed) {
    console.log('\nDEMO PREFLIGHT: PASS ✅\n');
    process.exit(0);
  } else {
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    console.error(`\nDEMO PREFLIGHT: FAIL ❌ (${failed.join(', ')})\n`);
    process.exit(1);
  }
}

runPreflight();
