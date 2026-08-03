import { emit, ui } from './host.js';
import { ASSETS, acquireModel, defImported, removeImported, saveLibraryIndex } from './assets.js';
import { importGLB } from './gltf.js';
import { markSceneDirty } from './persistence.js';
import { state } from './state.js';
import { World, updateObject } from './world.js';
import { fmtInt } from './util.js';

/* ============================================================================
   MODEL LIBRARY

   Everything placeable in a world is a Sketchfab model the person chose. This
   module is the bit between "the browser found one" and "the Place station
   can put it down": download (or pull from cache), convert, register, select.
   ========================================================================== */

/** Search state, kept here so reopening the browser resumes where it was. */
export var Browser = { q: '', kind: 'building', maxFaces: 40000, sort: '-likeCount' };

/**
 * @param {{uid: string, name: string, author: string, faces: number, license: string}} meta
 * @param {'building'|'nature'|'prop'|'person'|'vehicle'} kind  which shelf it lands on
 * @param {(fraction: number) => void} [onProgress]
 */
export function importFromSketchfab(meta, kind, onProgress) {
  return acquireModel(meta.uid,
    { name: meta.name, author: meta.author, faces: meta.faces, license: meta.license }, onProgress)
    .then(function (buf) { return importGLB(buf, meta.name); })
    .then(function (model) {
      if (model.tris > 300000) {
        ui.toast('"' + model.name + '" is ' + fmtInt(model.tris) +
          ' triangles — placing many copies will be slow', 'err', 6000);
      }
      var def = defImported(meta.uid, model, {
        label: meta.name, kind: kind, author: meta.author, license: meta.license,
        sway: kind === 'nature' ? 0.5 : 0,
        scale: 1
      });
      saveLibraryIndex();
      // Select it straight away, so the next click on the ground places it.
      state.place.kind = meta.uid;
      state.place.kinds = [meta.uid];
      if (kind === 'person' || kind === 'vehicle') state.people.place = meta.uid;
      markSceneDirty();
      emit('library');
      return def;
    });
}

/** Throws a model away along with every copy of it standing in the world. */
export function removeFromLibrary(uid) {
  removeImported(uid);
  if (state.place.kind === uid) state.place.kind = '';
  state.place.kinds = state.place.kinds.filter(function (k) { return k !== uid; });
  markSceneDirty();
  emit('library');
}

/** A model arrived at the wrong scale; fix every copy already placed. */
export function rescaleKind(id) {
  for (var i = 0; i < World.objs.length; i++) {
    if (World.objs[i].kind === id) updateObject(World.objs[i]);
  }
}

/** Same, for how much a model bends in the wind. */
export function reswayKind(id) {
  var def = ASSETS[id];
  if (!def) return;
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.kind !== id) continue;
    o.sway = def.sway;
    updateObject(o);
  }
}
