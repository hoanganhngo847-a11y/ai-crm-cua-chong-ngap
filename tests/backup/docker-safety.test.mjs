import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SCRIPT_PATH = path.resolve('scripts/backup/ci-postgres17.sh');

/**
 * Creates an isolated mock Docker environment and executes ci-postgres17.sh.
 */
async function runWithMockDocker(args, { env = {}, initialState = {} } = {}) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'crm-fake-docker-'));
  const stateFile = path.join(tempDir, 'state.json');
  const logFile = path.join(tempDir, 'commands.log');
  const dispatcherFile = path.join(tempDir, 'dispatcher.cjs');
  const dockerBin = path.join(tempDir, 'docker');

  const effectiveInitialState = {
    activeContext: 'desktop-linux',
    contexts: {
      'desktop-linux': { endpoint: 'unix:///var/run/docker.sock' },
    },
    ...initialState,
  };

  await fsp.writeFile(stateFile, JSON.stringify(effectiveInitialState, null, 2), 'utf8');
  await fsp.writeFile(logFile, '', 'utf8');

  // Dispatcher script handling Docker subcommands
  const dispatcherCode = `
const path = require('path');
const fs = require('fs');
const stateFile = process.env.FAKE_DOCKER_STATE_FILE;
const logFile = process.env.FAKE_DOCKER_LOG_FILE;
const dockerConfig = process.env.DOCKER_CONFIG;

const args = process.argv.slice(2);
if (logFile) {
  fs.appendFileSync(logFile, args.join(' ') + '\\n', 'utf8');
}

let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch (e) {
  state = {};
}

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

const cmd = args[0];

if (cmd === 'context') {
  const sub = args[1];
  if (sub === 'show') {
    if (state.failContextShow) {
      process.stderr.write('error getting active context\\n');
      process.exit(1);
    }
    // Check DOCKER_CONFIG/config.json first if available
    if (dockerConfig) {
      const cfgPath = path.join(dockerConfig, 'config.json');
      if (fs.existsSync(cfgPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          if (cfg.currentContext && typeof cfg.currentContext === 'string') {
            process.stdout.write(cfg.currentContext.trim() + '\\n');
            process.exit(0);
          }
        } catch (e) {
          process.stderr.write('error parsing config.json: ' + e.message + '\\n');
          process.exit(1);
        }
      }
    }
    process.stdout.write((state.activeContext || 'desktop-linux') + '\\n');
    process.exit(0);
  }
  if (sub === 'inspect') {
    if (state.failContextInspect) {
      process.stderr.write('error inspecting context\\n');
      process.exit(1);
    }
    const name = args[args.length - 1];
    // Check DOCKER_CONFIG metadata first
    if (dockerConfig) {
      const metaDir = path.join(dockerConfig, 'contexts', 'meta');
      if (fs.existsSync(metaDir)) {
        try {
          const entries = fs.readdirSync(metaDir);
          for (const entry of entries) {
            const entryPath = path.join(metaDir, entry);
            let metaFile = null;
            if (fs.statSync(entryPath).isFile()) metaFile = entryPath;
            else if (fs.existsSync(path.join(entryPath, 'meta.json'))) metaFile = path.join(entryPath, 'meta.json');
            if (metaFile) {
              const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
              if (meta.Name === name && meta.Endpoints?.docker?.Host) {
                process.stdout.write(meta.Endpoints.docker.Host + '\\n');
                process.exit(0);
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }
    if (state.contexts && state.contexts[name]) {
      const ctx = state.contexts[name];
      if (ctx.endpoint !== undefined) {
        process.stdout.write(ctx.endpoint + '\\n');
        process.exit(0);
      }
    }
    process.stderr.write('context "' + name + '": context not found\\n');
    process.exit(1);
  }
}

if (cmd === 'ps') {
  if (state.failPs) {
    process.stderr.write('Error response from daemon: ' + (state.failPsMsg || 'connection refused') + '\\n');
    process.exit(1);
  }
  if (state.containers) {
    for (const name of Object.keys(state.containers)) {
      process.stdout.write(name + '\\n');
    }
  }
  process.exit(0);
}

if (cmd === 'inspect') {
  if (state.failInspect) {
    process.stderr.write('Error: ' + (state.failInspectMsg || 'permission denied inspecting container') + '\\n');
    process.exit(1);
  }
  const name = args[args.length - 1];
  if (!state.containers || !state.containers[name]) {
    process.stderr.write('Error: No such container: ' + name + '\\n');
    process.exit(1);
  }
  const container = state.containers[name];
  const formatIdx = args.indexOf('--format');
  const formatStr = formatIdx !== -1 ? args[formatIdx + 1] : '';

  if (formatStr.includes('crm.disposable-test')) {
    process.stdout.write((container.labels?.['crm.disposable-test'] || '') + '\\n');
    process.exit(0);
  }
  if (formatStr.includes('crm.owner')) {
    process.stdout.write((container.labels?.['crm.owner'] || '') + '\\n');
    process.exit(0);
  }
  if (formatStr.includes('crm.purpose')) {
    process.stdout.write((container.labels?.['crm.purpose'] || '') + '\\n');
    process.exit(0);
  }
  process.stdout.write('{}\\n');
  process.exit(0);
}

if (cmd === 'image') {
  const sub = args[1];
  if (sub === 'inspect') {
    const img = args[args.length - 1];
    if (state.images && state.images[img]) {
      process.exit(0);
    }
    process.exit(1);
  }
}

if (cmd === 'pull') {
  const img = args[args.length - 1];
  if (state.failPull) {
    process.stderr.write('Error: pull failed for ' + img + '\\n');
    process.exit(1);
  }
  state.images = state.images || {};
  state.images[img] = true;
  saveState();
  process.stdout.write('Status: Downloaded image for ' + img + '\\n');
  process.exit(0);
}

if (cmd === 'rm') {
  const name = args[args.length - 1];
  if (state.failRm) {
    process.stderr.write('Error: rm failed for ' + name + '\\n');
    process.exit(1);
  }
  if (state.containers && state.containers[name]) {
    delete state.containers[name];
    saveState();
  }
  process.stdout.write(name + '\\n');
  process.exit(0);
}

if (cmd === 'run') {
  const nameIdx = args.indexOf('--name');
  const name = nameIdx !== -1 ? args[nameIdx + 1] : 'unknown';
  const labels = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label' && args[i + 1]) {
      const parts = args[i + 1].split('=');
      labels[parts[0]] = parts.slice(1).join('=');
    }
  }
  state.containers = state.containers || {};
  state.containers[name] = { labels };
  saveState();
  process.stdout.write('fake_container_id_12345\\n');
  process.exit(0);
}

if (cmd === 'logs') {
  const name = args[args.length - 1];
  if (!state.containers || !state.containers[name]) {
    process.stderr.write('Error: No such container: ' + name + '\\n');
    process.exit(1);
  }
  process.stdout.write(state.logs?.[name] || 'PostgreSQL init process complete; ready for start up.\\n');
  process.exit(0);
}

if (cmd === 'exec') {
  if (args.includes('pg_isready')) {
    process.stdout.write('/var/run/postgresql:5432 - accepting connections\\n');
    process.exit(0);
  }
  if (args.includes('SHOW server_version_num;')) {
    process.stdout.write('170002\\n');
    process.exit(0);
  }
  if (args.includes('SELECT version();')) {
    process.stdout.write('PostgreSQL 17.2 on x86_64-pc-linux-gnu\\n');
    process.exit(0);
  }
  if (args.includes('SELECT 1;')) {
    process.stdout.write('1\\n');
    process.exit(0);
  }
  if (args.includes('SELECT count(*) FROM public._crm_disposable_test_marker;')) {
    process.stdout.write('0\\n');
    process.exit(0);
  }
  process.exit(0);
}

process.exit(0);
`;

  await fsp.writeFile(dispatcherFile, dispatcherCode, 'utf8');

  // Executable docker shim
  const dockerShim = `#!/usr/bin/env bash
exec node "${dispatcherFile}" "$@"
`;
  await fsp.writeFile(dockerBin, dockerShim, { mode: 0o755 });

  // Custom environment: prepend tempDir to PATH so our fake docker is called
  const mergedEnv = {
    ...process.env,
    PATH: `${tempDir}:${process.env.PATH}`,
    FAKE_DOCKER_STATE_FILE: stateFile,
    FAKE_DOCKER_LOG_FILE: logFile,
    CRM_PG17_READY_ATTEMPTS: '5',
    CRM_PG17_PULL_ATTEMPTS: '1',
    CRM_PG17_PULL_RETRY_DELAY: '1',
    ...env,
  };

  // Remove keys set to undefined
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) {
      delete mergedEnv[k];
    }
  }

  const child = spawn(SCRIPT_PATH, args, {
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const code = await new Promise((resolve) => child.on('close', resolve));

  const logContent = await fsp.readFile(logFile, 'utf8');
  const commands = logContent.split('\n').filter(Boolean);

  let finalState = {};
  try {
    finalState = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    // best-effort
  }

  await fsp.rm(tempDir, { recursive: true, force: true });

  return { code, stdout, stderr, commands, finalState };
}

/**
 * Creates a temporary DOCKER_CONFIG directory with optional config.json and contexts.
 */
async function createDockerConfigFixture({ configJson, contexts = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'crm-docker-config-test-'));
  if (configJson !== undefined) {
    if (typeof configJson === 'string') {
      await fsp.writeFile(path.join(dir, 'config.json'), configJson, 'utf8');
    } else {
      await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(configJson, null, 2), 'utf8');
    }
  }
  if (Object.keys(contexts).length > 0) {
    const metaDir = path.join(dir, 'contexts', 'meta');
    await fsp.mkdir(metaDir, { recursive: true });
    for (const [name, ctx] of Object.entries(contexts)) {
      const meta = {
        Name: name,
        Endpoints: {
          docker: {
            Host: ctx.endpoint,
          },
        },
      };
      await fsp.writeFile(path.join(metaDir, `${name}.json`), JSON.stringify(meta, null, 2), 'utf8');
    }
  }
  return dir;
}

// =============================================================================
// Nhóm A — Docker Environment Precedence (A01 - A10)
// DOCKER_CONTEXT > DOCKER_HOST > active/default context
// =============================================================================

test('A01: DOCKER_CONTEXT remote + DOCKER_HOST local -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: 'remote-ssh',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    },
    initialState: {
      contexts: {
        'remote-ssh': { endpoint: 'ssh://developer@prod-server.corp:22' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(ssh:\/\/developer@prod-server.corp:22\)/);
});

test('A02: DOCKER_CONTEXT local + DOCKER_HOST remote -> Resolve đúng context local', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: {
      DOCKER_CONTEXT: 'local-desktop',
      DOCKER_HOST: 'tcp://10.0.0.5:2376',
    },
    initialState: {
      contexts: {
        'local-desktop': { endpoint: 'unix:///var/run/docker.sock' },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not present; nothing to remove/);
});

test('A03: DOCKER_CONTEXT remote + DOCKER_HOST remote -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: 'remote-ssh',
      DOCKER_HOST: 'tcp://10.0.0.5:2376',
    },
    initialState: {
      contexts: {
        'remote-ssh': { endpoint: 'ssh://developer@prod-server.corp:22' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(ssh:\/\/developer@prod-server.corp:22\)/);
});

test('A04: Chỉ DOCKER_HOST local -> PASS', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: {
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not present; nothing to remove/);
});

test('A05: Chỉ DOCKER_HOST remote -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: 'tcp://10.0.0.5:2376',
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/10.0.0.5:2376\)/);
});

test('A06: Chỉ DOCKER_CONTEXT local -> PASS', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: {
      DOCKER_CONTEXT: 'local-desktop',
      DOCKER_HOST: undefined,
    },
    initialState: {
      contexts: {
        'local-desktop': { endpoint: 'unix:///var/run/docker.sock' },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not present; nothing to remove/);
});

test('A07: Chỉ DOCKER_CONTEXT remote -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: 'remote-ssh',
      DOCKER_HOST: undefined,
    },
    initialState: {
      contexts: {
        'remote-ssh': { endpoint: 'ssh://developer@prod-server.corp:22' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(ssh:\/\/developer@prod-server.corp:22\)/);
});

test('A08: Không có hai biến, default context local -> PASS', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: {
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: undefined,
    },
    initialState: {
      activeContext: 'desktop-linux',
      contexts: {
        'desktop-linux': { endpoint: 'unix:///var/run/docker.sock' },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not present; nothing to remove/);
});

test('A09: Không có hai biến, default context remote -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: undefined,
    },
    initialState: {
      activeContext: 'remote-prod',
      contexts: {
        'remote-prod': { endpoint: 'tcp://prod.company.internal:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/prod.company.internal:2375\)/);
});

test('A10: DOCKER_CONTEXT không tồn tại -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: 'nonexistent-context-xyz',
      DOCKER_HOST: undefined,
    },
    initialState: {
      contexts: {},
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unable to inspect endpoint for Docker context 'nonexistent-context-xyz'/);
});

// =============================================================================
// Nhóm B — DOCKER_CONFIG Isolation (B01 - B10)
// =============================================================================

test('B01: HOME local, DOCKER_CONFIG remote -> FAIL CLOSED', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'remote-swarm' },
    contexts: {
      'remote-swarm': { endpoint: 'tcp://swarm.corp:2375' },
    },
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
      initialState: {
        activeContext: 'desktop-local',
        contexts: {
          'desktop-local': { endpoint: 'unix:///var/run/docker.sock' },
        },
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/swarm.corp:2375\)/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B02: HOME remote, DOCKER_CONFIG local -> Resolve đúng DOCKER_CONFIG', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'local-isolated' },
    contexts: {
      'local-isolated': { endpoint: 'unix:///var/run/isolated.sock' },
    },
  });
  try {
    const result = await runWithMockDocker(['stop'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
      initialState: {
        activeContext: 'home-remote',
        contexts: {
          'home-remote': { endpoint: 'tcp://prod:2375' },
        },
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /not present; nothing to remove/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B03: DOCKER_CONFIG local có metadata đầy đủ -> PASS', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'valid-local' },
    contexts: {
      'valid-local': { endpoint: 'unix:///var/run/docker.sock' },
    },
  });
  try {
    const result = await runWithMockDocker(['stop'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
    });
    assert.equal(result.code, 0);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B04: DOCKER_CONFIG remote SSH -> FAIL CLOSED', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'remote-ssh' },
    contexts: {
      'remote-ssh': { endpoint: 'ssh://root@jumpbox.cloud' },
    },
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing remote Docker endpoint \(ssh:\/\/root@jumpbox.cloud\)/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B05: DOCKER_CONFIG remote TCP -> FAIL CLOSED', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'remote-tcp' },
    contexts: {
      'remote-tcp': { endpoint: 'tcp://10.200.0.1:2375' },
    },
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/10.200.0.1:2375\)/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B06: DOCKER_CONFIG thiếu config.json -> Không được fallback HOME để đoán', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: undefined,
    contexts: {},
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
      initialState: {
        failContextShow: true, // CLI context show cannot resolve
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unable to determine active Docker context/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B07: DOCKER_CONFIG config.json lỗi JSON -> FAIL CLOSED nếu không thể xác minh', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: '{ invalid corrupted json syntax',
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
    });
    assert.equal(result.code, 1);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B08: DOCKER_CONFIG metadata không tồn tại -> FAIL CLOSED', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'unregistered-context' },
    contexts: {},
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unable to inspect endpoint for Docker context 'unregistered-context'/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B09: DOCKER_CONFIG context không inspect được -> FAIL CLOSED', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'error-context' },
  });
  try {
    const result = await runWithMockDocker(['start'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
      initialState: {
        failContextInspect: true,
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unable to inspect endpoint for Docker context 'error-context'/);
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

test('B10: DOCKER_CONFIG và HOME có currentContext khác nhau -> Chọn đúng DOCKER_CONFIG', async () => {
  const cfgDir = await createDockerConfigFixture({
    configJson: { currentContext: 'custom-config-ctx' },
    contexts: {
      'custom-config-ctx': { endpoint: 'unix:///var/run/custom.sock' },
    },
  });
  try {
    const result = await runWithMockDocker(['stop'], {
      env: {
        DOCKER_CONFIG: cfgDir,
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
      },
      initialState: {
        activeContext: 'home-ctx',
        contexts: {
          'home-ctx': { endpoint: 'tcp://home.remote:2375' },
        },
      },
    });
    assert.equal(result.code, 0);
    assert.ok(result.commands.some((c) => c.includes('inspect') && c.includes('custom-config-ctx')));
    assert.ok(!result.commands.some((c) => c.includes('home-ctx')));
  } finally {
    await fsp.rm(cfgDir, { recursive: true, force: true });
  }
});

// =============================================================================
// Nhóm C — Docker Inspect Error & 4-State Verification (C01 - C10)
// =============================================================================

test('C01: Container thực sự không tồn tại -> NOT_FOUND (status 2)', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      containers: {
        'other-container': {},
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not present; nothing to remove/);
  assert.ok(!result.commands.some((c) => c.startsWith('rm')));
});

test('C02: Docker daemon unavailable -> ERROR (status 3)', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      failPs: true,
      failPsMsg: 'cannot connect to daemon',
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unable to verify container 'crm-dumpcheck-test' status due to Docker daemon or inspect error/);
  assert.ok(!result.commands.some((c) => c.startsWith('rm')));
});

test('C03: Permission denied -> ERROR (status 3)', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      failPs: true,
      failPsMsg: 'permission denied while attempting to connect to the Docker daemon socket',
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unable to verify container 'crm-dumpcheck-test' status due to Docker daemon or inspect error/);
  assert.ok(!result.commands.some((c) => c.startsWith('pull') || c.startsWith('run') || c.startsWith('rm')));
});

test('C04: Docker API error -> ERROR (status 3)', async () => {
  const result = await runWithMockDocker(['logs'], {
    initialState: {
      failPs: true,
      failPsMsg: 'API error 500: daemon error',
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unable to verify container 'crm-dumpcheck-test' status due to Docker daemon or inspect error/);
  assert.ok(!result.commands.some((c) => c.startsWith('logs')));
});

test('C05: Container tồn tại nhưng inspect thất bại -> ERROR (status 3)', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      containers: {
        'crm-dumpcheck-test': {},
      },
      failInspect: true,
      failInspectMsg: 'failed to inspect container metadata',
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unable to verify container 'crm-dumpcheck-test' status due to Docker daemon or inspect error/);
  assert.ok(!result.commands.some((c) => c.startsWith('rm')));
});

test('C06: Container có đủ ownership marker -> OWNED (status 0)', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      containers: {
        'crm-dumpcheck-test': {
          labels: {
            'crm.disposable-test': 'true',
            'crm.owner': 'ci-postgres17',
            'crm.purpose': 'pg17-backup-restore-test',
          },
        },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Removed disposable PostgreSQL container 'crm-dumpcheck-test'/);
  assert.ok(result.commands.some((c) => c.startsWith('rm')));
});

test('C07: Container thiếu ownership marker -> FOREIGN (status 1)', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      containers: {
        'crm-dumpcheck-test': {
          labels: {
            'crm.disposable-test': 'true',
            // Missing crm.owner and crm.purpose
          },
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exists but lacks valid ownership markers; refusing to remove foreign container/);
  assert.ok(!result.commands.some((c) => c.startsWith('rm')));
});

test('C08: start gặp inspect error -> Không pull/run/rm', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      containers: {
        'crm-dumpcheck-test': {},
      },
      failInspect: true,
    },
  });
  assert.equal(result.code, 1);
  assert.ok(!result.commands.some((c) => c.startsWith('pull')));
  assert.ok(!result.commands.some((c) => c.startsWith('run')));
  assert.ok(!result.commands.some((c) => c.startsWith('rm')));
});

test('C09: stop gặp inspect error -> Không rm', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      failPs: true,
    },
  });
  assert.equal(result.code, 1);
  assert.ok(!result.commands.some((c) => c.startsWith('rm')));
});

test('C10: logs gặp inspect error -> Không đọc logs', async () => {
  const result = await runWithMockDocker(['logs'], {
    initialState: {
      failPs: true,
    },
  });
  assert.equal(result.code, 1);
  assert.ok(!result.commands.some((c) => c.startsWith('logs')));
});

// =============================================================================
// Nhóm D — Zero Remote Side Effects (D01 - D04)
// =============================================================================

test('D01: start với remote context không gọi pull/run/exec/rm', async () => {
  const result = await runWithMockDocker(['start'], {
    env: { DOCKER_CONTEXT: 'remote-env' },
    initialState: {
      contexts: {
        'remote-env': { endpoint: 'tcp://remote:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  const daemonCalls = result.commands.filter((c) => (
    c.startsWith('pull') || c.startsWith('run') || c.startsWith('exec') || c.startsWith('rm')
  ));
  assert.deepEqual(daemonCalls, []);
});

test('D02: stop với remote context không gọi rm', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: { DOCKER_CONTEXT: 'remote-env' },
    initialState: {
      contexts: {
        'remote-env': { endpoint: 'tcp://remote:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  const rmCalls = result.commands.filter((c) => c.startsWith('rm'));
  assert.deepEqual(rmCalls, []);
});

test('D03: logs với remote context không gọi logs', async () => {
  const result = await runWithMockDocker(['logs'], {
    env: { DOCKER_CONTEXT: 'remote-env' },
    initialState: {
      contexts: {
        'remote-env': { endpoint: 'tcp://remote:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  const logCalls = result.commands.filter((c) => c.startsWith('logs'));
  assert.deepEqual(logCalls, []);
});

test('D04: Zero daemon side effects when effective context is remote', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_CONTEXT: 'prod-cluster',
      DOCKER_HOST: 'unix:///var/run/docker.sock', // Overridden by DOCKER_CONTEXT
    },
    initialState: {
      contexts: {
        'prod-cluster': { endpoint: 'ssh://ops@prod-cluster.corp' },
      },
    },
  });
  assert.equal(result.code, 1);

  // Assert only client config inspection commands were executed
  for (const cmd of result.commands) {
    assert.ok(
      cmd.startsWith('context inspect') || cmd.startsWith('context show'),
      `unexpected daemon command executed on remote context: ${cmd}`,
    );
  }
});
