import * as THREE from 'three';
import { emit, ui } from './host.js';
import { beginStroke, endStroke, recordOp } from './history.js';
import { markSceneDirty } from './persistence.js';
import { camera, scene, viewH, viewW } from './renderer.js';
import { deleteRoad, roadSamples } from './roads.js';
import { LINE_FS, LINE_VS } from './shaders.js';
import { state } from './state.js';
import { _rayD, _rayO, heightAt, screenRay } from './terrain.js';
import { TAU, clamp } from './util.js';
import { LayerState, World, addObject, catLocked, deleteObject, ogridMove, recordObjAdd, recordObjDel, serObj, surfaceOrTerrainY, updateObject } from './world.js';

/* ==========================================================================
   24. SELECTION, GIZMO AND PREFABS
   ========================================================================== */
export var Sel = { objs: [], road: null, roadPt: -1, outline: null, gizmo: null, drag: null };

export function createSelectionVisuals() {
  function lines(cap, order) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    var m = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      vertexShader: LINE_VS, fragmentShader: LINE_FS,
      uniforms: { uOpacity: { value: 1 } },
      transparent: true, depthTest: false, depthWrite: false
    }));
    m.frustumCulled = false;
    m.renderOrder = order;
    m.visible = false;
    scene.add(m);
    return m;
  }
  Sel.outline = lines(4096, 995);
  // Enough for the densest handle (the rotate ring) with room to spare:
  // setLines truncates silently, and a half-drawn ring is a puzzle.
  Sel.gizmo = lines(4096, 998);
}

export function setLines(mesh, segs) {
  var pos = mesh.geometry.attributes.position, col = mesh.geometry.attributes.aColor;
  var pa = pos.array, ca = col.array;
  var n = Math.min(segs.length, pa.length / 6);
  for (var i = 0; i < n; i++) {
    var s = segs[i], o = i * 6;
    pa[o] = s[0]; pa[o + 1] = s[1]; pa[o + 2] = s[2];
    pa[o + 3] = s[3]; pa[o + 4] = s[4]; pa[o + 5] = s[5];
    var c = s[6] || [0.49, 0.85, 0.34];
    ca[o] = c[0]; ca[o + 1] = c[1]; ca[o + 2] = c[2];
    ca[o + 3] = c[0]; ca[o + 4] = c[1]; ca[o + 5] = c[2];
  }
  mesh.geometry.setDrawRange(0, n * 2);
  pos.needsUpdate = true; col.needsUpdate = true;
  mesh.visible = n > 0;
}

export function boxEdges(cx, cy, cz, hx, hy, hz, col, out) {
  var p = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz],
    [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]
  ];
  var E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  for (var i = 0; i < E.length; i++) {
    var a = p[E[i][0]], b = p[E[i][1]];
    out.push([a[0], a[1], a[2], b[0], b[1], b[2], col]);
  }
}

/* ---- selection state -----------------------------------------------------

   Every one of these repaints. The outline boxes and the gizmo describe what
   is selected, so they are a consequence of changing the selection — not a
   second thing the caller has to remember. Leaving it to callers meant the
   handles of a deleted object hung in the air until something unrelated
   happened to repaint.
   -------------------------------------------------------------------------- */
export function clearSelection() {
  for (var i = 0; i < Sel.objs.length; i++) { Sel.objs[i].sel = false; updateObject(Sel.objs[i]); }
  Sel.objs.length = 0;
  Sel.road = null; Sel.roadPt = -1;
  refreshSelectionVisuals();
  emit('selection');
}
export function selectObjects(list, additive) {
  if (!additive) {
    for (var i = 0; i < Sel.objs.length; i++) { Sel.objs[i].sel = false; updateObject(Sel.objs[i]); }
    Sel.objs.length = 0;
  }
  for (var k = 0; k < list.length; k++) {
    var o = list[k];
    if (catLocked(o.cat)) continue;
    if (Sel.objs.indexOf(o) >= 0) continue;
    o.sel = true; updateObject(o);
    Sel.objs.push(o);
  }
  Sel.road = null; Sel.roadPt = -1;
  refreshSelectionVisuals();
  emit('selection');
}
export function selectRoad(rd) {
  clearSelection();
  Sel.road = rd;
  refreshSelectionVisuals();
  emit('selection');
}
export function selectionCenter() {
  if (Sel.road) {
    var s = roadSamples(Sel.road);
    if (!s.length) return null;
    var mid = s[(s.length / 2) | 0];
    return new THREE.Vector3(mid.x, mid.y + 0.5, mid.z);
  }
  if (!Sel.objs.length) return null;
  var c = new THREE.Vector3();
  for (var i = 0; i < Sel.objs.length; i++) c.add(new THREE.Vector3(Sel.objs[i].x, Sel.objs[i].y, Sel.objs[i].z));
  return c.multiplyScalar(1 / Sel.objs.length);
}

/* ---- picking ------------------------------------------------------------- */
export function pickObject(px, py) {
  screenRay(px, py);
  var ro = _rayO, rd = _rayD;
  var best = null, bestT = 1e9;
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (!LayerState[o.cat].vis || LayerState[o.cat].lock) continue;
    var r = Math.max(o.radius * o.scale, 0.4);
    var cy = o.y + o.height * o.scale * 0.5;
    var ex = o.x - ro.x, ey = cy - ro.y, ez = o.z - ro.z;
    var t = ex * rd.x + ey * rd.y + ez * rd.z;
    if (t < 0) continue;
    var dx = ex - rd.x * t, dy = ey - rd.y * t, dz = ez - rd.z * t;
    var d2 = dx * dx + dy * dy + dz * dz;
    var rr = Math.max(r, o.height * o.scale * 0.5);
    if (d2 > rr * rr) continue;
    if (t < bestT) { bestT = t; best = o; }
  }
  return best;
}
export function pickRoad(x, z) {
  if (!LayerState.roads.vis || LayerState.roads.lock) return null;
  var best = null, bd = 1e9;
  for (var r = 0; r < World.roads.length; r++) {
    var rd = World.roads[r], s = roadSamples(rd);
    var lim = rd.width * 0.6 + 1;
    for (var k = 0; k < s.length; k++) {
      var d = Math.hypot(s[k].x - x, s[k].z - z);
      if (d < lim && d < bd) { bd = d; best = rd; }
    }
  }
  return best;
}
export function pickRoadPoint(rd, x, z) {
  var best = -1, bd = 4.5;
  for (var i = 0; i < rd.pts.length; i++) {
    var d = Math.hypot(rd.pts[i].x - x, rd.pts[i].z - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* Screen-space rectangle select. */
export var _projV = new THREE.Vector3();
export function boxSelect(x0, y0, x1, y1, additive) {
  var lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
  var hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
  var hits = [];
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (!LayerState[o.cat].vis || LayerState[o.cat].lock) continue;
    _projV.set(o.x, o.y + o.height * o.scale * 0.4, o.z).project(camera);
    if (_projV.z > 1) continue;
    var sx = (_projV.x * 0.5 + 0.5) * viewW, sy = (-_projV.y * 0.5 + 0.5) * viewH;
    if (sx >= lo.x && sx <= hi.x && sy >= lo.y && sy <= hi.y) hits.push(o);
  }
  selectObjects(hits, additive);
  return hits.length;
}

/* ---- visuals ------------------------------------------------------------- */
export function refreshSelectionVisuals() {
  var segs = [];
  var accent = [0.49, 0.85, 0.34];
  for (var i = 0; i < Sel.objs.length && segs.length < 1200; i++) {
    var o = Sel.objs[i];
    var r = Math.max(o.radius * o.scale, 0.35), h = Math.max(o.height * o.scale, 0.35);
    boxEdges(o.x, o.y + h * 0.5, o.z, r, h * 0.5, r, accent, segs);
  }
  if (Sel.road) {
    var s = roadSamples(Sel.road);
    var half = Sel.road.width * 0.5;
    for (var k = 0; k < s.length - 1; k++) {
      var a = s[k], b = s[k + 1];
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        segs.push([a.x - a.tz * half * sgn, a.y + 0.1, a.z + a.tx * half * sgn,
                   b.x - b.tz * half * sgn, b.y + 0.1, b.z + b.tx * half * sgn, accent]);
      }
    }
    for (var c = 0; c < Sel.road.pts.length; c++) {
      var p = Sel.road.pts[c];
      var y = heightAt(p.x, p.z) + 0.4;
      var col = c === Sel.roadPt ? [1, 0.85, 0.3] : [1, 1, 1];
      boxEdges(p.x, y, p.z, 0.45, 0.45, 0.45, col, segs);
    }
  }
  setLines(Sel.outline, segs);
  refreshGizmo();
}

export function gizmoScale(center) {
  return Math.max(0.6, camera.position.distanceTo(center) * 0.13);
}

/* How close, in screen pixels, counts as grabbing a handle. A line one pixel
   wide is a one-pixel target, which is no target at all — so the whole shaft
   is grabbable, not just the arrow head, and the band is wide enough to hit
   without aiming. */
var GRAB_PX = 15;
var GRAB_TIP_PX = 22;

/* Draws a shaft as several parallel lines so it reads as a solid bar rather
   than a hairline. `n` offsets are spread across the screen-facing plane. */
function thickLine(segs, ax, ay, az, bx, by, bz, col, width, strands) {
  var dx = bx - ax, dy = by - ay, dz = bz - az;
  var len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  // any two vectors perpendicular to the shaft
  var ux = 0, uy = 0, uz = 0;
  if (Math.abs(dy) < 0.9) { ux = -dz; uz = dx; } else { ux = 1; }
  var ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  var vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  var offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]];
  var n = Math.min(strands || offs.length, offs.length);
  for (var i = 0; i < n; i++) {
    var ox = (ux * offs[i][0] + vx * offs[i][1]) * width;
    var oy = (uy * offs[i][0] + vy * offs[i][1]) * width;
    var oz = (uz * offs[i][0] + vz * offs[i][1]) * width;
    segs.push([ax + ox, ay + oy, az + oz, bx + ox, by + oy, bz + oz, col]);
  }
}

/* A filled-looking arrow head: a ring of spokes back from the tip. */
function arrowHead(segs, tx, ty, tz, dx, dy, dz, col, s) {
  var ux = 0, uy = 0, uz = 0;
  if (Math.abs(dy) < 0.9) { ux = -dz; uz = dx; } else { ux = 1; }
  var ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  var vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  var back = 0.26 * s, rad = 0.1 * s;
  var bx = tx - dx * back, by = ty - dy * back, bz = tz - dz * back;
  var prev = null;
  for (var k = 0; k <= 10; k++) {
    var a = (k / 10) * TAU;
    var cx = bx + (ux * Math.cos(a) + vx * Math.sin(a)) * rad;
    var cy = by + (uy * Math.cos(a) + vy * Math.sin(a)) * rad;
    var cz = bz + (uz * Math.cos(a) + vz * Math.sin(a)) * rad;
    segs.push([tx, ty, tz, cx, cy, cz, col]);
    if (prev) segs.push([prev[0], prev[1], prev[2], cx, cy, cz, col]);
    prev = [cx, cy, cz];
  }
}
export function refreshGizmo() {
  var c = selectionCenter();
  if (!c || Sel.road) { Sel.gizmo.visible = false; return; }
  var s = gizmoScale(c), segs = [];
  var mode = state.sel.gizmo;
  var R = [0.92, 0.32, 0.28], G = [0.42, 0.86, 0.34], B = [0.34, 0.56, 0.94], W = [0.95, 0.95, 0.95];

  var w = s * 0.022;                 // shaft half-width, in world units
  if (mode === 'move') {
    var ax = [[[1, 0, 0], R], [[0, 1, 0], G], [[0, 0, 1], B]];
    for (var i = 0; i < 3; i++) {
      var d = ax[i][0], col = ax[i][1];
      thickLine(segs, c.x, c.y, c.z, c.x + d[0] * s, c.y + d[1] * s, c.z + d[2] * s, col, w);
      arrowHead(segs, c.x + d[0] * s, c.y + d[1] * s, c.z + d[2] * s, d[0], d[1], d[2], col, s);
    }
    // the free-drag handle in the middle
    boxEdges(c.x, c.y, c.z, s * 0.09, s * 0.09, s * 0.09, W, segs);
  } else if (mode === 'rotate') {
    for (var k = 0; k < 48; k++) {
      var a0 = k / 48 * TAU, a1 = (k + 1) / 48 * TAU;
      thickLine(segs,
        c.x + Math.cos(a0) * s, c.y, c.z + Math.sin(a0) * s,
        c.x + Math.cos(a1) * s, c.y, c.z + Math.sin(a1) * s, G, w * 0.9, 5);
    }
  } else {
    boxEdges(c.x, c.y, c.z, s * 0.14, s * 0.14, s * 0.14, W, segs);
    thickLine(segs, c.x, c.y, c.z, c.x, c.y + s, c.z, G, w);
    boxEdges(c.x, c.y + s, c.z, s * 0.13, s * 0.13, s * 0.13, G, segs);
  }
  setLines(Sel.gizmo, segs);
}

/* Which gizmo handle is under the cursor, in screen space. */
export function gizmoHit(px, py) {
  var c = selectionCenter();
  if (!c || Sel.road) return null;
  var s = gizmoScale(c), mode = state.sel.gizmo;
  function toScreen(x, y, z) {
    _projV.set(x, y, z).project(camera);
    return { x: (_projV.x * 0.5 + 0.5) * viewW, y: (-_projV.y * 0.5 + 0.5) * viewH };
  }
  var cs = toScreen(c.x, c.y, c.z);

  if (mode === 'move') {
    // Nearest axis wins, so overlapping shafts at a shallow camera angle pick
    // the one actually under the cursor rather than whichever is tested first.
    var ax = [['x', 1, 0, 0], ['y', 0, 1, 0], ['z', 0, 0, 1]];
    var best = null, bestD = GRAB_PX;
    for (var i = 0; i < 3; i++) {
      var t = toScreen(c.x + ax[i][1] * s, c.y + ax[i][2] * s, c.z + ax[i][3] * s);
      if (Math.hypot(t.x - px, t.y - py) < GRAB_TIP_PX) {
        return { mode: 'move', axis: ax[i][0], center: c };
      }
      var d = segmentDistance(px, py, cs.x, cs.y, t.x, t.y);
      if (d < bestD) { bestD = d; best = ax[i][0]; }
    }
    if (best) return { mode: 'move', axis: best, center: c };
    if (Math.hypot(cs.x - px, cs.y - py) < GRAB_PX) return { mode: 'move', axis: 'xz', center: c };
  } else if (mode === 'rotate') {
    var dc = Math.hypot(cs.x - px, cs.y - py);
    var edge = toScreen(c.x + s, c.y, c.z);
    var rad = Math.hypot(edge.x - cs.x, edge.y - cs.y);
    if (Math.abs(dc - rad) < GRAB_PX + 5) {
      return { mode: 'rotate', center: c, start: Math.atan2(py - cs.y, px - cs.x) };
    }
  } else {
    var top = toScreen(c.x, c.y + s, c.z);
    if (Math.hypot(top.x - px, top.y - py) < GRAB_TIP_PX ||
        Math.hypot(cs.x - px, cs.y - py) < GRAB_TIP_PX ||
        segmentDistance(px, py, cs.x, cs.y, top.x, top.y) < GRAB_PX) {
      return { mode: 'scale', center: c, ref: Math.hypot(cs.x - px, cs.y - py) || 1 };
    }
  }
  return null;
}

/* Distance from a point to a line segment, all in screen pixels. */
function segmentDistance(px, py, ax, ay, bx, by) {
  var vx = bx - ax, vy = by - ay;
  var len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  var t = ((px - ax) * vx + (py - ay) * vy) / len2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/* ---- transforms ---------------------------------------------------------- */
export function snapshotSelection() {
  var out = [];
  for (var i = 0; i < Sel.objs.length; i++) out.push(serObj(Sel.objs[i]));
  return out;
}
export function commitSelectionChange(before, label) {
  var after = snapshotSelection();
  if (!before.length) return;
  beginStroke(label || 'Transform');
  recordOp({ t: 'omod', before: before, after: after, bytes: before.length * 190 });
  endStroke();
  markSceneDirty();
}
export function moveSelection(dx, dy, dz) {
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    o.x += dx; o.z += dz;
    if (dy) o.yOff += dy;
    o.y = surfaceOrTerrainY(o) + o.yOff;
    ogridMove(o);
    updateObject(o);
  }
  refreshSelectionVisuals();
  emit('selection');
}
export function rotateSelection(da) {
  var c = selectionCenter();
  if (!c) return;
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    var dx = o.x - c.x, dz = o.z - c.z;
    var ca = Math.cos(da), sa = Math.sin(da);
    o.x = c.x + dx * ca - dz * sa;
    o.z = c.z + dx * sa + dz * ca;
    o.rotY += da;
    o.y = surfaceOrTerrainY(o) + o.yOff;
    ogridMove(o);
    updateObject(o);
  }
  refreshSelectionVisuals();
  emit('selection');
}
export function scaleSelection(f) {
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    o.scale = clamp(o.scale * f, 0.05, 20);
    updateObject(o);
  }
  refreshSelectionVisuals();
  emit('selection');
}
export function deleteSelection() {
  if (Sel.road) { deleteRoad(Sel.road); clearSelection(); return; }
  if (!Sel.objs.length) return;
  var list = Sel.objs.slice();
  beginStroke('Delete');
  recordObjDel(list);
  for (var i = 0; i < list.length; i++) deleteObject(list[i]);
  endStroke();
  /* Not clearSelection() — those objects are gone, and touching them to unset
     `sel` would be reaching into freed state. Empty the list and repaint. */
  Sel.objs.length = 0;
  Sel.road = null; Sel.roadPt = -1;
  refreshSelectionVisuals();
  emit('selection');
  ui.toast('Deleted ' + list.length + ' object' + (list.length === 1 ? '' : 's'));
}
export function duplicateSelection() {
  if (!Sel.objs.length) return;
  var made = [];
  beginStroke('Duplicate');
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    var n = addObject(o.kind, o.x + 2, o.z + 2, {
      seed: o.seed, rotY: o.rotY, scale: o.scale, align: o.align,
      tint: o.tintCustom ? o.tint : null, yOff: o.yOff
    });
    if (n) made.push(n);
  }
  if (made.length) recordObjAdd(made);
  endStroke();
  selectObjects(made, false);
  ui.toast('Duplicated ' + made.length);
}

/* ---- prefabs ------------------------------------------------------------- */
export function groupSelectionToPrefab(name) {
  if (Sel.objs.length < 1) { ui.toast('Select some objects first', 'err'); return null; }
  var c = selectionCenter();
  var items = [];
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    items.push({ k: o.kind, s: o.seed, dx: o.x - c.x, dz: o.z - c.z,
                 r: o.rotY, c: o.scale, a: o.align, yo: o.yOff,
                 tn: o.tintCustom ? o.tint : null });
  }
  var pf = { id: 'pf' + (World.prefabs.length + 1), name: name || ('Prefab ' + (World.prefabs.length + 1)), items: items };
  World.prefabs.push(pf);
  markSceneDirty();
  ui.toast('Saved "' + pf.name + '" with ' + items.length + ' objects', 'ok');
  return pf;
}
export function stampPrefab(pf, x, z, rotY) {
  var made = [], ca = Math.cos(rotY || 0), sa = Math.sin(rotY || 0);
  for (var i = 0; i < pf.items.length; i++) {
    var it = pf.items[i];
    var px = x + it.dx * ca - it.dz * sa;
    var pz = z + it.dx * sa + it.dz * ca;
    var o = addObject(it.k, px, pz, {
      seed: it.s, rotY: it.r + (rotY || 0), scale: it.c, align: it.a,
      tint: it.tn, yOff: it.yo
    });
    if (o) made.push(o);
  }
  return made;
}

