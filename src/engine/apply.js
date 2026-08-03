import { emit } from './host.js';
import { rebuildBladeTemplate, Dens } from './grass.js';
import { rebuildPlate } from './terrain.js';
import { rebuildWater } from './water.js';
import { rebuildAllRoads } from './roads.js';
import { syncEnvUniforms, syncGrassUniforms, syncGroundUniforms } from './field.js';
import { syncCamera } from './renderer.js';
import { markSceneDirty } from './persistence.js';

/* ============================================================================
   Changing one setting is rarely free: a blade colour is a uniform upload, a
   plate width is a whole geometry rebuild. Each control declares which of
   these it needs and this decides what actually runs, so no control has to
   know how the renderer is put together.
   ========================================================================== */

const WORK = {
  template: rebuildBladeTemplate,
  plate: rebuildPlate,
  grass: syncGrassUniforms,
  ground: syncGroundUniforms,
  env: syncEnvUniforms,
  water: rebuildWater,
  roads: rebuildAllRoads,
  camera: syncCamera,
  dens: () => { Dens.dirty = true; }
};

/**
 * @param {string[]} [tags]  any of: template, plate, grass, ground, env, water, roads, camera, dens
 */
export function applyChange(tags) {
  if (tags) for (const tag of tags) if (WORK[tag]) WORK[tag]();
  markSceneDirty();
  emit('state');
}
