import * as THREE from 'three';
import { ASSETS } from './assets.js';
import { Grass, resnapRegion } from './grass.js';
import { recordOp } from './history.js';
import { Layers, disposeEmptyLayers, layerFor } from './layers.js';
import { Roads, addRoadRecord, applyRoadRecords, nearestRoadPoint, rebuildAllRoads, removeRoadById, roadCovers } from './roads.js';
import { Q, state } from './state.js';
import { Terrain, applyTerrainPatch, heightAt, normalAt, normalYAt, recomputeTerrainBounds, sculptCellRect, sculptWrite, updateGroundVerts } from './terrain.js';
import { DEG, TAU, clamp, lerp, rnd, smoothstep } from './util.js';
import { Water, underWater } from './water.js';

/* ==========================================================================
   21. WORLD OBJECTS
   --------------------------------------------------------------------------
   One registry for everything that is not terrain, grass or road geometry.
   Each record knows which instance layers and slots render it — an imported
   model has one slot per merged material — so selection, undo, save/load and
   culling all operate on the same objects.
   ========================================================================== */
export var World = {
  objs: [],
  byId: {},
  nextId: 1,
  roads: [],
  paths: [],
  prefabs: [],
  // The Explorer's tree. Objects point at a folder by id; see hierarchy.js.
  folders: [],
  nextFolderId: 1
};

export var CATS = ['terrain', 'grass', 'roads', 'buildings', 'nature', 'props', 'people', 'vehicles'];
export var CAT_OF = { building: 'buildings', nature: 'nature', prop: 'props', person: 'people', vehicle: 'vehicles' };
export var CAT_COLOR = {
  terrain: '#8a7a4a', grass: '#7ed957', roads: '#9aa4ad', buildings: '#d8a45c',
  nature: '#4b9a3a', props: '#6f9fd4', people: '#e07a9c', vehicles: '#c9645a'
};
export var LayerState = {};
(function () { for (var i = 0; i < CATS.length; i++) LayerState[CATS[i]] = { vis: true, lock: false }; })();

export function catVisible(assetKind) { var c = CAT_OF[assetKind] || 'props'; return LayerState[c].vis; }
export function catLocked(cat) { return LayerState[cat] && LayerState[cat].lock; }

export function applyLayerVisibility() {
  for (var i = 0; i < Layers.list.length; i++) {
    var L = Layers.list[i];
    L.mesh.visible = ASSETS[L.kind] ? catVisible(ASSETS[L.kind].kind) : false;
  }
  Grass.mesh.visible = LayerState.grass.vis;
  Terrain.mesh.visible = LayerState.terrain.vis;
  if (Roads.group) Roads.group.visible = LayerState.roads.vis;
  if (Water.mesh) Water.mesh.visible = LayerState.terrain.vis && !!state.plate.water && Q().water > 0;
}

/* ---- transforms ---------------------------------------------------------- */
export var _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion();
export var _upV = new THREE.Vector3(0, 1, 0), _nV = new THREE.Vector3();

export function computeQuat(o) {
  _qA.setFromAxisAngle(_upV, o.rotY);
  if (o.align > 0.001 && state.plate.mode === 'terrain') {
    normalAt(o.x, o.z, _nV);
    _qB.setFromUnitVectors(_upV, _nV);
    _qC.set(0, 0, 0, 1).slerp(_qB, clamp(o.align, 0, 1));
    _qA.premultiply(_qC);
  }
  o.qx = _qA.x; o.qy = _qA.y; o.qz = _qA.z; o.qw = _qA.w;
}

export function pushObject(o) {
  o.idx = World.objs.length;
  World.objs.push(o);
  World.byId[o.id] = o;
  ogridAdd(o);
}
export function popObject(o) {
  var last = World.objs.length - 1;
  if (o.idx !== last) { World.objs[o.idx] = World.objs[last]; World.objs[o.idx].idx = o.idx; }
  World.objs.pop();
  delete World.byId[o.id];
  ogridRemove(o);
}

/* ---- creation ------------------------------------------------------------ */
export function makeObject(kind, x, z, opt) {
  opt = opt || {};
  var def = ASSETS[kind];
  if (!def) return null;
  var seed = (opt.seed === undefined) ? Math.floor(rnd() * 1e9) : opt.seed;
  var o = {
    id: opt.id || World.nextId++,
    kind: kind,
    cat: CAT_OF[def.kind] || 'props',
    seed: seed,
    x: x, z: z, y: 0,
    rotY: opt.rotY === undefined ? 0 : opt.rotY,
    scale: (opt.scale === undefined ? 1 : opt.scale) * (def.scale || 1),
    align: opt.align === undefined ? 0 : opt.align,
    tint: opt.tint ? opt.tint.slice() : [1, 1, 1],
    tintCustom: !!opt.tint,
    sway: def.sway === undefined ? 0 : def.sway,
    pose: 0,
    phase: opt.phase === undefined ? rnd() * TAU : opt.phase,
    rate: opt.rate === undefined ? 0 : opt.rate,
    sel: false,
    radius: def.radius || 1,
    height: def.height || 1,
    folder: opt.folder || 0,
    name: opt.name || '',
    yOff: opt.yOff || 0,
    slots: []
  };
  if (World.nextId <= o.id) World.nextId = o.id + 1;
  o.sx = o.sy = o.sz = o.scale;
  o.y = surfaceOrTerrainY(o) + o.yOff;
  computeQuat(o);
  return o;
}

export function surfaceOrTerrainY(o) { return heightAt(o.x, o.z); }

/* An imported model spans several layers; the record keeps a slot in each. */
export function attachObject(o) {
  var def = ASSETS[o.kind];
  if (!def) return o;
  o.slots = [];
  for (var p = 0; p < def.parts.length; p++) {
    var L = layerFor(o.kind, p);
    var slot = L.alloc(o);
    o.slots[p] = slot;
    L.write(slot, o);
  }
  return o;
}
export function detachObject(o) {
  var def = ASSETS[o.kind];
  if (!def || !o.slots) return;
  for (var p = def.parts.length - 1; p >= 0; p--) {
    var L = Layers.map[o.kind + '#' + p];
    if (L && o.slots[p] !== undefined && o.slots[p] >= 0) L.remove(o.slots[p]);
  }
  o.slots = [];
}
export function updateObject(o) {
  o.sx = o.sy = o.sz = o.scale;
  computeQuat(o);
  var def = ASSETS[o.kind];
  if (!def || !o.slots) return;
  for (var p = 0; p < def.parts.length; p++) {
    var L = Layers.map[o.kind + '#' + p];
    if (L && o.slots[p] !== undefined) L.write(o.slots[p], o);
  }
}

export function addObject(kind, x, z, opt) {
  var o = makeObject(kind, x, z, opt);
  if (!o) return null;
  pushObject(o);
  attachObject(o);
  return o;
}
export function deleteObject(o) {
  detachObject(o);
  popObject(o);
}

/* ---- serialisation ------------------------------------------------------- */
export function serObj(o) {
  var r = { i: o.id, k: o.kind, s: o.seed,
            x: +o.x.toFixed(3), z: +o.z.toFixed(3),
            r: +o.rotY.toFixed(4), c: +o.scale.toFixed(3),
            a: +o.align.toFixed(3), yo: +o.yOff.toFixed(3) };
  if (o.tintCustom) r.tn = o.tint;
  if (o.folder) r.f = o.folder;
  if (o.name) r.nm = o.name;
  // the lane offset has to travel with the actor: without it roadPose() gets
  // an undefined offset on reload and the actor lands at NaN
  if (o.pathId) { r.pa = o.pathId; r.t = +o.t.toFixed(4); r.sp = +o.speed.toFixed(3); r.ln = +(o.lane || 0).toFixed(3); }
  if (o.roadId !== undefined && o.roadId !== null) { r.rd = o.roadId; r.t = +o.t.toFixed(4); r.sp = +o.speed.toFixed(3); r.dr = o.dir; r.ln = +(o.lane || 0).toFixed(3); }
  return r;
}
export function deserObj(r) {
  if (!ASSETS[r.k]) return null;              // model no longer in the library
  var o = addObject(r.k, r.x, r.z, {
    id: r.i, seed: r.s, rotY: r.r, align: r.a, tint: r.tn, yOff: r.yo,
    folder: r.f, name: r.nm
  });
  if (!o) return null;
  o.scale = r.c; o.sx = o.sy = o.sz = r.c;
  if (r.pa !== undefined) { o.pathId = r.pa; o.t = r.t; o.speed = r.sp; o.lane = r.ln || 0; o.rate = 2.4; }
  if (r.rd !== undefined) { o.roadId = r.rd; o.t = r.t; o.speed = r.sp; o.dir = r.dr; o.lane = r.ln || 0; }
  updateObject(o);
  return o;
}

/* ---- undo ops ------------------------------------------------------------ */
export var WORLD_OPS = {
  oadd: {
    undo: function (op) { for (var i = 0; i < op.recs.length; i++) { var o = World.byId[op.recs[i].i]; if (o) deleteObject(o); } },
    redo: function (op) { for (var i = 0; i < op.recs.length; i++) deserObj(op.recs[i]); }
  },
  odel: {
    undo: function (op) { for (var i = 0; i < op.recs.length; i++) deserObj(op.recs[i]); },
    redo: function (op) { for (var i = 0; i < op.recs.length; i++) { var o = World.byId[op.recs[i].i]; if (o) deleteObject(o); } }
  },
  omod: {
    undo: function (op) { applyObjRecords(op.before); },
    redo: function (op) { applyObjRecords(op.after); }
  },
  terr: {
    undo: function (op) { applyTerrainPatch(op, true); },
    redo: function (op) { applyTerrainPatch(op, false); }
  },
  radd: {
    undo: function (op) { for (var i = 0; i < op.ids.length; i++) removeRoadById(op.ids[i], true); },
    redo: function (op) { for (var i = 0; i < op.recs.length; i++) addRoadRecord(op.recs[i]); rebuildAllRoads(); }
  },
  rdel: {
    undo: function (op) { for (var i = 0; i < op.recs.length; i++) addRoadRecord(op.recs[i]); rebuildAllRoads(); },
    redo: function (op) { for (var i = 0; i < op.ids.length; i++) removeRoadById(op.ids[i], true); }
  },
  rmod: {
    undo: function (op) { applyRoadRecords(op.before); },
    redo: function (op) { applyRoadRecords(op.after); }
  }
};
export function applyObjRecords(list) {
  for (var i = 0; i < list.length; i++) {
    var r = list[i], o = World.byId[r.i];
    if (!o) { deserObj(r); continue; }
    o.x = r.x; o.z = r.z; o.rotY = r.r; o.scale = r.c; o.align = r.a;
    o.yOff = r.yo || 0;
    if (r.tn) { o.tint = r.tn.slice(); o.tintCustom = true; }
    o.y = surfaceOrTerrainY(o) + o.yOff;
    ogridMove(o);
    updateObject(o);
  }
}
export function recordObjAdd(objs) {
  if (!objs.length) return;
  var recs = [];
  for (var i = 0; i < objs.length; i++) recs.push(serObj(objs[i]));
  recordOp({ t: 'oadd', recs: recs, bytes: recs.length * 96 });
}
export function recordObjDel(objs) {
  if (!objs.length) return;
  var recs = [];
  for (var i = 0; i < objs.length; i++) recs.push(serObj(objs[i]));
  recordOp({ t: 'odel', recs: recs, bytes: recs.length * 96 });
}

/* ==========================================================================
   SPATIAL HASH — spacing checks, brush erasing and click selection.
   ========================================================================== */
export var OGrid = { cell: 5, map: {} };
export function ogKey(x, z) { return (Math.floor(x / OGrid.cell)) + ',' + (Math.floor(z / OGrid.cell)); }
export function ogridAdd(o) {
  var k = ogKey(o.x, o.z);
  (OGrid.map[k] || (OGrid.map[k] = [])).push(o);
  o._gk = k;
}
export function ogridRemove(o) {
  var a = OGrid.map[o._gk];
  if (!a) return;
  var i = a.indexOf(o);
  if (i >= 0) a.splice(i, 1);
}
export function ogridMove(o) { ogridRemove(o); ogridAdd(o); }
export function ogridRebuild() {
  OGrid.map = {};
  for (var i = 0; i < World.objs.length; i++) ogridAdd(World.objs[i]);
}
export function ogridQuery(x, z, r, fn) {
  var c = OGrid.cell;
  var i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
  var j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
  for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
    var a = OGrid.map[i + ',' + j];
    if (!a) continue;
    for (var k = a.length - 1; k >= 0; k--) fn(a[k]);
  }
}
export function nearestObjectDist(x, z, r, catFilter) {
  var best = 1e9;
  ogridQuery(x, z, r, function (o) {
    if (catFilter && o.cat !== catFilter) return;
    var dx = o.x - x, dz = o.z - z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < best) best = d;
  });
  return best;
}

/* ==========================================================================
   RE-PROJECTION — anything standing on the ground follows a sculpt edit.
   ========================================================================== */
export function resnapWorld() {
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.pathId || o.roadId !== undefined) continue;   // actors re-solve each frame
    o.y = surfaceOrTerrainY(o) + o.yOff;
    updateObject(o);
  }
}
export function resnapWorldRegion(cx, cz, r) {
  var r2 = r * r;
  ogridQuery(cx, cz, r, function (o) {
    var dx = o.x - cx, dz = o.z - cz;
    if (dx * dx + dz * dz > r2) return;
    o.y = surfaceOrTerrainY(o) + o.yOff;
    updateObject(o);
  });
}

/* Level the ground under a footprint so a building never floats or clips. */
export function flattenFootprint(cx, cz, radius, targetH) {
  if (state.plate.mode !== 'terrain') return;
  var p = state.plate, N = Terrain.N, W = N + 1;
  var rc = sculptCellRect(cx, cz, radius * 1.9);
  var h = (targetH === undefined) ? heightAt(cx, cz) : targetH;
  for (var j = rc.j0; j <= rc.j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = rc.i0; i <= rc.i1; i++) {
      var x = (i / N - 0.5) * p.width;
      var dx = x - cx, dz = z - cz;
      var d = Math.sqrt(dx * dx + dz * dz);
      var w = 1 - smoothstep(radius * 0.85, radius * 1.85, d);
      if (w <= 0) continue;
      var k = j * W + i;
      sculptWrite(k, (h - Terrain.h[k]) * w);
    }
  }
  recomputeTerrainBounds();
  updateGroundVerts(Math.max(rc.j0 - 1, 0), Math.min(rc.j1 + 1, N));
  resnapRegion(cx, cz, radius * 2.2);
  resnapWorldRegion(cx, cz, radius * 2.4);
  Water.dirty = true;
}

/* ==========================================================================
   PLACEMENT
   ========================================================================== */
export function placementOpts(kind, x, z, over) {
  var b = state.build, s = state.nature;
  var def = ASSETS[kind];
  var o = { seed: Math.floor(rnd() * 1e9) };
  // state.place.size is the one Size slider in the Place panel; it multiplies
  // whichever per-kind variation set applies, so it means the same thing for
  // a house as it does for a fern.
  if (def.kind === 'building') {
    o.rotY = b.rotation * DEG + (rnd() - 0.5) * b.rotJitter * DEG;
    o.scale = state.place.size * b.scale * lerp(b.scaleMin, b.scaleMax, rnd());
    o.align = b.upright ? 0 : 0.4;
  } else {
    o.rotY = rnd() * s.rotJitter * DEG * 2;
    o.scale = state.place.size * lerp(s.scaleMin, s.scaleMax, rnd());
    o.align = s.alignNormal;
  }
  if (over) for (var k in over) if (over[k] !== undefined) o[k] = over[k];
  return o;
}

/* Buildings snap to the grid or face the nearest road with a setback — that
   road-facing rule is what turns a row of houses into a street. */
export function resolvePlacement(kind, x, z) {
  var b = state.build, def = ASSETS[kind];
  var out = { x: x, z: z, rotY: b.rotation * DEG, snapped: false };
  if (!def || def.kind !== 'building') return out;
  if (b.snap === 'grid') {
    var g = Math.max(0.25, b.gridSize);
    out.x = Math.round(x / g) * g;
    out.z = Math.round(z / g) * g;
  } else if (b.snap === 'road') {
    var info = nearestRoadPoint(x, z, 60);
    if (info) {
      var nx = info.nx, nz = info.nz;                 // unit normal away from road
      var half = info.width * 0.5 + b.setback;
      out.x = info.px + nx * half;
      out.z = info.pz + nz * half;
      // (nx, nz) points from the road out to the plot, so facing the street is
      // the reverse of the offset direction.
      out.rotY = Math.atan2(-nx, -nz);
      out.snapped = true;
    }
  }
  return out;
}

export function placeObjectAt(kind, x, z, opt) {
  var b = state.build, def = ASSETS[kind];
  if (!def) return null;
  var res = resolvePlacement(kind, x, z);
  var o2 = placementOpts(kind, res.x, res.z, opt);
  if (def.kind === 'building') {
    o2.rotY = res.rotY + (rnd() - 0.5) * b.rotJitter * DEG;
    if (opt && opt.rotY !== undefined) o2.rotY = opt.rotY;
  }
  var o = addObject(kind, res.x, res.z, o2);
  if (!o) return null;
  if (def.kind === 'building' && b.flatten) {
    flattenFootprint(o.x, o.z, o.radius * o.scale, heightAt(o.x, o.z));
    o.y = heightAt(o.x, o.z) + o.yOff;
    updateObject(o);
  }
  return o;
}

/* ==========================================================================
   SCATTER BRUSH — filtered by slope, altitude and a minimum spacing.
   ========================================================================== */
export function scatterStamp(cx, cz, cfg, kinds) {
  var p = state.plate, b = state.brush;
  var live = [];
  for (var q = 0; q < kinds.length; q++) if (ASSETS[kinds[q]]) live.push(kinds[q]);
  if (!live.length) return [];
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var tries = Math.max(1, Math.round(cfg.density * b.radius * b.radius * 0.55));
  var added = [];
  var edge = lerp(0.04, 0.97, b.falloff);
  for (var n = 0; n < tries; n++) {
    var ang = rnd() * TAU, rr = b.radius * Math.sqrt(rnd());
    var u = rr / b.radius;
    if (rnd() > 1 - smoothstep(edge, 1, u)) continue;
    var x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
    if (x < -hw || x > hw || z < -hd || z > hd) continue;
    var y = heightAt(x, z);
    if (y < cfg.minAlt || y > cfg.maxAlt) continue;
    if (normalYAt(x, z) < cfg.minNormalY) continue;
    if (underWater(x, z)) continue;
    if (nearestObjectDist(x, z, cfg.spacing) < cfg.spacing) continue;
    if (roadCovers(x, z, 0.6)) continue;
    var kind = live[(rnd() * live.length) | 0];
    var o = addObject(kind, x, z, {
      rotY: rnd() * cfg.rotJitter * DEG * 2,
      scale: (cfg.size === undefined ? state.place.size : cfg.size) * lerp(cfg.scaleMin, cfg.scaleMax, rnd()),
      align: cfg.alignNormal === undefined ? 0.25 : cfg.alignNormal
    });
    if (o) added.push(o);
  }
  return added;
}

/* ==========================================================================
   ERASE — one brush, filtered by category so grass can be painted around
   finished buildings without touching them.
   ========================================================================== */
export function eraseWorldStamp(cx, cz, r, mask) {
  var hits = [];
  var r2 = r * r;
  ogridQuery(cx, cz, r, function (o) {
    if (!mask[o.cat]) return;
    if (catLocked(o.cat)) return;
    var dx = o.x - cx, dz = o.z - cz;
    if (dx * dx + dz * dz > r2) return;
    hits.push(o);
  });
  if (!hits.length) return 0;
  recordObjDel(hits);
  for (var i = 0; i < hits.length; i++) deleteObject(hits[i]);
  return hits.length;
}

export function objectCounts() {
  var c = { buildings: 0, nature: 0, props: 0, people: 0, vehicles: 0 };
  for (var i = 0; i < World.objs.length; i++) c[World.objs[i].cat]++;
  return c;
}

export function clearWorldObjects(cats) {
  var kill = [];
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (!cats || cats.indexOf(o.cat) >= 0) kill.push(o);
  }
  for (var k = 0; k < kill.length; k++) deleteObject(kill[k]);
  disposeEmptyLayers();
}

