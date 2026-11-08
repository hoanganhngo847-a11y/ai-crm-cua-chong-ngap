"""The same SQL inventory runs in the exported source snapshot and restore."""
import hashlib
import json

NS = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'"


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def inventory(query):
    version = query("SELECT current_setting('server_version') AS version, "
                    "current_setting('server_version_num')::int AS version_num")[0]
    relations = query(f"""SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
        pg_get_userbyid(c.relowner) AS owner, c.relpersistence AS persistence,
        c.relrowsecurity AS rls,
        c.relforcerowsecurity AS force_rls,
        EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
          AND d.objid=c.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e') AS extension_member
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE {NS} AND c.relkind IN ('r','p','S','v','m','f')
        ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C" """)
    queries = {
        'columns': f"""SELECT n.nspname AS schema,c.relname AS relation,a.attname AS name,
          a.attnum AS position,format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,
          co.collname AS collation,pg_get_expr(d.adbin,d.adrelid) AS default_expression
          FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
          LEFT JOIN pg_collation co ON co.oid=a.attcollation
          WHERE {NS} AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f')""",
        'views': f"""SELECT n.nspname AS schema,c.relname AS name,c.reloptions AS options,
          pg_get_viewdef(c.oid,true) AS definition FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {NS} AND c.relkind IN ('v','m')""",
        'routines': f"""SELECT n.nspname AS schema, p.proname AS name,
          pg_get_function_identity_arguments(p.oid) AS arguments,
          p.prokind AS kind, pg_get_userbyid(p.proowner) AS owner,
          CASE WHEN p.prokind='a' THEN p.prosrc ELSE pg_get_functiondef(p.oid) END AS definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE {NS}""",
        'triggers': f"""SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS name,
          t.tgenabled AS enabled,pg_get_triggerdef(t.oid,true) AS definition
          FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {NS} AND NOT t.tgisinternal""",
        'constraints': f"""SELECT n.nspname AS schema,c.conname AS name,
          c.conrelid::regclass::text AS relation, pg_get_constraintdef(c.oid,true) AS definition,
          c.convalidated AS validated FROM pg_constraint c JOIN pg_namespace n
          ON n.oid=c.connamespace WHERE {NS}""",
        'indexes': f"""SELECT n.nspname AS schema,c.relname AS name,
          i.indisvalid AS valid,pg_get_indexdef(c.oid) AS definition
          FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {NS}""",
        'policies': f"""SELECT n.nspname AS schema,c.relname AS relation,p.polname AS name,
          p.polcmd AS command,p.polpermissive AS permissive,
          (SELECT array_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END
            ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END)
           FROM unnest(p.polroles) r) AS roles,
          pg_get_expr(p.polqual,p.polrelid) AS using_expression,
          pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
          FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {NS}""",
        'relation_grants': f"""SELECT n.nspname AS schema,c.relname AS relation,
          pg_get_userbyid(a.grantor) AS grantor,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
          a.privilege_type,a.is_grantable FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace,
          LATERAL aclexplode(coalesce(c.relacl,acldefault(
            CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
          WHERE {NS} AND c.relkind IN ('r','p','S','v','m','f')""",
        'routine_grants': f"""SELECT n.nspname AS schema,p.proname AS name,
          pg_get_function_identity_arguments(p.oid) AS arguments,
          pg_get_userbyid(a.grantor) AS grantor,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
          a.privilege_type,a.is_grantable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
          LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE {NS}""",
        'column_grants': f"""SELECT n.nspname AS schema,c.relname AS relation,col.attname AS column,
          pg_get_userbyid(a.grantor) AS grantor,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
          a.privilege_type,a.is_grantable FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace,LATERAL aclexplode(col.attacl) a
          WHERE {NS} AND col.attnum>0 AND NOT col.attisdropped""",
        'schema_grants': f"""SELECT n.nspname AS schema,pg_get_userbyid(n.nspowner) AS owner,
          pg_get_userbyid(a.grantor) AS grantor,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
          a.privilege_type,a.is_grantable FROM pg_namespace n,
          LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE {NS}""",
        'default_grants': """SELECT coalesce(n.nspname,'') AS schema,
          pg_get_userbyid(d.defaclrole) AS owner,d.defaclobjtype AS kind,
          pg_get_userbyid(a.grantor) AS grantor,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
          a.privilege_type,a.is_grantable FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace,LATERAL aclexplode(d.defaclacl) a""",
    }
    catalog = {'relations': relations}
    for name, sql in queries.items():
        catalog[name] = query(sql)
    # Normalize ordering by names/values, never by source OIDs.
    for name in catalog:
        catalog[name] = sorted(catalog[name], key=lambda row: json.dumps(row, sort_keys=True))
    tables, sequences = [], []
    fingerprints = {}
    critical = {('public', 'customers'), ('public', 'interactions'),
                ('private', 'customer_private_contacts'), ('supabase_migrations', 'schema_migrations'),
                ('public', 'identities'), ('private', 'customer_identity_values'),
                ('private', 'zalo_accounts'), ('public', 'conversations'),
                ('public', 'zalo_customer_identity_mappings'), ('public', 'company_members')}
    for relation in relations:
        schema, name, kind = relation['schema'], relation['name'], relation['kind']
        table = f'{ident(schema)}.{ident(name)}'
        if kind in ('r', 'p'):
            count = query(f'SELECT count(*) AS count FROM {table}')[0]['count']
            tables.append({'schema': schema, 'name': name, 'count': count,
                           'extension_member':relation['extension_member']})
            if (schema, name) in critical:
                # Multiset digest checks actual restored rows without logging any rows.
                fingerprints[f'{schema}.{name}'] = query(f"""SELECT md5(coalesce(
                  string_agg(row_hash,'' ORDER BY row_hash COLLATE "C"),'')) AS digest
                  FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM {table} t) q""")[0]['digest']
        elif kind == 'S':
            sequences.append({'schema': schema, 'name': name,
                              'state': query(f'SELECT last_value,is_called FROM {table}')[0]})
    extensions = query('SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema '
                       'FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname')
    large_objects = query("""SELECT
      (SELECT count(*) FROM pg_largeobject_metadata) AS objects,
      count(*) AS pages,
      coalesce(sum(octet_length(data)),0) AS bytes,
      md5(coalesce(string_agg(md5(loid::text || ':' || pageno::text || ':' || encode(data,'hex')),
                            '' ORDER BY loid,pageno),'')) AS content_digest
      FROM pg_largeobject""")[0]
    large_object_owners = query("""SELECT oid::bigint AS id,pg_get_userbyid(lomowner) AS owner,
        lomacl::text AS acl FROM pg_largeobject_metadata ORDER BY oid""")
    return {'postgres': version, 'catalog': catalog, 'tables': tables, 'sequences': sequences,
            'extensions': extensions, 'large_objects': large_objects,
            'large_object_owners': large_object_owners, 'row_fingerprints': fingerprints,
            'database': database_inventory(query),
            'catalog_sha256': hashlib.sha256(json.dumps(catalog,sort_keys=True).encode()).hexdigest()}


def database_inventory(query):
    properties = query("""SELECT d.datname AS name,pg_get_userbyid(d.datdba) AS owner,
        pg_encoding_to_char(d.encoding) AS encoding, d.datlocprovider AS locale_provider,
        d.datlocale AS locale,d.datcollate AS lc_collate,d.datctype AS lc_ctype,
        d.datcollversion AS collation_version,d.daticurules AS icu_rules,
        d.datconnlimit AS connection_limit,d.datallowconn AS allow_connections,
        d.datistemplate AS is_template,t.spcname AS tablespace
        FROM pg_database d JOIN pg_tablespace t ON t.oid=d.dattablespace
        WHERE d.datname=current_database()""")[0]
    grants = query("""SELECT pg_get_userbyid(a.grantor) AS grantor,
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
        a.privilege_type,a.is_grantable FROM pg_database d,
        LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
        WHERE d.datname=current_database() ORDER BY 1,2,3,4""")
    settings = query("""SELECT CASE WHEN s.setrole=0 THEN NULL ELSE pg_get_userbyid(s.setrole) END AS role,
        ARRAY(SELECT v FROM unnest(s.setconfig) v ORDER BY v COLLATE "C") AS settings
        FROM pg_db_role_setting s JOIN pg_database d ON d.oid=s.setdatabase
        WHERE d.datname=current_database() ORDER BY 1 NULLS FIRST""")
    return {'properties': properties, 'grants': grants, 'settings': settings}


def role_inventory(query):
    roles = query("""SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
      rolreplication,rolconnlimit,rolbypassrls,rolconfig,rolvaliduntil::text AS valid_until
      FROM pg_roles ORDER BY rolname""")
    memberships = query("""SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,
      pg_get_userbyid(grantor) AS grantor,admin_option,inherit_option,set_option
      FROM pg_auth_members ORDER BY 1,2,3""")
    bootstrap = query('SELECT rolname FROM pg_roles WHERE oid=10')[0]['rolname']
    return {'roles': roles, 'memberships': memberships, 'bootstrap_role':bootstrap}
