import * as THREE from 'three';
import { ASSETS, ImpMat, makeImpMaterial } from './assets.js';
import { scene } from './renderer.js';
import { catVisible } from './world.js';

/* ==========================================================================
   20. INSTANCE LAYERS
   --------------------------------------------------------------------------
   One layer per (model, merged material). Placing a model allocates a slot in
   every one of its part layers, so N copies of a building cost one draw call
   per material rather than one per copy. Layers grow by doubling; growth
   rebuilds the geometry outright so no GPU buffer is orphaned.
   ========================================================================== */
export var OBJ_ATTRS = [
  ['iPosSeed', 4], ['iQuat', 4], ['iSclSway', 4], ['iTint', 3], ['iAnim', 4]
];

export function InstanceLayer(kind, partIndex, initial) {
  this.kind = kind;
  this.partIndex = partIndex;
  this.def = ASSETS[kind];
  this.part = this.def.parts[partIndex];
  this.base = this.part.geo;
  this.cap = 0;
  this.count = 0;
  this.owner = [];
  this.dirty = false;
  this.boundsDirty = true;
  this.arr = {};
  this.attr = {};
  this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(),
                             makeImpMaterial(this.def, this.part, partIndex, false));
  this.mesh.frustumCulled = true;
  scene.add(this.mesh);
  this.resize(initial || 16);
}

InstanceLayer.prototype.resize = function (cap) {
  var old = this.arr, oldCount = this.count;
  var geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', this.base.attributes.position);
  geo.setAttribute('normal', this.base.attributes.normal);
  geo.setAttribute('uv', this.base.attributes.uv);
  // Present only on models with baked animation; the shader ignores it otherwise.
  if (this.base.attributes.aVid) geo.setAttribute('aVid', this.base.attributes.aVid);
  if (this.base.index) geo.setIndex(this.base.index);
  for (var i = 0; i < OBJ_ATTRS.length; i++) {
    var n = OBJ_ATTRS[i][0], s = OBJ_ATTRS[i][1];
    var a = new Float32Array(cap * s);
    if (old[n]) a.set(old[n].subarray(0, Math.min(old[n].length, cap * s)));
    var at = new THREE.InstancedBufferAttribute(a, s);
    at.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(n, at);
    this.arr[n] = a;
    this.attr[n] = at;
  }
  geo.instanceCount = oldCount;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  // Disposing the previous geometry releases every GPU buffer it held; the
  // shared base attributes simply re-upload on the next frame.
  if (this.mesh.geometry) this.mesh.geometry.dispose();
  this.mesh.geometry = geo;
  this.geo = geo;
  this.cap = cap;
  this.boundsDirty = true;
};

InstanceLayer.prototype.alloc = function (ownerRef) {
  if (this.count >= this.cap) this.resize(Math.max(16, this.cap * 2));
  var i = this.count++;
  this.owner[i] = ownerRef;
  this.dirty = true;
  this.boundsDirty = true;
  return i;
};

InstanceLayer.prototype.write = function (i, o) {
  var A = this.arr, i4 = i * 4, i3 = i * 3;
  A.iPosSeed[i4] = o.x; A.iPosSeed[i4 + 1] = o.y; A.iPosSeed[i4 + 2] = o.z; A.iPosSeed[i4 + 3] = o.seed % 1;
  A.iQuat[i4] = o.qx; A.iQuat[i4 + 1] = o.qy; A.iQuat[i4 + 2] = o.qz; A.iQuat[i4 + 3] = o.qw;
  A.iSclSway[i4] = o.sx; A.iSclSway[i4 + 1] = o.sy; A.iSclSway[i4 + 2] = o.sz;
  A.iSclSway[i4 + 3] = o.sway;
  A.iTint[i3] = o.tint[0]; A.iTint[i3 + 1] = o.tint[1]; A.iTint[i3 + 2] = o.tint[2];
  A.iAnim[i4] = o.phase; A.iAnim[i4 + 1] = o.rate; A.iAnim[i4 + 2] = o.pose; A.iAnim[i4 + 3] = o.sel ? 1 : 0;
  this.dirty = true;
  this.boundsDirty = true;
};

/* Swap-remove; the record that moved into the freed slot updates its own
   slot index for this layer. */
InstanceLayer.prototype.remove = function (i) {
  var last = this.count - 1;
  var moved = null;
  if (i !== last) {
    for (var a = 0; a < OBJ_ATTRS.length; a++) {
      var n = OBJ_ATTRS[a][0], s = OBJ_ATTRS[a][1], arr = this.arr[n];
      for (var k = 0; k < s; k++) arr[i * s + k] = arr[last * s + k];
    }
    moved = this.owner[last];
    this.owner[i] = moved;
    if (moved && moved.slots) moved.slots[this.partIndex] = i;
  }
  this.owner[last] = null;
  this.count--;
  this.dirty = true;
  this.boundsDirty = true;
  return moved;
};

InstanceLayer.prototype.flush = function () {
  this.geo.instanceCount = this.count;
  if (!this.dirty) return;
  for (var i = 0; i < OBJ_ATTRS.length; i++) this.attr[OBJ_ATTRS[i][0]].needsUpdate = true;
  this.dirty = false;
  if (this.boundsDirty) this.updateBounds();
};

/* Layer-level bounding sphere so three can frustum-cull whole layers; the
   per-instance distance cull in the shader handles the rest. */
InstanceLayer.prototype.updateBounds = function () {
  this.boundsDirty = false;
  var A = this.arr.iPosSeed, n = this.count;
  if (!n) { this.geo.boundingSphere.radius = 0; return; }
  var mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (var i = 0; i < n; i++) {
    var x = A[i * 4], y = A[i * 4 + 1], z = A[i * 4 + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  var pad = (this.def.radius || 1) * 3 + (this.def.height || 1) * 2;
  var cx = (mnx + mxx) * 0.5, cy = (mny + mxy) * 0.5, cz = (mnz + mxz) * 0.5;
  var r = Math.sqrt(Math.pow(mxx - cx, 2) + Math.pow(mxy - cy, 2) + Math.pow(mxz - cz, 2)) + pad;
  this.geo.boundingSphere.center.set(cx, cy, cz);
  this.geo.boundingSphere.radius = r;
};

InstanceLayer.prototype.dispose = function () {
  scene.remove(this.mesh);
  this.mesh.geometry.dispose();
  var i = ImpMat.list.indexOf(this.mesh.material);
  if (i >= 0) ImpMat.list.splice(i, 1);
  this.mesh.material.dispose();
  this.arr = {}; this.attr = {}; this.owner.length = 0;
};

/* ==========================================================================
   LAYER POOL — created on demand, one per (model, part).
   ========================================================================== */
export var Layers = { map: {}, list: [] };

export function layerFor(kind, partIndex) {
  var id = kind + '#' + partIndex;
  var L = Layers.map[id];
  if (!L) {
    L = new InstanceLayer(kind, partIndex, 16);
    L.id = id;
    Layers.map[id] = L;
    Layers.list.push(L);
    L.mesh.visible = catVisible(ASSETS[kind].kind);
  }
  return L;
}

export function disposeEmptyLayers() {
  for (var i = Layers.list.length - 1; i >= 0; i--) {
    var L = Layers.list[i];
    if (L.count === 0 && L.cap > 32) {
      L.dispose();
      delete Layers.map[L.id];
      Layers.list.splice(i, 1);
    }
  }
}
export function clearAllLayers() {
  for (var i = 0; i < Layers.list.length; i++) Layers.list[i].dispose();
  Layers.list.length = 0;
  Layers.map = {};
}
export function flushLayers() {
  for (var i = 0; i < Layers.list.length; i++) Layers.list[i].flush();
}
export function layerStats() {
  var tris = 0, draws = 0;
  for (var i = 0; i < Layers.list.length; i++) {
    var L = Layers.list[i];
    if (!L.count || !L.mesh.visible) continue;
    draws++;
    tris += (L.base.index ? L.base.index.count / 3 : 0) * L.count;
  }
  return { draws: draws, tris: Math.round(tris) };
}

