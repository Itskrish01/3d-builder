/* ============================================================================
   THE ENGINE, AS ONE OBJECT

   `createEngine(canvas, viewport)` boots WebGL, restores the last world, and
   starts the frame loop. It returns everything React is allowed to touch —
   which is a lot, but all of it read-or-command, never render.

   Nothing here reaches into the DOM beyond the canvas it is handed. Messages,
   dialogs and the marquee go out through the host bridge in ./host.js.
   ========================================================================== */
import { setUiAdapter, emit, on } from './host.js';
import { applyChange } from './apply.js';
import { state, defaultState, getPath, setPath, MAX_BLADES, QUALITY, Q } from './state.js';
import { clamp, fmtInt, nowMs } from './util.js';
import { initRenderer, resize, renderer, scene, camera, cam, canvas as engineCanvas } from './renderer.js';
import { clockLabel } from './renderer.js';
import { initField, syncEnvUniforms, syncGrassUniforms, syncGroundUniforms } from './field.js';
import { Terrain, rebuildPlate, regenerateTerrain, heightAt } from './terrain.js';
import { createWater, rebuildWater, syncWaterUniforms } from './water.js';
import { Grass, createScene, createGrass, rebuildBladeTemplate } from './grass.js';
import { History, doUndo, doRedo, beginStroke, endStroke, fillPlate, clearAll, paintStamp } from './history.js';
import { PRESETS, applyPreset } from './presets.js';
import {
  serializeScene, deserializeScene, saveScene, loadSceneFile, exportPNG,
  markSceneDirty, restoreAutosave, autosaveTick
} from './persistence.js';
import { SF, sfSearch, sfCacheSize } from './sketchfab.js';
import { ASSETS, IMP_KINDS, applyAnimSettings, rebuildAssetCats, restoreLibrary, saveLibraryIndex } from './assets.js';
import { Layers, disposeEmptyLayers } from './layers.js';
import {
  World, CATS, CAT_COLOR, LayerState, objectCounts, addObject, deleteObject,
  scatterStamp, recordObjDel, applyLayerVisibility, updateObject
} from './world.js';
import { ROAD_TYPES, createRoads, syncRoadUniforms, deleteRoad } from './roads.js';
import { populateWorld } from './actors.js';
import {
  Sel, gizmoHit, createSelectionVisuals, clearSelection, selectObjects, deleteSelection,
  duplicateSelection, groupSelectionToPrefab, selectionCenter, moveSelection,
  rotateSelection, scaleSelection, snapshotSelection, commitSelectionChange,
  refreshSelectionVisuals
} from './selection.js';
import { TEMPLATES } from './templates.js';
import {
  ROOT as ROOT_FOLDER, createFolder, renameFolder, deleteFolder, moveFolder, moveToFolder,
  objectsIn, childFolders, groupIntoFolder, folderById
} from './hierarchy.js';
import { initThumbs, renderThumb, drawGroupSwatch } from './thumbnails.js';
import { Browser, importFromSketchfab, removeFromLibrary, rescaleKind, reswayKind } from './library.js';
import {
  MODES, MODE_TOOLS, EXTRA_TOOLS, allTools, currentTool, setTool, setMode, cycleTool,
  normalizeMode, focusSelection, frameWorld, setQuality, toggleSimulate
} from './modes.js';
import { bindInput, setUiHidden, Cursor, Keys, Ptr, Ghost } from './input.js';
import { tick, renderFrame } from './loop.js';
import { PT, canPathTrace, startRender, renderStep, stopRender, saveRender } from './pathtrace.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} viewport   element the canvas should size itself to
 * @param {object} adapter         host implementations (see host.js)
 * @returns {Promise<Engine>}
 */
export async function createEngine(canvas, viewport, adapter, onProgress) {
  setUiAdapter(adapter || {});

  initRenderer(canvas, viewport);
  initField();
  createScene();
  createGrass();
  createRoads();
  createWater();
  createSelectionVisuals();
  initThumbs();
  bindInput();

  syncGrassUniforms();
  syncGroundUniforms();
  syncEnvUniforms();
  syncRoadUniforms();

  // The library has to come back before the world does: a saved object refers
  // to a model by uid, and an unknown uid is skipped on load.
  let libraryCount = 0;
  try {
    libraryCount = await restoreLibrary((i, n, label) => {
      if (onProgress) onProgress(`Loading model ${i} of ${n} — ${label}`);
    });
  } catch {
    libraryCount = 0;
  }
  rebuildAssetCats();
  if (onProgress) onProgress('Building your world');

  const restored = await new Promise((resolve) => restoreAutosave(resolve));
  if (!restored) {
    // First run opens on the blank baseplate. A finished village demonstrates
    // the tool nicely, but it also means the first thing a person does is
    // delete someone else's work; starting empty means everything in the world
    // is theirs. The finished scenes are one click away under New world.
    TEMPLATES[0].run();
    History.undo.length = 0;
    History.redo.length = 0;
    History.bytes = 0;
  }
  state.world.mode = normalizeMode(state.world.mode);
  applyLayerVisibility();
  resize();

  /* ---- frame loop ---- */
  let raf = 0;
  let last = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let statTimer = 0;
  const stats = { fps: 0, blades: 0, objects: 0, triangles: 0, draws: 0 };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = clamp((now - last) / 1000, 0.0001, 0.1);
    last = now;

    tick(dt);
    // While a trace is on screen it owns the canvas — rastering the same view
    // on alternate frames would just flicker between two pictures of it.
    if (!renderStep()) renderFrame();

    fpsAcc += dt;
    fpsFrames++;
    statTimer += dt;
    if (statTimer > 0.3) {
      stats.fps = fpsFrames / Math.max(fpsAcc, 1e-6);
      stats.blades = Grass.count;
      stats.objects = World.objs.length;
      stats.triangles = renderer.info.render.triangles;
      stats.draws = renderer.info.render.calls;
      fpsAcc = 0; fpsFrames = 0; statTimer = 0;
    }
    autosaveTick(now);
  }
  raf = requestAnimationFrame(frame);

  /** @typedef {ReturnType<typeof build>} Engine */
  function build() {
    return {
      /* ---- live state, read directly by the panels ---- */
      state,
      get stats() { return stats; },
      get history() { return { undo: History.undo.length, redo: History.redo.length }; },
      get bladeCount() { return Grass.count; },
      get objectCount() { return World.objs.length; },
      get libraryWasEmpty() { return libraryCount === 0 && Object.keys(ASSETS).length === 0; },
      get restoredFromAutosave() { return restored; },
      MAX_BLADES, QUALITY, Q, PRESETS, TEMPLATES, MODES, MODE_TOOLS, EXTRA_TOOLS,
      CATS, CAT_COLOR, LayerState, IMP_KINDS, ROAD_TYPES,
      ASSETS, World, Sel, Layers, Browser, SF, Cursor, Keys, Ptr, Ghost, Terrain,

      /* ---- reading and writing one setting ---- */
      get: (path) => getPath(state, path),
      set: (path, value) => setPath(state, path, value),
      apply: applyChange,
      defaults: defaultState(),

      /* ---- stations and tools ---- */
      setMode, setTool, cycleTool, currentTool, allTools, normalizeMode,

      /* ---- the world ---- */
      applyPreset, fillPlate, clearAll, regenerateTerrain, rebuildPlate, rebuildWater,
      rebuildBladeTemplate, populateWorld, objectCounts, applyLayerVisibility,
      frameWorld, focusSelection, setQuality, toggleSimulate,
      syncEnvUniforms, syncGrassUniforms, syncGroundUniforms, syncWaterUniforms,
      heightAt, clockLabel, fmtInt,

      /* ---- selection ---- */
      clearSelection, selectObjects, deleteSelection, duplicateSelection,
      groupSelectionToPrefab, selectionCenter, moveSelection, rotateSelection,
      scaleSelection, snapshotSelection, commitSelectionChange, refreshSelectionVisuals,
      deleteRoad,
      selectAll() {
        const all = World.objs.filter((o) => !LayerState[o.cat].lock && LayerState[o.cat].vis);
        setMode('select');
        selectObjects(all, false);
      },

      /* ---- the hierarchy ---- */
      ROOT_FOLDER, createFolder, renameFolder, deleteFolder, moveFolder, moveToFolder,
      objectsIn, childFolders, groupIntoFolder, folderById,

      /* ---- history ---- */
      undo: doUndo, redo: doRedo, beginStroke, endStroke, paintStamp, scatterStamp,
      addObject, deleteObject, recordObjDel, disposeEmptyLayers, updateObject,

      /* ---- files ---- */
      save: saveScene, load: loadSceneFile, exportPNG, serialize: serializeScene,
      deserialize: deserializeScene, markSceneDirty,

      /* ---- library ---- */
      sfSearch, sfCacheSize, importFromSketchfab, removeFromLibrary,
      rescaleKind, reswayKind, saveLibraryIndex, rebuildAssetCats, applyAnimSettings,
      renderThumb, drawGroupSwatch,
      /* Rendering a thumbnail costs a render target, so each one is drawn once
         and kept. Lives with the engine because it is engine output. */
      thumbCache: new Map(),

      /* ---- ray tracing ---- */
      PT, canPathTrace, startRender, stopRender, saveRender,

      /* ---- chrome ---- */
      setUiHidden, resize,
      on,
      /** Ask every panel to re-read state — used after a bulk change. */
      touch: () => emit('scene'),

      dispose() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        renderer.dispose();
      },

      /* Escape hatch for the console and for tests. The UI never reads it. */
      internals: { scene, renderer, camera, cam, canvas: engineCanvas, Grass, Terrain, History, nowMs, gizmoHit }
    };
  }

  return build();
}
