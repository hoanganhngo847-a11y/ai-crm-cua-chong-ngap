/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-Memory Mock Supabase Client for Testing Zalo Omnichannel & Care Modules.
 * Allows pure, isolated unit and integration testing without a running Postgres instance.
 */

export interface MockDatabase {
  companies: any[];
  customers: any[];
  identities: any[];
  conversations: any[];
  interactions: any[];
  interaction_raw_contents: any[];
  care_campaigns: any[];
  care_deliveries: any[];
  care_schedules: any[];
  [table: string]: any[];
}

export function createMockDatabase(seed: Partial<MockDatabase> = {}): MockDatabase {
  return {
    companies: seed.companies || [
      { id: '11111111-1111-1111-1111-111111111111', name: 'Công ty Cửa Chống Ngập', status: 'ACTIVE' },
    ],
    customers: seed.customers || [],
    identities: seed.identities || [],
    conversations: seed.conversations || [],
    interactions: seed.interactions || [],
    interaction_raw_contents: seed.interaction_raw_contents || [],
    care_campaigns: seed.care_campaigns || [],
    care_deliveries: seed.care_deliveries || [],
    care_schedules: seed.care_schedules || [],
    ...seed,
  };
}

class MockQueryBuilder {
  private filters: Array<(item: any) => boolean> = [];
  private orderFn: ((a: any, b: any) => number) | null = null;
  private rangeBounds: [number, number] | null = null;
  private selectFields: string = '*';
  private operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' = 'SELECT';
  private insertData: any = null;
  private updateData: any = null;

  constructor(
    private table: string,
    private db: MockDatabase
  ) {
    if (!this.db[this.table]) {
      this.db[this.table] = [];
    }
  }

  select(fields = '*') {
    this.selectFields = fields;
    return this;
  }

  insert(data: any) {
    this.operation = 'INSERT';
    this.insertData = data;
    return this;
  }

  update(data: any) {
    this.operation = 'UPDATE';
    this.updateData = data;
    return this;
  }

  delete() {
    this.operation = 'DELETE';
    this.delete() ;
    return this;
  }

  eq(field: string, value: any) {
    this.filters.push((item) => item[field] === value);
    return this;
  }

  in(field: string, values: any[]) {
    this.filters.push((item) => values.includes(item[field]));
    return this;
  }

  lte(field: string, value: any) {
    this.filters.push((item) => item[field] <= value);
    return this;
  }

  order(field: string, options: { ascending?: boolean } = {}) {
    const asc = options.ascending !== false;
    this.orderFn = (a, b) => {
      if (a[field] < b[field]) return asc ? -1 : 1;
      if (a[field] > b[field]) return asc ? 1 : -1;
      return 0;
    };
    return this;
  }

  range(from: number, to: number) {
    this.rangeBounds = [from, to];
    return this;
  }

  limit(n: number) {
    this.rangeBounds = [0, n - 1];
    return this;
  }

  private execute() {
    const list = this.db[this.table] || [];

    if (this.operation === 'INSERT') {
      const rows = Array.isArray(this.insertData) ? this.insertData : [this.insertData];
      const inserted: any[] = [];

      for (const row of rows) {
        const item = {
          id: row.id || `mock_${this.table}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
          ...row,
        };
        list.push(item);
        inserted.push(item);
      }

      const resultData = Array.isArray(this.insertData) ? inserted : inserted[0];
      return { data: resultData, error: null };
    }

    if (this.operation === 'UPDATE') {
      const matched = list.filter((item) => this.filters.every((f) => f(item)));
      for (const item of matched) {
        Object.assign(item, this.updateData, { updated_at: new Date().toISOString() });
      }
      return { data: matched, error: null };
    }

    if (this.operation === 'DELETE') {
      const remaining = list.filter((item) => !this.filters.every((f) => f(item)));
      this.db[this.table] = remaining;
      return { data: null, error: null };
    }

    // SELECT
    let result = list.filter((item) => this.filters.every((f) => f(item)));

    if (this.orderFn) {
      result.sort(this.orderFn);
    }

    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      result = result.slice(from, to + 1);
    }

    // Handle simple join simulation: customers(name)
    if (this.selectFields.includes('customers(name)')) {
      result = result.map((item) => {
        const cust = this.db.customers?.find((c) => c.id === item.customer_id);
        return {
          ...item,
          customers: cust ? { name: cust.name } : null,
        };
      });
    }

    return { data: result, error: null };
  }

  async single() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (Array.isArray(data)) {
      if (data.length === 0) return { data: null, error: new Error('Row not found') };
      return { data: data[0], error: null };
    }
    return { data, error: null };
  }

  async maybeSingle() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (Array.isArray(data)) {
      return { data: data[0] || null, error: null };
    }
    return { data, error: null };
  }

  // Promise interface
  then(onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

export function createMockSupabase(db?: MockDatabase) {
  const database = db || createMockDatabase();
  return {
    from: (table: string) => new MockQueryBuilder(table, database),
    schema: () => ({
      from: (table: string) => new MockQueryBuilder(table, database),
    }),
    _db: database,
  };
}
