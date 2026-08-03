import * as THREE from 'three';
import { emit, ui } from './host.js';
import { syncGrassUniforms } from './field.js';
import { BLADE_STRIDE, Dens, Grass, copyBlade, densBump, densCell, densCellArea, markDirty, rebuildDensityGrid, writeBlade, writeBladeArr } from './grass.js';
import { markSceneDirty } from './persistence.js';
import { Roads, rebuildAllRoads, roadCovers } from './roads.js';
import { refreshSelectionVisuals } from './selection.js';
import { MAX_BLADES, state } from './state.js';
import { heightAt, normalAt, normalYAt } from './terrain.js';
import { TAU, clamp, fmtInt, lerp, rnd, smoothstep } from './util.js';
import { underWater } from './water.js';
import { WORLD_OPS, applyLayerVisibility, ogridRebuild } from './world.js';

/* ==========================================================================
   9. HISTORY (undo / redo)
   --------------------------------------------------------------------------
   A stroke is a list of primitive ops recorded in the order they happened;
   undo replays them backwards. Only two primitives exist:
     add : n blades appended at `start`
     rm  : blades removed at descending indices (so each removal is exact)
   ========================================================================== */
export var History = {
  undo: [], redo: [], cur: null, bytes: 0,
  MAX_ENTRIES: 80, MAX_BYTES: 180 * 1024 * 1024
};

export function beginStroke(label) {
  History.cur = { label: label, ops: [], bytes: 0 };
}
export function endStroke() {
  var s = History.cur; History.cur = null;
  if (!s || !s.ops.length) return;
  History.undo.push(s);
  History.bytes += s.bytes;
  History.redo.length = 0;
  while (History.undo.length > History.MAX_ENTRIES ||
        (History.bytes > History.MAX_BYTES && History.undo.length > 30)) {
    History.bytes -= History.undo.shift().bytes;
  }
  markSceneDirty();
  emit('history');
}
export function recordOp(op) {
  if (!History.cur) return;
  History.cur.ops.push(op);
  var b = (op.data && op.data.byteLength ? op.data.byteLength : 0) +
          (op.idx && op.idx.byteLength ? op.idx.byteLength : 0) + (op.bytes || 0);
  History.cur.bytes += b;
}

export function applyUndoOp(op) {
  // world-builder op types (terrain patches, objects, roads) register here
  if (WORLD_OPS[op.t]) { WORLD_OPS[op.t].undo(op); return; }
  if (op.t === 'add') {
    Grass.count = op.start;
    markDirty(op.start, op.start + op.n);
  } else {
    // Restore in reverse removal order.
    for (var k = op.idx.length - 1; k >= 0; k--) {
      var i = op.idx[k], last = Grass.count;
      if (i !== last) copyBlade(i, last);
      writeBladeArr(i, op.data, k * BLADE_STRIDE);
      Grass.count++;
    }
    markDirty(0, Grass.count);
  }
}
export function applyRedoOp(op) {
  if (WORLD_OPS[op.t]) { WORLD_OPS[op.t].redo(op); return; }
  if (op.t === 'add') {
    for (var k = 0; k < op.n; k++) writeBladeArr(op.start + k, op.data, k * BLADE_STRIDE);
    Grass.count = op.start + op.n;
    markDirty(op.start, Grass.count);
  } else {
    for (var m = 0; m < op.idx.length; m++) {
      var i = op.idx[m], last = Grass.count - 1;
      if (i !== last) copyBlade(last, i);
      Grass.count--;
    }
    markDirty(0, Math.max(Grass.count, 0));
  }
}

export function doUndo() {
  if (!History.undo.length) { ui.toast('Nothing to undo'); return; }
  var s = History.undo.pop();
  for (var i = s.ops.length - 1; i >= 0; i--) applyUndoOp(s.ops[i]);
  History.redo.push(s);
  History.bytes -= s.bytes;
  afterHistory(s.label + ' undone');
}
export function doRedo() {
  if (!History.redo.length) { ui.toast('Nothing to redo'); return; }
  var s = History.redo.pop();
  for (var i = 0; i < s.ops.length; i++) applyRedoOp(s.ops[i]);
  History.undo.push(s);
  History.bytes += s.bytes;
  afterHistory(s.label + ' redone');
}
export function afterHistory(msg) {
  rebuildDensityGrid();
  markDirty(0, MAX_BLADES - 1);
  ogridRebuild();
  if (Roads.dirty) rebuildAllRoads();
  applyLayerVisibility();
  refreshSelectionVisuals();
  emit('selection');
  markSceneDirty();
  emit('history');
  ui.toast(msg);
}


/* ==========================================================================
   10. BRUSH / PAINTING
   ========================================================================== */
export var Brush = {
  down: false,
  active: null,           // the tool actually being applied this stroke
  last: new THREE.Vector3(),
  hasLast: false,
  start: new THREE.Vector3(),
  axis: 0,                // shift-constrain axis: 0 none, 1 x, 2 z
  leftover: 0,
  eraseQueue: []
};

/* Probability that a candidate at normalised distance u survives the brush
   falloff. falloff=0 -> very soft edge, 1 -> hard edge. */
export function falloffAt(u) {
  var edge = lerp(0.04, 0.97, state.brush.falloff);
  return 1 - smoothstep(edge, 1, u);
}

export function bladeCapacityLeft() { return MAX_BLADES - Grass.count; }

/* ---- PAINT --------------------------------------------------------------- */
export var _tmpN = new THREE.Vector3();
/* The grass system is gone. Its code is still here because the density
   texture it maintained is what the ground shader samples, and the blade
   buffers are what a pre-Diorama save file still contains — but nothing
   plants a blade any more, so the count stays at zero and none of it ever
   reaches the screen. */
export function paintStamp() {
  return 0;
}
function _retiredPaintStamp(cx, cz, scale) {
  var b = state.brush, g = state.grass, p = state.plate;
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var want = Math.max(1, Math.round(b.flow * b.radius * b.radius * 34 * (scale === undefined ? 1 : scale)));
  var room = bladeCapacityLeft();
  if (room <= 0) return 0;
  if (want > room) want = room;

  var target = Math.max(1, b.maxDensity * densCellArea());
  var lattice = 1 / Math.sqrt(Math.max(b.maxDensity, 0.5));
  var start = Grass.count, added = 0;

  for (var n = 0; n < want; n++) {
    var ang = rnd() * TAU, rr = b.radius * Math.sqrt(rnd());
    var u = rr / b.radius;
    if (rnd() > falloffAt(u)) continue;

    var x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
    // Scatter: 0 snaps candidates onto a lattice (tidy lawn), 1 is fully
    // random (natural). Anything between blends the two.
    if (b.scatter < 0.999) {
      var gx = Math.round(x / lattice) * lattice, gz = Math.round(z / lattice) * lattice;
      x = gx + (x - gx) * b.scatter;
      z = gz + (z - gz) * b.scatter;
    }
    if (x < -hw || x > hw || z < -hd || z > hd) continue;

    var cell = densCell(x, z);
    if (cell < 0 || Dens.grid[cell] >= target) continue;
    // world-builder rules: no blades on cliffs, in roads or under water
    if (normalYAt(x, z) < p.maxGrassSlope) continue;
    if (roadCovers(x, z)) continue;
    if (underWater(x, z)) continue;

    var y = heightAt(x, z);
    normalAt(x, z, _tmpN);
    // Random tilt away from the surface normal so blades are not perfectly
    // perpendicular to the ground.
    if (b.tilt > 0.001) {
      var ta = rnd() * TAU, tm = rnd() * b.tilt;
      _tmpN.x += Math.cos(ta) * tm; _tmpN.z += Math.sin(ta) * tm;
      _tmpN.normalize();
    }

    var i = Grass.count;
    writeBlade(i, x, y, z, _tmpN.x, _tmpN.y, _tmpN.z,
      rnd() * TAU,
      Math.max(0.12, 1 + (rnd() * 2 - 1) * g.heightVar),
      Math.max(0.12, 1 + (rnd() * 2 - 1) * g.widthVar),
      Math.max(0, 1 + (rnd() * 2 - 1) * g.curveVar),
      lerp(g.stiffMin, g.stiffMax, rnd()),
      rnd());
    Grass.count++;
    Dens.grid[cell]++;
    Dens.dirty = true;
    added++;
  }

  if (added) {
    var data = new Float32Array(added * BLADE_STRIDE);
    for (var k = 0; k < added; k++) readBladeInto(start + k, data, k * BLADE_STRIDE);
    recordOp({ t: 'add', start: start, n: added, data: data });
  }
  return added;
}
export function readBladeInto(i, dst, off) {
  var A = Grass.arr, o3 = i * 3, o2 = i * 2;
  dst[off] = A.aOffset[o3]; dst[off + 1] = A.aOffset[o3 + 1]; dst[off + 2] = A.aOffset[o3 + 2];
  dst[off + 3] = A.aNormal[o3]; dst[off + 4] = A.aNormal[o3 + 1]; dst[off + 5] = A.aNormal[o3 + 2];
  dst[off + 6] = A.aRot[i];
  dst[off + 7] = A.aSize[o2]; dst[off + 8] = A.aSize[o2 + 1];
  dst[off + 9] = A.aShape[o2]; dst[off + 10] = A.aShape[o2 + 1];
  dst[off + 11] = A.aSeed[i];
}

/* ---- ERASE ---------------------------------------------------------------
   Removals are collected for the whole frame and applied in one pass so a
   fast drag costs a single scan of the blade array. */
export function flushErase() {
  var q = Brush.eraseQueue;
  if (!q.length) return;
  var A = Grass.arr, n = Grass.count, hits = [];
  for (var i = 0; i < n; i++) {
    var o = i * 3, x = A.aOffset[o], z = A.aOffset[o + 2];
    for (var s = 0; s < q.length; s++) {
      var st = q[s], dx = x - st.x, dz = z - st.z;
      var d2 = dx * dx + dz * dz;
      if (d2 > st.r2) continue;
      if (rnd() < st.p * falloffAt(Math.sqrt(d2) / st.r)) { hits.push(i); break; }
    }
  }
  q.length = 0;
  if (!hits.length) return;
  removeBlades(hits);
}

/* Removes the given indices (any order). Descending order guarantees the
   swap-remove source is never itself scheduled for removal. */
export function removeBlades(list) {
  list.sort(function (a, b) { return b - a; });
  var idx = new Int32Array(list.length);
  var data = new Float32Array(list.length * BLADE_STRIDE);
  var A = Grass.arr;
  for (var k = 0; k < list.length; k++) {
    var i = list[k];
    idx[k] = i;
    readBladeInto(i, data, k * BLADE_STRIDE);
    densBump(A.aOffset[i * 3], A.aOffset[i * 3 + 2], -1);
    var last = Grass.count - 1;
    if (i !== last) copyBlade(last, i);
    Grass.count--;
  }
  markDirty(0, Math.max(Grass.count, 0));
  recordOp({ t: 'rm', idx: idx, data: data });
}

/* ---- SMOOTH --------------------------------------------------------------
   Evens out density: bins the blades under the brush, then thins the
   over-populated bins and seeds the under-populated ones toward the local
   mean, weighted by the brush falloff. */
export function smoothStamp(cx, cz, dt) {
  var b = state.brush, g = state.grass, p = state.plate;
  var GX = 7, r = b.radius, cell = (r * 2) / GX;
  var bins = [], counts = new Int32Array(GX * GX);
  for (var i = 0; i < GX * GX; i++) bins.push([]);

  var A = Grass.arr, n = Grass.count, r2 = r * r;
  for (var k = 0; k < n; k++) {
    var o = k * 3, dx = A.aOffset[o] - cx, dz = A.aOffset[o + 2] - cz;
    if (dx * dx + dz * dz > r2) continue;
    var gi = clamp(Math.floor((dx + r) / cell), 0, GX - 1);
    var gj = clamp(Math.floor((dz + r) / cell), 0, GX - 1);
    bins[gj * GX + gi].push(k);
    counts[gj * GX + gi]++;
  }

  var total = 0, live = 0;
  for (var j = 0; j < GX; j++) for (var i2 = 0; i2 < GX; i2++) {
    var ccx = (i2 + 0.5) * cell - r, ccz = (j + 0.5) * cell - r;
    if (ccx * ccx + ccz * ccz > r2) continue;
    total += counts[j * GX + i2]; live++;
  }
  if (!live) return;
  var mean = total / live;
  var rate = clamp(dt * 5.5, 0, 0.85);

  var toRemove = [], addStart = Grass.count, added = 0;
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var densTarget = Math.max(1, b.maxDensity * densCellArea());

  for (var j2 = 0; j2 < GX; j2++) {
    for (var i3 = 0; i3 < GX; i3++) {
      var ci = j2 * GX + i3;
      var ccx2 = (i3 + 0.5) * cell - r, ccz2 = (j2 + 0.5) * cell - r;
      var dist = Math.sqrt(ccx2 * ccx2 + ccz2 * ccz2);
      if (dist > r) continue;
      var w = falloffAt(dist / r) * rate;
      var diff = counts[ci] - mean;

      if (diff > 0.5) {
        var kill = Math.min(bins[ci].length, Math.round(diff * w));
        for (var q = 0; q < kill; q++) {
          var pick = (rnd() * bins[ci].length) | 0;
          toRemove.push(bins[ci][pick]);
          bins[ci].splice(pick, 1);
        }
      } else if (diff < -0.5 && bladeCapacityLeft() > 8) {
        var grow = Math.min(bladeCapacityLeft() - 4, Math.round(-diff * w));
        for (var q2 = 0; q2 < grow; q2++) {
          // Retry a couple of times: a candidate rejected for landing off the
          // plate or in a saturated cell would otherwise silently thin the
          // field instead of redistributing it.
          var x = 0, z = 0, dc = -1, tries = 0;
          while (tries++ < 3) {
            x = cx + ccx2 + (rnd() - 0.5) * cell;
            z = cz + ccz2 + (rnd() - 0.5) * cell;
            if (x < -hw || x > hw || z < -hd || z > hd) { dc = -1; continue; }
            dc = densCell(x, z);
            if (dc >= 0 && Dens.grid[dc] < densTarget) break;
            dc = -1;
          }
          if (dc < 0) continue;
          var y = heightAt(x, z);
          normalAt(x, z, _tmpN);
          if (b.tilt > 0.001) {
            var ta = rnd() * TAU, tm = rnd() * b.tilt;
            _tmpN.x += Math.cos(ta) * tm; _tmpN.z += Math.sin(ta) * tm; _tmpN.normalize();
          }
          writeBlade(Grass.count, x, y, z, _tmpN.x, _tmpN.y, _tmpN.z,
            rnd() * TAU,
            Math.max(0.12, 1 + (rnd() * 2 - 1) * g.heightVar),
            Math.max(0.12, 1 + (rnd() * 2 - 1) * g.widthVar),
            Math.max(0, 1 + (rnd() * 2 - 1) * g.curveVar),
            lerp(g.stiffMin, g.stiffMax, rnd()), rnd());
          Grass.count++; Dens.grid[dc]++; Dens.dirty = true; added++;
        }
      }
    }
  }

  if (toRemove.length) removeBlades(toRemove);
  if (added) {
    var data = new Float32Array(added * BLADE_STRIDE);
    for (var a2 = 0; a2 < added; a2++) readBladeInto(addStart + a2, data, a2 * BLADE_STRIDE);
    recordOp({ t: 'add', start: addStart, n: added, data: data });
  }
}

/* ---- EYEDROPPER ---------------------------------------------------------- */
export function eyedrop(cx, cz) {
  var A = Grass.arr, best = -1, bd = 1e18;
  var r2 = state.brush.radius * state.brush.radius;
  for (var i = 0; i < Grass.count; i++) {
    var o = i * 3, dx = A.aOffset[o] - cx, dz = A.aOffset[o + 2] - cz;
    var d = dx * dx + dz * dz;
    if (d < bd && d <= r2) { bd = d; best = i; }
  }
  if (best < 0) { ui.toast('No grass under the cursor', 'err'); return; }
  var hm = A.aSize[best * 2], wm = A.aSize[best * 2 + 1];
  var bd2 = A.aShape[best * 2], st = A.aShape[best * 2 + 1];
  state.grass.heightVar = clamp(Math.abs(hm - 1) * 0.5 + 0.02, 0.02, 1);
  state.grass.widthVar = clamp(Math.abs(wm - 1) * 0.5 + 0.02, 0.02, 1);
  state.grass.curveVar = clamp(Math.abs(bd2 - 1) * 0.5 + 0.02, 0.02, 1);
  state.grass.height = clamp(state.grass.height * hm, 0.05, 6);
  state.grass.width = clamp(state.grass.width * wm, 0.005, 0.5);
  state.grass.stiffMin = clamp(st - 0.08, 0.15, 3);
  state.grass.stiffMax = clamp(st + 0.08, 0.15, 3);
  syncGrassUniforms();
  emit('state');
  markSceneDirty();
  ui.toast('Sampled: height ' + (state.grass.height).toFixed(2) + ', stiffness ' + st.toFixed(2), 'ok');
}

/* ---- FILL / CLEAR -------------------------------------------------------- */
export function fillPlate() {
  return 0;
}
function _retiredFillPlate() {
  var p = state.plate, b = state.brush, g = state.grass;
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var spacing = 1 / Math.sqrt(Math.max(b.maxDensity, 0.5));
  var nx = Math.floor(p.width / spacing), nz = Math.floor(p.depth / spacing);
  var estimate = nx * nz;
  if (estimate > bladeCapacityLeft()) {
    var f = bladeCapacityLeft() / estimate;
    spacing = spacing / Math.sqrt(Math.max(f, 0.001));
    nx = Math.floor(p.width / spacing); nz = Math.floor(p.depth / spacing);
  }
  beginStroke('Fill');
  var start = Grass.count, added = 0;
  var jit = b.scatter;
  for (var j = 0; j < nz; j++) {
    for (var i = 0; i < nx; i++) {
      if (bladeCapacityLeft() < 2) break;
      var x = -hw + (i + 0.5) * spacing + (rnd() - 0.5) * spacing * jit;
      var z = -hd + (j + 0.5) * spacing + (rnd() - 0.5) * spacing * jit;
      if (x < -hw || x > hw || z < -hd || z > hd) continue;
      var dc = densCell(x, z);
      if (dc < 0) continue;
      if (normalYAt(x, z) < p.maxGrassSlope) continue;
      if (roadCovers(x, z)) continue;
      if (underWater(x, z)) continue;
      var y = heightAt(x, z);
      normalAt(x, z, _tmpN);
      if (b.tilt > 0.001) {
        var ta = rnd() * TAU, tm = rnd() * b.tilt;
        _tmpN.x += Math.cos(ta) * tm; _tmpN.z += Math.sin(ta) * tm; _tmpN.normalize();
      }
      writeBlade(Grass.count, x, y, z, _tmpN.x, _tmpN.y, _tmpN.z,
        rnd() * TAU,
        Math.max(0.12, 1 + (rnd() * 2 - 1) * g.heightVar),
        Math.max(0.12, 1 + (rnd() * 2 - 1) * g.widthVar),
        Math.max(0, 1 + (rnd() * 2 - 1) * g.curveVar),
        lerp(g.stiffMin, g.stiffMax, rnd()), rnd());
      Grass.count++; Dens.grid[dc]++; added++;
    }
  }
  Dens.dirty = true;
  if (added) {
    var data = new Float32Array(added * BLADE_STRIDE);
    for (var k = 0; k < added; k++) readBladeInto(start + k, data, k * BLADE_STRIDE);
    recordOp({ t: 'add', start: start, n: added, data: data });
  }
  endStroke();
  markDirty(0, Grass.count);
  ui.toast('Filled plate with ' + fmtInt(added) + ' blades', 'ok');
}

export function clearAll() {
  if (!Grass.count) { ui.toast('Nothing to clear'); return; }
  var n = Grass.count;
  var idx = new Int32Array(n), data = new Float32Array(n * BLADE_STRIDE);
  for (var k = 0; k < n; k++) {
    var i = n - 1 - k;                     // descending -> pure truncation
    idx[k] = i;
    readBladeInto(i, data, k * BLADE_STRIDE);
  }
  beginStroke('Clear');
  recordOp({ t: 'rm', idx: idx, data: data });
  endStroke();
  Grass.count = 0;
  Dens.grid.fill(0); Dens.dirty = true;
  markDirty(0, n);
  markSceneDirty();
  ui.toast('Cleared ' + fmtInt(n) + ' blades', 'ok');
}
