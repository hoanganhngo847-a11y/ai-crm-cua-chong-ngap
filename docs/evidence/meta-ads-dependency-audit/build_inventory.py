"""Offline audit only: read repository SQL; write documentation evidence.

Requires pglast==8.7 in an external environment. Never connects to a database,
executes migration SQL, or modifies migration/application files.
"""
from pathlib import Path
from collections import Counter
import hashlib
import json
import re
import sys
from pglast import parser

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
TABLES = json.loads((BASE / 'staging-tables.json').read_text())
TABLE_NAMES = {r['name'] for r in TABLES}
FUNCTION_NAMES = set(json.loads((BASE / 'legacy-function-names.json').read_text()))
LEVEL = {'SAFE': 0, 'CONDITIONAL': 1, 'HIGH RISK': 2, 'BLOCKED': 3}

def strings(nodes):
    return [n.get('String', {}).get('sval', '') for n in (nodes or [])]

def relation(r):
    return '.'.join(filter(None, [r.get('schemaname'), r.get('relname')]))

def typename(t):
    name = '.'.join(strings(t.get('names'))).removeprefix('pg_catalog.')
    return name + '[]' * len(t.get('arrayBounds', []))

def signature(n):
    params = [p['FunctionParameter'] for p in n.get('parameters', [])]
    inputs = [p for p in params if p.get('mode') not in ('FUNC_PARAM_OUT', 'FUNC_PARAM_TABLE')]
    return '.'.join(strings(n['funcname'])) + '(' + ','.join(typename(p['argType']) for p in inputs) + ')'

def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)

def classify(kind, n, sql, replacing=False):
    if kind == 'DropStmt' or kind == 'TruncateStmt':
        return 'BLOCKED', 'Explicit object/data removal; individual approval and live dependency/retention checks required.'
    if kind == 'AlterTableStmt':
        subtypes = [x['AlterTableCmd']['subtype'] for x in n.get('cmds', [])]
        if any('Drop' in x for x in subtypes):
            return 'BLOCKED', 'Column/constraint/default/trigger removal or privilege reduction; review each ALTER subcommand and dependent data/API.'
        if any(x in ('AT_DisableRowSecurity', 'AT_DisableTrig', 'AT_DisableTrigAll', 'AT_DisableTrigUser') for x in subtypes):
            return 'BLOCKED', 'Security/trigger disabling requires explicit review; prohibited during this audit.'
        if any(x in ('AT_AlterColumnType', 'AT_SetNotNull', 'AT_ColumnDefault', 'AT_SetDefault') for x in subtypes):
            return 'HIGH RISK', 'Existing-row validation/rewrite or runtime default changes; verify data, locks and callers.'
        return 'CONDITIONAL', 'Check live schema, lock duration, constraint validation, RLS and application compatibility.'
    if kind in ('UpdateStmt', 'DeleteStmt', 'InsertStmt', 'MergeStmt'):
        return ('BLOCKED' if kind == 'DeleteStmt' else 'HIGH RISK'), 'Migration-time data/configuration transformation; back up affected rows and verify tenant-scoped before/after semantics.'
    if kind == 'GrantStmt':
        grantees = [g['RoleSpec'] for g in n.get('grantees', [])]
        broad = any(g.get('roletype') == 'ROLESPEC_PUBLIC' or g.get('rolename') in ('anon', 'authenticated') for g in grantees)
        if n.get('is_grant') and broad:
            return 'HIGH RISK', 'Client/PUBLIC privilege grant; verify RLS, function authorization and transient exposure before later revokes.'
        return 'CONDITIONAL', 'Privilege change can break callers or broaden trusted access; verify exact role/object boundary.'
    if kind == 'CreateFunctionStmt':
        return ('HIGH RISK' if replacing else 'CONDITIONAL'), ('Existing function implementation replaced; same signature does not prove unchanged business behavior.' if replacing else 'New executable API/trigger helper; verify grants, fixed search_path, authorization, return contract and dependency order.')
    if kind == 'DoStmt':
        return 'CONDITIONAL', 'Immediate procedural block; nested SQL/dynamic expressions are separately inventoried below.'
    if kind in ('CreatePolicyStmt', 'AlterPolicyStmt', 'CreateTrigStmt', 'ViewStmt', 'RenameStmt', 'AlterObjectSchemaStmt', 'AlterFunctionStmt'):
        return 'CONDITIONAL', 'Policy/trigger/API/schema behavior changes; verify dependent callers, tenant isolation and permissions.'
    if kind == 'IndexStmt':
        return 'CONDITIONAL', 'Verify duplicate definition, existing data uniqueness, build locks and query/operator dependencies.'
    if kind == 'CreateExtensionStmt':
        return 'CONDITIONAL', 'Verify extension version, schema placement, availability and dependent operators/indexes.'
    if kind in ('CreateStmt', 'CreateSchemaStmt', 'CreateSeqStmt'):
        return 'SAFE', 'Additive object creation; no destructive impact identified. Existence guards do not attest schema equivalence; all schema execution still requires separate approval.'
    if kind in ('CommentStmt', 'TransactionStmt', 'NotifyStmt') or (kind=='SelectStmt' and not any(k=='FuncCall' for k,v in walk(n))):
        return 'SAFE', 'Metadata/transaction/schema-cache notification; no destructive impact identified.'
    return 'CONDITIONAL', 'Review executable operation and side effects; do not infer safety from statement spelling.'

def trim_leading_comments(sql):
    # pglast ranges can start before comments following the previous semicolon.
    i = 0
    while i < len(sql):
        if sql[i].isspace():
            i += 1
        elif sql.startswith('--', i):
            end = sql.find('\n', i)
            i = len(sql) if end < 0 else end + 1
        elif sql.startswith('/*', i):
            depth = 1
            i += 2
            while depth and i < len(sql):
                if sql.startswith('/*', i): depth += 1; i += 2
                elif sql.startswith('*/', i): depth -= 1; i += 2
                else: i += 1
        else:
            break
    return i

def nested_do(sql, start_line):
    ast = json.loads(parser.parse_plpgsql_json(sql))
    match = re.search(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$', sql)
    body_line = start_line + sql[:match.end()].count('\n') if match else start_line
    result = []
    for key, n in walk(ast):
        if key not in ('PLpgSQL_stmt_execsql', 'PLpgSQL_stmt_dynexecute', 'PLpgSQL_stmt_perform'):
            continue
        expr = n.get('sqlstmt', n.get('query', n.get('expr', {})))
        query = expr.get('PLpgSQL_expr', {}).get('query', '')
        if not query:
            continue
        dynamic = key == 'PLpgSQL_stmt_dynexecute'
        row = {'line': body_line + n.get('lineno', 1) - 1, 'kind': key, 'sql_or_dynamic_expression': query,
               'risk': 'CONDITIONAL', 'reason': 'Immediate procedural SQL; validate conditional execution and source objects.'}
        if dynamic:
            row['reason'] = 'Dynamic SQL expression: target set must be expanded against the catalog at this exact migration boundary; never execute to discover it in staging.'
            value = json.loads(parser.parse_sql_json('SELECT '+query))['stmts'][0]['stmt']['SelectStmt']['targetList'][0]['ResTarget']['val']
            constant = value.get('A_Const', {}).get('sval', {}).get('sval')
            template = None
            if 'FuncCall' in value and strings(value['FuncCall'].get('funcname')) == ['format']:
                template = value['FuncCall'].get('args',[{}])[0].get('A_Const',{}).get('sval',{}).get('sval')
            if constant is not None:
                children = []
                for parsed in json.loads(parser.parse_sql_json(constant))['stmts']:
                    kind, definition = next(iter(parsed['stmt'].items()))
                    start = parsed.get('stmt_location',0)
                    raw = constant.encode()
                    end = start+parsed['stmt_len'] if parsed.get('stmt_len',0) else len(raw)
                    child_sql=raw[start:end].decode()
                    child_level, child_reason=classify(kind,definition,child_sql)
                    nested=[]
                    if kind=='DoStmt':
                        nested=nested_do(child_sql+';',row['line']+raw[:start].count(b'\n'))
                        if nested: child_level=max([child_level]+[c['risk'] for c in nested],key=lambda r:LEVEL[r])
                    children.append({'line':row['line']+raw[:start].count(b'\n'),'kind':kind,'risk':child_level,'reason':child_reason,'sql':child_sql,'nested_operations':nested})
                row['constant_sql_statements']=children
                row['risk']=max([c['risk'] for c in children],key=lambda r:LEVEL[r]) if children else 'CONDITIONAL'
            else:
                row['format_template']=template
                row['risk']='BLOCKED' if re.match(r'\s*(?:DROP|TRUNCATE|DELETE)\b',template or '',re.I) else 'CONDITIONAL'
                if template is None:
                    row['risk']='HIGH RISK'
        else:
            try:
                queries = json.loads(parser.parse_sql_json(query))['stmts']
                categories = [classify(k, v, query) for q in queries for k, v in q['stmt'].items()]
                if categories:
                    row['risk'], row['reason'] = max(categories, key=lambda x: LEVEL[x[0]])
            except Exception:
                row['risk'] = 'HIGH RISK'
                row['reason'] = 'Procedural SQL not independently resolved by SQL parser; requires manual target/side-effect review.'
        result.append(row)
    return result

def extract_function(n, sql, file, line):
    options = {x['DefElem']['defname']: x['DefElem'].get('arg') for x in n.get('options', [])}
    body_options = options.get('as') or {}
    body = '\n'.join(strings(body_options.get('List', {}).get('items', [])))
    return {'signature': signature(n), 'name': strings(n['funcname'])[-1], 'file': file, 'line': line,
            'parameters': [x['FunctionParameter'] for x in n.get('parameters', [])],
            'language': (options.get('language') or {}).get('String', {}).get('sval'), 'body': body,
            'replaces': bool(n.get('replace'))}

def build():
    statements, per_migration, function_events = [], [], []
    functions = {}
    before_removal = None
    paths = sorted((ROOT / 'supabase/migrations').glob('*.sql'))
    for migration_index, path in enumerate(paths, 1):
        raw = path.read_bytes()
        tree = json.loads(parser.parse_sql_json(raw.decode()))
        file_rows = []
        for index, stmt in enumerate(tree['stmts'], 1):
            offset = stmt.get('stmt_location', 0)
            end = offset + stmt['stmt_len'] if stmt.get('stmt_len', 0) else len(raw)
            original = raw[offset:end].decode()
            skip = trim_leading_comments(original)
            start = offset + len(original[:skip].encode())
            sql = original[skip:].strip().rstrip(';') + ';'
            line = raw[:start].count(b'\n') + 1
            kind, node = next(iter(stmt['stmt'].items()))
            sig = signature(node) if kind == 'CreateFunctionStmt' else None
            replacing = sig in functions if sig else False
            risk, reason = classify(kind, node, sql, replacing)
            row = {'id': f'M{migration_index:03d}-S{index:03d}', 'file': path.name, 'line': line,
                   'kind': kind, 'risk': risk, 'reason': reason, 'already_recorded_prefix': migration_index <= 21,
                   'sql': sql, 'affected_objects': [], 'details': {}}
            if kind == 'AlterTableStmt':
                row['affected_objects'] = [relation(node['relation'])]
                row['details']['subcommands'] = [x['AlterTableCmd'] for x in node.get('cmds', [])]
            elif kind == 'CreateFunctionStmt':
                fn = extract_function(node, sql, path.name, line)
                row['affected_objects'] = [fn['signature']]
                row['details']['replaces_existing_signature'] = replacing
                body_start = max(0, sql.find(fn['body']))
                row['details']['runtime_body_mutations'] = [{'line': line + sql[:body_start+m.start()].count('\n'), 'operation': m.group(0)} for m in re.finditer(r'(?im)^[ \t]*(?:DELETE\s+FROM|UPDATE\s+[\w.]|TRUNCATE\s|EXECUTE\s)', fn['body'])]
                functions[sig] = fn
                function_events.append({'event': 'create_or_replace', **fn})
            elif kind == 'DropStmt':
                row['details'] = node
                # Function input types are already present in objargs; the raw
                # grammar duplicates these again as objfuncargs.
                for o in node.get('objects',[]):
                    if 'ObjectWithArgs' in o: o['ObjectWithArgs'].pop('objfuncargs',None)
                row['affected_objects'] = re.findall(r'(?:public|private|storage)\.[a-z_]+', sql)
                if node['removeType'] == 'OBJECT_FUNCTION':
                    for obj in node['objects']:
                        entry = obj.get('ObjectWithArgs', {})
                        fn_name = '.'.join(strings(entry.get('objname')))
                        args = [typename(t['TypeName']) for t in entry.get('objargs', [])]
                        exact = fn_name + '(' + ','.join(args) + ')'
                        to_delete = [key for key in functions if key == exact or (entry.get('args_unspecified') and key.startswith(fn_name+'('))]
                        for key in to_delete:
                            function_events.append({'event': 'drop', 'signature': key, 'file': path.name, 'line': line})
                            functions.pop(key)
            elif kind in ('CreateStmt', 'IndexStmt', 'CreateTrigStmt'):
                if node.get('relation'): row['affected_objects'] = [relation(node['relation'])]
                row['details'] = node
            elif kind == 'GrantStmt':
                row['details'] = {k:v for k,v in node.items() if k not in ('objects',)}
                row['affected_objects'] = sorted(set(re.findall(r'(?:public|private|storage|cron_internal)\.[a-z_]+', sql)))
            elif kind == 'CreatePolicyStmt':
                row['affected_objects'] = [relation(node['table'])+'.'+node['policy_name']]
                row['details'] = node
            elif kind == 'DoStmt':
                row['details']['nested_operations'] = nested_do(sql, line)
                if row['details']['nested_operations']:
                    riskier = max(row['details']['nested_operations'], key=lambda x: LEVEL[x['risk']])
                    if LEVEL[riskier['risk']] > LEVEL[row['risk']]: row['risk'], row['reason'] = riskier['risk'], riskier['reason']
                if path.name == '20261029160000_remove_legacy_flood_barrier_schema.sql':
                    before_removal = dict(functions)
                    removed = [fn for fn in functions.values() if fn['name'] in FUNCTION_NAMES]
                    row['details']['statically_expanded_legacy_signatures'] = [fn['signature'] for fn in removed]
                    for fn in removed:
                        function_events.append({'event':'dynamic_legacy_drop','signature':fn['signature'],'file':path.name,'line':529})
                        functions.pop(fn['signature'])
            else:
                row['affected_objects'] = sorted(set(re.findall(r'(?:public|private|storage|cron_internal)\.[a-z_]+', sql)))
            statements.append(row)
            file_rows.append(row)
        per_migration.append({'file':path.name,'sha256':hashlib.sha256(raw).hexdigest(),'statements':len(file_rows),
                              'counts':dict(Counter(x['risk'] for x in file_rows)), 'pending':migration_index>21})
    assert before_removal is not None
    def body_references(fn):
        # Strip SQL comments before flagging body references; textual, not pg_depend.
        body = re.sub(r'/\*[\s\S]*?\*/|--[^\n]*', ' ', fn['body'])
        table_refs = sorted(set(re.findall(r'\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+(?:public\.)?('+'|'.join(sorted(TABLE_NAMES))+r')\b', body, re.I)))
        function_refs = sorted(name for name in FUNCTION_NAMES if re.search(r'\b'+re.escape(name)+r'\s*\(', body))
        return table_refs, function_refs
    removed_functions = []
    for name in sorted(FUNCTION_NAMES):
        entries = [v for v in before_removal.values() if v['name'] == name]
        removed_functions.append({'name':name, 'pre_removal_definitions':entries,
                                 'callers_before_removal':[{'signature':v['signature'],'file':v['file'],'line':v['line']} for v in before_removal.values() if name in body_references(v)[1]]})
    survivors = []
    for fn in functions.values():
        table_refs, function_refs = body_references(fn)
        if table_refs or function_refs: survivors.append({**fn,'legacy_table_references':table_refs,'legacy_function_references':function_refs})
    output = {'parser':'pglast 8.7 / PostgreSQL parser 18.6; offline syntax/classification, not PostgreSQL 17 execution or a dependency oracle',
              'counting_unit':'one top-level SQL statement; ALTER subcommands and immediate DO operations retained within their parent, runtime function bodies labeled separately',
              'migration_count':len(paths),'statement_count':len(statements),'risk_counts':dict(Counter(x['risk'] for x in statements)),
              'pending_risk_counts':dict(Counter(x['risk'] for x in statements if not x['already_recorded_prefix'])),
              'migrations':per_migration,'statements':statements}
    # Keep one statement/event per JSON line for review instead of duplicating
    # hundreds of thousands of pretty-printed AST lines. Exact SQL stays intact.
    metadata={k:v for k,v in output.items() if k!='statements'}
    payload=json.dumps(metadata,ensure_ascii=False,indent=2)[:-2]+',\n  "statements": [\n'
    payload+=',\n'.join('    '+json.dumps(r,ensure_ascii=False,separators=(',',':')) for r in statements)+'\n  ]\n}\n'
    (BASE/'migration-risk-statements.json').write_text(payload)
    concise_events=[{k:v for k,v in e.items() if k!='body'} for e in function_events]
    (BASE/'function-definition-timeline.json').write_text('[\n'+',\n'.join('  '+json.dumps(r,ensure_ascii=False,separators=(',',':')) for r in concise_events)+'\n]\n')
    for name, value in [
                         ('legacy-pre-removal-functions.json',removed_functions),('surviving-legacy-function-references.json',survivors)]:
        (BASE/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    md=['# Full migration risk matrix','', 'Offline statement-level assessment. SAFE is not execution authorization. Full exact SQL and nested operations are in [the JSON inventory](migration-risk-statements.json).', '',
        '| Migration | Statements | SAFE | CONDITIONAL | HIGH RISK | BLOCKED |','| --- | ---: | ---: | ---: | ---: | ---: |']
    for m in per_migration:
        md.append('| '+m['file']+' | '+str(m['statements'])+' | '+' | '.join(str(m['counts'].get(k,0)) for k in LEVEL)+' |')
    for m in per_migration:
        md += ['', '## '+m['file'], '', '| ID | Line | Kind | Risk | Objects / exact SQL header | Reason / action |','| --- | ---: | --- | --- | --- | --- |']
        for row in [r for r in statements if r['file']==m['file']]:
            header=re.sub(r'\s+',' ',row['sql']).replace('|','\\|')[:200]
            md.append(f"| {row['id']} | [{row['line']}](../../../supabase/migrations/{row['file']}#L{row['line']}) | {row['kind']} | {row['risk']} | `{header}` | {row['reason']} |")
            for i,n in enumerate(row['details'].get('nested_operations',[]),1):
                header=re.sub(r'\s+',' ',n['sql_or_dynamic_expression']).replace('|','\\|')[:180]
                md.append(f"| {row['id']}.DO{i} | {n['line']} | {n['kind']} | {n['risk']} | `{header}` | {n['reason']} |")
    (BASE/'FULL_MIGRATION_RISK_MATRIX.md').write_text('\n'.join(md)+'\n')
    print(json.dumps({k:output[k] for k in ['migration_count','statement_count','risk_counts','pending_risk_counts']}))
    print('Legacy function names:',len(removed_functions),'pre-removal overloads:',sum(len(x['pre_removal_definitions']) for x in removed_functions),'surviving textual references:',len(survivors))

def self_test():
    sql="-- unicode tiếng Việt\nALTER TABLE public.t DROP COLUMN x, ADD COLUMN y text;"
    raw=json.loads(parser.parse_sql_json(sql))['stmts'][0]
    node=raw['stmt']['AlterTableStmt']
    assert classify('AlterTableStmt',node,sql)[0]=='BLOCKED'
    assert len(node['cmds'])==2
    assert classify('GrantStmt',{'is_grant':False,'grantees':[{'RoleSpec':{'roletype':'ROLESPEC_PUBLIC'}}]},'REVOKE TRUNCATE ON t FROM PUBLIC;')[0]=='CONDITIONAL'
    assert classify('DropStmt',{},'DROP FUNCTION f(uuid);')[0]=='BLOCKED'
    assert classify('CreateFunctionStmt',{},'CREATE FUNCTION f()...',True)[0]=='HIGH RISK'
    nested=nested_do("DO $$\nBEGIN\n EXECUTE format('DROP FUNCTION %s CASCADE','public.f()');\nEND $$;",10)
    assert len(nested)==1 and nested[0]['risk']=='BLOCKED' and nested[0]['line']==12
    assert trim_leading_comments('-- one\n/* outer /* inner */ */\nSELECT 1;')==len('-- one\n/* outer /* inner */ */\n')
    b=sql.encode(); start=raw.get('stmt_location',0); s=b[start:start+raw['stmt_len']].decode(); skip=trim_leading_comments(s)
    assert s[skip:].startswith('ALTER TABLE')
    print('PASS: 8 offline parser/classification assertions; no SQL executed')

if __name__=='__main__':
    self_test() if '--test' in sys.argv else build()
