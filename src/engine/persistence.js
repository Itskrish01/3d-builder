import { emit, ui } from './host.js';
import { syncEnvUniforms, syncGrassUniforms, syncGroundUniforms, updateGrassBounds } from './field.js';
import { Dens, Grass, markDirty, rebuildBladeTemplate, rebuildDensityGrid, writeBlade } from './grass.js';
import { History } from './history.js';
import { renderFrame } from './loop.js';
import { setTool } from './modes.js';
import { basePR, cam, renderer, syncCamera, viewH, viewW } from './renderer.js';
import { MAX_BLADES, deepMerge, defaultState, replaceState, state } from './state.js';
import { Terrain, buildGroundGeometry, computeTerrainHeights, heightAt, resampleSculpt, terrainSegs } from './terrain.js';
import { TAU, clamp, fmtInt } from './util.js';
import { World, LayerState, serObj, deserObj, clearWorldObjects, OGrid, ogridRebuild, applyLayerVisibility } from './world.js';
import { Roads, serRoad, addRoadRecord, rebuildAllRoads } from './roads.js';
import { Paths, serPath, addPathRecord } from './actors.js';
import { clearAllLayers } from './layers.js';
import { Sel } from './selection.js';
import { rebuildWater } from './water.js';
import { normalizeMode } from './modes.js';
import { repairHierarchy } from './hierarchy.js';

/* ==========================================================================
   12. PERSISTENCE
   ========================================================================== */
export var SAVE_VERSION = 1;
export var LS_KEY = 'grasspainter.scene.v1';

export function b64enc(u8) {
  var s = '', C = 0x8000;
  for (var i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
  return btoa(s);
}
export function b64dec(str) {
  var bin = atob(str), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* 12 bytes per blade. Height is not stored — it is recomputed from the
   restored plate, which keeps the file small and keeps grass welded to the
   surface even if the terrain is regenerated. */
export function encodeBlades() {
  var n = Grass.count, A = Grass.arr;
  var buf = new ArrayBuffer(n * 12), dv = new DataView(buf);
  for (var i = 0; i < n; i++) {
    var o = i * 12, o3 = i * 3, o2 = i * 2;
    dv.setInt16(o, clamp(Math.round(A.aOffset[o3] * 100), -32768, 32767), true);
    dv.setInt16(o + 2, clamp(Math.round(A.aOffset[o3 + 2] * 100), -32768, 32767), true);
    // Yaw is circular, so quantise over 256 steps with 256 === 0. Using 255
    // would give both 0 and 2*PI a slot and make the round trip non-exact.
    dv.setUint8(o + 4, Math.round((A.aRot[i] % TAU + TAU) % TAU / TAU * 256) & 255);
    dv.setUint8(o + 5, clamp(Math.round(A.aSize[o2] * 127.5), 0, 255));
    dv.setUint8(o + 6, clamp(Math.round(A.aSize[o2 + 1] * 127.5), 0, 255));
    dv.setUint8(o + 7, clamp(Math.round(A.aShape[o2] * 127.5), 0, 255));
    dv.setUint8(o + 8, clamp(Math.round(A.aShape[o2 + 1] * 85), 0, 255));
    dv.setUint8(o + 9, clamp(Math.round(A.aSeed[i] * 255), 0, 255));
    dv.setInt8(o + 10, clamp(Math.round(A.aNormal[o3] * 127), -127, 127));
    dv.setInt8(o + 11, clamp(Math.round(A.aNormal[o3 + 2] * 127), -127, 127));
  }
  return new Uint8Array(buf);
}
export function decodeBlades(u8) {
  var n = Math.min((u8.byteLength / 12) | 0, MAX_BLADES);
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (var i = 0; i < n; i++) {
    var o = i * 12;
    var x = dv.getInt16(o, true) / 100, z = dv.getInt16(o + 2, true) / 100;
    var nx = dv.getInt8(o + 10) / 127, nz = dv.getInt8(o + 11) / 127;
    var ny = Math.sqrt(Math.max(0.0001, 1 - nx * nx - nz * nz));
    writeBlade(i, x, heightAt(x, z), z, nx, ny, nz,
      dv.getUint8(o + 4) / 256 * TAU,
      dv.getUint8(o + 5) / 127.5,
      dv.getUint8(o + 6) / 127.5,
      dv.getUint8(o + 7) / 127.5,
      dv.getUint8(o + 8) / 85,
      dv.getUint8(o + 9) / 255);
  }
  Grass.count = n;
  markDirty(0, MAX_BLADES - 1);
  /* A world saved when this was a grass painter still carries its blades.
     They are dropped rather than restored: there is no longer any way to
     add, remove or shape them, so keeping them would leave grass in the
     scene that nothing can touch. */
  Grass.count = 0;
  rebuildDensityGrid();
}

export function encodeSculpt() {
  var sc = Terrain.sculpt, any = false;
  for (var i = 0; i < sc.length; i++) if (sc[i] !== 0) { any = true; break; }
  if (!any) return null;
  var buf = new ArrayBuffer(sc.length * 2), dv = new DataView(buf);
  for (var k = 0; k < sc.length; k++)
    dv.setInt16(k * 2, clamp(Math.round(sc[k] * 200), -32768, 32767), true);
  return { n: Terrain.N, data: b64enc(new Uint8Array(buf)) };
}

function serializeCore() {
  return {
    app: 'grass-painter', version: SAVE_VERSION,
    saved: new Date().toISOString(),
    state: JSON.parse(JSON.stringify(state)),
    camera: { r: cam.tSph.r, th: cam.tSph.th, ph: cam.tSph.ph,
              tx: cam.tTarget.x, ty: cam.tTarget.y, tz: cam.tTarget.z },
    sculpt: encodeSculpt(),
    blades: { count: Grass.count, data: b64enc(encodeBlades()) }
  };
}

function deserializeCore(obj) {
  if (!obj || obj.app !== 'grass-painter') throw new Error('Not a Grass Painter scene file');
  var fresh = defaultState();
  deepMerge(fresh, obj.state || {});
  replaceState(fresh);

  // Plate first — blade heights are derived from it.
  Terrain.N = -1;                       // force a full rebuild
  var newN = terrainSegs();
  Terrain.sculpt = new Float32Array((newN + 1) * (newN + 1));
  if (obj.sculpt && obj.sculpt.data) {
    var raw = b64dec(obj.sculpt.data);
    var dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    var srcN = obj.sculpt.n, srcW = srcN + 1;
    var tmp = new Float32Array(srcW * srcW);
    for (var i = 0; i < Math.min(tmp.length, raw.byteLength / 2); i++) tmp[i] = dv.getInt16(i * 2, true) / 200;
    Terrain.sculpt = resampleSculpt(srcN, tmp, newN);
  }
  Terrain.N = newN;
  Terrain.h = new Float32Array((newN + 1) * (newN + 1));
  Terrain.base = new Float32Array((newN + 1) * (newN + 1));
  computeTerrainHeights();
  buildGroundGeometry();

  Grass.count = 0;
  Dens.grid.fill(0);
  if (obj.blades && obj.blades.data) decodeBlades(b64dec(obj.blades.data));

  rebuildBladeTemplate();
  syncGrassUniforms();
  syncGroundUniforms();
  syncEnvUniforms();
  updateGrassBounds();
  Dens.dirty = true;

  if (obj.camera) {
    cam.tSph.r = obj.camera.r; cam.tSph.th = obj.camera.th; cam.tSph.ph = obj.camera.ph;
    cam.tTarget.set(obj.camera.tx, obj.camera.ty, obj.camera.tz);
    cam.snap();
  }
  History.undo.length = 0; History.redo.length = 0; History.bytes = 0;
  emit('history');
  emit('state');
  setTool(state.tool || 'paint');
}

export function downloadBlob(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

export function saveScene() {
  try {
    var json = JSON.stringify(serializeScene());
    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadBlob(new Blob([json], { type: 'application/json' }), 'grass-scene-' + stamp + '.json');
    ui.toast('Saved ' + fmtInt(Grass.count) + ' blades', 'ok');
  } catch (e) {
    ui.toast('Save failed: ' + e.message, 'err', 6000);
  }
}

export function loadSceneFile(file) {
  var fr = new FileReader();
  fr.onload = function () {
    try {
      deserializeScene(JSON.parse(fr.result));
      ui.toast('Loaded ' + fmtInt(Grass.count) + ' blades', 'ok');
      markSceneDirty();
    } catch (e) {
      ui.toast('Load failed: ' + e.message, 'err', 6000);
    }
  };
  fr.onerror = function () { ui.toast('Could not read the file', 'err'); };
  fr.readAsText(file);
}

/* ---- autosave ------------------------------------------------------------
   A full field serialises to a couple of megabytes, which overflows
   localStorage's ~5 MB (UTF-16) quota. IndexedDB has no such limit, so it is
   the primary store; localStorage stays as a fallback for private-mode
   browsers and holds a settings-only copy when the blades will not fit.
   -------------------------------------------------------------------------- */
export var IDB_NAME = 'grasspainter', IDB_STORE = 'scenes', IDB_KEY = 'autosave';
export var _idbPromise = null;

export function idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise(function (resolve) {
    var idb = window.indexedDB;
    if (!idb) { resolve(null); return; }
    var req;
    try { req = idb.open(IDB_NAME, 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { resolve(null); };
    req.onblocked = function () { resolve(null); };
  });
  return _idbPromise;
}
export function idbPut(value) {
  return idbOpen().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, IDB_KEY);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  });
}
export function idbGet() {
  return idbOpen().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var rq = tx.objectStore(IDB_STORE).get(IDB_KEY);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  });
}

export var _sceneDirty = false, _lastAuto = 0, _autoBusy = false, _autoWarned = false;
export function markSceneDirty() { _sceneDirty = true; }

export function autosaveTick(now) {
  if (!state.scene.autosave || !_sceneDirty || _autoBusy) return;
  if (now - _lastAuto < 30000) return;
  _lastAuto = now;
  _sceneDirty = false;
  _autoBusy = true;

  var snap;
  try { snap = serializeScene(); }
  catch (e) { _autoBusy = false; return; }

  idbPut(snap).then(function (ok) {
    _autoBusy = false;
    if (ok) { emit('saved'); try { localStorage.removeItem(LS_KEY); } catch (e) {} return; }
    // No IndexedDB — fall back to localStorage, shedding the blades if the
    // quota rejects the full scene.
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(snap));
      emit('saved');
    } catch (e2) {
      try {
        snap.blades = { count: 0, data: '' };
        snap.tooBig = true;
        localStorage.setItem(LS_KEY, JSON.stringify(snap));
      } catch (e3) { /* nothing we can do */ }
      if (!_autoWarned) {
        _autoWarned = true;
        ui.toast('Autosave storage is full — settings only. Use Save to keep the grass.', 'err', 7000);
      }
    }
  }, function () { _autoBusy = false; });
}

/* Async because IndexedDB is; calls back with true if a scene was restored. */
export function restoreAutosave(done) {
  function fromLocal() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) {}
    if (!raw) return done(false);
    try { deserializeScene(JSON.parse(raw)); done(true); }
    catch (e) { done(false); }
  }
  idbGet().then(function (obj) {
    if (!obj) { fromLocal(); return; }
    try { deserializeScene(obj); done(true); }
    catch (e) { fromLocal(); }
  }, fromLocal);
}

/* ---- PNG export ---------------------------------------------------------- */
export function exportPNG(scale) {
  var pr = renderer.getPixelRatio();
  try {
    renderer.setPixelRatio(basePR * scale);
    renderer.setSize(viewW, viewH, false);
    renderFrame(0);
    var url = renderer.domElement.toDataURL('image/png');
    var a = document.createElement('a');
    a.href = url;
    a.download = 'grass-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    ui.toast('Exported PNG at ' + Math.round(viewW * basePR * scale) + ' × ' + Math.round(viewH * basePR * scale), 'ok');
  } catch (e) {
    ui.toast('Export failed: ' + e.message, 'err');
  } finally {
    renderer.setPixelRatio(pr);
    renderer.setSize(viewW, viewH, false);
  }
}

/* ==========================================================================
   THE WHOLE WORLD
   The two functions above cover terrain and grass; these wrap them so roads,
   paths, placed objects and prefabs travel in the same file.
   ========================================================================== */

export function serializeScene() {
  var o = serializeCore();
  o.world = {
    nextId: World.nextId,
    roadId: Roads.nextId,
    pathId: Paths.nextId,
    layers: JSON.parse(JSON.stringify(LayerState)),
    folders: World.folders,
    folderId: World.nextFolderId,
    roads: World.roads.map(serRoad),
    paths: World.paths.map(serPath),
    objs: World.objs.map(serObj),
    prefabs: World.prefabs
  };
  return o;
}

export function deserializeScene(obj) {
  // wipe the world first so the base loader's terrain rebuild has nothing
  // stale to re-project
  clearWorldObjects(null);
  clearAllLayers();
  World.roads.length = 0; World.paths.length = 0; World.prefabs.length = 0;
  World.folders.length = 0; World.nextFolderId = 1;
  World.objs.length = 0; World.byId = {}; OGrid.map = {};
  Sel.objs.length = 0; Sel.road = null;

  deserializeCore(obj);

  var w = obj.world;
  if (w) {
    if (w.layers) for (var c in w.layers) if (LayerState[c]) {
      LayerState[c].vis = w.layers[c].vis !== false;
      LayerState[c].lock = !!w.layers[c].lock;
    }
    World.nextId = w.nextId || 1;
    if (w.folders) for (var fi = 0; fi < w.folders.length; fi++) World.folders.push(w.folders[fi]);
    World.nextFolderId = w.folderId || (World.folders.length + 1);
    Roads.nextId = w.roadId || 1;
    Paths.nextId = w.pathId || 1;
    if (w.roads) for (var r = 0; r < w.roads.length; r++) addRoadRecord(w.roads[r]);
    if (w.paths) for (var p = 0; p < w.paths.length; p++) addPathRecord(w.paths[p]);
    if (w.objs) for (var i = 0; i < w.objs.length; i++) deserObj(w.objs[i]);
    if (w.prefabs) World.prefabs = w.prefabs;
    // rewire decoration ownership so deleting a road still removes its lights
    for (var rr = 0; rr < World.roads.length; rr++) World.roads[rr].decoIds = [];
  }
  repairHierarchy();
  ogridRebuild();
  rebuildAllRoads();
  rebuildWater();
  applyLayerVisibility();
  syncEnvUniforms();
  syncCamera();
  state.world.mode = normalizeMode(state.world.mode);
  emit('scene');
  emit('env');
  emit('state');
  emit('stats');
}
