import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanClientBoundaries, scanPrivateQueries } from '../helpers/client-boundary-scan';
const root=mkdtempSync(path.join(tmpdir(),'client-boundary-test-'));
try {
  mkdirSync(path.join(root,'app'));mkdirSync(path.join(root,'features'));
  writeFileSync(path.join(root,'app','ui.tsx'),`'use client'; import {run} from '../features/indirect'; export const UI=run;`);
  writeFileSync(path.join(root,'features','indirect.ts'),`export {run} from './privileged';`);
  writeFileSync(path.join(root,'features','privileged.ts'),`import 'server-only'; export function run(){return 'private';}`);
  assert.equal(scanClientBoundaries(root).length,1,'indirect privileged client import is denied');
  writeFileSync(path.join(root,'features','indirect.ts'),`export {run} from './privileged'; 'use server';`);
  assert.equal(scanClientBoundaries(root).length,1,'a string outside the directive prologue cannot hide a client leak');
  writeFileSync(path.join(root,'features','indirect.ts'),`'use server'; export async function run(){return 'safe';}`);
  writeFileSync(path.join(root,'app','route.ts'),`import {createAdminClient} from '../features/server'; export async function POST(){return createAdminClient();}`);
  assert.equal(scanClientBoundaries(root).length,0,'server action boundary and API server adapter do not become client modules');
  writeFileSync(path.join(root,'app','route.ts'),`'use client'; import {createAdminClient} from '../features/server';`);
  assert.equal(scanClientBoundaries(root).length,1,'mislabelled client adapter is denied');
  writeFileSync(path.join(root,'app','route.ts'),`export const leaked=process.env.SUPABASE_SERVICE_ROLE_KEY;`);
  assert.equal(scanClientBoundaries(root).length,1,'raw secret in any app wrapper is denied');
  writeFileSync(path.join(root,'app','policy.tsx'),`export default function Policy(){return <code>private.customer_private_contacts</code>}`);
  assert.equal(scanPrivateQueries(root).length,0,'disclosure prose does not query private data');
  writeFileSync(path.join(root,'features','query.ts'),`db.schema('private').from('customer_private_contacts').select('*');`);
  assert.equal(scanPrivateQueries(root).length,1,'actual private SDK query is denied');
  writeFileSync(path.join(root,'features','query.ts'),`db.query('SELECT * FROM private.customer_private_contacts');`);
  assert.equal(scanPrivateQueries(root).length,1,'actual raw SQL query is denied');
  console.log('PASS: client import graph guard catches indirect leaks and distinguishes real server boundaries');
} finally {rmSync(root,{recursive:true,force:true});}
