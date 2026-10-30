import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface MigrationIntegrityResult {
  valid: boolean;
  errors: string[];
  filesCount: number;
}

export interface MigrationGitGuardOptions {
  cwd?: string;
  baseRef?: string;
  migrationsRelPath?: string;
}

export interface MigrationGitGuardResult {
  valid: boolean;
  errors: string[];
  mergeBase?: string;
  changes: string[];
}

/**
 * Frozen baseline SHA-256 checksums for canonical Foundation migrations 001–004.
 * Invariant: New migrations may be appended, but old frozen foundation migrations may never mutate.
 */
export const FROZEN_FOUNDATION_MIGRATIONS: Record<string, string> = {
  '20260914000001_initial_schema.sql': 'a877e0e3fdf3b127c093b498fcc866b3df5ef37c4972dc778650e6a2d248c920',
  '20260915000001_rls_foundation.sql': '447cee608bdcad83c3deac07f967ae2116c2ae39cba9dd557c00ea1119632794',
  '20260915000002_trusted_server_private_rpc.sql': 'e432723499a195d8e552826782e702799739ad0f60b64c94b3ddce9a6f752712',
  '20260916000001_private_call_transcripts.sql': '1a04b0988362e3ad04ddd6fdd775bb1331a7d6ec0065c159bde7574661d075b1',
};

export const MIGRATION_FILENAME_REGEX = /^\d{14}_[a-z0-9_]+\.sql$/;

/**
 * Pure invariant-based migration integrity checker.
 * Validates:
 * 1. Presence of canonical Foundation migrations (001–004).
 * 2. Canonical naming format (YYYYMMDDHHMMSS_name.sql).
 * 3. Strict timestamp uniqueness.
 * 4. Deterministic chronological sorting.
 * 5. Frozen foundation migration checksum integrity.
 * 6. OPEN-ENDED: NEVER hardcodes total migration count; passes for 19, 20, N migrations.
 */
export function verifyMigrationIntegrity(
  files: string[],
  fileContentResolver?: (filename: string) => string
): MigrationIntegrityResult {
  const errors: string[] = [];

  // A. Canonical Foundation migrations exist
  for (const requiredMigration of Object.keys(FROZEN_FOUNDATION_MIGRATIONS)) {
    if (!files.includes(requiredMigration)) {
      errors.push(`Missing canonical foundation migration: "${requiredMigration}"`);
    }
  }

  // B. Canonical filename pattern and timestamp uniqueness
  const timestamps: string[] = [];
  for (const file of files) {
    if (!MIGRATION_FILENAME_REGEX.test(file)) {
      errors.push(`Migration filename "${file}" does not match pattern YYYYMMDDHHMMSS_name.sql`);
      continue;
    }
    const ts = file.slice(0, 14);
    timestamps.push(ts);
  }

  // Check unique timestamps
  const uniqueTimestamps = new Set(timestamps);
  if (timestamps.length !== uniqueTimestamps.size) {
    errors.push(`Duplicate migration timestamps detected (${timestamps.length - uniqueTimestamps.size} duplicate(s))`);
  }

  // Check unique filenames
  const uniqueFiles = new Set(files);
  if (files.length !== uniqueFiles.size) {
    errors.push('Duplicate migration filenames detected');
  }

  // Deterministic chronological ordering
  const sorted = [...files].sort();
  if (JSON.stringify(files) !== JSON.stringify(sorted)) {
    errors.push('Migrations are not in deterministic ascending chronological order');
  }

  // C. Foundation frozen migration integrity (checksums)
  if (fileContentResolver) {
    for (const [migrationName, expectedSha256] of Object.entries(FROZEN_FOUNDATION_MIGRATIONS)) {
      if (files.includes(migrationName)) {
        try {
          const content = fileContentResolver(migrationName);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          if (hash !== expectedSha256) {
            errors.push(`Foundation migration "${migrationName}" frozen integrity violated (checksum mismatch)`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to read foundation migration "${migrationName}": ${msg}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    filesCount: files.length,
  };
}

/**
 * Validates the actual filesystem migrations directory against all invariants.
 */
export function verifyFilesystemMigrations(
  migrationsDir = path.resolve(process.cwd(), 'supabase/migrations')
): MigrationIntegrityResult {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  return verifyMigrationIntegrity(files, (filename) => {
    return fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
  });
}

/**
 * Validates that migration history is strictly append-only relative to the git baseline
 * (by default, `origin/main` via `git merge-base HEAD origin/main`).
 *
 * Rules:
 * - Compares committed + working changes against the git merge-base commit.
 * - Uses `--no-renames` so renamed migrations appear as deletion + addition.
 * - Only additive ('A') files following the canonical timestamp_sql pattern are allowed.
 * - Any modification ('M'), deletion ('D'), or rename of a baseline migration is rejected,
 *   even if committed earlier on the feature branch.
 * - Fails closed if the baseline ref is unavailable (no silent fallback to HEAD).
 */
export function verifyMigrationGitGuard(
  options?: MigrationGitGuardOptions
): MigrationGitGuardResult {
  const cwd = options?.cwd || process.cwd();
  const baseRef = options?.baseRef || process.env.MIGRATION_BASE_REF || 'origin/main';
  const migrationsRelPath = (options?.migrationsRelPath || 'supabase/migrations').replace(/\\/g, '/');

  let mergeBase: string;
  try {
    mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Git baseline "${baseRef}" is unavailable or has no merge-base with HEAD: ${msg}`],
      changes: [],
    };
  }

  if (!mergeBase) {
    return {
      valid: false,
      errors: [`Failed to determine git merge-base between HEAD and "${baseRef}"`],
      changes: [],
    };
  }

  let diffOutput: string;
  try {
    diffOutput = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-status', mergeBase, '--', migrationsRelPath],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Failed to run git diff against merge-base "${mergeBase}": ${msg}`],
      mergeBase,
      changes: [],
    };
  }

  let untrackedOutput = '';
  try {
    untrackedOutput = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', migrationsRelPath],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
  } catch {
    // untracked file listing is best-effort alongside git diff
  }

  const changeLines = diffOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const untrackedLines = untrackedOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((f) => `A\t${f}`);

  const allChanges = [...changeLines, ...untrackedLines];
  const errors: string[] = [];

  const escapedRelPath = migrationsRelPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const validMigrationPattern = new RegExp(`^${escapedRelPath}/\\d{14}_[a-z0-9_]+\\.sql$`);

  for (const line of allChanges) {
    const parts = line.split(/\t+/);
    const status = parts[0]?.trim();
    const rawPath = (parts[1] || '').trim().replace(/^"(.*)"$/, '$1');
    const filePath = rawPath.replace(/\\/g, '/');

    // PR #139: production ledger inspection proved this colliding Messenger
    // migration was unapplied; the funnel owns 20261028130000. Permit only this
    // exact, body-preserving rename, with both original bytes and the applied
    // funnel anchored to reviewed SHA-256 values. No caller-controlled bypass.
    if (status === 'D' && filePath === `${migrationsRelPath}/20261028130000_remove_messenger_pending_sale_gate_and_enable_pages.sql`) {
      const replacement = `${migrationsRelPath}/20261028130001_remove_messenger_pending_sale_gate_and_enable_pages.sql`;
      const funnel = `${migrationsRelPath}/20261028130000_customer_funnel_six_stages.sql`;
      try {
        const original = execFileSync('git', ['show', `${mergeBase}:${filePath}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const current = fs.readFileSync(path.join(cwd, replacement), 'utf8');
        const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
        const funnelBefore = execFileSync('git', ['show', `${mergeBase}:${funnel}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const funnelAfter = fs.readFileSync(path.join(cwd, funnel), 'utf8');
        const originalHash = '8cdfd92019a15f4e3ca22a5f1906a40625332db83dd89712a248f19f851a55d1';
        const funnelHash = '44a5da682bd501210347b870731fc2260e82e881ef94b9481787ad15dec3c2b0';
        if (allChanges.includes(`A\t${replacement}`) && digest(original) === originalHash &&
            current.replace('-- Migration: 20261028130001_', '-- Migration: 20261028130000_') === original &&
            digest(funnelBefore) === funnelHash && digest(funnelAfter) === funnelHash) continue;
      } catch { /* Missing/mutated evidence is rejected by the normal guard. */ }
    }

    if (status !== 'A') {
      errors.push(
        `Disallowed migration modification (${status}) on "${filePath}". Existing migrations are immutable and cannot be modified or deleted.`
      );
      continue;
    }

    if (!validMigrationPattern.test(filePath)) {
      errors.push(
        `Added migration "${filePath}" does not match canonical naming pattern (${migrationsRelPath}/YYYYMMDDHHMMSS_name.sql).`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    mergeBase,
    changes: allChanges,
  };
}
