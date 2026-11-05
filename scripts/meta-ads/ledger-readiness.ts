import { createHash } from 'node:crypto';
import { reconcileMigrationLedger } from './migration-ledger';

export interface SqlStatement { start: number; end: number; head: string }

/** Lex SQL without executing it; dollar/quoted bodies and nested comments are
 * excluded from transaction-boundary detection. Original bytes are retained. */
export function inspectTransactionEnvelope(sql: string) {
  const statements: SqlStatement[] = [];
  let start = 0, i = 0, head = '', quote: string | null = null, commentDepth = 0, escapeString = false;
  while (i < sql.length) {
    if (commentDepth) {
      if (sql.startsWith('/*', i)) { commentDepth++; i += 2; }
      else if (sql.startsWith('*/', i)) { commentDepth--; i += 2; }
      else i++;
      continue;
    }
    if (quote) {
      if (sql.startsWith(quote, i)) {
        i += quote.length;
        if (quote.length === 1 && sql.startsWith(quote, i)) i++;
        else quote = null;
      } else if (quote === "'" && escapeString && sql[i] === '\\') i += 2;
      else i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; head += ' '; continue;
    }
    if (sql.startsWith('/*', i)) { commentDepth = 1; i += 2; head += ' '; continue; }
    if (sql[i] === "'" || sql[i] === '"') {
      escapeString = sql[i] === "'" && /(?:^|[^\w])E$/i.test(sql.slice(0, i));
      quote = sql[i++]; head += ' ? '; continue;
    }
    const dollar = sql[i] === '$' ? sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0] : null;
    if (dollar) { quote = dollar; i += dollar.length; head += ' ? '; continue; }
    if (sql[i] === ';') {
      if (head.trim()) statements.push({ start, end: i + 1, head: head.trim().replace(/\s+/g, ' ').toUpperCase() });
      start = ++i; head = '';
    } else head += sql[i++];
  }
  if (quote || commentDepth) throw new Error('UNTERMINATED_SQL');
  if (head.trim()) statements.push({ start, end: sql.length, head: head.trim().replace(/\s+/g, ' ').toUpperCase() });
  if (!statements.length) throw new Error('EMPTY_MIGRATION');
  const controls = statements.filter(s => /^(BEGIN\b|START TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|SAVEPOINT\b|RELEASE\b|PREPARE TRANSACTION\b)/.test(s.head));
  const outer = controls.length === 2 && /^(BEGIN|BEGIN WORK|BEGIN TRANSACTION|START TRANSACTION)$/.test(statements[0].head)
    && /^(COMMIT|COMMIT WORK|COMMIT TRANSACTION)$/.test(statements.at(-1)!.head)
    && controls[0] === statements[0] && controls[1] === statements.at(-1);
  const unsafe = controls.length > 0 && !outer;
  const nontransactional = statements.some(s => /^(VACUUM\b|ALTER SYSTEM\b|CREATE DATABASE\b|CREATE (UNIQUE )?INDEX CONCURRENTLY\b|REINDEX .*CONCURRENTLY\b)/.test(s.head));
  return { statements, mode: unsafe || nontransactional ? 'REJECT' as const : outer ? 'OUTER' as const : 'NONE' as const,
    destructive: statements.some(s => /^(DROP\b|TRUNCATE\b)/.test(s.head)),
    limitation: 'Lexical boundary inspection does not prove procedural/external side effects or live migration safety.' };
}

export const sqlSha256 = (sql: string) => createHash('sha256').update(sql, 'utf8').digest('hex');

/** Review artifact only. Never connects, applies SQL, repairs or edits history. */
export function buildLedgerReadinessPlan(files: { file: string; sql: string }[], history: { version: string; name: string }[]) {
  const reconciliation = reconcileMigrationLedger(files.map(f => f.file), history);
  const ordered = [...files].sort((a, b) => a.file.localeCompare(b.file));
  return { target: 'qmhfmgkymjgoevwmkidm', executionAuthorized: false,
    errors: reconciliation.errors,
    prefixCandidates: reconciliation.recorded.map(r => ({ ...r, sourceSha256: ordered.find(f => f.file === r.file) ? sqlSha256(ordered.find(f => f.file === r.file)!.sql) : null,
      sourceHashIsHistoricalAttestation: false })),
    pending: ordered.filter(f => reconciliation.pending.includes(f.file)).map(f => ({ file: f.file, sha256: sqlSha256(f.sql), predecessorCanonicalVersion: ordered[ordered.indexOf(f)-1]?.file.slice(0,14) || null,
      transactionMode: inspectTransactionEnvelope(f.sql).mode, statementCount: inspectTransactionEnvelope(f.sql).statements.length })),
    blockers: ['OWNER_COMPATIBILITY_DECISIONS', 'EXTERNAL_CONSUMER_ATTESTATION', 'BACKUP_RESTORE_APPROVAL', 'LIVE_EXECUTOR_REVIEW'],
    historyPolicy: 'Existing entries remain unchanged. Historical source hashes are current reviewed hashes, not invented proof of original execution.' };
}
