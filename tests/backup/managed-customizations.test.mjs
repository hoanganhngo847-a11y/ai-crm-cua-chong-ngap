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
  getPlatformAclBaseline,
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

  await t.test('Finding 1 regression: exact ACL baseline comparison fails closed on any anomaly', () => {
    const baseline = getPlatformAclBaseline();
    const usersBaseline = baseline['auth.users'];
    assert.ok(usersBaseline, 'auth.users must exist in baseline');

    // 1. ACL chuẩn của platform -> platform-default
    const standardAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: JSON.parse(JSON.stringify(usersBaseline)),
    };
    assert.equal(classifyManagedCustomization(standardAcl).classification, 'platform-default');

    // 2. ACL có thêm DELETE bất thường cấp cho authenticated -> unexplained (FAIL CLOSED)
    const extraDeleteAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        aclIsNull: false,
        entries: [
          ...JSON.parse(JSON.stringify(usersBaseline.entries)),
          { grantee: 'authenticated', grantor: 'supabase_auth_admin', privilegeType: 'DELETE', isGrantable: false },
        ],
      },
    };
    assert.equal(classifyManagedCustomization(extraDeleteAcl).classification, 'unexplained');

    // 3. ACL có WITH GRANT OPTION bất thường -> unexplained (FAIL CLOSED)
    const alteredGrantOptionEntries = JSON.parse(JSON.stringify(usersBaseline.entries));
    alteredGrantOptionEntries[0].isGrantable = true; // Was false in baseline
    const alteredGrantOptionAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        aclIsNull: false,
        entries: alteredGrantOptionEntries,
      },
    };
    assert.equal(classifyManagedCustomization(alteredGrantOptionAcl).classification, 'unexplained');

    // 4. ACL bị thiếu quyền so với baseline -> unexplained (FAIL CLOSED)
    const missingPrivEntries = JSON.parse(JSON.stringify(usersBaseline.entries)).slice(1);
    const missingPrivAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        aclIsNull: false,
        entries: missingPrivEntries,
      },
    };
    assert.equal(classifyManagedCustomization(missingPrivAcl).classification, 'unexplained');

    // 5. ACL có grantor khác -> unexplained (FAIL CLOSED)
    const alteredGrantorEntries = JSON.parse(JSON.stringify(usersBaseline.entries));
    alteredGrantorEntries[0].grantor = 'postgres'; // Was supabase_auth_admin
    const alteredGrantorAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        aclIsNull: false,
        entries: alteredGrantorEntries,
      },
    };
    assert.equal(classifyManagedCustomization(alteredGrantorAcl).classification, 'unexplained');

    // 6. ACL NULL so với ACL explicit (aclIsNull mismatch) -> unexplained (FAIL CLOSED)
    const nullMismatchAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        aclIsNull: true, // Baseline has false
        entries: [],
      },
    };
    assert.equal(classifyManagedCustomization(nullMismatchAcl).classification, 'unexplained');

    // 7. ACL có role lạ / attacker -> unexplained (FAIL CLOSED)
    const rogueRoleAcl = {
      kind: 'relation-acl',
      identity: 'auth.users',
      details: {
        aclIsNull: false,
        entries: [
          ...JSON.parse(JSON.stringify(usersBaseline.entries)),
          { grantee: 'rogue_attacker', grantor: 'supabase_auth_admin', privilegeType: 'SELECT', isGrantable: false },
        ],
      },
    };
    assert.equal(classifyManagedCustomization(rogueRoleAcl).classification, 'unexplained');

    // 8. Standard platform column ACL (aclIsNull: true, entries: []) -> platform-default
    const standardColAcl = {
      kind: 'column-acl',
      identity: 'auth.users.email',
      details: {
        aclIsNull: true,
        entries: [],
      },
    };
    assert.equal(classifyManagedCustomization(standardColAcl).classification, 'platform-default');

    // 9. Column ACL with explicit permission -> unexplained (FAIL CLOSED)
    const explicitColAcl = {
      kind: 'column-acl',
      identity: 'auth.users.email',
      details: {
        aclIsNull: false,
        entries: [{ grantee: 'anon', grantor: 'postgres', privilegeType: 'SELECT', isGrantable: false }],
      },
    };
    assert.equal(classifyManagedCustomization(explicitColAcl).classification, 'unexplained');

    // 10. Allowlisted custom relation ACL -> project-owned
    const allowlist = new Set(['auth.users']);
    assert.equal(classifyManagedCustomization(extraDeleteAcl, allowlist).classification, 'project-owned');
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

  await t.test('Finding 2 regression: deep restore verification mutation tests fail closed on any attribute change', async () => {
    const tempDir = await createTempDir();
    try {
      const sourcePath = path.join(tempDir, 'source-all.json');
      const reportPath = path.join(tempDir, 'verify-report.json');

      const canonicalSource = [
        {
          kind: 'policy',
          identity: 'storage.objects:crm_customer_policy',
          details: {
            schema: 'storage',
            table: 'objects',
            policy: 'crm_customer_policy',
            permissive: 'PERMISSIVE',
            roles: ['authenticated', 'service_role'],
            command: 'ALL',
            using: '(bucket_id = \'crm_docs\')',
            withCheck: '(bucket_id = \'crm_docs\')',
          },
        },
        {
          kind: 'index',
          identity: 'public.crm_leads:crm_leads_phone_idx',
          details: {
            definition: 'CREATE INDEX crm_leads_phone_idx ON public.crm_leads USING btree (phone)',
            valid: true,
            ready: true,
            live: true,
            unique: false,
            primary: false,
          },
        },
        {
          kind: 'trigger',
          identity: 'public.crm_leads:crm_lead_audit_trg',
          details: {
            definition: 'CREATE TRIGGER crm_lead_audit_trg AFTER INSERT ON public.crm_leads FOR EACH ROW EXECUTE FUNCTION crm_log_lead()',
            enabled: 'O',
            functionIdentity: 'public.crm_log_lead()',
            functionDefinition: 'CREATE OR REPLACE FUNCTION public.crm_log_lead() RETURNS trigger AS ...',
            functionOwner: 'postgres',
            securityDefiner: true,
            functionConfig: ['search_path=public,auth'],
            functionAcl: 'postgres=X/postgres',
          },
        },
        {
          kind: 'routine',
          identity: 'public.crm_calculate_score(text)',
          details: {
            definition: 'CREATE OR REPLACE FUNCTION public.crm_calculate_score(text) ...',
            owner: 'postgres',
            securityDefiner: false,
            config: ['search_path=public'],
            acl: 'postgres=X/postgres,authenticated=X/postgres',
            language: 'plpgsql',
            comment: 'CRM lead scoring routine',
          },
        },
      ];
      await fsp.writeFile(sourcePath, JSON.stringify(canonicalSource));

      // Baseline exact match returns PASSED
      const baselineResult = await handleVerifyCommand({
        sourcePath,
        target: 'supabase_db_crm-restore-rehearsal',
        reportPath,
        querySql: async () => JSON.stringify(canonicalSource),
      });
      assert.equal(baselineResult.status, 'PASSED');
      assert.equal(baselineResult.report.discrepancyCount, 0);

      // Helper for testing single mutations
      const verifyMutation = async (mutateFn, expectedField) => {
        const mutatedTarget = JSON.parse(JSON.stringify(canonicalSource));
        mutateFn(mutatedTarget);
        const res = await handleVerifyCommand({
          sourcePath,
          target: 'supabase_db_crm-restore-rehearsal',
          reportPath,
          querySql: async () => JSON.stringify(mutatedTarget),
        });
        assert.equal(res.status, 'BLOCKED', `Mutation for ${expectedField} must result in BLOCKED status`);
        assert.ok(
          res.report.discrepancies.some((d) => d.field === expectedField),
          `Expected discrepancy on field '${expectedField}', found: ${JSON.stringify(res.report.discrepancies)}`
        );
      };

      // 1. Policy mutations
      await verifyMutation((t) => { t[0].details.roles = ['authenticated']; }, 'roles');
      await verifyMutation((t) => { t[0].details.withCheck = 'false'; }, 'withCheck');
      await verifyMutation((t) => { t[0].details.using = 'false'; }, 'using');
      await verifyMutation((t) => { t[0].details.permissive = 'RESTRICTIVE'; }, 'permissive');
      await verifyMutation((t) => { t[0].details.command = 'SELECT'; }, 'command');

      // 2. Index mutations
      await verifyMutation((t) => { t[1].details.definition = 'CREATE INDEX ... altered'; }, 'definition');
      await verifyMutation((t) => { t[1].details.unique = true; }, 'unique');
      await verifyMutation((t) => { t[1].details.valid = false; }, 'valid');
      await verifyMutation((t) => { t[1].details.ready = false; }, 'ready');
      await verifyMutation((t) => { t[1].details.live = false; }, 'live');
      await verifyMutation((t) => { t[1].details.primary = true; }, 'primary');

      // 3. Trigger mutations
      await verifyMutation((t) => { t[2].details.definition = 'CREATE TRIGGER altered ...'; }, 'definition');
      await verifyMutation((t) => { t[2].details.enabled = 'D'; }, 'enabled');
      await verifyMutation((t) => { t[2].details.functionIdentity = 'public.rogue_func()'; }, 'functionIdentity');
      await verifyMutation((t) => { t[2].details.functionDefinition = 'CREATE altered body'; }, 'functionDefinition');
      await verifyMutation((t) => { t[2].details.functionOwner = 'hacker_role'; }, 'functionOwner');
      await verifyMutation((t) => { t[2].details.securityDefiner = false; }, 'securityDefiner');
      await verifyMutation((t) => { t[2].details.functionConfig = ['search_path=public']; }, 'functionConfig');
      await verifyMutation((t) => { t[2].details.functionAcl = 'postgres=X/postgres,anon=X/postgres'; }, 'functionAcl');

      // 4. Routine & Procedure mutations
      await verifyMutation((t) => { t[3].details.definition = 'CREATE OR REPLACE altered body'; }, 'definition');
      await verifyMutation((t) => { t[3].details.owner = 'hacker_role'; }, 'owner');
      await verifyMutation((t) => { t[3].details.securityDefiner = true; }, 'securityDefiner');
      await verifyMutation((t) => { t[3].details.config = ['search_path=auth']; }, 'config');
      await verifyMutation((t) => { t[3].details.acl = 'postgres=X/postgres'; }, 'acl');
      await verifyMutation((t) => { t[3].details.language = 'sql'; }, 'language');
      await verifyMutation((t) => { t[3].details.comment = 'Altered comment'; }, 'comment');

      // 5. Target has extra unexpected project-owned customization
      await verifyMutation((t) => {
        t.push({
          kind: 'policy',
          identity: 'storage.objects:crm_extra_unapproved_policy',
          details: { schema: 'storage', table: 'objects', policy: 'crm_extra_unapproved_policy' },
        });
      }, 'extra_object');

      // 6. Target has unexpected unexplained object
      await verifyMutation((t) => {
        t.push({
          kind: 'trigger',
          identity: 'auth.users:backdoor_trigger',
          details: { definition: '...', functionOwner: 'attacker' },
        });
      }, 'unexplained_object');
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
