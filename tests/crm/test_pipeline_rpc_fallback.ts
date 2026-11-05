import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerService } from '../../features/crm/services/customer.service';

const COMPANY = '90000000-0000-0000-0000-000000000001';

test('production pipeline uses exact tenant-scoped table counts when stage-count RPC is missing', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const rows = [
      { id: '92000000-0000-0000-0000-000000000001', company_id: COMPANY, customer_code: 'KH-001', name: 'Legacy lead', stage: 'LEAD_NEW', source: 'FACEBOOK', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', phone: null, email: null },
      { id: '92000000-0000-0000-0000-000000000002', company_id: COMPANY, customer_code: 'KH-002', name: 'Canonical lead', stage: 'awareness', source: 'ZALO', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', phone: null, email: null },
      { id: '92000000-0000-0000-0000-000000000003', company_id: COMPANY, customer_code: 'KH-003', name: 'Unmapped legacy', stage: 'UNMAPPED_LEGACY', source: 'MANUAL', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z', phone: null, email: null },
      { id: '92000000-0000-0000-0000-000000000004', company_id: '90000000-0000-0000-0000-000000000002', customer_code: 'KH-004', name: 'Other tenant', stage: 'LEAD_NEW', source: 'FACEBOOK', created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', phone: null, email: null },
    ];
    let headCountQueries = 0;
    const client: any = {
      rpc: async (name: string) => {
        assert.equal(name, 'get_customer_stage_counts');
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_customer_stage_counts in the schema cache' } };
      },
      from: (table: string) => {
        assert.equal(table, 'customers');
        const state: any = { equals: {}, inValues: {}, lower: {}, upper: {}, head: false, limit: 1000 };
        const query: any = {
          select: (_columns: unknown, options?: { head?: boolean }) => { state.head = options?.head === true; if (state.head) headCountQueries++; return query; },
          eq: (key: string, value: unknown) => { state.equals[key] = value; return query; },
          in: (key: string, values: string[]) => { state.inValues[key] = values; return query; },
          or: (value: string) => { state.search = value; return query; },
          gte: (key: string, value: string) => { state.lower[key] = value; return query; },
          lte: (key: string, value: string) => { state.upper[key] = value; return query; },
          order: (..._args: unknown[]) => query,
          limit: (value: number) => { state.limit = value; return query; },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
            if (state.equals.company_id !== COMPANY) {
              return Promise.reject(new Error('company_id tenant filter is required')).then(resolve, reject);
            }
            const filtered = rows.filter((row) => {
              if (row.company_id !== state.equals.company_id) return false;
              if (state.equals.source && row.source !== state.equals.source) return false;
              if (state.inValues.stage && !state.inValues.stage.includes(row.stage)) return false;
              if (state.lower.created_at && row.created_at < state.lower.created_at) return false;
              if (state.upper.created_at && row.created_at > state.upper.created_at) return false;
              return true;
            });
            const result = state.head
              ? { data: null, count: filtered.length, error: null }
              : { data: filtered.slice(0, state.limit), count: null, error: null };
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      },
    };

    const result = await CustomerService.getPipeline({
      companyId: COMPANY,
      role: 'BOSS_ADMIN',
      client,
      limit: 200,
    });

    const awareness = result.stages.find((stage) => stage.stage === 'awareness');
    assert.equal(result.total_customers, 3);
    assert.equal(result.eligible_customers, 2);
    assert.equal(result.unmapped_count, 1);
    assert.equal(result.needs_review_count, 2);
    assert.equal(awareness?.count, 2);
    assert.equal(awareness?.needs_review_count, 1);
    assert.ok(headCountQueries >= 10, 'exact head-count queries cover canonical and legacy review stages');
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
