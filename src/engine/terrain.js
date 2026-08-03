import * as THREE from 'three';
import { syncGroundUniforms, updateGrassBounds } from './field.js';
import { rebuildDensityGrid, resnapAll, resnapRegion } from './grass.js';
import { recordOp } from './history.js';
import { Keys } from './input.js';
import { markSceneDirty } from './persistence.js';
import { camera, viewH, viewW } from './renderer.js';
import { Roads, rebuildAllRoads } from './roads.js';
import { state } from './state.js';
import { SN, clamp, lerp, smoothstep } from './util.js';
import { Water, rebuildWater } from './water.js';
import { World, resnapWorld, resnapWorldRegion } from './world.js';

/* ==========================================================================
   6. TERRAIN / BASEPLATE
   ========================================================================== */

export var Terrain = {
  N: 1,                       // segments per side (grid is (N+1)^2 vertices)
  h: new Float32Array(4),     // final height = procedural base + sculpt
  base: new Float32Array(4),
  sculpt: new Float32Array(4),
  min: 0, max: 0,
  mesh: null, geo: null, mat: null
};




/* Resample the user's sculpt offsets when the grid resolution changes, so
   resizing the plate or toggling modes never throws sculpting away. */
export function resampleSculpt(oldN, oldArr, newN) {
  var out = new Float32Array((newN + 1) * (newN + 1));
  if (!oldArr || oldN < 1) return out;
  var oW = oldN + 1, nW = newN + 1;
  for (var j = 0; j < nW; j++) {
    var v = j / newN * oldN, jj = Math.min(oldN - 1, v | 0), fv = v - jj;
    if (oldN === 0) { jj = 0; fv = 0; }
    for (var i = 0; i < nW; i++) {
      var u = i / newN * oldN, ii = Math.min(oldN - 1, u | 0), fu = u - ii;
      var a = oldArr[jj * oW + ii], b = oldArr[jj * oW + Math.min(ii + 1, oldN)];
      var c = oldArr[Math.min(jj + 1, oldN) * oW + ii], d = oldArr[Math.min(jj + 1, oldN) * oW + Math.min(ii + 1, oldN)];
      out[j * nW + i] = lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
    }
  }
  return out;
}



export function buildGroundGeometry() {
  var N = Terrain.N, W = N + 1;
  var need = !Terrain.geo || Terrain.geo.userData.N !== N;
  if (need) {
    if (Terrain.geo) Terrain.geo.dispose();
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(W * W * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(W * W * 3), 3));
    var idx = (W * W > 65535) ? new Uint32Array(N * N * 6) : new Uint16Array(N * N * 6);
    var o = 0;
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        var a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.userData.N = N;
    Terrain.geo = g;
    if (Terrain.mesh) Terrain.mesh.geometry = g;
  }
  updateGroundVerts(0, N);
  Terrain.geo.computeBoundingSphere();
}

/* Rewrite vertex rows j0..j1 (inclusive) from the heightfield. */
export function updateGroundVerts(j0, j1) {
  var N = Terrain.N, W = N + 1, p = state.plate, h = Terrain.h;
  var pos = Terrain.geo.attributes.position, nrm = Terrain.geo.attributes.normal;
  var pa = pos.array, na = nrm.array;
  var cx = p.width / N, cz = p.depth / N;
  j0 = clamp(j0, 0, N); j1 = clamp(j1, 0, N);
  for (var j = j0; j <= j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = 0; i < W; i++) {
      var k = j * W + i, o = k * 3;
      pa[o] = (i / N - 0.5) * p.width;
      pa[o + 1] = h[k];
      pa[o + 2] = z;
      // Analytic normal from central differences on the heightfield.
      var hl = h[j * W + Math.max(i - 1, 0)], hr = h[j * W + Math.min(i + 1, N)];
      var hd = h[Math.max(j - 1, 0) * W + i], hu = h[Math.min(j + 1, N) * W + i];
      var dx = (hr - hl) / (cx * (i === 0 || i === N ? 1 : 2));
      var dz = (hu - hd) / (cz * (j === 0 || j === N ? 1 : 2));
      var nx = -dx, ny = 1, nz = -dz;
      var il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      na[o] = nx * il; na[o + 1] = ny * il; na[o + 2] = nz * il;
    }
  }
  var off = j0 * W * 3, cnt = (j1 - j0 + 1) * W * 3;
  pos.updateRange.offset = off; pos.updateRange.count = cnt; pos.needsUpdate = true;
  nrm.updateRange.offset = off; nrm.updateRange.count = cnt; nrm.needsUpdate = true;
}

/* Rebuild the whole plate. `keepSculpt` survives resolution changes. */
export function rebuildPlate() {
  var newN = terrainSegs();
  if (newN !== Terrain.N || Terrain.sculpt.length !== (newN + 1) * (newN + 1)) {
    Terrain.sculpt = resampleSculpt(Terrain.N, Terrain.sculpt, newN);
    Terrain.N = newN;
    var n = (newN + 1) * (newN + 1);
    Terrain.h = new Float32Array(n);
    Terrain.base = new Float32Array(n);
  }
  computeTerrainHeights();
  buildGroundGeometry();
  syncGroundUniforms();
  rebuildDensityGrid();
  resnapAll();
  updateGrassBounds();
  if (Water.mesh) rebuildWater();
  if (Roads.group) { for (var r = 0; r < World.roads.length; r++) World.roads[r]._dirty = true; rebuildAllRoads(); }
  resnapWorld();
}

export function heightAt(x, z) {
  if (state.plate.mode === 'flat') return 0;
  var p = state.plate, N = Terrain.N, W = N + 1, T = Terrain.h;
  var u = clamp((x / p.width + 0.5) * N, 0, N - 1e-5);
  var v = clamp((z / p.depth + 0.5) * N, 0, N - 1e-5);
  var i = u | 0, j = v | 0, fu = u - i, fv = v - j;
  var a = T[j * W + i], b = T[j * W + i + 1], c = T[(j + 1) * W + i], d = T[(j + 1) * W + i + 1];
  return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
}

export var _nrmTmp = new THREE.Vector3();
export function normalAt(x, z, out) {
  out = out || _nrmTmp;
  if (state.plate.mode === 'flat') return out.set(0, 1, 0);
  var e = Math.max(state.plate.width, state.plate.depth) / Terrain.N;
  var dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  var dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return out.set(-dx, 1, -dz).normalize();
}

/* --------------------------------------------------------------------------
   Ray marching against the heightfield. Much faster and more robust than
   raycasting 70k triangles, and it degenerates to an exact plane test when
   the plate is flat.
   -------------------------------------------------------------------------- */
export function raycastGround(ro, rd, out) {
  var p = state.plate, hw = p.width * 0.5, hd = p.depth * 0.5;
  out = out || new THREE.Vector3();

  if (p.mode === 'flat') {
    if (Math.abs(rd.y) < 1e-7) return null;
    var t = -ro.y / rd.y;
    if (t <= 0) return null;
    var x = ro.x + rd.x * t, z = ro.z + rd.z * t;
    if (Math.abs(x) > hw || Math.abs(z) > hd) return null;
    return out.set(x, 0, z);
  }

  // Clip the ray to the terrain's bounding slab first.
  var t0 = 0, t1 = 1e9;
  var lo = [-hw, Terrain.min - 1, -hd], hi = [hw, Terrain.max + 1, hd];
  var o = [ro.x, ro.y, ro.z], d = [rd.x, rd.y, rd.z];
  for (var ax = 0; ax < 3; ax++) {
    if (Math.abs(d[ax]) < 1e-9) { if (o[ax] < lo[ax] || o[ax] > hi[ax]) return null; continue; }
    var ta = (lo[ax] - o[ax]) / d[ax], tb = (hi[ax] - o[ax]) / d[ax];
    if (ta > tb) { var tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  t0 = Math.max(t0, 0);

  var span = t1 - t0;
  if (span <= 0) return null;
  var steps = 256, step = span / steps;
  var pt = t0, prev = ro.y + rd.y * t0 - heightAt(ro.x + rd.x * t0, ro.z + rd.z * t0);
  if (prev < 0) {
    // started underground — walk backwards is not useful, just accept entry
    return out.set(ro.x + rd.x * t0, heightAt(ro.x + rd.x * t0, ro.z + rd.z * t0), ro.z + rd.z * t0);
  }
  for (var s = 1; s <= steps; s++) {
    var tc = t0 + s * step;
    var cx = ro.x + rd.x * tc, cz = ro.z + rd.z * tc;
    var cur = ro.y + rd.y * tc - heightAt(cx, cz);
    if (cur <= 0) {
      // bisect between pt and tc
      var lo2 = pt, hi2 = tc;
      for (var b = 0; b < 14; b++) {
        var mid = (lo2 + hi2) * 0.5;
        var mx = ro.x + rd.x * mid, mz = ro.z + rd.z * mid;
        if (ro.y + rd.y * mid - heightAt(mx, mz) > 0) lo2 = mid; else hi2 = mid;
      }
      var tf = (lo2 + hi2) * 0.5;
      var fx = ro.x + rd.x * tf, fz = ro.z + rd.z * tf;
      if (Math.abs(fx) > hw + 1e-3 || Math.abs(fz) > hd + 1e-3) return null;
      return out.set(fx, heightAt(fx, fz), fz);
    }
    pt = tc; prev = cur;
  }
  return null;
}

export var _rayO = new THREE.Vector3(), _rayD = new THREE.Vector3(), _ndc = new THREE.Vector3();
export function screenRay(px, py) {
  _ndc.set((px / viewW) * 2 - 1, -(py / viewH) * 2 + 1, 0.5);
  _ndc.unproject(camera);
  _rayO.copy(camera.position);
  _rayD.copy(_ndc).sub(_rayO).normalize();
  return true;
}

/* --------------------------------------------------------------------------
   Sculpt brush — raise / lower / smooth / flatten on the sculpt offset grid.
   -------------------------------------------------------------------------- */

/* ==========================================================================
   6b. HEIGHTMAP TERRAIN
   --------------------------------------------------------------------------
   Replaces the Phase 1 baseplate noise with a seeded landform generator plus a
   full sculpt brush set. These are plain function declarations that shadow the
   Phase 1 versions of the same name, so every existing caller — heightAt(),
   raycastGround(), grass re-snapping — keeps working unchanged.
   ========================================================================== */

export var RES_CHOICES = [64, 128, 256, 512];

export function terrainSegs() {
  if (state.plate.mode === 'flat') return 1;
  var r = state.plate.resolution;
  var best = RES_CHOICES[0];
  for (var i = 0; i < RES_CHOICES.length; i++) if (Math.abs(RES_CHOICES[i] - r) < Math.abs(best - r)) best = RES_CHOICES[i];
  return best;
}

/* Seed only shifts the sample domain — cheaper than reseeding the permutation
   table and just as effective for "give me a different mountain range". */
export function seedOffsets() {
  var s = state.plate.seed >>> 0;
  return [((s % 9973) * 0.731) % 5000 + 13.7, (((s >>> 7) % 9871) * 0.917) % 5000 - 21.3];
}

export function landformSample(x, z, ox, oz) {
  var p = state.plate;
  var f = Math.max(0.0005, p.frequency);
  var oct = clamp(Math.round(p.octaves), 1, 6);
  var n = SN.fbm((x + ox) * f, (z + oz) * f, oct);

  switch (p.landform) {
    case 'flat': return 0;

    case 'rolling': return n;

    case 'mountains': {
      // Ridged multifractal: folding the noise about zero turns smooth hills
      // into sharp crests, then a low-frequency mask keeps some areas low so
      // the range has passes and foothills instead of uniform spikes.
      var r = SN.fbm((x + ox) * f * 0.62, (z + oz) * f * 0.62, oct);
      var ridge = 1 - Math.abs(r);
      ridge = ridge * ridge * ridge;
      var mask = SN.fbm((x + ox) * f * 0.21, (z + oz) * f * 0.21, 2) * 0.5 + 0.5;
      return (ridge * 2.3 - 0.55) * (0.3 + 1.0 * mask) + n * 0.18;
    }

    case 'valley': {
      var wob = SN.noise((z + oz) * f * 0.55, 11.3) * p.width * 0.18;
      var d = Math.abs(x - wob) / (p.width * 0.5);
      return n * 0.3 + smoothstep(0.10, 0.9, d) * 1.7 - 0.42;
    }

    case 'island': {
      var rx = x / (p.width * 0.5), rz = z / (p.depth * 0.5);
      var dd = Math.sqrt(rx * rx + rz * rz);
      var fall = 1 - smoothstep(0.30, 1.0, dd + n * 0.09);
      return (n * 0.5 + 0.6) * fall * 2.1 - 0.55;
    }

    case 'plateau': {
      var v = n * 0.5 + 0.5;
      var st = v * 3.4;
      var base = Math.floor(st) / 3.4;
      // soften the riser so the terraces are cut, not stamped
      var frac = st - Math.floor(st);
      return (base + smoothstep(0.62, 0.98, frac) * (1 / 3.4)) * 2 - 1;
    }

    case 'canyon': {
      var cxx = SN.noise((z + oz) * f * 0.42, 4.7) * p.width * 0.3;
      var d3 = Math.abs(x - cxx) / (p.width * 0.5);
      var carve = 1 - smoothstep(0.015, 0.16, d3);
      var walls = smoothstep(0.10, 0.30, d3);
      return n * 0.35 + 0.45 * walls - carve * 2.4;
    }
  }
  return n;
}

export function computeTerrainHeights() {
  var p = state.plate, N = Terrain.N, W = N + 1;
  var base = Terrain.base, h = Terrain.h, sc = Terrain.sculpt;
  if (p.mode === 'flat') {
    for (var k = 0; k < W * W; k++) { base[k] = 0; h[k] = 0; }
    Terrain.min = 0; Terrain.max = 0;
    return;
  }
  var off = seedOffsets(), ox = off[0], oz = off[1];
  var amp = p.amplitude * p.heightScale;
  var mn = 1e9, mx = -1e9;
  for (var j = 0; j < W; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = 0; i < W; i++) {
      var x = (i / N - 0.5) * p.width;
      var idx = j * W + i;
      base[idx] = landformSample(x, z, ox, oz) * amp;
      var v = base[idx] + sc[idx];
      h[idx] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  Terrain.min = mn; Terrain.max = mx;
}

export function recomputeTerrainBounds() {
  var mn = 1e9, mx = -1e9, h = Terrain.h;
  for (var k = 0; k < h.length; k++) { if (h[k] < mn) mn = h[k]; if (h[k] > mx) mx = h[k]; }
  Terrain.min = mn; Terrain.max = mx;
}

/* Full regenerate: new seed / landform / resolution. Everything sitting on the
   surface is re-projected afterwards. */
export function regenerateTerrain(newSeed) {
  if (newSeed !== undefined) state.plate.seed = newSeed >>> 0;
  Terrain.sculpt.fill(0);
  rebuildPlate();
  rebuildWater();
  resnapWorld();
  markSceneDirty();
}

/* ==========================================================================
   SCULPT BRUSHES
   ========================================================================== */
export var SCULPT_INVERT = { raise: 'lower', lower: 'raise', smooth: 'noise', noise: 'smooth',
                      flatten: 'flatten', erode: 'erode', ramp: 'ramp' };

export var Sculpt = {
  holdT: 0,
  flatH: 0,
  snap: null,          // sculpt array copy taken at stroke start
  ramp: null,          // {ax, az, ah}
  dirty: false
};

export function sculptCellRect(cx, cz, r) {
  var p = state.plate, N = Terrain.N;
  return {
    i0: clamp(Math.floor(((cx - r) / p.width + 0.5) * N), 0, N),
    i1: clamp(Math.ceil(((cx + r) / p.width + 0.5) * N), 0, N),
    j0: clamp(Math.floor(((cz - r) / p.depth + 0.5) * N), 0, N),
    j1: clamp(Math.ceil(((cz + r) / p.depth + 0.5) * N), 0, N)
  };
}

export function beginSculptStroke(cx, cz) {
  Sculpt.holdT = 0;
  Sculpt.flatH = heightAt(cx, cz);
  Sculpt.snap = Terrain.sculpt.slice();
  Sculpt.ramp = { ax: cx, az: cz, ah: heightAt(cx, cz) };
}

/* Diff the stroke against its opening snapshot and store only the rectangle
   that actually moved — a 512 grid would otherwise cost 1 MB per undo step. */
export function endSculptStroke() {
  if (!Sculpt.snap) return;
  var N = Terrain.N, W = N + 1, sc = Terrain.sculpt, sn = Sculpt.snap;
  var i0 = 1e9, j0 = 1e9, i1 = -1, j1 = -1;
  for (var j = 0; j < W; j++) {
    for (var i = 0; i < W; i++) {
      var k = j * W + i;
      if (sc[k] !== sn[k]) {
        if (i < i0) i0 = i; if (i > i1) i1 = i;
        if (j < j0) j0 = j; if (j > j1) j1 = j;
      }
    }
  }
  Sculpt.snap = null;
  if (i1 < 0) return;
  var w = i1 - i0 + 1, hgt = j1 - j0 + 1;
  var before = new Float32Array(w * hgt), after = new Float32Array(w * hgt);
  for (var jj = 0; jj < hgt; jj++) {
    for (var ii = 0; ii < w; ii++) {
      var src = (j0 + jj) * W + (i0 + ii), dst = jj * w + ii;
      before[dst] = sn[src]; after[dst] = sc[src];
    }
  }
  recordOp({ t: 'terr', N: N, i0: i0, j0: j0, w: w, h: hgt, before: before, after: after,
             data: after });   // `data` so the history byte accounting sees it
}

export function applyTerrainPatch(op, useBefore) {
  if (op.N !== Terrain.N) return;                 // resolution changed underneath
  var W = Terrain.N + 1, src = useBefore ? op.before : op.after;
  for (var j = 0; j < op.h; j++)
    for (var i = 0; i < op.w; i++)
      Terrain.sculpt[(op.j0 + j) * W + (op.i0 + i)] = src[j * op.w + i];
  for (var k = 0; k < Terrain.h.length; k++) Terrain.h[k] = Terrain.base[k] + Terrain.sculpt[k];
  recomputeTerrainBounds();
  updateGroundVerts(0, Terrain.N);
  Terrain.geo.computeBoundingSphere();
  resnapAll();
  resnapWorld();
  Water.dirty = true;
}

/* Writes a height delta into the sculpt layer and keeps Terrain.h in step. */
export function sculptWrite(k, delta) {
  Terrain.sculpt[k] += delta;
  Terrain.h[k] = Terrain.base[k] + Terrain.sculpt[k];
}

export function sculptStamp(cx, cz, dt) {
  var p = state.plate, b = state.brush, s = state.sculpt;
  if (p.mode !== 'terrain') return;
  var N = Terrain.N, W = N + 1, r = b.radius;
  var mode = s.mode;
  if (Keys.alt) mode = SCULPT_INVERT[mode] || mode;
  if (mode === 'ramp') return;                    // applied on release

  // Strength ramps the longer the brush is held in one place, so a peak grows
  // under a parked cursor instead of needing twenty passes.
  Sculpt.holdT += dt;
  var ramp = 1 + Math.min(Sculpt.holdT * 0.7, 2.2);
  var amt = s.strength * dt * 5.0 * ramp;
  var edge = lerp(0.05, 0.96, b.falloff);
  var rc = sculptCellRect(cx, cz, r);
  var off = seedOffsets();

  if (mode === 'erode') { erodeStamp(cx, cz, dt); }
  else {
    for (var j = rc.j0; j <= rc.j1; j++) {
      var z = (j / N - 0.5) * p.depth;
      for (var i = rc.i0; i <= rc.i1; i++) {
        var x = (i / N - 0.5) * p.width;
        var dx = x - cx, dz = z - cz;
        var dd = Math.sqrt(dx * dx + dz * dz) / r;
        if (dd > 1) continue;
        var w = 1 - smoothstep(edge, 1, dd);
        var k = j * W + i;

        if (mode === 'raise') sculptWrite(k, amt * w);
        else if (mode === 'lower') sculptWrite(k, -amt * w);
        else if (mode === 'flatten') {
          sculptWrite(k, (Sculpt.flatH - Terrain.h[k]) * clamp(amt * w * 1.6, 0, 1));
        } else if (mode === 'smooth') {
          var hl = Terrain.h[j * W + Math.max(i - 1, 0)], hr = Terrain.h[j * W + Math.min(i + 1, N)];
          var hb = Terrain.h[Math.max(j - 1, 0) * W + i], ht = Terrain.h[Math.min(j + 1, N) * W + i];
          sculptWrite(k, ((hl + hr + hb + ht) * 0.25 - Terrain.h[k]) * clamp(amt * w * 1.8, 0, 1));
        } else if (mode === 'noise') {
          var ns = Math.max(0.02, s.noiseScale);
          var v = SN.fbm((x + off[0]) / ns * 0.5, (z + off[1]) / ns * 0.5, 3);
          sculptWrite(k, v * amt * w * 1.4);
        }
      }
    }
  }

  Terrain.min = Math.min(Terrain.min, -1e-6);
  recomputeTerrainBounds();
  updateGroundVerts(Math.max(rc.j0 - 1, 0), Math.min(rc.j1 + 1, N));
  resnapRegion(cx, cz, r + 1.5);
  resnapWorldRegion(cx, cz, r + 2.5);
  Water.dirty = true;
  Sculpt.dirty = true;
}

/* --------------------------------------------------------------------------
   Thermal erosion. For every cell steeper than the talus angle, material
   slides to its lowest neighbour. A few iterations per stamp is enough to cut
   gullies into a ridge and settle scree at the base of a cliff.
   -------------------------------------------------------------------------- */
export function erodeStamp(cx, cz, dt) {
  var p = state.plate, b = state.brush, s = state.sculpt;
  var N = Terrain.N, W = N + 1, r = b.radius;
  var rc = sculptCellRect(cx, cz, r);
  var cw = p.width / N;
  var talus = Math.max(0.05, s.talus) * cw;
  var rate = clamp(s.strength * dt * 6, 0, 0.55);
  var edge = lerp(0.05, 0.96, b.falloff);
  var iters = clamp(Math.round(s.erodeIters), 1, 6);
  var NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (var it = 0; it < iters; it++) {
    for (var j = rc.j0; j <= rc.j1; j++) {
      var z = (j / N - 0.5) * p.depth;
      for (var i = rc.i0; i <= rc.i1; i++) {
        var x = (i / N - 0.5) * p.width;
        var dx = x - cx, dz = z - cz;
        var dd = Math.sqrt(dx * dx + dz * dz) / r;
        if (dd > 1) continue;
        var w = (1 - smoothstep(edge, 1, dd)) * rate;
        if (w <= 0) continue;
        var k = j * W + i;
        var lowest = -1, drop = 0;
        for (var q = 0; q < 4; q++) {
          var ni = i + NB[q][0], nj = j + NB[q][1];
          if (ni < 0 || nj < 0 || ni > N || nj > N) continue;
          var nk = nj * W + ni;
          var d2 = Terrain.h[k] - Terrain.h[nk];
          if (d2 > drop) { drop = d2; lowest = nk; }
        }
        if (lowest >= 0 && drop > talus) {
          var move = (drop - talus) * 0.42 * w;
          sculptWrite(k, -move);
          sculptWrite(lowest, move);
        }
      }
    }
  }
}

/* Ramp: press at A, release at B. The graded surface runs linearly between
   the two sampled heights, blended in by the brush falloff across its width. */
export function applyRamp(bx, bz) {
  var a = Sculpt.ramp;
  if (!a) return;
  var p = state.plate, b = state.brush, N = Terrain.N, W = N + 1;
  var bh = heightAt(bx, bz);
  var vx = bx - a.ax, vz = bz - a.az;
  var len2 = vx * vx + vz * vz;
  if (len2 < 1e-4) return;
  var r = b.radius, edge = lerp(0.05, 0.96, b.falloff);
  var minX = Math.min(a.ax, bx) - r, maxX = Math.max(a.ax, bx) + r;
  var minZ = Math.min(a.az, bz) - r, maxZ = Math.max(a.az, bz) + r;
  var i0 = clamp(Math.floor((minX / p.width + 0.5) * N), 0, N);
  var i1 = clamp(Math.ceil((maxX / p.width + 0.5) * N), 0, N);
  var j0 = clamp(Math.floor((minZ / p.depth + 0.5) * N), 0, N);
  var j1 = clamp(Math.ceil((maxZ / p.depth + 0.5) * N), 0, N);

  for (var j = j0; j <= j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = i0; i <= i1; i++) {
      var x = (i / N - 0.5) * p.width;
      var t = ((x - a.ax) * vx + (z - a.az) * vz) / len2;
      var tc = clamp(t, 0, 1);
      var px = a.ax + vx * tc, pz = a.az + vz * tc;
      var dx = x - px, dz = z - pz;
      var dd = Math.sqrt(dx * dx + dz * dz) / r;
      if (dd > 1) continue;
      var w = 1 - smoothstep(edge, 1, dd);
      var target = lerp(a.ah, bh, tc);
      var k = j * W + i;
      sculptWrite(k, (target - Terrain.h[k]) * w);
    }
  }
  recomputeTerrainBounds();
  updateGroundVerts(0, N);
  Terrain.geo.computeBoundingSphere();
  resnapAll();
  resnapWorld();
  Water.dirty = true;
}

/* Surface steepness helper shared by grass placement and scatter limits. */
export var _slopeN = new THREE.Vector3();
export function normalYAt(x, z) {
  if (state.plate.mode === 'flat') return 1;
  normalAt(x, z, _slopeN);
  return _slopeN.y;
}

