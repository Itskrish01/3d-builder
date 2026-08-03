import * as THREE from 'three';
import { kindsOfType } from './actors.js';
import { ASSETS } from './assets.js';
import { Grass, resnapAll } from './grass.js';
import { beginStroke, endStroke, recordOp, removeBlades } from './history.js';
import { markSceneDirty } from './persistence.js';
import { Env, scene } from './renderer.js';
import { ROAD_FS, ROAD_VS } from './shaders.js';
import { state } from './state.js';
import { Sculpt, Terrain, endSculptStroke, heightAt, recomputeTerrainBounds, sculptCellRect, updateGroundVerts } from './terrain.js';
import { TAU, clamp, hexLin, lerp, rnd, smoothstep } from './util.js';
import { Water } from './water.js';
import { LayerState, World, addObject, deleteObject, recordObjAdd, recordObjDel, resnapWorld } from './world.js';

/* ==========================================================================
   22. ROADS
   --------------------------------------------------------------------------
   Roads are Catmull-Rom splines sampled into ribbons. They follow the terrain
   through a smoothed height profile and then flatten (or, for rivers, carve)
   the ground beneath themselves, so they can never float or clip. Geometry is
   merged per material, which keeps the whole network to a handful of draws.
   ========================================================================== */
export var ROAD_TYPES = {
  highway:     { label: 'Highway',     width: 13, material: 'asphalt',  markings: true,  sw: false, prio: 5 },
  street:      { label: 'City street', width: 8.5, material: 'asphalt', markings: true,  sw: true,  prio: 4 },
  residential: { label: 'Residential', width: 6.2, material: 'concrete', markings: false, sw: true, prio: 3 },
  dirt:        { label: 'Dirt path',   width: 3.4, material: 'dirt',     markings: false, sw: false, prio: 2 },
  foot:        { label: 'Footpath',    width: 2.1, material: 'cobble',   markings: false, sw: false, prio: 2 },
  river:       { label: 'River',       width: 10, material: 'water',     markings: false, sw: false, prio: 1 }
};
export var ROAD_MATS = {
  asphalt:  { surface: '#3b3f45', edge: '#2e3238', line: '#d8d2be', walk: '#9a9a94', grain: 1, water: 0 },
  concrete: { surface: '#8d8c85', edge: '#77766f', line: '#e0dccc', walk: '#a3a29a', grain: 0.7, water: 0 },
  cobble:   { surface: '#7d7367', edge: '#655d53', line: '#c9c2b2', walk: '#8d8478', grain: 1.5, water: 0 },
  gravel:   { surface: '#8a8175', edge: '#6f6759', line: '#c9c2b2', walk: '#96907f', grain: 1.8, water: 0 },
  dirt:     { surface: '#6d5940', edge: '#57462f', line: '#c9c2b2', walk: '#7a6749', grain: 1.6, water: 0 },
  water:    { surface: '#2f6f8f', edge: '#1e4d66', line: '#ffffff', walk: '#2f6f8f', grain: 0.4, water: 1 }
};
export var ROAD_MAT_LIST = ['asphalt', 'concrete', 'cobble', 'gravel', 'dirt', 'water'];

export var Roads = { group: null, meshes: {}, mask: null, maskN: 96, dirty: true, nextId: 1 };

export function createRoads() {
  Roads.group = new THREE.Group();
  scene.add(Roads.group);
  Roads.mask = new Uint8Array(Roads.maskN * Roads.maskN);
  for (var i = 0; i < ROAD_MAT_LIST.length; i++) {
    var m = ROAD_MAT_LIST[i], cfg = ROAD_MATS[m];
    var mat = new THREE.ShaderMaterial({
      vertexShader: ROAD_VS, fragmentShader: ROAD_FS,
      uniforms: {
        uSurface: { value: hexLin(cfg.surface, new THREE.Vector3()) },
        uEdge: { value: hexLin(cfg.edge, new THREE.Vector3()) },
        uLine: { value: hexLin(cfg.line, new THREE.Vector3()) },
        uWalk: { value: hexLin(cfg.walk, new THREE.Vector3()) },
        uMarkings: { value: 1 }, uGrain: { value: cfg.grain }, uWater: { value: cfg.water },
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Vector3() },
        uSkyColor: { value: new THREE.Vector3() }, uGroundColor: { value: new THREE.Vector3() },
        uAmbient: { value: 1 }, uExposure: { value: 1.05 },
        uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0.0075 }
      },
      side: THREE.DoubleSide,
      transparent: cfg.water > 0,
      depthWrite: cfg.water === 0
    });
    var mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = cfg.water > 0 ? 30 : 5;
    Roads.group.add(mesh);
    Roads.meshes[m] = mesh;
  }
}

export function syncRoadUniforms() {
  for (var i = 0; i < ROAD_MAT_LIST.length; i++) {
    var mesh = Roads.meshes[ROAD_MAT_LIST[i]];
    if (!mesh) continue;
    var u = mesh.material.uniforms;
    u.uSunDir.value.copy(Env.sunDir);
    u.uSunColor.value.copy(Env.sun);
    u.uSkyColor.value.copy(Env.amb);
    u.uGroundColor.value.copy(Env.gnd);
    u.uAmbient.value = Env.ambient;
    u.uExposure.value = state.env.exposure;
    u.uFogColor.value.copy(Env.fog);
    u.uFogDensity.value = state.env.fogDensity;
  }
}

/* ---- spline -------------------------------------------------------------- */
export function catmull(p0, p1, p2, p3, t) {
  var t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
export function splinePoint(pts, u) {
  var n = pts.length;
  if (n === 0) return { x: 0, z: 0 };
  if (n === 1) return { x: pts[0].x, z: pts[0].z };
  var seg = clamp(Math.floor(u), 0, n - 2);
  var t = clamp(u - seg, 0, 1);
  var p0 = pts[Math.max(seg - 1, 0)], p1 = pts[seg], p2 = pts[seg + 1], p3 = pts[Math.min(seg + 2, n - 1)];
  return { x: catmull(p0.x, p1.x, p2.x, p3.x, t), z: catmull(p0.z, p1.z, p2.z, p3.z, t) };
}

/* Sample the spline at roughly uniform spacing and attach a smoothed terrain
   height profile — a raw terrain sample makes the surface wobble. */
export function roadSamples(rd) {
  if (rd._s && !rd._dirty) return rd._s;
  var pts = rd.pts;
  if (pts.length < 2) { rd._s = []; rd._dirty = false; return rd._s; }
  var out = [];
  var total = pts.length - 1;
  var dist = 0, px = 0, pz = 0;
  for (var s = 0; s < total; s++) {
    var approx = Math.hypot(pts[s + 1].x - pts[s].x, pts[s + 1].z - pts[s].z);
    var steps = clamp(Math.ceil(approx / 1.4), 2, 90);
    for (var i = 0; i < steps; i++) {
      var u = s + i / steps;
      var p = splinePoint(pts, u);
      if (out.length) dist += Math.hypot(p.x - px, p.z - pz);
      px = p.x; pz = p.z;
      out.push({ x: p.x, z: p.z, d: dist, y: 0, tx: 0, tz: 0 });
    }
  }
  var last = splinePoint(pts, total);
  dist += Math.hypot(last.x - px, last.z - pz);
  out.push({ x: last.x, z: last.z, d: dist, y: 0, tx: 0, tz: 0 });

  for (var k = 0; k < out.length; k++) out[k].y0 = heightAt(out[k].x, out[k].z);
  // moving average smooths the height profile without moving the road plan
  var win = Math.max(1, Math.round(rd.flatten * 9));
  for (var k2 = 0; k2 < out.length; k2++) {
    var acc = 0, cnt = 0;
    for (var w = -win; w <= win; w++) {
      var idx = clamp(k2 + w, 0, out.length - 1);
      acc += out[idx].y0; cnt++;
    }
    out[k2].y = acc / cnt;
  }
  for (var k3 = 0; k3 < out.length; k3++) {
    var a = out[Math.max(k3 - 1, 0)], b = out[Math.min(k3 + 1, out.length - 1)];
    var dx = b.x - a.x, dz = b.z - a.z;
    var l = Math.hypot(dx, dz) || 1;
    out[k3].tx = dx / l; out[k3].tz = dz / l;
  }
  rd._s = out; rd._dirty = false;
  rd.length = dist;
  return out;
}

export function roadDefaults(type) {
  var t = ROAD_TYPES[type] || ROAD_TYPES.street, r = state.road;
  return {
    type: type, width: r.width || t.width, material: r.material || t.material,
    markings: r.markings && t.markings, curb: r.curb,
    swL: r.sidewalkL && t.sw, swR: r.sidewalkR && t.sw, swW: r.sidewalkW,
    flatten: r.flatten, carve: type === 'river' ? r.carve : 0,
    prio: t.prio
  };
}

export function newRoad(type, pts) {
  var d = roadDefaults(type);
  var rd = {
    id: Roads.nextId++, type: type, pts: pts.slice(),
    width: d.width, material: d.material, markings: d.markings, curb: d.curb,
    swL: d.swL, swR: d.swR, swW: d.swW, flatten: d.flatten, carve: d.carve, prio: d.prio,
    deco: { lights: state.road.autoLights, trees: state.road.autoTrees, signs: state.road.autoSigns },
    decoIds: [], _dirty: true
  };
  return rd;
}
export function serRoad(rd) {
  return {
    i: rd.id, t: rd.type, p: rd.pts.map(function (p) { return [+p.x.toFixed(2), +p.z.toFixed(2)]; }),
    w: rd.width, m: rd.material, mk: rd.markings ? 1 : 0, cu: rd.curb,
    l: rd.swL ? 1 : 0, r: rd.swR ? 1 : 0, sw: rd.swW, f: rd.flatten, cv: rd.carve, pr: rd.prio,
    d: [rd.deco.lights ? 1 : 0, rd.deco.trees ? 1 : 0, rd.deco.signs ? 1 : 0]
  };
}
export function addRoadRecord(r) {
  var rd = {
    id: r.i, type: r.t, pts: r.p.map(function (p) { return { x: p[0], z: p[1] }; }),
    width: r.w, material: r.m, markings: !!r.mk, curb: r.cu,
    swL: !!r.l, swR: !!r.r, swW: r.sw, flatten: r.f, carve: r.cv, prio: r.pr,
    deco: { lights: !!r.d[0], trees: !!r.d[1], signs: !!r.d[2] }, decoIds: [], _dirty: true
  };
  World.roads.push(rd);
  if (Roads.nextId <= rd.id) Roads.nextId = rd.id + 1;
  return rd;
}
export function applyRoadRecords(list) {
  for (var i = 0; i < list.length; i++) {
    var r = list[i], rd = roadById(r.i);
    if (!rd) { addRoadRecord(r); continue; }
    rd.pts = r.p.map(function (p) { return { x: p[0], z: p[1] }; });
    rd.width = r.w; rd.material = r.m; rd.markings = !!r.mk; rd.curb = r.cu;
    rd.swL = !!r.l; rd.swR = !!r.r; rd.swW = r.sw; rd.flatten = r.f; rd.carve = r.cv;
    rd._dirty = true;
  }
  rebuildAllRoads();
}
export function roadById(id) {
  for (var i = 0; i < World.roads.length; i++) if (World.roads[i].id === id) return World.roads[i];
  return null;
}
export function removeRoadById(id, silent) {
  for (var i = 0; i < World.roads.length; i++) {
    if (World.roads[i].id !== id) continue;
    clearRoadDeco(World.roads[i]);
    World.roads.splice(i, 1);
    break;
  }
  if (!silent) rebuildAllRoads(); else Roads.dirty = true;
}

/* ---- terrain shaping ----------------------------------------------------- */
export function applyRoadToTerrain(rd) {
  if (state.plate.mode !== 'terrain') return;
  var s = roadSamples(rd);
  if (s.length < 2) return;
  var p = state.plate, N = Terrain.N, W = N + 1;
  var half = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW : 0);
  var reach = half * 1.9;
  for (var k = 0; k < s.length; k++) {
    var pt = s[k];
    var target = pt.y - (rd.carve || 0);
    var rc = sculptCellRect(pt.x, pt.z, reach);
    for (var j = rc.j0; j <= rc.j1; j++) {
      var z = (j / N - 0.5) * p.depth;
      for (var i = rc.i0; i <= rc.i1; i++) {
        var x = (i / N - 0.5) * p.width;
        var dx = x - pt.x, dz = z - pt.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d > reach) continue;
        var w = 1 - smoothstep(half * 0.9, reach, d);
        if (w <= 0) continue;
        var idx = j * W + i;
        var cur = Terrain.base[idx] + Terrain.sculpt[idx];
        Terrain.sculpt[idx] += (target - cur) * w * (rd.carve ? 1 : rd.flatten);
        Terrain.h[idx] = Terrain.base[idx] + Terrain.sculpt[idx];
      }
    }
  }
  recomputeTerrainBounds();
  updateGroundVerts(0, N);
  Terrain.geo.computeBoundingSphere();
  Water.dirty = true;
}

/* ---- geometry ------------------------------------------------------------ */
export function rebuildAllRoads() {
  var buckets = {};
  for (var m = 0; m < ROAD_MAT_LIST.length; m++) buckets[ROAD_MAT_LIST[m]] = { p: [], n: [], uv: [], k: [] };

  for (var r = 0; r < World.roads.length; r++) emitRoad(World.roads[r], buckets);
  emitJunctions(buckets);

  for (var mm = 0; mm < ROAD_MAT_LIST.length; mm++) {
    var name = ROAD_MAT_LIST[mm], b = buckets[name], mesh = Roads.meshes[name];
    if (!mesh) continue;
    var g = mesh.geometry;
    g.dispose();
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.n), 3));
    g.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(b.k), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    mesh.geometry = g;
    mesh.material.uniforms.uMarkings.value = 1;
    mesh.visible = b.p.length > 0 && LayerState.roads.vis;
  }
  rebuildRoadMask();
  Roads.dirty = false;
}

export function pushStrip(b, ax, ay, az, bx, by, bz, cx, cy, cz, dx2, dy2, dz2, u0, u1, v0, v1, kind) {
  var P = b.p, N = b.n, U = b.uv, K = b.k;
  function tri(x1, y1, z1, x2, y2, z2, x3, y3, z3, ua, va, ub, vb, uc, vc) {
    var ux = x2 - x1, uy = y2 - y1, uz = z2 - z1;
    var vx = x3 - x1, vy = y3 - y1, vz = z3 - z1;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    P.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
    N.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
    U.push(ua, va, ub, vb, uc, vc);
    K.push(kind, kind, kind);
  }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, u0, v0, u1, v0, u1, v1);
  tri(ax, ay, az, cx, cy, cz, dx2, dy2, dz2, u0, v0, u1, v1, u0, v1);
}

export function emitRoad(rd, buckets) {
  var s = roadSamples(rd);
  if (s.length < 2) return;
  var b = buckets[rd.material] || buckets.asphalt;
  var half = rd.width * 0.5;
  // Priority lift: wider / more important roads sit fractionally higher so
  // overlaps resolve deterministically instead of z-fighting.
  var lift = 0.02 + rd.prio * 0.006;
  var swb = buckets[rd.material === 'water' ? 'concrete' : rd.material] || b;

  for (var i = 0; i < s.length - 1; i++) {
    var a = s[i], c = s[i + 1];
    var anx = -a.tz, anz = a.tx, cnx = -c.tz, cnz = c.tx;
    pushStrip(b,
      a.x + anx * half, a.y + lift, a.z + anz * half,
      a.x - anx * half, a.y + lift, a.z - anz * half,
      c.x - cnx * half, c.y + lift, c.z - cnz * half,
      c.x + cnx * half, c.y + lift, c.z + cnz * half,
      1, -1, a.d, c.d, 0);

    if (rd.swL || rd.swR) {
      var sides = [];
      if (rd.swL) sides.push(1);
      if (rd.swR) sides.push(-1);
      for (var q = 0; q < sides.length; q++) {
        var sgn = sides[q];
        var o0 = half, o1 = half + rd.swW;
        var cy = lift + rd.curb;
        pushStrip(swb,
          a.x + anx * o0 * sgn, a.y + cy, a.z + anz * o0 * sgn,
          a.x + anx * o1 * sgn, a.y + cy, a.z + anz * o1 * sgn,
          c.x + cnx * o1 * sgn, c.y + cy, c.z + cnz * o1 * sgn,
          c.x + cnx * o0 * sgn, c.y + cy, c.z + cnz * o0 * sgn,
          0, 1, a.d, c.d, 1);
        // curb face
        pushStrip(swb,
          a.x + anx * o0 * sgn, a.y + lift, a.z + anz * o0 * sgn,
          a.x + anx * o0 * sgn, a.y + cy, a.z + anz * o0 * sgn,
          c.x + cnx * o0 * sgn, c.y + cy, c.z + cnz * o0 * sgn,
          c.x + cnx * o0 * sgn, c.y + lift, c.z + cnz * o0 * sgn,
          0, 0.4, a.d, c.d, 1);
      }
    }
  }
}

/* Where two centrelines cross, drop a patch sized to the wider road on top of
   both ribbons. One clean quad instead of two overlapping surfaces. */
export function segIntersect(a1, a2, b1, b2) {
  var d1x = a2.x - a1.x, d1z = a2.z - a1.z;
  var d2x = b2.x - b1.x, d2z = b2.z - b1.z;
  var den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return null;
  var t = ((b1.x - a1.x) * d2z - (b1.z - a1.z) * d2x) / den;
  var u = ((b1.x - a1.x) * d1z - (b1.z - a1.z) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + d1x * t, z: a1.z + d1z * t, t: t };
}
export function emitJunctions(buckets) {
  var R = World.roads;
  for (var i = 0; i < R.length; i++) {
    var A = R[i];
    if (A.type === 'river') continue;
    var sa = roadSamples(A);
    for (var j = i + 1; j < R.length; j++) {
      var B = R[j];
      if (B.type === 'river') continue;
      var sb = roadSamples(B);
      var found = [];
      for (var a = 0; a < sa.length - 1; a += 2) {
        for (var b2 = 0; b2 < sb.length - 1; b2 += 2) {
          var hit = segIntersect(sa[a], sa[a + 2] || sa[sa.length - 1], sb[b2], sb[b2 + 2] || sb[sb.length - 1]);
          if (!hit) continue;
          var dup = false;
          for (var f = 0; f < found.length; f++)
            if (Math.hypot(found[f].x - hit.x, found[f].z - hit.z) < Math.max(A.width, B.width)) { dup = true; break; }
          if (dup) continue;
          found.push(hit);
          var wide = Math.max(A.width, B.width) * 0.5 + 0.15;
          var y = Math.max(heightAt(hit.x, hit.z), 0) * 0 + interpRoadY(sa, hit) + 0.02 +
                  Math.max(A.prio, B.prio) * 0.006 + 0.004;
          var tx = sa[a].tx, tz = sa[a].tz;
          var nx = -tz, nz = tx;
          var bucket = buckets[A.width >= B.width ? A.material : B.material] || buckets.asphalt;
          pushStrip(bucket,
            hit.x + (tx + nx) * wide, y, hit.z + (tz + nz) * wide,
            hit.x + (tx - nx) * wide, y, hit.z + (tz - nz) * wide,
            hit.x + (-tx - nx) * wide, y, hit.z + (-tz - nz) * wide,
            hit.x + (-tx + nx) * wide, y, hit.z + (-tz + nz) * wide,
            1, -1, 0, wide * 2, 2);
        }
      }
    }
  }
}
export function interpRoadY(s, hit) {
  var best = 1e9, y = 0;
  for (var i = 0; i < s.length; i++) {
    var d = (s[i].x - hit.x) * (s[i].x - hit.x) + (s[i].z - hit.z) * (s[i].z - hit.z);
    if (d < best) { best = d; y = s[i].y; }
  }
  return y;
}

/* ---- coverage mask ------------------------------------------------------- */
export function rebuildRoadMask() {
  var n = Roads.maskN, p = state.plate;
  Roads.mask.fill(0);
  for (var r = 0; r < World.roads.length; r++) {
    var rd = World.roads[r], s = roadSamples(rd);
    var half = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW : 0);
    for (var k = 0; k < s.length; k++) {
      var pt = s[k];
      var i0 = clamp(Math.floor(((pt.x - half) / p.width + 0.5) * n), 0, n - 1);
      var i1 = clamp(Math.ceil(((pt.x + half) / p.width + 0.5) * n), 0, n - 1);
      var j0 = clamp(Math.floor(((pt.z - half) / p.depth + 0.5) * n), 0, n - 1);
      var j1 = clamp(Math.ceil(((pt.z + half) / p.depth + 0.5) * n), 0, n - 1);
      for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) Roads.mask[j * n + i] = 1;
    }
  }
}
export function roadCovers(x, z, _margin) {
  var n = Roads.maskN, p = state.plate;
  var i = ((x / p.width + 0.5) * n) | 0, j = ((z / p.depth + 0.5) * n) | 0;
  if (i < 0 || j < 0 || i >= n || j >= n) return false;
  return Roads.mask[j * n + i] === 1;
}

/* Nearest point on any road, with the outward normal — drives building snap. */
export function nearestRoadPoint(x, z, maxDist) {
  var best = null, bd = maxDist * maxDist;
  for (var r = 0; r < World.roads.length; r++) {
    var rd = World.roads[r];
    if (rd.type === 'river') continue;
    var s = roadSamples(rd);
    for (var k = 0; k < s.length; k++) {
      var dx = s[k].x - x, dz = s[k].z - z;
      var d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        var nx = -s[k].tz, nz = s[k].tx;
        var side = (x - s[k].x) * nx + (z - s[k].z) * nz;
        if (side < 0) { nx = -nx; nz = -nz; }
        best = { px: s[k].x, pz: s[k].z, nx: nx, nz: nz, width: rd.width + (rd.swL || rd.swR ? rd.swW * 2 : 0),
                 road: rd, idx: k };
      }
    }
  }
  return best;
}

/* ---- decoration ---------------------------------------------------------- */
export function clearRoadDeco(rd) {
  for (var i = 0; i < rd.decoIds.length; i++) {
    var o = World.byId[rd.decoIds[i]];
    if (o) deleteObject(o);
  }
  rd.decoIds.length = 0;
}
/* Auto-decoration needs to know which imported model is a lamp post and which
   is a tree — the panel picks those, and anything left unset falls back to any
   model of a sensible category. */
export function decoKind(pref, type) {
  if (pref && ASSETS[pref] && ASSETS[pref].kind === type) return pref;
  var list = kindsOfType(type);
  return list.length ? list[0] : null;
}
export function decorateRoad(rd) {
  clearRoadDeco(rd);
  var s = roadSamples(rd);
  if (s.length < 2) return [];
  var cfg = state.road, added = [];
  var half = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW * 0.55 : 0.6);
  var jit = cfg.decoJitter;

  function along(spacing, fn) {
    if (spacing <= 0.5) return;
    var next = spacing * 0.5;
    for (var k = 0; k < s.length; k++) {
      if (s[k].d < next) continue;
      next += spacing;
      fn(s[k], k);
    }
  }
  var lightK = decoKind(cfg.lightKind, 'prop');
  var treeK = cfg.treeKind && ASSETS[cfg.treeKind] ? cfg.treeKind : (kindsOfType('nature')[0] || null);
  var signK = decoKind(cfg.signKind, 'prop');
  if (rd.deco.lights && lightK) along(cfg.lightSpacing, function (pt, k) {
    var side = (k % 2) ? 1 : -1;
    var nx = -pt.tz * side, nz = pt.tx * side;
    var o = addObject(lightK, pt.x + nx * (half + 0.5), pt.z + nz * (half + 0.5), {
      rotY: Math.atan2(-nx, -nz), scale: 1, align: 0
    });
    if (o) { rd.decoIds.push(o.id); added.push(o); }
  });
  if (rd.deco.trees && treeK) along(cfg.treeSpacing, function (pt) {
    for (var side = -1; side <= 1; side += 2) {
      var nx = -pt.tz * side, nz = pt.tx * side;
      var jx = (rnd() - 0.5) * jit * 3, jz = (rnd() - 0.5) * jit * 3;
      var x = pt.x + nx * (half + 2.2) + jx, z = pt.z + nz * (half + 2.2) + jz;
      if (roadCovers(x, z)) continue;
      var o = addObject(treeK, x, z, {
        rotY: rnd() * TAU, scale: lerp(0.8, 1.15, rnd()), align: 0.2
      });
      if (o) { rd.decoIds.push(o.id); added.push(o); }
    }
  });
  if (rd.deco.signs && signK) along(cfg.lightSpacing * 2.4, function (pt, k) {
    var side = (k % 3) ? 1 : -1;
    var nx = -pt.tz * side, nz = pt.tx * side;
    var o = addObject(signK, pt.x + nx * (half + 0.9), pt.z + nz * (half + 0.9), {
      rotY: Math.atan2(-nx, -nz), scale: 1, align: 0
    });
    if (o) { rd.decoIds.push(o.id); added.push(o); }
  });
  return added;
}

/* ---- grass clearing ------------------------------------------------------ */
export function clearGrassUnderRoads() {
  if (!Grass.count) return;
  var A = Grass.arr, kill = [];
  for (var i = 0; i < Grass.count; i++) {
    var x = A.aOffset[i * 3], z = A.aOffset[i * 3 + 2];
    if (roadCovers(x, z)) kill.push(i);
  }
  if (kill.length) removeBlades(kill);
}

/* ---- commit -------------------------------------------------------------- */
export function commitRoad(rd) {
  beginStroke('Road');
  if (state.plate.mode === 'terrain') Sculpt.snap = Terrain.sculpt.slice();
  World.roads.push(rd);
  applyRoadToTerrain(rd);
  rebuildAllRoads();
  var deco = decorateRoad(rd);
  if (state.road.clearGrass) clearGrassUnderRoads();
  resnapAll();
  resnapWorld();
  recordOp({ t: 'radd', ids: [rd.id], recs: [serRoad(rd)], bytes: 400 });
  if (deco.length) recordObjAdd(deco);
  if (state.plate.mode === 'terrain') endSculptStroke();
  endStroke();
  markSceneDirty();
}

export function reshapeRoad(rd, beforeRec) {
  beginStroke('Edit road');
  if (state.plate.mode === 'terrain') Sculpt.snap = Terrain.sculpt.slice();
  rd._dirty = true;
  applyRoadToTerrain(rd);
  rebuildAllRoads();
  decorateRoad(rd);
  if (state.road.clearGrass) clearGrassUnderRoads();
  resnapAll(); resnapWorld();
  recordOp({ t: 'rmod', before: [beforeRec], after: [serRoad(rd)], bytes: 800 });
  if (state.plate.mode === 'terrain') endSculptStroke();
  endStroke();
  markSceneDirty();
}

export function deleteRoad(rd) {
  beginStroke('Delete road');
  var decoObjs = [];
  for (var i = 0; i < rd.decoIds.length; i++) { var o = World.byId[rd.decoIds[i]]; if (o) decoObjs.push(o); }
  if (decoObjs.length) recordObjDel(decoObjs);
  recordOp({ t: 'rdel', ids: [rd.id], recs: [serRoad(rd)], bytes: 400 });
  removeRoadById(rd.id);
  endStroke();
  markSceneDirty();
}

/* ---- vehicle routing ------------------------------------------------------
   Roads form a graph through their endpoints; a car reaching the end of one
   picks any road whose end is close by and continues onto it, which is what
   produces turns at intersections rather than cars vanishing. */
export function roadEndpoint(rd, atEnd) {
  var s = roadSamples(rd);
  if (!s.length) return null;
  return atEnd ? s[s.length - 1] : s[0];
}
export function pickNextRoad(rd, atEnd) {
  var here = roadEndpoint(rd, atEnd);
  if (!here) return null;
  var opts = [];
  for (var i = 0; i < World.roads.length; i++) {
    var o = World.roads[i];
    if (o.type === 'river' || o.type === 'foot') continue;
    if (o.id === rd.id) continue;
    var a = roadEndpoint(o, false), b = roadEndpoint(o, true);
    if (a && Math.hypot(a.x - here.x, a.z - here.z) < Math.max(o.width, rd.width) * 1.4) opts.push({ rd: o, dir: 1 });
    if (b && Math.hypot(b.x - here.x, b.z - here.z) < Math.max(o.width, rd.width) * 1.4) opts.push({ rd: o, dir: -1 });
  }
  if (!opts.length) return null;
  return opts[(rnd() * opts.length) | 0];
}
export function roadPose(rd, dist, lane) {
  var s = roadSamples(rd);
  if (s.length < 2) return null;
  var d = clamp(dist, 0, s[s.length - 1].d);
  var lo = 0, hi = s.length - 1;
  while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (s[mid].d < d) lo = mid; else hi = mid; }
  var a = s[lo], b = s[hi];
  var t = (b.d - a.d) > 1e-6 ? (d - a.d) / (b.d - a.d) : 0;
  var x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t), y = lerp(a.y, b.y, t);
  var tx = lerp(a.tx, b.tx, t), tz = lerp(a.tz, b.tz, t);
  var l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  var nx = -tz, nz = tx;
  return { x: x + nx * lane, y: y, z: z + nz * lane, tx: tx, tz: tz, total: s[s.length - 1].d };
}

export function applyRoadTypeDefaults() {
  var t = ROAD_TYPES[state.road.type];
  if (!t) return;
  state.road.width = t.width;
  state.road.material = t.material;
  state.road.markings = t.markings;
  state.road.sidewalkL = t.sw;
  state.road.sidewalkR = t.sw;
}
