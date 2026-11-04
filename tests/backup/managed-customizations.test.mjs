import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  classifyManagedCustomization,
  generateManagedCustomizationsSql,
  handlePlanCommand,
  handleApplyCommand,
  handleVerifyCommand,
} from '../../scripts/backup/managed-customizations.mjs';
import { sha256Hex } from '../../scripts/backup/owner-map.mjs';

async function createTempDir(prefix = 'managed-cust-test-') {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempDir(dirPath) {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    const cliPath = path.resolve('scripts/backup/managed-customizations.mjs');
    const child = spawn(process.execPath, [cliPath, ...args], {
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

test('managed-customizations helper suite', async (t) => {
  await t.test('classifies platform defaults correctly', () => {
    const defaultPolicy = {
      kind: 'policy',
      identity: 'storage.objects:Allow access to own bucket',
      details: {
        schema: 'storage',
        table: 'objects',
        policy: 'Allow access to own bucket',
        permissive: 'PERMISSIVE',
        roles: ['authenticated'],
        command: 'SELECT',
        using: 'true',
        withCheck: null,
      },
    };
    const res = classifyManagedCustomization(defaultPolicy);
    assert.equal(res.classification, 'platform-default');

    const defaultRoutine = {
      kind: 'routine',
      identity: 'storage.foldername(text)',
      details: {},
    };
    const resRoutine = classifyManagedCustomization(defaultRoutine);
    assert.equal(resRoutine.classification, 'platform-default');

    const defaultRls = {
      kind: 'relation-rls',
      identity: 'auth.users',
      details: {},
    };
    assert.equal(classifyManagedCustomization(defaultRls).classification, 'platform-default');
  });

  await t.test('classifies project customizations and unexplained items', () => {
    const projectPolicy = {
      kind: 'policy',
      identity: 'storage.objects:crm_customer_documents_policy',
      details: {
        schema: 'storage',
        table: 'objects',
        policy: 'crm_customer_documents_policy',
        permissive: 'PERMISSIVE',
        roles: ['authenticated'],
        command: 'ALL',
        using: 'auth.uid() IS NOT NULL',
        withCheck: 'auth.uid() IS NOT NULL',
      },
    };
    assert.equal(classifyManagedCustomization(projectPolicy).classification, 'project-owned');

    const unexplainedItem = {
      kind: 'policy',
      identity: 'auth.secret_table:rogue_backdoor_policy',
      details: {
        schema: 'auth',
        table: 'secret_table',
        policy: 'rogue_backdoor_policy',
      },
    };
    assert.equal(classifyManagedCustomization(unexplainedItem).classification, 'unexplained');
  });

  await t.test('generates valid transaction-wrapped SQL plan for project-owned items', () => {
    const projectItems = [
      {
        kind: 'policy',
        identity: 'storage.objects:crm_customer_documents_policy',
        details: {
          schema: 'storage',
          table: 'objects',
          policy: 'crm_customer_documents_policy',
          permissive: 'PERMISSIVE',
          roles: ['authenticated'],
          command: 'ALL',
          using: 'auth.uid() IS NOT NULL',
          withCheck: 'auth.uid() IS NOT NULL',
        },
      },
    ];
    const sql = generateManagedCustomizationsSql(projectItems);
    assert.match(sql, /BEGIN;/);
    assert.match(sql, /COMMIT;/);
    // BEGIN must precede SET LOCAL search_path
    const beginIndex = sql.indexOf('BEGIN;');
    const setSearchPathIndex = sql.indexOf('SET LOCAL search_path');
    assert.ok(beginIndex !== -1, 'BEGIN; must be present');
    assert.ok(setSearchPathIndex !== -1, 'SET LOCAL search_path must be present');
    assert.ok(beginIndex < setSearchPathIndex, 'BEGIN; must precede SET LOCAL search_path');

    assert.match(sql, /DROP POLICY IF EXISTS "crm_customer_documents_policy" ON "storage"\."objects";/);
    assert.match(sql, /CREATE POLICY "crm_customer_documents_policy"/);
  });

  await t.test('rejects unsupported project-owned customization kinds as BLOCKED', async () => {
    const tempDir = await createTempDir();
    try {
      const sourcePath = path.join(tempDir, 'unsupported-kind.json');
      const planOut = path.join(tempDir, 'unsupported-plan.sql');
      const reportOut = path.join(tempDir, 'unsupported-report.json');

      // A project-owned constraint or relation-rls is unsupported by recreation logic
      const items = [
        {
          kind: 'constraint',
          identity: 'public.crm_leads:crm_leads_check_status',
          details: { schema: 'public', table: 'crm_leads', constraint: 'crm_leads_check_status' },
        },
      ];
      await fsp.writeFile(sourcePath, JSON.stringify(items));

      const res = await handlePlanCommand({
        sourcePath,
        targetLabel: 'crm-restore-rehearsal',
        outPath: planOut,
        reportPath: reportOut,
      });

      assert.equal(res.status, 'BLOCKED');
      assert.equal(res.report.counts.unsupportedCount, 1);
      assert.equal(res.report.counts.projectOwnedCount, 1);
      assert.ok(res.report.unsupportedObjects.some((u) => u.kind === 'constraint'));
      const sql = await fsp.readFile(planOut, 'utf8');
      assert.match(sql, /PLAN GENERATION BLOCKED/);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  await t.test('fails closed for unauthorized or unexplained relation-acl and column-acl', () => {
    // Platform default relation with approved role
    const defaultAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        schema: 'auth',
        table: 'users',
        acl: [{ grantee: 'postgres', grantor: 'supabase_admin', privilege: 'SELECT' }],
      },
    };
    assert.equal(classifyManagedCustomization(defaultAcl).classification, 'platform-default');

    // Platform default relation with unauthorized grantee
    const rogueAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        schema: 'auth',
        table: 'users',
        acl: [{ grantee: 'rogue_attacker', grantor: 'supabase_admin', privilege: 'SELECT' }],
      },
    };
    assert.equal(classifyManagedCustomization(rogueAcl).classification, 'unexplained');

    // Non-platform relation acl is unexplained
    const nonPlatformAcl = {
      kind: 'relation-acl',
      identity: 'public.crm_leads',
      details: {
        schema: 'public',
        table: 'crm_leads',
        acl: [{ grantee: 'authenticated', grantor: 'postgres', privilege: 'SELECT' }],
      },
    };
    assert.equal(classifyManagedCustomization(nonPlatformAcl).classification, 'unexplained');

    // Column ACL with unknown grantee
    const rogueColAcl = {
      kind: 'column-acl',
      identity: 'auth.users.email',
      details: {
        schema: 'auth',
        table: 'users',
        column: 'email',
        acl: [{ grantee: 'unknown_role', grantor: 'supabase_admin', privilege: 'SELECT' }],
      },
    };
    assert.equal(classifyManagedCustomization(rogueColAcl).classification, 'unexplained');
  });

  await t.test('plan command generates report and handles approved vs blocked plans', async () => {
    const tempDir = await createTempDir();
    try {
      const sourceValid = path.join(tempDir, 'valid.json');
      const planValidOut = path.join(tempDir, 'valid-plan.sql');
      const reportValidOut = path.join(tempDir, 'valid-report.json');

      const itemsValid = [
        {
          kind: 'policy',
          identity: 'storage.objects:Allow access to own bucket',
          details: { schema: 'storage', table: 'objects', policy: 'Allow access to own bucket' },
        },
        {
          kind: 'policy',
          identity: 'storage.objects:crm_documents_policy',
          details: { schema: 'storage', table: 'objects', policy: 'crm_documents_policy', permissive: 'PERMISSIVE', roles: ['authenticated'], command: 'SELECT' },
        },
      ];
      await fsp.writeFile(sourceValid, JSON.stringify(itemsValid));

      const resValid = await handlePlanCommand({
        sourcePath: sourceValid,
        targetLabel: 'crm-restore-rehearsal',
        outPath: planValidOut,
        reportPath: reportValidOut,
      });

      assert.equal(resValid.status, 'APPROVED');
      assert.equal(resValid.report.counts.platformDefaultsCount, 1);
      assert.equal(resValid.report.counts.projectOwnedCount, 1);
      assert.equal(resValid.report.counts.unexplainedCount, 0);

      const generatedSql = await fsp.readFile(planValidOut, 'utf8');
      assert.equal(sha256Hex(generatedSql), resValid.planSha256);

      // Blocked plan test (unexplained object present)
      const sourceUnexplained = path.join(tempDir, 'unexplained.json');
      const planUnexplainedOut = path.join(tempDir, 'unexplained-plan.sql');
      const reportUnexplainedOut = path.join(tempDir, 'unexplained-report.json');

      const itemsUnexplained = [
        {
          kind: 'trigger',
          identity: 'auth.users:mystery_unauthorized_trigger',
          details: { definition: 'CREATE TRIGGER mystery...', functionOwner: 'unknown_hacker' },
        },
      ];
      await fsp.writeFile(sourceUnexplained, JSON.stringify(itemsUnexplained));

      const resUnexplained = await handlePlanCommand({
        sourcePath: sourceUnexplained,
        targetLabel: 'crm-restore-rehearsal',
        outPath: planUnexplainedOut,
        reportPath: reportUnexplainedOut,
      });

      assert.equal(resUnexplained.status, 'BLOCKED');
      assert.equal(resUnexplained.report.counts.unexplainedCount, 1);
      const blockedSql = await fsp.readFile(planUnexplainedOut, 'utf8');
      assert.match(blockedSql, /PLAN GENERATION BLOCKED/);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  await t.test('apply command enforces approved sha256 hash match and target isolation', async () => {
    const tempDir = await createTempDir();
    try {
      const planPath = path.join(tempDir, 'plan.sql');
      const planSql = 'BEGIN;\n-- valid plan\nCOMMIT;\n';
      await fsp.writeFile(planPath, planSql);
      const validHash = sha256Hex(planSql);

      // Hash mismatch fails closed
      await assert.rejects(
        async () => {
          await handleApplyCommand({
            planPath,
            approvedSha256: '0'.repeat(64),
            target: 'supabase_db_crm-restore-rehearsal',
          });
        },
        (err) => err.code === 'HASH_MISMATCH'
      );

      // Remote cloud target fails closed
      await assert.rejects(
        async () => {
          await handleApplyCommand({
            planPath,
            approvedSha256: validHash,
            target: 'db.abcdefghijklmnop.supabase.co',
          });
        },
        (err) => err.code === 'REMOTE_TARGET_BLOCKED'
      );

      // Successful apply using executeSql injection
      let executedSql = '';
      const res = await handleApplyCommand({
        planPath,
        approvedSha256: validHash,
        target: 'supabase_db_crm-restore-rehearsal',
        executeSql: async (sql) => { executedSql = sql; },
      });
      assert.equal(res.status, 'APPLIED');
      assert.equal(executedSql, planSql);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  await t.test('verify command detects matching vs missing customizations', async () => {
    const tempDir = await createTempDir();
    try {
      const sourcePath = path.join(tempDir, 'source.json');
      const reportPath = path.join(tempDir, 'verify-report.json');

      const sourceItems = [
        {
          kind: 'policy',
          identity: 'storage.objects:crm_documents_policy',
          details: { schema: 'storage', table: 'objects', policy: 'crm_documents_policy' },
        },
      ];
      await fsp.writeFile(sourcePath, JSON.stringify(sourceItems));

      // Case 1: Target matches
      const targetQuerySuccess = async () => JSON.stringify([
        { kind: 'policy', identity: 'storage.objects:crm_documents_policy', details: {} },
      ]);
      const resPass = await handleVerifyCommand({
        sourcePath,
        target: 'supabase_db_crm-restore-rehearsal',
        reportPath,
        querySql: targetQuerySuccess,
      });
      assert.equal(resPass.status, 'PASSED');
      assert.equal(resPass.report.discrepancyCount, 0);

      // Case 2: Target missing customization
      const targetQueryMissing = async () => JSON.stringify([]);
      const resFail = await handleVerifyCommand({
        sourcePath,
        target: 'supabase_db_crm-restore-rehearsal',
        reportPath,
        querySql: targetQueryMissing,
      });
      assert.equal(resFail.status, 'BLOCKED');
      assert.equal(resFail.report.discrepancyCount, 1);

      // Case 3: Target inventory provided via file
      const targetInvPath = path.join(tempDir, 'target-inventory.json');
      await fsp.writeFile(targetInvPath, JSON.stringify(sourceItems));
      const resFilePass = await handleVerifyCommand({
        sourcePath,
        target: 'supabase_db_crm-restore-rehearsal',
        targetInventoryPath: targetInvPath,
        reportPath,
      });
      assert.equal(resFilePass.status, 'PASSED');
      assert.equal(resFilePass.report.discrepancyCount, 0);

      // Case 4: Target evidence missing throws TARGET_EVIDENCE_MISSING error
      await assert.rejects(
        async () => {
          await handleVerifyCommand({
            sourcePath,
            target: 'supabase_db_crm-restore-rehearsal',
            reportPath,
            querySql: async () => { throw new Error('connection failed'); },
          });
        },
        (err) => err.code === 'TARGET_EVIDENCE_MISSING'
      );
    } finally {
      await removeTempDir(tempDir);
    }
  });

  await t.test('CLI rejects duplicate JSON keys (parseJsonStrict)', async () => {
    const tempDir = await createTempDir();
    try {
      const dupJsonPath = path.join(tempDir, 'dup.json');
      const outPath = path.join(tempDir, 'out.sql');
      const reportPath = path.join(tempDir, 'report.json');

      const dupJson = '[{"kind": "policy", "kind": "trigger", "identity": "foo", "details": {}}]';
      await fsp.writeFile(dupJsonPath, dupJson);

      const cliRes = await runCli(['plan', '--source', dupJsonPath, '--out', outPath, '--report', reportPath]);
      assert.notEqual(cliRes.code, 0);
      assert.match(cliRes.stderr, /duplicate.*key/i);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
