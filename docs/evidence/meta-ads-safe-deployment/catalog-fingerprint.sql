-- Read-only application schema fingerprints. No customer data or credentials.
WITH objects AS (
  SELECT 'columns' AS category, n.nspname || '.' || c.relname || '.' || a.attname AS identity,
    concat_ws('|', format_type(a.atttypid,a.atttypmod), a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid), a.attidentity, a.attgenerated) AS definition
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p')
    AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraints', n.nspname || '.' || c.conrelid::regclass::text || '.' || c.conname,
    pg_get_constraintdef(c.oid,true) || '|' || c.convalidated::text
  FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
  WHERE n.nspname IN ('public','private')
  UNION ALL
  SELECT 'indexes', n.nspname || '.' || c.relname,
    pg_get_indexdef(i.indexrelid) || '|' || i.indisvalid::text
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
  UNION ALL
  SELECT 'triggers', n.nspname || '.' || c.relname || '.' || t.tgname,
    pg_get_triggerdef(t.oid,true) || '|' || t.tgenabled::text
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') AND NOT t.tgisinternal
  UNION ALL
  SELECT 'functions', n.nspname || '.' || p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','private') AND NOT EXISTS (
    SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  UNION ALL
  SELECT 'policies', schemaname || '.' || tablename || '.' || policyname,
    concat_ws('|',permissive,roles::text,cmd,qual,with_check)
  FROM pg_policies WHERE schemaname IN ('public','private')
  UNION ALL
  SELECT 'relations', n.nspname || '.' || c.relname,
    concat_ws('|',c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions::text,
      CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) END)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v')
  UNION ALL
  SELECT 'table_grants', n.nspname||'.'||c.relname||':'||r.role||':'||p.privilege,
    has_table_privilege(r.role,c.oid,p.privilege)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) r(role)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
  WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v')
  UNION ALL
  SELECT 'function_grants', n.nspname||'.'||p.oid::regprocedure::text||':'||r.role,
    has_function_privilege(r.role,p.oid,'EXECUTE')::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) r(role)
  WHERE n.nspname IN ('public','private') AND NOT EXISTS (
    SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  UNION ALL
  SELECT 'schema_grants', n.nspname||':'||r.role||':'||p.privilege,
    has_schema_privilege(r.role,n.oid,p.privilege)::text
  FROM pg_namespace n
  CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) r(role)
  CROSS JOIN (VALUES ('USAGE'),('CREATE')) p(privilege)
  WHERE n.nspname IN ('public','private')

)
SELECT category, count(*) AS object_count,
  md5(string_agg(identity || '|' || definition, E'\n' ORDER BY identity COLLATE "C")) AS fingerprint
FROM objects GROUP BY category ORDER BY category;
