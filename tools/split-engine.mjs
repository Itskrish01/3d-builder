/* ============================================================================
   Splits the legacy single-closure engine into ES modules.

   The legacy build concatenated 29 fragments inside one `__GP_MAIN__` function,
   so every symbol saw every other symbol. This walks the real syntax tree,
   works out which module owns each of the ~520 top-level symbols, and writes
   the imports that the code actually needs — rather than a human guessing at
   500 references and getting some of them wrong.

   Run: node tools/split-engine.mjs
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { readFile, topLevelDecls, referencedNames, BROWSER_GLOBALS } from './analyze.mjs';

const OUT = new URL('../src/engine/', import.meta.url);

/* ---------------------------------------------------------------------------
   Which legacy fragment ends up in which module. Two fragments mapping to the
   same module are concatenated in this order.
   -------------------------------------------------------------------------- */
const MAP = [
  ['j01_state:math', 'util.js'],
  ['j01_state:state', 'state.js'],
  ['n01_worldstate', 'state.js'],
  ['j02_shaders', 'shaders.js'],
  ['n02_shaders', 'shaders.js'],
  ['j03_render', 'renderer.js'],
  ['j04_terrain', 'terrain.js'],
  ['n03_terrain', 'terrain.js'],
  ['n04_water', 'water.js'],
  ['j05_grass', 'grass.js'],
  ['j06_field', 'field.js'],
  ['j07_history', 'history.js'],
  ['j08_presets:presets', 'presets.js'],
  ['j08_presets:persist', 'persistence.js'],
  ['n06_sketchfab', 'sketchfab.js'],
  ['n07_import', 'gltf.js'],
  ['n08_impassets', 'assets.js'],
  ['n09_layers', 'layers.js'],
  ['n10_world', 'world.js'],
  ['n11_roads', 'roads.js'],
  ['n12_actors', 'actors.js'],
  ['n13_select', 'selection.js'],
  ['n16_templates', 'templates.js'],
  ['j11_input', 'input.js'],
  ['n17_input2', 'input.js'],
  ['j12_loop', 'loop.js']
];

/* ---------------------------------------------------------------------------
   Calls into the old DOM UI, rewritten onto the host bridge.

   Nine of the ten imperative "go and repaint that bit of the page" helpers
   collapse into a single `emit(topic)`: React re-reads engine state itself, so
   the engine only has to say what changed, not who should redraw.
   -------------------------------------------------------------------------- */
const REWRITE = [
  [/\btoast\(/g, 'ui.toast('],
  [/\bflashSaved\(\)/g, "emit('saved')"],
  [/\brefreshUI\(\)/g, "emit('state')"],
  [/\brefreshSelectionUI\(\)/g, "emit('selection')"],
  [/\brefreshHint\(\)/g, "emit('mode')"],
  [/\bupdateBladeMeter\(\)/g, "emit('stats')"],
  [/\brefreshHistoryButtons\(\)/g, "emit('history')"],
  [/\brefreshTopExtras\(\)/g, "emit('env')"],
  [/\bbuildRail\(\); *buildPanel\(\);/g, "emit('scene');"],
  [/\bbuildPanel\(\)/g, "emit('scene')"],
  [/\bbuildRail\(\)/g, "emit('scene')"],
  [/\baskClear\(\)/g, 'ui.askClearGrass()'],
  [/\bshowShortcuts\(\)/g, 'ui.showShortcuts()'],
  // Escape is owned by the UI first: it closes a tour or a dialog before the
  // engine gets to cancel a drag or drop a selection.
  [/if \(Tour\.on\) \{ endTour\(\); return; \}\n\s*if \(_modal\) \{ closeModal\(\); return; \}/g,
    'if (ui.escape()) return;']
];

/* Modules written by hand (they carry the parts of the old UI files that are
   genuinely engine work) and the symbols they export. */
const HAND_WRITTEN = {
  'host.js': ['emit', 'on', 'ui', 'setUiAdapter'],
  'modes.js': [
    'MODES', 'MODE_TOOLS', 'EXTRA_TOOLS', 'LEGACY_MODES', 'normalizeMode', 'modeDef',
    'allTools', 'modeHasTool', 'currentTool', 'setTool', 'setMode', 'focusSelection',
    'frameWorld', 'setQuality', 'toggleSimulate'
  ],
  'thumbnails.js': ['Thumbs', 'initThumbs', 'renderThumb', 'drawGroupSwatch'],
  'library.js': ['Browser', 'importFromSketchfab', 'rescaleKind', 'reswayKind', 'removeFromLibrary']
};

/* Definitions that a later fragment redefines. The legacy build relied on
   hoisting so that the last one won; here the dead ones are simply deleted. */
const DROP = {
  n16_templates: ['showTemplates'],
  j12_loop: ['boot', 'loop'],
  // Reached into the DOM to grey out two buttons. React derives that from
  // History.undo.length, so only the `emit('history')` call sites survive.
  j07_history: ['refreshHistoryButtons'],
  j04_terrain: ['terrainSegs', 'computeTerrainHeights', 'sculptStamp'],
  j11_input: [
    'effectiveTool', 'isPaintTool', 'bindInput', 'onKeyDown', 'nudgeRadius',
    '_strokeTool', '_lastStampTime', 'startStroke', 'endCurrentStroke', 'strokeTo', 'strokeAt'
  ]
};

/* Symbols that belonged to the old DOM UI and have no place in the engine.
   Anything still referencing one of these is reported so it can be rewritten
   against the host bridge instead of silently compiling to a runtime error. */
const UI_ONLY = new Set([
  'UI', 'el', 'svgIcon', 'openModal', 'closeModal', '_modal', 'confirmDialog', 'initTooltips',
  'refreshUI', 'buildPanel', 'buildRail', 'buildTopExtras', 'refreshTopExtras', 'refreshHint',
  'refreshSelectionUI', 'refreshHistoryButtons', 'updateBladeMeter', 'paintWorldReadout',
  'askClear', 'showShortcuts', 'showSketchfabBrowser', 'showTemplates', 'showHelp',
  'startTour', 'endTour', 'Tour', 'flashSaved', 'refreshToolButtons', 'refreshLibraryUI',
  'applyDetail', 'toast'
]);

/* ---------------------------------------------------------------------------
   Fragment preprocessing
   -------------------------------------------------------------------------- */
function fragment(key) {
  const [file, part] = key.split(':');
  let src = readFile(file);

  if (file === 'j01_state') {
    const cut = src.indexOf('   2. MATH');
    const head = src.lastIndexOf('/* ==========', cut);
    src = part === 'math' ? src.slice(head) : src.slice(0, head);
  }
  if (file === 'j08_presets') {
    const cut = src.indexOf('function applyPreset');
    const end = src.indexOf('/* ==========', cut);
    src = part === 'presets' ? src.slice(0, end) : src.slice(end);
  }
  // The shortcut table is reference material for a help dialog, not engine code.
  if (file === 'n17_input2') src = src.slice(0, src.indexOf('/* ---- shortcut list'));
  // Templates only need the road defaults; the helper lived in a UI file
  // because that is where road *types* were picked, but it is roads' business.
  if (file === 'n11_roads') src += '\n' + extract('n14_ui2', 'applyRoadTypeDefaults');

  if (DROP[file]) src = removeDeclarations(src, DROP[file]);
  return src;
}

/* Lifts one whole function declaration out of a fragment, by span. */
function extract(file, name) {
  const src = readFile(file);
  for (const node of parse(src).body) {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
      return src.slice(node.start - OFFSET, node.end - OFFSET);
    }
  }
  throw new Error(`extract: ${name} not found in ${file}`);
}

/* Deletes top-level declarations by span, using the parser rather than a
   brace-counting guess. A `var a = 1, b = 2;` goes only if every name in it is
   being dropped, so a half-deleted statement can never be emitted. */
function removeDeclarations(src, names) {
  const wanted = new Set(names);
  const spans = [];
  for (const node of parse(src).body) {
    if (node.type === 'FunctionDeclaration' && node.id && wanted.has(node.id.name)) {
      spans.push([node.start, node.end]);
    } else if (node.type === 'VariableDeclaration' &&
               node.declarations.every((d) => d.id.type === 'Identifier' && wanted.has(d.id.name))) {
      spans.push([node.start, node.end]);
    }
  }
  let out = src;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start - OFFSET) + out.slice(end - OFFSET);
  }
  return out;
}
const OFFSET = 'function __wrap__(){\n'.length;
function parse(src) {
  return acorn.parse(`function __wrap__(){\n${src}\n}`, { ecmaVersion: 2022 }).body[0].body;
}

/* ---------------------------------------------------------------------------
   Build
   -------------------------------------------------------------------------- */
const modules = new Map();          // file -> { fragments: [], decls: Set }
for (const [key, mod] of MAP) {
  if (!modules.has(mod)) modules.set(mod, { fragments: [], decls: new Set() });
  const src = fragment(key);
  modules.get(mod).fragments.push(src);
  for (const d of topLevelDecls(parse(src))) modules.get(mod).decls.add(d);
}

const owner = new Map();            // symbol -> module file
for (const [mod, m] of modules) for (const d of m.decls) owner.set(d, mod);
for (const [mod, syms] of Object.entries(HAND_WRITTEN)) for (const s of syms) owner.set(s, mod);

/* ---------------------------------------------------------------------------
   Emit
   -------------------------------------------------------------------------- */
fs.mkdirSync(OUT, { recursive: true });
const report = { modules: [], uiRefs: new Map(), unresolved: new Map() };

for (const [mod, m] of modules) {
  let src = m.fragments.join('\n');
  for (const [from, to] of REWRITE) src = src.replace(from, to);
  let body;
  try {
    body = parse(src);
  } catch (e) {
    const lines = src.split('\n');
    console.error(`PARSE FAIL in ${mod}: ${e.message}`);
    console.error(lines.slice(Math.max(0, e.loc.line - 4), e.loc.line + 2).join('\n'));
    throw e;
  }
  const refs = referencedNames(body, [...m.decls]);

  const needed = new Map();         // module -> Set(symbol)
  const uiHits = new Set();
  for (const r of refs) {
    if (m.decls.has(r) || BROWSER_GLOBALS.has(r)) continue;
    if (r === 'emit' || r === 'ui') continue;
    if (UI_ONLY.has(r)) { uiHits.add(r); continue; }
    const from = owner.get(r);
    if (!from) {
      if (!report.unresolved.has(r)) report.unresolved.set(r, new Set());
      report.unresolved.get(r).add(mod);
      continue;
    }
    if (from === mod) continue;
    if (!needed.has(from)) needed.set(from, new Set());
    needed.get(from).add(r);
  }
  if (uiHits.size) report.uiRefs.set(mod, [...uiHits]);

  const imports = [];
  if (refs.has('THREE')) imports.push("import * as THREE from 'three';");
  // The rewrites above introduce `emit`/`ui`, so their import is added here
  // rather than being discovered as a free identifier.
  const hostBits = ['emit', 'ui'].filter((h) => new RegExp('\\b' + h + '\\b').test(src));
  if (hostBits.length && mod !== 'host.js') imports.push(`import { ${hostBits.join(', ')} } from './host.js';`);
  for (const from of [...needed.keys()].sort()) {
    const syms = [...needed.get(from)].sort();
    imports.push(`import { ${syms.join(', ')} } from './${from}';`);
  }

  const out = imports.join('\n') + '\n\n' + exportDeclarations(src, m.decls) + '\n';
  fs.writeFileSync(new URL(mod, OUT), out);
  report.modules.push([mod, out.split('\n').length, imports.length]);
}

/* Prefix every top-level declaration with `export`, walking the tree backwards
   so earlier offsets stay valid. */
function exportDeclarations(src, decls) {
  const body = parse(src);
  const spots = [];
  for (const node of body.body) {
    if (node.type === 'FunctionDeclaration' && node.id && decls.has(node.id.name)) {
      spots.push(node.start - OFFSET);
    } else if (node.type === 'VariableDeclaration' &&
               node.declarations.some((d) => d.id.type === 'Identifier' && decls.has(d.id.name))) {
      spots.push(node.start - OFFSET);
    }
  }
  let out = src;
  for (const at of spots.sort((a, b) => b - a)) out = out.slice(0, at) + 'export ' + out.slice(at);
  return out;
}

console.log('=== modules written ===');
for (const [mod, lines, imps] of report.modules) {
  console.log('  ' + mod.padEnd(18) + String(lines).padStart(5) + ' lines  ' + imps + ' imports');
}
console.log('\n=== references to the old DOM UI (rewrite these by hand) ===');
for (const [mod, syms] of report.uiRefs) console.log('  ' + mod.padEnd(18) + syms.join(' '));
console.log('\n=== unresolved ===');
for (const [sym, mods] of report.unresolved) console.log('  ' + sym.padEnd(24) + [...mods].join(' '));
if (!report.unresolved.size) console.log('  (none)');
