/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Real-PostgreSQL test harness for the Zalo module, without Docker.
 *
 * Boots PGlite (PostgreSQL compiled to WASM), applies EVERY migration in supabase/migrations
 * (after minimal Supabase platform stubs: roles, auth.users, storage), and exposes a small
 * supabase-js compatible adapter (`from()` query builder subset + `rpc()`), executing real SQL.
 * RPC state machines, constraints, triggers and transactions are therefore the production SQL,
 * not a JavaScript re-implementation.
 *
 * Not covered here (see zalo_supabase.integration.test.ts, run in CI against `supabase start`):
 * PostgREST exposure, JWT roles and true multi-connection concurrency.
 */
import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { SupabaseClient } from '@supabase/supabase-js';

const PLATFORM_STUBS = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE supabase_auth_admin NOLOGIN; CREATE ROLE authenticator NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
CREATE TABLE storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
CREATE TABLE storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name,'/') $$;
`;

export interface PgliteSupabase {
  db: PGlite;
  client: SupabaseClient;
  /** Adapter whose rpc() can be intercepted (fault injection). */
  withRpcOverride(override: (fn: string, params: Record<string, unknown>) => { data: any; error: any } | null): SupabaseClient;
  close(): Promise<void>;
}

type Result = { data: any; error: { message: string; code?: string } | null };

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}

function toParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

class QueryBuilder implements PromiseLike<Result> {
  private op: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' = 'SELECT';
  private columns = '*';
  private returning: string | null = null;
  private payload: any = null;
  private where: string[] = [];
  private params: unknown[] = [];
  private orderBy: string[] = [];
  private limitN: number | null = null;
  private offsetN: number | null = null;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(private readonly db: PGlite, private readonly table: string) {}

  select(columns = '*') {
    if (this.op === 'SELECT') this.columns = columns;
    else this.returning = columns;
    return this;
  }
  insert(payload: any) {
    this.op = 'INSERT';
    this.payload = payload;
    return this;
  }
  update(payload: any) {
    this.op = 'UPDATE';
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = 'DELETE';
    return this;
  }
  private bind(value: unknown): string {
    this.params.push(toParam(value));
    return `$${this.params.length}`;
  }
  eq(col: string, value: unknown) {
    this.where.push(value === null ? `${ident(col)} IS NULL` : `${ident(col)} = ${this.bind(value)}`);
    return this;
  }
  in(col: string, values: unknown[]) {
    if (values.length === 0) {
      this.where.push('false');
      return this;
    }
    this.where.push(`${ident(col)} IN (${values.map((v) => this.bind(v)).join(', ')})`);
    return this;
  }
  lte(col: string, value: unknown) {
    this.where.push(`${ident(col)} <= ${this.bind(value)}`);
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push(`${ident(col)} ${opts.ascending === false ? 'DESC' : 'ASC'}`);
    return this;
  }
  range(from: number, to: number) {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  single() {
    this.mode = 'single';
    return this.execute();
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this.execute();
  }
  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /** Supports plain columns and one-level embeds like `customers(name)` (FK customer_id). */
  private selectList(columns: string, alias: string): string {
    const parts: string[] = [];
    const re = /([a-z_]+)\(([^)]*)\)|([a-z_*]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(columns.replace(/\s+/g, '')))) {
      if (m[1]) {
        const rel = m[1];
        const fk = `${rel.replace(/s$/, '')}_id`;
        const cols = m[2].split(',').filter(Boolean);
        const obj = cols.map((c) => `'${c}', r.${ident(c)}`).join(', ');
        parts.push(`(SELECT json_build_object(${obj}) FROM public.${ident(rel)} r WHERE r.id = ${alias}.${ident(fk)}) AS ${ident(rel)}`);
      } else if (m[3] === '*') {
        parts.push(`${alias}.*`);
      } else if (m[3]) {
        parts.push(`${alias}.${ident(m[3])}`);
      }
    }
    return parts.join(', ');
  }

  private buildSql(): string {
    const t = `public.${ident(this.table)}`;
    const whereSql = this.where.length ? ` WHERE ${this.where.join(' AND ')}` : '';
    if (this.op === 'SELECT') {
      let sql = `SELECT ${this.selectList(this.columns, 't')} FROM ${t} t${whereSql}`;
      if (this.orderBy.length) sql += ` ORDER BY ${this.orderBy.join(', ')}`;
      if (this.limitN !== null) sql += ` LIMIT ${this.limitN}`;
      if (this.offsetN !== null) sql += ` OFFSET ${this.offsetN}`;
      return sql;
    }
    const ret = this.returning ? ` RETURNING ${this.returning === '*' ? '*' : this.returning.split(',').map((c) => ident(c.trim())).join(', ')}` : '';
    if (this.op === 'INSERT') {
      const rows: Record<string, unknown>[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
      const values = rows
        .map((r) => `(${cols.map((c) => (c in r ? this.bind(r[c]) : 'DEFAULT')).join(', ')})`)
        .join(', ');
      return `INSERT INTO ${t} (${cols.map(ident).join(', ')}) VALUES ${values}${ret}`;
    }
    if (this.op === 'UPDATE') {
      // Bind SET params first so their numbering precedes WHERE params.
      const whereParams = this.params;
      this.params = [];
      const sets = Object.entries(this.payload).map(([c, v]) => `${ident(c)} = ${this.bind(v)}`);
      const offset = this.params.length;
      const renumberedWhere = this.where.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`));
      this.params.push(...whereParams);
      const w = renumberedWhere.length ? ` WHERE ${renumberedWhere.join(' AND ')}` : '';
      return `UPDATE ${t} SET ${sets.join(', ')}${w}${ret}`;
    }
    return `DELETE FROM ${t}${whereSql}${ret}`;
  }

  private async execute(): Promise<Result> {
    let rows: Record<string, unknown>[];
    try {
      const sql = this.buildSql();
      rows = ((await this.db.query(sql, this.params)).rows as Record<string, unknown>[]).map(normalizeRow);
    } catch (e: any) {
      return { data: null, error: { message: e.message, code: e.code } };
    }

    const hasResult = this.op === 'SELECT' || this.returning !== null;
    if (!hasResult) return { data: null, error: null };
    if (this.mode === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: `JSON object requested, ${rows.length} rows returned`, code: 'PGRST116' } };
      return { data: rows[0], error: null };
    }
    if (this.mode === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: 'Multiple rows returned', code: 'PGRST116' } };
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

async function callRpc(db: PGlite, fn: string, params: Record<string, unknown>): Promise<Result> {
  try {
    const meta = (
      await db.query<{ proretset: boolean; ret: string; names: string[] | null; types: string[] }>(
        `SELECT p.proretset, format_type(p.prorettype, NULL) AS ret, p.proargnames AS names,
                array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`,
        [fn]
      )
    ).rows[0];
    if (!meta) return { data: null, error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' } };

    const names = meta.names || [];
    const args: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(params)) {
      const idx = names.indexOf(key);
      if (idx < 0 || idx >= meta.types.length) {
        return { data: null, error: { message: `Unknown parameter ${key} for ${fn}`, code: 'PGRST202' } };
      }
      values.push(toParam(value));
      args.push(`${ident(key)} => $${values.length}::${meta.types[idx]}`);
    }
    const call = `public.${ident(fn)}(${args.join(', ')})`;

    if (meta.proretset || meta.ret === 'record') {
      const rows = (await db.query(`SELECT * FROM ${call}`, values)).rows as Record<string, unknown>[];
      return { data: rows.map(normalizeRow), error: null };
    }
    const row = (await db.query<{ result: unknown }>(`SELECT ${call} AS result`, values)).rows[0];
    return { data: normalizeValue(row?.result ?? null), error: null };
  } catch (e: any) {
    return { data: null, error: { message: e.message, code: e.code } };
  }
}

function makeClient(
  db: PGlite,
  override?: (fn: string, params: Record<string, unknown>) => { data: any; error: any } | null
): SupabaseClient {
  const client = {
    from: (table: string) => new QueryBuilder(db, table),
    rpc: async (fn: string, params: Record<string, unknown> = {}) => {
      const intercepted = override?.(fn, params);
      if (intercepted) return intercepted;
      return callRpc(db, fn, params);
    },
  };
  return client as unknown as SupabaseClient;
}

export async function createPgliteSupabase(): Promise<PgliteSupabase> {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(PLATFORM_STUBS);

  const dir = path.resolve(__dirname, '../../../supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      await db.exec(`BEGIN;\n${sql}\n;COMMIT;`);
    } catch (e: any) {
      await db.exec('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${file} failed on PGlite: ${e.message}`);
    }
  }

  return {
    db,
    client: makeClient(db),
    withRpcOverride: (override) => makeClient(db, override),
    close: () => db.close(),
  };
}
