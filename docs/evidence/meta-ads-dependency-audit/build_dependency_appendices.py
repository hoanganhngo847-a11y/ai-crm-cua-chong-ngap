"""Offline evidence join only. No database connections or SQL execution."""
from pathlib import Path
from collections import Counter
import json
import re

B=Path(__file__).resolve().parent
load=lambda n:json.loads((B/n).read_text())
inventory=load('migration-risk-statements.json')
refs=load('repository-references.json')
functions=load('legacy-pre-removal-functions.json')
live_functions=load('staging-legacy-functions.json')
tables=load('staging-tables.json')
counts={x['name']:x['exact_rows'] for x in load('staging-exact-counts.json')}
staging_sigs={x['name']:x for x in live_functions}
all_names={x['name'] for x in tables}

def table_refs(body):
    body=re.sub(r'/\*[\s\S]*?\*/|--[^\n]*',' ',body)
    return sorted(set(re.findall(r'\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+(?:public\.)?('+'|'.join(sorted(all_names))+r')\b',body,re.I)))

def function_name(o):
    e=o.get('ObjectWithArgs',{})
    return '.'.join(x['String']['sval'] for x in e.get('objname',[]))

by_table=[]
fk={}
for t in tables:
    name=t['name']; meta=load('staging-table-'+name+'.json')
    calls=[x for x in refs['literal_query_and_rpc_calls'] if x['method']=='from' and x['target']==name]
    static=[{'id':r['id'],'file':r['file'],'line':r['line'],'kind':r['kind'],'risk':r['risk']} for r in inventory['statements']
            if any(o in (name,'public.'+name) or o.startswith('public.'+name+'.') for o in r['affected_objects'])]
    functions_with_table=[{'name':f['name'],'signature':d['signature'],'file':d['file'],'line':d['line']}
                          for f in functions for d in f['pre_removal_definitions'] if name in table_refs(d['body'])]
    for c in meta.get('constraints') or []:
        if c['type']=='f':fk[(c['referencing_table'],c['name'])]=c
    by_table.append({'name':name,'staging_relation':t['relation'],'exact_rows':counts.get(name),'staging_metadata':meta,
                     'literal_application_and_test_queries':calls,'static_ddl_statements':static,
                     'pre_removal_functions_referencing_table':functions_with_table,
                     'evidence_limit':'Static DDL events are a timeline, not a claim that every historical index/policy/trigger survives to the deletion boundary. Recapture that catalog after approved predecessors.'})
(B/'legacy-table-dependency-inventory.json').write_text(json.dumps(by_table,ensure_ascii=False,indent=2)+'\n')

md=['# Legacy dependency inventory','','All 14 tables and all 33 dynamic function-name targets are included. Current catalog entries are distinct from objects introduced by pending migrations.','','## Tables','']
for t in by_table:
    m=t['staging_metadata'];md += ['### '+t['name'],'',f"Current staging: {'ABSENT' if not t['staging_relation'] else str(t['exact_rows'])+' exact rows'}.",'']
    for key in ['constraints','indexes','triggers','policies']:
        md += ['**'+key.capitalize()+'**','']
        for x in m.get(key) or []:
            definition=x.get('definition') or '; '.join(f'{k}={v}' for k,v in x.items() if k!='name')
            md.append('- `'+x['name']+'`: `'+str(definition).replace('`','\u0027')+'`')
        if not m.get(key):md.append('- None observed.')
        md.append('')
    md += ['**Literal query consumers**','']
    for x in t['literal_application_and_test_queries']:md.append(f"- `{x['file']}:{x['line']}` ({x['group']}).")
    if not t['literal_application_and_test_queries']:md.append('- None found; this does not cover clients outside the repository.')
    md += ['', '**Removed functions that reference this table before cleanup**','']
    for x in t['pre_removal_functions_referencing_table']:md.append(f"- `{x['signature']}` at `{x['file']}:{x['line']}`.")
    if not t['pre_removal_functions_referencing_table']:md.append('- No direct body reference in the 33-name removal set.')
    md.append('')
md += ['## Dynamic function targets','','Each name selects **all overloads** in public. The static canonical timeline has one matching overload per name at the removal boundary; live staging currently has 22 of them. A new externally created overload would also be selected, so the live set must be allowlisted before execution.','',
       '| Name / pre-removal signature | Live now | Last definition | Table references | Database function callers before removal | Repository RPC consumers |','| --- | --- | --- | --- | --- | --- |']
for f in functions:
    d=f['pre_removal_definitions'][0] if f['pre_removal_definitions'] else {}
    calls=[r for r in refs['literal_query_and_rpc_calls'] if r['target']==f['name']]
    callers=', '.join(x['signature'] for x in f['callers_before_removal']) or 'none textually found'
    md.append('| `'+d.get('signature',f['name'])+'` | '+('present' if f['name'] in staging_sigs else 'absent; pending')+' | `'+d.get('file','?')+':'+str(d.get('line','?'))+'` | '+', '.join(table_refs(d.get('body','')))+' | '+callers+' | '+(', '.join(x['file']+':'+str(x['line']) for x in calls) or 'none found')+' |')
(B/'LEGACY_DEPENDENCY_INVENTORY.md').write_text('\n'.join(md)+'\n')

graph=['flowchart LR','  subgraph Legacy[Current staging legacy tables]']
for name in sorted(all_names):graph.append(f'    {name}["{name}'+(' (absent)' if name=='company_bank_accounts' else '')+'"]')
graph += ['  end']
edges=set()
for c in fk.values():
    a=c['referencing_table'].removeprefix('public.'); b=c['referenced_table'].removeprefix('public.')
    edges.add((a,b))
for a,b in sorted(edges):graph.append(f'  {a} -->|FK| {b}')
graph += ['  qc["record_quality_check_atomic: survives cleanup"]','  qc -.-> orders','  qc -.-> production_orders','  qc -.-> ops["operations_actor / operations_audit: removed"]']
(B/'legacy-dependencies.mmd').write_text('\n'.join(graph)+'\n')

# One unchecked approval item per drop object / destructive ALTER subcommand.
approvals=[]
for r in inventory['statements']:
    if r['risk']!='BLOCKED':continue
    actions=[]
    if r['kind']=='DropStmt':
        for i,o in enumerate(r['details'].get('objects',[]),1):
            obj=function_name(o) or '.'.join(x.get('String',{}).get('sval','') for x in o.get('List',{}).get('items',[]))
            if 'ObjectWithArgs' in o:
                args=o['ObjectWithArgs'].get('objargs',[])
                obj+='('+','.join('.'.join(x['String']['sval'] for x in a['TypeName']['names']).removeprefix('pg_catalog.')+'[]'*len(a['TypeName'].get('arrayBounds',[])) for a in args)+')'
            actions.append((r['id']+f'.object{i}',r['line'],obj or str(o),r['sql']))
    elif r['kind']=='AlterTableStmt':
        for i,c in enumerate(r['details'].get('subcommands',[]),1):
            if 'Drop' in c['subtype'] or c['subtype'].startswith('AT_Disable'):
                actions.append((r['id']+f'.alter{i}',r['line'],','.join(r['affected_objects'])+' / '+c['subtype']+' / '+str(c.get('name','')),r['sql']))
    elif r['kind']=='DoStmt':
        if r['file']=='20261029160000_remove_legacy_flood_barrier_schema.sql':
            for i,f in enumerate(functions,1):
                sigs=[x['signature'] for x in f['pre_removal_definitions']]
                actions.append((r['id']+f'.function{i}',529,', '.join(sigs),"EXECUTE format('DROP FUNCTION %s CASCADE', f.signature); [restricted to this reviewed name/signature only]"))
        else:
            for i,op in enumerate(r['details']['nested_operations'],1):
                if op['risk']=='BLOCKED':actions.append((r['id']+f'.DO{i}',op['line'],'nested procedural operation',op['sql_or_dynamic_expression']))
    if not actions:actions=[(r['id'],r['line'],','.join(r['affected_objects']) or r['kind'],r['sql'])]
    for aid,line,obj,sql in actions:
        approvals.append({'id':aid,'file':r['file'],'line':line,'object':obj,'already_recorded_prefix':r['already_recorded_prefix'],'sql':sql,'status':'NOT APPROVED'})
(B/'destructive-approval-items.json').write_text(json.dumps(approvals,ensure_ascii=False,indent=2)+'\n')
approval_md=['# Individually approvable destructive actions','','All items are **NOT APPROVED**. This checklist grants no authority. Items in the recorded prefix are historical inventory only; do not replay them. For a combined statement all affected-object approvals are required. Dynamic name matching must not include any unreviewed overload.','']
for a in approvals:
    approval_md += [f"- [ ] **{a['id']}** — `{a['object']}`; `{a['file']}:{a['line']}`; {'historical prefix, no replay' if a['already_recorded_prefix'] else 'pending, blocked'}. Exact statement: `"+re.sub(r'\s+',' ',a['sql']).replace('`',"'")+'`']
(B/'DESTRUCTIVE_APPROVAL_CHECKLIST.md').write_text('\n'.join(approval_md)+'\n')

drops=[]
for r in inventory['statements']:
    if r['kind']!='DropStmt' or r['details'].get('removeType')!='OBJECT_FUNCTION':continue
    for o in r['details']['objects']:
        name=function_name(o).removeprefix('public.')
        drops.append({'id':r['id'],'file':r['file'],'line':r['line'],'sql':r['sql'],'function_name':name,
                      'literal_calls':[c for c in refs['literal_query_and_rpc_calls'] if c['target']==name],
                      'lexical_source_and_worker_references':[c for c in refs['lexical_references'] if c['target']==name and c['group'] not in ('migration','prior_generated_evidence','documentation','test')],
                      'required_action':'Compare each call parameter set with the later canonical definition before authorizing this replacement; tests are required after separate execution approval.'})
(B/'all-function-drop-consumers.json').write_text(json.dumps(drops,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'tables':len(by_table),'function_names':len(functions),'staging_unique_foreign_keys_touching_targets':len(fk),'approval_items':len(approvals),'pending_approval_items':sum(not a['already_recorded_prefix'] for a in approvals),'function_drop_targets':len(drops)}))
