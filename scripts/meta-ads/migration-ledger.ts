/** Read-only reconciliation. A name match is evidence to inspect schema, never
 * permission to rerun SQL, repair history, or skip an entry during deployment. */
export function reconcileMigrationLedger(files: string[], history: { version: string; name: string }[]) {
  const errors: string[] = [];
  const canonical = [...files].sort().map(file => ({ file, version: file.slice(0, 14), name: file.slice(15, -4) }));
  if (new Set(canonical.map(m => m.version)).size !== canonical.length) errors.push('DUPLICATE_FILE_VERSION');
  if (new Set(canonical.map(m => m.name)).size !== canonical.length) errors.push('AMBIGUOUS_FILE_NAME');
  if (new Set(history.map(m => m.version)).size !== history.length) errors.push('DUPLICATE_HISTORY_VERSION');
  if (new Set(history.map(m => m.name)).size !== history.length) errors.push('AMBIGUOUS_HISTORY_NAME');
  const ordered = [...history].sort((a, b) => a.version.localeCompare(b.version));
  const recorded = ordered.map((entry, index) => {
    const matches = canonical.filter(m => m.name === entry.name);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match) errors.push(`UNKNOWN_OR_AMBIGUOUS_HISTORY_NAME:${entry.name}`);
    if (match && canonical[index]?.file !== match.file) errors.push(`NON_PREFIX_HISTORY:${entry.name}`);
    const versionOwner = canonical.find(m => m.version === entry.version);
    if (versionOwner && versionOwner.name !== entry.name) errors.push(`VERSION_NAME_CONFLICT:${entry.version}`);
    return { ...entry, file: match?.file, canonicalVersion: match?.version,
      requiresSchemaVerification: match?.version !== entry.version };
  });
  return { errors, recorded,
    pending: canonical.filter(m => !history.some(h => h.name === m.name)).map(m => m.file),
    // Even an exact name/version match does not prove the current schema.
    schemaVerificationRequired: true as const };
}
