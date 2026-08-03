const fs = require('fs');
const ORDER = [
  'a01_head',
  'a02_body',
  'j01_state', 'n01_worldstate',
  'j02_shaders', 'n02_shaders',
  'j03_render',
  'j04_terrain', 'n03_terrain', 'n04_water',
  'j05_grass',
  'j06_field',
  'j07_history',
  'j08_presets',
  'n06_sketchfab', 'n07_import', 'n08_impassets',
  'n09_layers', 'n10_world', 'n11_roads', 'n12_actors', 'n13_select',
  'j09_ui', 'n14_ui2',
  'j10_panel', 'n15_panels', 'n18_library', 'n16_templates',
  'j11_input', 'n17_input2',
  'j12_loop'
];
const miss = [], parts = [];
// c01_css2 must land INSIDE the <style> block, not after it
for (const n of ORDER) {
  const p = 'src/' + n + '.txt';
  if (!fs.existsSync(p)) { miss.push(n); continue; }
  let body = fs.readFileSync(p, 'utf8').replace(/\n+$/, '');
  if (n === 'a01_head') {
    const css2 = fs.readFileSync('src/c01_css2.txt', 'utf8').replace(/\n+$/, '');
    body = body.replace('</style>', css2 + '\n</style>');
  }
  parts.push(body);
}
fs.writeFileSync('index.html', parts.join('\n') + '\n');
const s = fs.readFileSync('index.html', 'utf8');
const st = s.indexOf("<script>\n'use strict';") + '<script>\n'.length;
const en = s.lastIndexOf('</' + 'script>');
fs.writeFileSync('src/_check.js', s.slice(st, en));
if (miss.length) console.log('pending:', miss.join(' '));
console.log('index.html', (fs.statSync('index.html').size / 1024).toFixed(0) + 'KB', s.split('\n').length + ' lines');
