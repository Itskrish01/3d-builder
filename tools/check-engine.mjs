/* ============================================================================
   Static check over src/engine: every name a module uses must be declared in
   it, imported by it, or a browser global — and no module may assign to one of
   its own imports. Both are silent at build time and loud at 3am.

   Run: node tools/check-engine.mjs
   ========================================================================== */
import fs from 'node:fs';
import * as acorn from 'acorn';
import { referencedNames, BROWSER_GLOBALS } from './analyze.mjs';

const DIR = new URL('../src/engine/', import.meta.url);
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));

const EXTRA_GLOBALS = new Set(['import', 'process', 'AbortController', 'queueMicrotask', 'Proxy', 'Reflect']);

let problems = 0;
const exportsOf = new Map();

function parse(src) {
  return acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module' });
}

/* pass 1 — what each module exports */
for (const f of files) {
  const ast = parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
  const names = new Set();
  for (const n of ast.body) {
    if (n.type !== 'ExportNamedDeclaration' || !n.declaration) continue;
    if (n.declaration.type === 'FunctionDeclaration') names.add(n.declaration.id.name);
    if (n.declaration.type === 'VariableDeclaration') {
      n.declaration.declarations.forEach((d) => names.add(d.id.name));
    }
  }
  exportsOf.set(f, names);
}

/* pass 2 — resolve every module against those exports */
for (const f of files) {
  const src = fs.readFileSync(new URL(f, DIR), 'utf8');
  const ast = parse(src);

  const bound = new Set();
  const imported = new Set();
  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') {
      for (const sp of n.specifiers) {
        bound.add(sp.local.name);
        imported.add(sp.local.name);
        if (sp.type !== 'ImportSpecifier') continue;
        const target = n.source.value.startsWith('./') ? n.source.value.slice(2) : null;
        if (!target) continue;
        if (!exportsOf.has(target)) {
          console.log(`  ${f}: imports from missing module ${n.source.value}`);
          problems++;
        } else if (!exportsOf.get(target).has(sp.imported.name)) {
          console.log(`  ${f}: ${sp.imported.name} is not exported by ${n.source.value}`);
          problems++;
        }
      }
      continue;
    }
    const decl = n.type === 'ExportNamedDeclaration' ? n.declaration : n;
    if (!decl) continue;
    if (decl.type === 'FunctionDeclaration' && decl.id) bound.add(decl.id.name);
    if (decl.type === 'VariableDeclaration') decl.declarations.forEach((d) => {
      if (d.id.type === 'Identifier') bound.add(d.id.name);
    });
  }

  const where = new Map();
  for (const name of referencedNames({ body: ast.body }, [...bound], where)) {
    if (BROWSER_GLOBALS.has(name) || EXTRA_GLOBALS.has(name)) continue;
    const line = src.slice(0, where.get(name) ?? 0).split('\n').length;
    console.log(`  ${f}:${line}: uses "${name}" but never declares or imports it`);
    problems++;
  }

  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && imported.has(n.left.name)) {
      console.log(`  ${f}: assigns to the imported binding "${n.left.name}"`);
      problems++;
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
}

console.log(problems ? `\n${problems} problem(s)` : `${files.length} engine modules, all references resolve`);
process.exit(problems ? 1 : 0);
