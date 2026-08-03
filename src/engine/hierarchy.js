import { emit } from './host.js';
import { World, deleteObject } from './world.js';
import { disposeEmptyLayers } from './layers.js';
import { markSceneDirty } from './persistence.js';

/* ============================================================================
   THE HIERARCHY

   Placed objects live in one flat array because that is what the instance
   layers want. This adds the other view of the same objects: a tree of named
   folders you can put things in, which is how anyone who has used Roblox
   Studio or Blender expects to organise a scene.

   A folder owns nothing. It is a name and a parent, and objects point at one
   by id. That means the renderer never has to know the tree exists, and an
   object cannot be lost by deleting the folder it was in.
   ========================================================================== */

export var ROOT = 0;

/** @returns {number} the new folder's id */
export function createFolder(name, parent) {
  var id = World.nextFolderId++;
  World.folders.push({ id: id, name: name || 'Folder', parent: parent || ROOT });
  markSceneDirty();
  emit('scene');
  return id;
}

export function folderById(id) {
  for (var i = 0; i < World.folders.length; i++) if (World.folders[i].id === id) return World.folders[i];
  return null;
}

export function renameFolder(id, name) {
  var f = folderById(id);
  if (!f) return;
  f.name = (name || '').trim() || 'Folder';
  markSceneDirty();
  emit('scene');
}

/* A folder cannot be dragged inside itself; walking up from the proposed
   parent is the cheapest way to know. */
export function isDescendant(id, maybeAncestor) {
  var f = folderById(id);
  while (f) {
    if (f.parent === maybeAncestor) return true;
    f = folderById(f.parent);
  }
  return false;
}

export function moveFolder(id, parent) {
  var f = folderById(id);
  if (!f || id === parent || isDescendant(parent, id)) return false;
  f.parent = parent;
  markSceneDirty();
  emit('scene');
  return true;
}

/**
 * Removes a folder. Its contents move up to its parent rather than vanishing —
 * deleting a container should never be a way to lose work by accident.
 * Pass `withContents` to delete the objects too.
 */
export function deleteFolder(id, withContents) {
  var f = folderById(id);
  if (!f) return;
  var parent = f.parent;
  var i;

  if (withContents) {
    var doomed = objectsIn(id, true);
    for (i = 0; i < doomed.length; i++) deleteObject(doomed[i]);
    disposeEmptyLayers();
    var kids = World.folders.filter(function (c) { return c.parent === id; });
    for (i = 0; i < kids.length; i++) deleteFolder(kids[i].id, true);
  } else {
    for (i = 0; i < World.objs.length; i++) {
      if (World.objs[i].folder === id) World.objs[i].folder = parent;
    }
    for (i = 0; i < World.folders.length; i++) {
      if (World.folders[i].parent === id) World.folders[i].parent = parent;
    }
  }

  var at = World.folders.indexOf(f);
  if (at >= 0) World.folders.splice(at, 1);
  markSceneDirty();
  emit('scene');
}

export function moveToFolder(objs, folderId) {
  for (var i = 0; i < objs.length; i++) objs[i].folder = folderId || ROOT;
  markSceneDirty();
  emit('scene');
}

/** Objects filed directly in a folder, or in it and everything below it. */
export function objectsIn(folderId, deep) {
  var out = [];
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.folder === folderId || (deep && isDescendant(o.folder, folderId))) out.push(o);
  }
  return out;
}

export function childFolders(parent) {
  return World.folders.filter(function (f) { return f.parent === parent; });
}

/** Put the selection in a folder of its own — the Ctrl+G everyone expects. */
export function groupIntoFolder(objs, name) {
  if (!objs.length) return 0;
  var id = createFolder(name || 'Group', ROOT);
  moveToFolder(objs, id);
  return id;
}

/* A folder that no longer exists would strand its objects invisibly in the
   tree, so loading repairs any dangling reference back to the root. */
export function repairHierarchy() {
  var live = {};
  var i;
  for (i = 0; i < World.folders.length; i++) live[World.folders[i].id] = true;
  for (i = 0; i < World.folders.length; i++) {
    if (World.folders[i].parent !== ROOT && !live[World.folders[i].parent]) World.folders[i].parent = ROOT;
  }
  for (i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (!o.folder || !live[o.folder]) o.folder = ROOT;
  }
}
