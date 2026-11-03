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

  await fsp.writeFile(stateFile, JSON.stringify(initialState, null, 2), 'utf8');
  await fsp.writeFile(logFile, '', 'utf8');

  // Dispatcher script handling Docker subcommands
  const dispatcherCode = `
const fs = require('fs');
const stateFile = process.env.FAKE_DOCKER_STATE_FILE;
const logFile = process.env.FAKE_DOCKER_LOG_FILE;

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
    process.stdout.write((state.activeContext || 'desktop-linux') + '\\n');
    process.exit(0);
  }
  if (sub === 'inspect') {
    const name = args[args.length - 1];
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

if (cmd === 'inspect') {
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

// -----------------------------------------------------------------------------
// Nhóm A — Docker Context Guard Regression Tests (A01 - A10)
// -----------------------------------------------------------------------------

test('A01: Default context là local Unix socket -> PASS', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined },
    initialState: {
      activeContext: 'local-desktop',
      contexts: {
        'local-desktop': { endpoint: 'unix:///var/run/docker.sock' },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not present; nothing to remove/);
});

test('A02: Default context là remote SSH -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined },
    initialState: {
      activeContext: 'remote-ssh',
      contexts: {
        'remote-ssh': { endpoint: 'ssh://developer@prod-server.corp:22' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(ssh:\/\/developer@prod-server.corp:22\)/);
});

test('A03: Default context là remote TCP -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined },
    initialState: {
      activeContext: 'remote-tcp',
      contexts: {
        'remote-tcp': { endpoint: 'tcp://192.168.1.100:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/192.168.1.100:2375\)/);
});

test('A04: DOCKER_CONTEXT trỏ remote SSH -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: 'my-remote-box',
    },
    initialState: {
      activeContext: 'local-desktop',
      contexts: {
        'local-desktop': { endpoint: 'unix:///var/run/docker.sock' },
        'my-remote-box': { endpoint: 'ssh://root@box.cloud' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(ssh:\/\/root@box.cloud\)/);
});

test('A05: DOCKER_HOST trỏ remote TCP -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_HOST: 'tcp://10.0.0.5:2376',
      DOCKER_CONTEXT: 'local-desktop',
    },
    initialState: {
      activeContext: 'local-desktop',
      contexts: {
        'local-desktop': { endpoint: 'unix:///var/run/docker.sock' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/10.0.0.5:2376\)/);
});

test('A06: Context không tồn tại -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: 'ghost-context',
    },
    initialState: {
      contexts: {},
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unable to inspect endpoint for Docker context 'ghost-context'/);
});

test('A07: Không đọc được context endpoint -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: 'empty-endpoint-ctx',
    },
    initialState: {
      contexts: {
        'empty-endpoint-ctx': { endpoint: '' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /endpoint for Docker context 'empty-endpoint-ctx' is empty or unresolvable/);
});

test('A08: DOCKER_HOST/DOCKER_CONTEXT không được khai báo nhưng default context remote -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: undefined,
    },
    initialState: {
      activeContext: 'production-swarm',
      contexts: {
        'production-swarm': { endpoint: 'tcp://swarm.prod.internal:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint \(tcp:\/\/swarm.prod.internal:2375\)/);
});

test('A09: Remote context không được phép chạy docker rm -> PASS', async () => {
  const result = await runWithMockDocker(['stop'], {
    env: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: undefined,
    },
    initialState: {
      activeContext: 'remote-prod',
      contexts: {
        'remote-prod': { endpoint: 'ssh://deploy@remote.datacenter' },
      },
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
  assert.equal(result.code, 1);
  const rmInvoked = result.commands.some((cmd) => cmd.startsWith('rm'));
  assert.equal(rmInvoked, false, 'docker rm must not be called when context is remote');
  assert.ok(result.finalState.containers?.['crm-dumpcheck-test'], 'container must still exist');
});

test('A10: Remote context không được phép chạy docker pull/run/exec -> PASS', async () => {
  const result = await runWithMockDocker(['start'], {
    env: {
      DOCKER_HOST: undefined,
      DOCKER_CONTEXT: undefined,
    },
    initialState: {
      activeContext: 'remote-prod',
      contexts: {
        'remote-prod': { endpoint: 'tcp://10.200.0.1:2375' },
      },
    },
  });
  assert.equal(result.code, 1);
  const pullInvoked = result.commands.some((cmd) => cmd.startsWith('pull'));
  const runInvoked = result.commands.some((cmd) => cmd.startsWith('run'));
  const execInvoked = result.commands.some((cmd) => cmd.startsWith('exec'));
  assert.equal(pullInvoked, false, 'docker pull must not be called when context is remote');
  assert.equal(runInvoked, false, 'docker run must not be called when context is remote');
  assert.equal(execInvoked, false, 'docker exec must not be called when context is remote');
});

// -----------------------------------------------------------------------------
// Nhóm B — Container Ownership Regression Tests (B01 - B10)
// -----------------------------------------------------------------------------

const VALID_OWNERSHIP_LABELS = {
  'crm.disposable-test': 'true',
  'crm.owner': 'ci-postgres17',
  'crm.purpose': 'pg17-backup-restore-test',
};

test('B01: Container chưa tồn tại -> Cho phép start', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      images: {
        'public.ecr.aws/supabase/postgres:17.11.0.004': true,
      },
      containers: {},
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Container 'crm-dumpcheck-test' does not exist; ready to create/);
  assert.match(result.stdout, /Disposable marker verified; PostgreSQL 17 target is ready/);
  const created = result.finalState.containers?.['crm-dumpcheck-test'];
  assert.ok(created, 'container must be created');
  assert.equal(created.labels['crm.disposable-test'], 'true');
  assert.equal(created.labels['crm.owner'], 'ci-postgres17');
  assert.equal(created.labels['crm.purpose'], 'pg17-backup-restore-test');
});

test('B02: Container cùng tên nhưng không có ownership label -> Không xóa', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: {}, // no labels at all (foreign container)
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to overwrite or remove foreign container/);
  assert.ok(result.finalState.containers?.['crm-dumpcheck-test'], 'foreign container must NOT be deleted');
  const rmCalls = result.commands.filter((cmd) => cmd.startsWith('rm'));
  assert.equal(rmCalls.length, 0, 'docker rm must not be called on foreign container');
});

test('B03: Container có sai ownership label -> Không xóa', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: {
            'crm.disposable-test': 'true',
            'crm.owner': 'wrong-team',
            'crm.purpose': 'pg17-backup-restore-test',
          },
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to overwrite or remove foreign container/);
  assert.ok(result.finalState.containers?.['crm-dumpcheck-test'], 'container with wrong label must NOT be deleted');
});

test('B04: Container có đúng ownership marker -> Cho phép cleanup theo chính sách', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      images: {
        'public.ecr.aws/supabase/postgres:17.11.0.004': true,
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: { ...VALID_OWNERSHIP_LABELS },
        },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /verified with valid ownership markers; removing stale container before recreate/);
  assert.ok(result.finalState.containers?.['crm-dumpcheck-test'], 'recreated container must exist');
});

test('B05: stop container không thuộc script -> Không xóa', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: {
            'crm.disposable-test': 'false',
          },
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to remove foreign container/);
  assert.ok(result.finalState.containers?.['crm-dumpcheck-test'], 'foreign container must remain intact');
  const rmCalls = result.commands.filter((cmd) => cmd.startsWith('rm'));
  assert.equal(rmCalls.length, 0, 'docker rm must not be called');
});

test('B06: stop container thuộc script -> Cleanup thành công', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: { ...VALID_OWNERSHIP_LABELS },
        },
      },
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Removed disposable PostgreSQL container 'crm-dumpcheck-test'/);
  assert.equal(result.finalState.containers?.['crm-dumpcheck-test'], undefined, 'owned container must be removed');
});

test('B07: logs container không thuộc script -> Từ chối', async () => {
  const result = await runWithMockDocker(['logs'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: {
            'crm.owner': 'some-other-project',
          },
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to read logs from container 'crm-dumpcheck-test' without valid ownership markers/);
  const logCalls = result.commands.filter((cmd) => cmd.startsWith('logs'));
  assert.equal(logCalls.length, 0, 'docker logs must not be called on foreign container');
});

test('B08: start khi container không xác định ownership -> FAIL CLOSED', async () => {
  const result = await runWithMockDocker(['start'], {
    initialState: {
      activeContext: 'default',
      contexts: {
        default: { endpoint: 'unix:///var/run/docker.sock' },
      },
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
  assert.match(result.stderr, /refusing to overwrite or remove foreign container/);
  assert.ok(result.finalState.containers?.['crm-dumpcheck-test'], 'container must be kept intact');
});

test('B09: stop chạy với remote Docker context -> Không gọi docker rm', async () => {
  const result = await runWithMockDocker(['stop'], {
    initialState: {
      activeContext: 'remote-env',
      contexts: {
        'remote-env': { endpoint: 'tcp://172.16.0.50:2375' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: { ...VALID_OWNERSHIP_LABELS },
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint/);
  const rmCalls = result.commands.filter((cmd) => cmd.startsWith('rm'));
  assert.equal(rmCalls.length, 0, 'docker rm must not be called when context is remote');
});

test('B10: logs chạy với remote Docker context -> Không đọc logs', async () => {
  const result = await runWithMockDocker(['logs'], {
    initialState: {
      activeContext: 'remote-env',
      contexts: {
        'remote-env': { endpoint: 'ssh://admin@remote-host' },
      },
      containers: {
        'crm-dumpcheck-test': {
          labels: { ...VALID_OWNERSHIP_LABELS },
        },
      },
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing remote Docker endpoint/);
  const logCalls = result.commands.filter((cmd) => cmd.startsWith('logs'));
  assert.equal(logCalls.length, 0, 'docker logs must not be called when context is remote');
});
