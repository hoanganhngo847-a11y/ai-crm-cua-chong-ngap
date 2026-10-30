"""Pure file/evidence checks. No SQL or application module execution."""
from pathlib import Path
from collections import Counter
import hashlib
import json
import re

B=Path(__file__).resolve().parent
ROOT=B.parents[2]
load=lambda n:json.loads((B/n).read_text())
inv=load('migration-risk-statements.json')
assert inv['migration_count']==len(inv['migrations'])==116
assert inv['statement_count']==len(inv['statements'])==2277
assert dict(Counter(r['risk'] for r in inv['statements']))==inv['risk_counts']
assert dict(Counter(r['risk'] for r in inv['statements'] if not r['already_recorded_prefix']))==inv['pending_risk_counts']
for m in inv['migrations']:
    assert hashlib.sha256((ROOT/'supabase/migrations'/m['file']).read_bytes()).hexdigest()==m['sha256']
for r in inv['statements']:
    line=(ROOT/'supabase/migrations'/r['file']).read_text().splitlines()[r['line']-1]
    assert line.strip() and not line.lstrip().startswith('--'),r['id']
assert len(load('legacy-table-dependency-inventory.json'))==14
assert len(load('legacy-pre-removal-functions.json'))==33
assert len(load('staging-legacy-functions.json'))==22
assert len(load('staging-cascade-candidates.json'))==472
assert len(load('destructive-approval-items.json'))==176
assert sum(not a['already_recorded_prefix'] for a in load('destructive-approval-items.json'))==158
assert all(a['status']=='NOT APPROVED' for a in load('destructive-approval-items.json'))
assert len(load('staging-exact-counts.json'))==13
assert all(t['exact_rows']==0 for t in load('staging-exact-counts.json'))
assert json.loads((ROOT/'docs/evidence/meta-ads-staging/staging-prefix-catalog.json').read_text())==load('staging-catalog-recheck.json')
report=ROOT/'docs/META_ADS_STAGING_DESTRUCTIVE_DEPENDENCY_AUDIT.md'
for target in re.findall(r'\]\(([^)]+)\)',report.read_text()):
    if not target.startswith('http'):
        assert (report.parent/target.split('#')[0]).exists(),target
for name in load('legacy-function-names.json'):
    assert name in report.read_text(),name
files=[report]+[p for p in B.rglob('*') if p.is_file()]
for p in files:
    assert not re.search(r'sbp_[A-Za-z0-9]{15,}|sb_secret_[A-Za-z0-9]{15,}|eyJ[A-Za-z0-9_-]{20,}\.',p.read_text()),p
result={'status':'PASS','source_commit':'48aab3388f69ecd9dd0f8da5546dfb8e25752e22',
        'checks':['116 migration source hashes','2277 executable statement start lines','risk totals and pending counts',
                  '14 target tables / 33 dynamic function names / 22 live functions','472 catalog candidate objects',
                  '176 unapproved destructive items / 158 pending','13 current exact zero-row counts',
                  'staging catalog matches canonical prefix capture','report file links / all 33 names',
                  'credential-pattern scan'],
        'database_writes':0,'business_mutation_tests_run':False,
        'regression_database_tests':'Proposed only; execution requires separate approval.'}
(B/'validation-results.json').write_text(json.dumps(result,indent=2)+'\n')
print('PASS: all audit evidence/file consistency checks; no SQL executed')
