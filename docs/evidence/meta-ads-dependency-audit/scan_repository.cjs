/* Read-only source scan using TypeScript's parser. Does not import application
 * modules, execute SQL, run workers, or read ignored environment files. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ts = require('typescript');
const base = __dirname;
const root = path.resolve(base, '../../..');
const tables = JSON.parse(fs.readFileSync(path.join(base,'staging-tables.json'),'utf8')).map(x=>x.name);
const functions = JSON.parse(fs.readFileSync(path.join(base,'legacy-function-names.json'),'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(base,'migration-risk-statements.json'),'utf8'));
const otherDroppedFunctions = inventory.statements.filter(s=>s.kind==='DropStmt'&&s.details.removeType==='OBJECT_FUNCTION')
  .flatMap(s=>s.details.objects.map(o=>o.ObjectWithArgs?.objname?.at(-1)?.String?.sval).filter(Boolean));
const orphanNames=JSON.parse(fs.readFileSync(path.join(base,'surviving-legacy-function-references.json'),'utf8')).map(x=>x.name);
const targets = [...new Set([...tables,...functions,...otherDroppedFunctions,...orphanNames,'resolve_response_sla_on_sale_reply'])];
const helpers = new Set(['resolveResponseSlaOnSaleReply','authorizeAppointmentAccess','authorizeSurveyAccess','authorizeInstallationAccess','authorizeOrderAccess','authorizeContractAccess','authorizePaymentAccess','createAuthorizedSignedUrl','internalGetAuthorizedSignedUrlAction','getAuthorizedSignedUrlAction']);
const files = cp.execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const lexical = [], calls = [], imports = [], helperCalls = [], genericRpcCalls = [], dynamicCalls = [], skipped = [];
const rx = new RegExp('\\b(' + targets.join('|') + ')\\b','g');
function group(file) {
  if(file.startsWith('supabase/migrations/'))return 'migration';
  if(file.startsWith('docs/evidence/'))return 'prior_generated_evidence';
  if(file.startsWith('tests/')||file.includes('/test/')||file.includes('/tests/'))return 'test';
  if(file.endsWith('.md')||file.startsWith('docs/'))return 'documentation';
  if(file.startsWith('scripts/'))return 'script';
  if(file.includes('worker/')||file.startsWith('services/'))return 'worker_service';
  if(file.startsWith('app/'))return 'application_entrypoint';
  return 'library_or_configuration';
}
for(const file of files) {
  const full = path.join(root,file);
  if(!fs.statSync(full).isFile())continue;
  const bytes = fs.readFileSync(full);
  if(bytes.includes(0)){skipped.push(file);continue;}
  const source = bytes.toString('utf8');
  const lines = source.split('\n');
  for(let n=0;n<lines.length;n++) {
    const found=[...lines[n].matchAll(rx)].map(m=>m[1]);
    for(const target of new Set(found))lexical.push({target,file,line:n+1,group:group(file),text:lines[n].trim()});
  }
  if(!/\.(?:[cm]?js|jsx|ts|tsx)$/.test(file))continue;
  const sf = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const locate=n=>sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;
  function visit(n) {
    if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)) {
      const named=n.importClause?.namedBindings;
      imports.push({file,line:locate(n),module:n.moduleSpecifier.text,names:named&&ts.isNamedImports(named)?named.elements.map(e=>({imported:e.propertyName?.text||e.name.text,local:e.name.text})):[]});
    }
    if(ts.isCallExpression(n)) {
      if(ts.isIdentifier(n.expression)&&n.expression.text==='rpc'&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0])) {
        genericRpcCalls.push({file,line:locate(n),group:group(file),target:n.arguments[0].text,text:n.getText(sf)});
      }
      if(ts.isPropertyAccessExpression(n.expression)&&['from','rpc'].includes(n.expression.name.text)&&
        !['Array','Buffer','Uint8Array','Object'].includes(n.expression.expression.getText(sf))) {
        const method=n.expression.name.text;
        let arg=n.arguments[0];
        while(arg&&(ts.isAsExpression(arg)||ts.isTypeAssertionExpression(arg)||ts.isParenthesizedExpression(arg)))arg=arg.expression;
        if(arg&&ts.isStringLiteralLike(arg)) {
          if(targets.includes(arg.text)) {
            const payload=n.arguments[1];
            const keys=payload&&ts.isObjectLiteralExpression(payload)?payload.properties.map(p=>p.name?.getText(sf)).filter(Boolean):[];
            calls.push({file,line:locate(n.expression.name),group:group(file),method,target:arg.text,argument_keys:keys,text:n.getText(sf)});
          }
        } else dynamicCalls.push({file,line:locate(n.expression.name),method,receiver:n.expression.expression.getText(sf),expression:arg?.getText(sf),group:group(file)});
      }
      if(ts.isIdentifier(n.expression)&&helpers.has(n.expression.text))helperCalls.push({file,line:locate(n),callee:n.expression.text,group:group(file),text:n.getText(sf)});
    }
    ts.forEachChild(n,visit);
  }
  visit(sf);
}
const output={typescript_version:ts.version,tracked_files:files.length,binary_files_skipped:skipped,
  literal_query_and_rpc_calls:calls,helper_calls:helperCalls,generic_rpc_helper_calls:genericRpcCalls,
  dynamic_query_and_rpc_names:dynamicCalls,
  relevant_imports:imports.filter(i=>i.names.some(n=>helpers.has(n.imported))||/sensitive\/(?:signed-urls|action-handlers)|resource-access|response-sla-store/.test(i.module)),
  lexical_references:lexical,
  caveat:'Whole tracked text repository searched. Lexical matches include comments and unrelated uses (e.g. shared/contracts imports); literal from/rpc and helper-call AST records are stronger evidence. Dynamic names are explicit review items. Binary files were not text searched and are listed separately; this scan does not attest embedded or external compiled consumers.'};
fs.writeFileSync(path.join(base,'repository-references.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({tracked_files:files.length,literal_target_calls:calls.length,helper_calls:helperCalls.length,dynamic_query_or_rpc_names:dynamicCalls.length,lexical_matches:lexical.length}));
console.log('Runtime target calls:',calls.filter(c=>!['migration','test','documentation','prior_generated_evidence'].includes(c.group)).map(c=>`${c.file}:${c.line} ${c.method} ${c.target}`));
