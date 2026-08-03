import { ui, emit } from './host.js';
import { QUALITY, Q, state } from './state.js';
import { markSceneDirty } from './persistence.js';
import { rebuildPlate, Terrain } from './terrain.js';
import { rebuildWater } from './water.js';
import { Grass } from './grass.js';
import { syncEnvUniforms } from './field.js';
import { cam, canvas } from './renderer.js';
import { Sel, clearSelection } from './selection.js';
import { roadSamples } from './roads.js';
import { cancelPending } from './input.js';

/* ============================================================================
   STATIONS

   Four of them. Only the identity of a station and its tools lives here —
   names, icons and help text are the UI's business, so they live in React.
   The engine's job is to know which tool a drag on the ground should run.
   ========================================================================== */

export var MODES = [
  { id: 'terrain', key: '1' },
  { id: 'place', key: '2' },
  { id: 'select', key: '3' }
];

/** The tools each station shows up front. The first one is its default. */
export var MODE_TOOLS = {
  terrain: ['raise', 'lower', 'smooth', 'flatten'],
  place: ['place_one', 'place_many', 'place_erase'],
  select: ['select']
};

/** Tools you reach for less often; same station, one panel deeper. */
export var EXTRA_TOOLS = {
  terrain: ['ramp', 'noise', 'erode'],
  place: [],
  select: []
};

/* Stations that no longer exist map onto the one that replaced them, so a
   world saved before the four-station redesign still opens somewhere sensible. */
export var LEGACY_MODES = { build: 'place', nature: 'place', people: 'place',
                            roads: 'terrain', grass: 'terrain' };

export function normalizeMode(id) {
  if (LEGACY_MODES[id]) return LEGACY_MODES[id];
  for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return id;
  return 'terrain';
}
export function modeDef(id) {
  for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
  return MODES[0];
}
export function allTools(mode) {
  return (MODE_TOOLS[mode] || []).concat(EXTRA_TOOLS[mode] || []);
}
export function modeHasTool(mode, id) {
  return allTools(mode).indexOf(id) >= 0;
}

/* Terrain keeps its brush in `sculpt.mode` because `tool` stays 'sculpt' for
   the whole station — the stroke code branches on the brush, not the station. */
export function currentTool() {
  return state.world.mode === 'terrain' ? state.sculpt.mode : state.tool;
}

export function setTool(id) {
  // Loading a world saved before the redesign restores a station and a tool
  // that no longer exist, and the scene loader calls this before anything has
  // had a chance to migrate them.
  var mode = state.world.mode = normalizeMode(state.world.mode);
  if (mode === 'terrain') {
    if (modeHasTool('terrain', id)) state.sculpt.mode = id;
    else if (!modeHasTool('terrain', state.sculpt.mode)) state.sculpt.mode = 'raise';
    state.tool = 'sculpt';
    if (state.plate.mode !== 'terrain') {
      state.plate.mode = 'terrain';
      rebuildPlate();
    }
  } else {
    state.tool = modeHasTool(mode, id) ? id : MODE_TOOLS[mode][0];
  }
  if (state.tool !== 'select') clearSelection();
  cancelPending();
  if (canvas) canvas.classList.remove('cam');
  markSceneDirty();
  emit('mode');
}

export function setMode(id) {
  id = normalizeMode(id);
  if (state.world.mode === id) return;
  state.world.mode = id;
  cancelPending();
  if (id !== 'select') clearSelection();
  if (id === 'terrain') {
    state.tool = 'sculpt';
    if (!modeHasTool('terrain', state.sculpt.mode)) state.sculpt.mode = 'raise';
    if (state.plate.mode !== 'terrain') { state.plate.mode = 'terrain'; rebuildPlate(); }
  } else {
    state.tool = MODE_TOOLS[id][0];
  }
  markSceneDirty();
  emit('mode');
}

export function cycleTool() {
  var list = allTools(state.world.mode);
  if (!list.length) return;
  var i = list.indexOf(currentTool());
  setTool(list[(i + 1) % list.length]);
}

/* ============================================================================
   CAMERA FRAMING
   ========================================================================== */

/** F frames whatever is selected, falling back to the whole world. */
export function focusSelection() {
  if (Sel.road) {
    var sp = roadSamples(Sel.road);
    if (sp.length) {
      var mid = sp[(sp.length / 2) | 0];
      cam.focusOn(mid.x, mid.y, mid.z, Math.max(Sel.road.width * 2, 12));
      return;
    }
  }
  if (Sel.objs.length) {
    var mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
    for (var i = 0; i < Sel.objs.length; i++) {
      var o = Sel.objs[i], rr = o.radius * o.scale, hh = o.height * o.scale;
      mnx = Math.min(mnx, o.x - rr); mxx = Math.max(mxx, o.x + rr);
      mnz = Math.min(mnz, o.z - rr); mxz = Math.max(mxz, o.z + rr);
      mny = Math.min(mny, o.y); mxy = Math.max(mxy, o.y + hh);
    }
    cam.focusOn((mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2,
      Math.max(mxx - mnx, mxy - mny, mxz - mnz) * 0.6 + 1);
    return;
  }
  frameWorld();
}

export function frameWorld() {
  cam.frame(state.plate.width, state.plate.depth, Terrain.max);
}

/* ============================================================================
   WORLD-WIDE SWITCHES
   ========================================================================== */

/** One control that moves draw distance, grass density and animation together. */
export function setQuality(q) {
  if (!QUALITY[q]) return;
  state.world.quality = q;
  Grass.mat.uniforms.uDensity.value = state.grass.density * Q().grass;
  syncEnvUniforms();
  rebuildWater();
  markSceneDirty();
  emit('env');
}

/** Freeze wind, water, people and traffic together, for a clean screenshot. */
export function toggleSimulate() {
  state.world.simulate = !state.world.simulate;
  syncEnvUniforms();
  markSceneDirty();
  emit('env');
  ui.toast(state.world.simulate ? 'Everything is moving again' : 'Everything is frozen');
}
