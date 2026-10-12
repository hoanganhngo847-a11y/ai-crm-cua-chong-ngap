import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const workerDir = path.resolve(rootDir, 'fb-inbox-worker');
const pidFile = path.resolve(workerDir, '.worker.pid');
const logFile = path.resolve(workerDir, 'worker.log');

async function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForHealth(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch('http://127.0.0.1:3099/health', { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) {
        return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log('==========================================================');
  console.log('STARTING LOCAL FACEBOOK PLAYWRIGHT WORKER (DEMO MODE)');
  console.log('==========================================================\n');

  // 1. Single-Instance Guard
  if (fs.existsSync(pidFile)) {
    const rawPid = fs.readFileSync(pidFile, 'utf8').trim();
    const existingPid = parseInt(rawPid, 10);
    if (!isNaN(existingPid) && (await isProcessAlive(existingPid))) {
      console.log('WORKER_ALREADY_RUNNING');
      console.log(`Tiến trình worker hiện đang chạy với PID: ${existingPid}`);
      console.log('Để dừng worker: npm run demo:stop');
      console.log('Để xem trạng thái: npm run demo:status');
      process.exit(0);
    } else {
      // Stale PID file, clean it up
      fs.unlinkSync(pidFile);
    }
  }

  // 2. Launch worker under caffeinate to prevent Mac from sleeping
  console.log('Khởi chạy tiến trình dưới sự bảo vệ của `caffeinate -dimsu`...');
  const outLog = fs.openSync(logFile, 'a');
  const errLog = fs.openSync(logFile, 'a');

  // caffeinate -dimsu node src/index.js
  const child = spawn(
    'caffeinate',
    ['-dimsu', 'node', 'src/index.js'],
    {
      cwd: workerDir,
      detached: true,
      stdio: ['ignore', outLog, errLog],
      env: { ...process.env },
    }
  );

  child.unref();

  const pid = child.pid;
  fs.writeFileSync(pidFile, pid.toString(), 'utf8');
  console.log(`Worker process spawned with PID: ${pid}`);

  // 3. Wait for Health endpoint to become available
  console.log('Đang chờ Local Health Endpoint (http://127.0.0.1:3099/health)...');
  const isHealthy = await waitForHealth(15000);

  if (isHealthy) {
    console.log('✅ Worker khởi động thành công!');
    console.log('----------------------------------------------------------');
    console.log('• Local Health: http://127.0.0.1:3099/health (HTTP 200)');
    console.log('• Local Ready:  http://127.0.0.1:3099/ready');
    console.log('• Worker PID:   ' + pid);
    console.log('• Worker Log:   ' + logFile);
    console.log('----------------------------------------------------------');
    console.log('Cửa sổ Chromium có thể mất vài giây để xuất hiện trên màn hình.');
    console.log('Chạy `npm run demo:status` để kiểm tra trạng thái Facebook session.');
    process.exit(0);
  } else {
    console.error('❌ Cảnh báo: Worker chưa phản hồi trên port 3099 sau 15s.');
    console.error(`Kiểm tra file log tại: ${logFile}`);
    process.exit(1);
  }
}

main();
