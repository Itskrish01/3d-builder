/* Reads the legacy concatenated sources and reports the symbol graph, so the
   split into ES modules is driven by what the code actually references rather
   than by guesswork. Run: node tools/analyze.mjs */
import fs from 'node:fs';
import * as acorn from 'acorn';

export const ORDER = [
  'j01_state', 'n01_worldstate',
  'j02_shaders', 'n02_shaders',
  'j03_render',
  'j04_terrain', 'n03_terrain', 'n04_water',
  'j05_grass', 'j06_field', 'j07_history', 'j08_presets',
  'n06_sketchfab', 'n07_import', 'n08_impassets',
  'n09_layers', 'n10_world', 'n11_roads', 'n12_actors', 'n13_select',
  'j09_ui', 'n14_ui2', 'j10_panel', 'n15_panels', 'n18_library', 'n16_templates',
  'j11_input', 'n17_input2', 'j12_loop'
];

/* Everything below is UI: it is being replaced by React and must not end up in
   the engine. Anything an engine module calls that lives here has to become
   part of the host bridge instead. */
export const UI_FILES = new Set(['j09_ui', 'n14_ui2', 'j10_panel', 'n15_panels', 'n18_library']);

export const BROWSER_GLOBALS = new Set([
  'window', 'document', 'navigator', 'console', 'localStorage', 'indexedDB', 'performance',
  'fetch', 'Promise', 'Math', 'JSON', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Error', 'RegExp', 'Map', 'Set', 'WeakMap', 'Symbol', 'parseInt', 'parseFloat', 'isFinite',
  'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'atob', 'btoa',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'Blob', 'File', 'FileReader', 'URL', 'Image', 'ImageData',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'Event', 'CustomEvent', 'DOMParser',
  'TextEncoder', 'TextDecoder', 'structuredClone', 'globalThis', 'undefined', 'NaN', 'Infinity',
  'THREE', 'arguments', 'self', 'HTMLCanvasElement', 'CSSRule', 'matchMedia', 'alert'
]);

/* The legacy build wraps everything in one `__GP_MAIN__` function so that no
   statement can run before the CDN copy of three.js has landed. Modules make
   that unnecessary, so the wrapper (and the HTML tail after it) is stripped. */
export function readFile(name) {
  let s = fs.readFileSync(new URL(`../legacy/src/${name}.txt`, import.meta.url), 'utf8');
  if (name === 'j01_state') s = s.replace(/function __GP_MAIN__\(\)\s*\{/, '');
  if (name === 'j12_loop') s = s.slice(0, s.indexOf('boot();'));
  return s;
}

/* The legacy files are fragments of one function body, so they only parse as a
   whole. Wrapping each one in a function gives acorn a valid program while
   keeping every declaration at what is, for our purposes, top level. */
function parseFragment(src) {
  return acorn.parse(`function __wrap__(){\n${src}\n}`, { ecmaVersion: 2022 }).body[0].body;
}

export function topLevelDecls(body) {
  const out = [];
  for (const node of body.body) {
    if (node.type === 'FunctionDeclaration' && node.id) out.push(node.id.name);
    else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') out.push(d.id.name);
      }
    }
  }
  return out;
}

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw']);

function collectPattern(node, into) {
  if (!node) return;
  if (node.type === 'Identifier') into.add(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach((p) => collectPattern(p.value || p.argument, into));
  else if (node.type === 'ArrayPattern') node.elements.forEach((e) => collectPattern(e, into));
  else if (node.type === 'AssignmentPattern') collectPattern(node.left, into);
  else if (node.type === 'RestElement') collectPattern(node.argument, into);
}

/* Every name a function scope binds. The legacy engine is pure ES5 — only
   `var`, `function` and parameters — so walking the body without descending
   into nested functions gives the exact set, not an approximation. */
function bindingsOf(fn) {
  const names = new Set();
  (fn.params || []).forEach((p) => collectPattern(p, names));
  if (fn.type === 'FunctionExpression' && fn.id) names.add(fn.id.name);
  (function scan(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration') { if (n.id) names.add(n.id.name); return; }
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return;
    if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => collectPattern(d.id, names));
    if (n.type === 'CatchClause') collectPattern(n.param, names);
    for (const k in n) {
      if (SKIP_KEYS.has(k)) continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v.type === 'string') scan(v);
    }
  })(fn.body);
  return names;
}

/* Identifiers the fragment reads but never binds — i.e. exactly the things it
   has to import. Property keys and non-computed member accesses are skipped,
   and every function introduces a scope, so locals never leak into the result. */
export function referencedNames(body, topLevel = [], positions = new Map()) {
  const free = new Set();
  (function visit(node, stack) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier':
        if (!stack.some((s) => s.has(node.name))) { free.add(node.name); positions.set(node.name, positions.get(node.name) ?? node.start); }
        return;
      case 'MetaProperty':        // import.meta — neither half is a reference
      case 'ImportDeclaration':   // specifiers bind names, they do not use them
      case 'ExportSpecifier':
        return;
      case 'MemberExpression':
        visit(node.object, stack);
        if (node.computed) visit(node.property, stack);
        return;
      case 'Property':
        if (node.computed) visit(node.key, stack);
        visit(node.value, stack);
        return;
      case 'LabeledStatement':
        visit(node.body, stack);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visit(node.body, stack.concat([bindingsOf(node)]));
        return;
      default:
        for (const k in node) {
          if (SKIP_KEYS.has(k)) continue;
          const v = node[k];
          if (Array.isArray(v)) v.forEach((c) => visit(c, stack));
          else if (v && typeof v.type === 'string') visit(v, stack);
        }
    }
  })({ type: 'Program', body: body.body }, [new Set(topLevel)]);
  return free;
}

if (process.argv[1] && process.argv[1].endsWith('analyze.mjs')) {
  const owners = new Map();       // symbol -> [files that declare it]
  const decls = new Map();        // file -> Set(symbols)
  const refs = new Map();         // file -> Set(symbols)

  for (const name of ORDER) {
    const body = parseFragment(readFile(name));
    const d = topLevelDecls(body);
    decls.set(name, new Set(d));
    refs.set(name, referencedNames(body, d));
    for (const s of d) {
      if (!owners.has(s)) owners.set(s, []);
      owners.get(s).push(name);
    }
  }

  console.log('=== symbols declared more than once (last one wins today) ===');
  for (const [sym, files] of owners) if (files.length > 1) console.log(' ', sym.padEnd(24), files.join(' -> '));

  const uiSymbols = new Set();
  for (const f of UI_FILES) for (const s of decls.get(f)) uiSymbols.add(s);

  console.log('\n=== engine -> UI references (these become the host bridge) ===');
  const needed = new Map();
  for (const name of ORDER) {
    if (UI_FILES.has(name)) continue;
    for (const r of refs.get(name)) {
      if (!uiSymbols.has(r)) continue;
      if (decls.get(name).has(r)) continue;
      if (!needed.has(r)) needed.set(r, []);
      needed.get(r).push(name);
    }
  }
  for (const [sym, files] of [...needed].sort()) console.log(' ', sym.padEnd(24), files.join(' '));

  console.log('\n=== unresolved (not declared anywhere, not a known global) ===');
  const all = new Set(owners.keys());
  const unresolved = new Map();
  for (const name of ORDER) {
    for (const r of refs.get(name)) {
      if (all.has(r) || BROWSER_GLOBALS.has(r)) continue;
      if (!unresolved.has(r)) unresolved.set(r, new Set());
      unresolved.get(r).add(name);
    }
  }
  for (const [sym, files] of [...unresolved].sort()) console.log(' ', sym.padEnd(24), [...files].join(' '));
}
