import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// All fixtures and fault-injection triggers are rolled back, even on failure.
const result = spawnSync('docker', [
    'exec', '-i', 'supabase_db_ai-crm-cua-chong-ngap',
    'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
], { input: readFileSync('tests/omnichannel/database.sql', 'utf8'), encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status !== 0) {
    throw new Error('Omnichannel DB tests failed. Start the local Supabase stack with migration 005 applied.');
}
