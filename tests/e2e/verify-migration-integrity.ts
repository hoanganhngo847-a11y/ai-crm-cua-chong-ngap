import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface MigrationIntegrityResult {
  valid: boolean;
  errors: string[];
  filesCount: number;
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
