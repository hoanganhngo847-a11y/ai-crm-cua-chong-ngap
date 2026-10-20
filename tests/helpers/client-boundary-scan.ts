import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Follow client imports, stopping only at real React Server Action boundaries. */
export function scanClientBoundaries(root: string, directories = ['app','components','features']) {
  const violations = new Set<string>();
  const visited = new Set<string>();
  const config = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
    allowJs: true, baseUrl: root, paths: {'@/*':['./*']} };
  function parse(file: string) {
    const text=fs.readFileSync(file,'utf8');
    const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    const directives: string[]=[];
    for(const statement of tree.statements) {
      if(!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      directives.push(statement.expression.text);
    }
    return {text,tree,directives};
  }
  function walk(file: string) {
    if(visited.has(file)) return;
    visited.add(file);
    const {tree,directives}=parse(file);
    if(directives.includes('use server') && !directives.includes('use client')) return;
    function resolve(specifier: string) {
      const resolved=ts.resolveModuleName(specifier,file,config,ts.sys).resolvedModule?.resolvedFileName;
      if(resolved && resolved.startsWith(root+path.sep) && !resolved.includes(`${path.sep}node_modules${path.sep}`) && /\.[jt]sx?$/.test(resolved)) walk(resolved);
    }
    function visit(node: ts.Node) {
      if(ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly ||
        (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
         node.importClause.namedBindings.elements.length>0 && node.importClause.namedBindings.elements.every(element=>element.isTypeOnly)))) return;
      if(ts.isExportDeclaration(node) && node.isTypeOnly) return;
      if((ts.isIdentifier(node) && ['createAdminClient','SUPABASE_SERVICE_ROLE_KEY'].includes(node.text)) ||
        ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^(?:server-only|SUPABASE_SERVICE_ROLE_KEY)$|lib\/supabase\/admin/.test(node.text))) {
        violations.add(`Forbidden privileged module in client import graph: ${path.relative(root,file)}`);
      }
      if((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) resolve(node.moduleSpecifier.text);
      if(ts.isCallExpression(node) && node.expression.kind===ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) resolve(node.arguments[0].text);
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  function scan(directory: string) {
    if(!fs.existsSync(directory)) return;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()) scan(file);
      else if(/\.[jt]sx?$/.test(entry.name)) {
        const {text,directives}=parse(file);
        // Raw keys must never appear in any app/component source, including server wrappers.
        if(text.includes('SUPABASE_SERVICE_ROLE_KEY') && (file.startsWith(path.join(root,'app')+path.sep) || file.startsWith(path.join(root,'components')+path.sep))) violations.add(`Raw service key reference in app/component: ${path.relative(root,file)}`);
        if(directives.includes('use client')) walk(file);
      }
    }
  }
  directories.forEach(directory=>scan(path.join(root,directory)));
  return [...violations];
}

/** Check executable queries, excluding policy prose/JSX that merely names tables. */
export function scanPrivateQueries(root: string, directories = ['app','components','features']) {
  const violations=new Set<string>();
  const protectedTable=/^(?:private\.)?(?:customer_private_contacts|interaction_raw_contents|call_transcripts)$/;
  const privateSql=/private\.(?:customer_private_contacts|interaction_raw_contents|call_transcripts)/;
  function scan(directory: string) {
    if(!fs.existsSync(directory)) return;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()) {scan(file);continue;}
      if(!/\.[jt]sx?$/.test(file)) continue;
      const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
      function visit(node: ts.Node) {
        if(ts.isCallExpression(node)) {
          const method=ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:ts.isIdentifier(node.expression)?node.expression.text:'';
          const argument=node.arguments[0];
          const literal=argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))?argument.text:'';
          if((method==='from' && protectedTable.test(literal)) ||
             (/^(?:query|exec|execute|executeSql|executeRawSql)$/.test(method) && privateSql.test(literal))) violations.add(path.relative(root,file));
        }
        if(ts.isTaggedTemplateExpression(node) && /(?:^|\.)sql$/.test(node.tag.getText(tree)) && privateSql.test(node.template.getText(tree))) violations.add(path.relative(root,file));
        ts.forEachChild(node,visit);
      }
      visit(tree);
    }
  }
  directories.forEach(directory=>scan(path.join(root,directory)));
  return [...violations];
}
