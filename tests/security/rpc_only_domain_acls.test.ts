import assert from 'node:assert/strict';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

const RPC_ONLY_TABLES = ['response_sla_windows', 'ai_analyses', 'sales_style_profiles'] as const;
const REPRESENTATIVE_RPCS = [
  'open_response_sla_window(uuid,uuid,uuid)',
  'get_ai_analysis_input(uuid,uuid,integer)',
  'get_sales_style_learning_input(uuid,uuid,integer)',
] as const;

async function main() {
  const harness = await createPgliteSupabase();
  const db = harness.db;

  try {
    for (const table of RPC_ONLY_TABLES) {
      for (const priv of ['select', 'insert', 'update', 'delete']) {
        const { rows } = await db.query<{ has_priv: boolean }>(
          `SELECT has_table_privilege('service_role', 'public.' || $1, $2) AS has_priv`,
          [table, priv]
        );
        assert.equal(rows[0]?.has_priv, false, `service_role must not have ${priv} on ${table}`);
      }

      await db.exec('SET ROLE service_role');
      try {
        const statements = [
          `SELECT id FROM public."${table}" LIMIT 0`,
          `INSERT INTO public."${table}" DEFAULT VALUES`,
          `UPDATE public."${table}" SET id = id WHERE false`,
          `DELETE FROM public."${table}" WHERE false`,
        ];

        for (const sql of statements) {
          let threw42501 = false;
          try {
            await db.query(sql);
          } catch (err: any) {
            threw42501 = err?.code === '42501';
          }
          assert.equal(threw42501, true, `Expected 42501 on ${sql}`);
        }
      } finally {
        await db.exec('RESET ROLE');
      }
    }

    for (const rpcSig of REPRESENTATIVE_RPCS) {
      const { rows: privRows } = await db.query<{
        has_sr: boolean;
        has_anon: boolean;
        has_auth: boolean;
      }>(
        `SELECT has_function_privilege('service_role', 'public.' || $1, 'execute') AS has_sr,
                has_function_privilege('anon', 'public.' || $1, 'execute') AS has_anon,
                has_function_privilege('authenticated', 'public.' || $1, 'execute') AS has_auth`,
        [rpcSig]
      );
      assert.equal(privRows[0]?.has_sr, true, `service_role must have EXECUTE on ${rpcSig}`);
      assert.equal(privRows[0]?.has_anon, false, `anon must not have EXECUTE on ${rpcSig}`);
      assert.equal(privRows[0]?.has_auth, false, `authenticated must not have EXECUTE on ${rpcSig}`);

      const { rows: metaRows } = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT p.prosecdef, p.proconfig
         FROM pg_proc p
         WHERE p.oid = ('public.' || $1)::regprocedure`,
        [rpcSig]
      );
      assert.equal(metaRows[0]?.prosecdef, true, `${rpcSig} must be SECURITY DEFINER`);
      const searchPathConfig = metaRows[0]?.proconfig?.find((c) => c.startsWith('search_path='));
      assert.equal(
        searchPathConfig === 'search_path=' || searchPathConfig === 'search_path=""',
        true,
        `${rpcSig} must have empty search_path`
      );
    }
  } finally {
    await harness.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
