import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

async function main() {
  const h = await createPgliteSupabase();
  const db = h.db;

  try {
    const company = randomUUID();
    const customer = randomUUID();
    const conversation = randomUUID();

    await db.query(
      `INSERT INTO companies(id, name) VALUES($1, 'Outbound Status Contract')`,
      [company]
    );
    await db.query(
      `INSERT INTO customers(id, company_id, name, customer_code, source, stage)
       VALUES($1, $2, 'Contract Customer', 'CUST-001', 'MANUAL', 'LEAD_NEW')`,
      [customer, company]
    );
    await db.query(
      `INSERT INTO conversations(id, customer_id, company_id, channel, status, external_conversation_id)
       VALUES($1, $2, $3, 'FACEBOOK', 'OPEN', $4)`,
      [conversation, customer, company, `ext-${randomUUID()}`]
    );

    const statuses = [
      'PENDING', 'PENDING_DISPATCH', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED',
      'DISPATCHING', 'PROVIDER_SENT_PENDING_FINALIZE', 'UNCERTAIN', 'PROVIDER_UNCERTAIN',
      'PROCESSING', 'RETRY', 'RECONCILE_REQUIRED',
    ] as const;

    for (const status of statuses) {
      const clientCmd = randomUUID();
      const insert = await db.query<{ id: string; delivery_status: string }>(
        `INSERT INTO outbound_deliveries (company_id, conversation_id, channel, delivery_status, client_command_id)
         VALUES ($1, $2, 'FACEBOOK', $3, $4)
         RETURNING id, delivery_status`,
        [company, conversation, status, clientCmd]
      );
      assert.equal(insert.rows[0].delivery_status, status);
      const readBack = await db.query<{ delivery_status: string }>(
        `SELECT delivery_status FROM outbound_deliveries WHERE id = $1`,
        [insert.rows[0].id]
      );
      assert.equal(readBack.rows[0]?.delivery_status, status);
    }

    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO outbound_deliveries (company_id, conversation_id, channel, delivery_status, client_command_id)
           VALUES ($1, $2, 'FACEBOOK', 'INVALID_STATUS', $3)`,
          [company, conversation, randomUUID()]
        );
      },
      (err: any) => {
        assert.equal(err.code, '23514');
        assert.match(String(err.constraint || err.message), /outbound_deliveries_delivery_status_check/);
        return true;
      }
    );

    const aiCmd = randomUUID();
    const aiRow = await db.query<{ status: string; delivery_status: string }>(
      `INSERT INTO outbound_deliveries (company_id, conversation_id, channel, delivery_status, client_command_id)
       VALUES ($1, $2, 'FACEBOOK', 'DISPATCHING', $3)
       RETURNING status, delivery_status`,
      [company, conversation, aiCmd]
    );
    assert.equal(aiRow.rows[0].delivery_status, 'DISPATCHING');
    assert.equal(aiRow.rows[0].status, 'PENDING');

    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${randomUUID()}', false);`);
    await assert.rejects(
      db.query(
        `INSERT INTO outbound_deliveries (company_id, conversation_id, channel, delivery_status, client_command_id)
         VALUES ($1, $2, 'FACEBOOK', 'PENDING', $3)`,
        [company, conversation, randomUUID()]
      )
    );
    await db.exec('SET ROLE anon');
    await assert.rejects(
      db.query(
        `INSERT INTO outbound_deliveries (company_id, conversation_id, channel, delivery_status, client_command_id)
         VALUES ($1, $2, 'FACEBOOK', 'PENDING', $3)`,
        [company, conversation, randomUUID()]
      )
    );
    await db.exec('RESET ROLE');
  } finally {
    await h.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
