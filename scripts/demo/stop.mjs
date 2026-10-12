import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const workerDir = path.resolve(rootDir, 'fb-inbox-worker');
const pidFile = path.resolve(workerDir, '.worker.pid');

async function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function stopProcess(pid) {
  try {
    // Send SIGTERM to process group or PID
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      console.warn(`Warning sending SIGTERM to ${pid}:`, err.message);
    }
  }

  // Poll for exit
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!(await isProcessAlive(pid))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Force kill if still alive
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_) {}

  await new Promise((r) => setTimeout(r, 500));
  return !(await isProcessAlive(pid));
}

async function main() {
  console.log('Stopping Local Facebook Worker...');

  if (!fs.existsSync(pidFile)) {
    console.log('[DEMO STOP] No worker PID file found. Worker is not running.');
    process.exit(0);
  }

  const rawPid = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = parseInt(rawPid, 10);

  if (isNaN(pid)) {
    fs.unlinkSync(pidFile);
    console.log('[DEMO STOP] Invalid PID file removed. Worker is not running.');
    process.exit(0);
  }

  const alive = await isProcessAlive(pid);
  if (!alive) {
    fs.unlinkSync(pidFile);
    console.log(`[DEMO STOP] Worker (PID ${pid}) was already stopped. PID file cleaned up.`);
    process.exit(0);
  }

  const stopped = await stopProcess(pid);
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (stopped) {
    console.log(`[DEMO STOP] Worker (PID ${pid}) stopped cleanly.`);
    process.exit(0);
  } else {
    console.error(`[DEMO STOP] Failed to terminate worker process ${pid}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error stopping worker:', err.message);
  process.exit(1);
});
