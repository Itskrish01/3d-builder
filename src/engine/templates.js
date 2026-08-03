import { emit, ui } from './host.js';
import { Paths } from './actors.js';
import { syncEnvUniforms, syncGrassUniforms, syncGroundUniforms } from './field.js';
import { Dens, Grass, markDirty } from './grass.js';
import { History } from './history.js';
import { modeHasTool } from './modes.js';
import { markSceneDirty } from './persistence.js';
import { cam } from './renderer.js';
import { Roads, applyRoadToTerrain, applyRoadTypeDefaults, decorateRoad, newRoad, rebuildAllRoads, roadCovers, roadSamples } from './roads.js';
import { clearSelection } from './selection.js';
import { MAX_BLADES, state } from './state.js';
import { Terrain, heightAt, normalYAt, rebuildPlate } from './terrain.js';
import { TAU, lerp, rnd } from './util.js';
import { rebuildWater, underWater } from './water.js';
import { World, addObject, applyLayerVisibility, clearWorldObjects, flattenFootprint, nearestObjectDist, updateObject } from './world.js';

/* ==========================================================================
   27. STARTER TEMPLATES + WORLD PERSISTENCE
   ========================================================================== */

export function templateRoad(type, pts, deco) {
  state.road.type = type;
  applyRoadTypeDefaults();
  var rd = newRoad(type, pts);
  if (deco) { rd.deco.lights = !!deco.lights; rd.deco.trees = !!deco.trees; rd.deco.signs = !!deco.signs; }
  World.roads.push(rd);
  applyRoadToTerrain(rd);
  return rd;
}
export function templateFinishRoads() {
  rebuildAllRoads();
  for (var i = 0; i < World.roads.length; i++) decorateRoad(World.roads[i]);
  rebuildAllRoads();
}
/* Place buildings along a road with a setback, alternating sides. */
export function templateStreetBuildings(rd, kinds, spacing, sides, startAt) {
  if (!kinds || !kinds.length) return [];
  var s = roadSamples(rd), next = startAt || spacing;
  var made = [];
  for (var k = 0; k < s.length; k++) {
    if (s[k].d < next) continue;
    next += spacing * (0.8 + rnd() * 0.45);
    for (var q = 0; q < sides.length; q++) {
      var sgn = sides[q];
      var nx = -s[k].tz * sgn, nz = s[k].tx * sgn;
      var off = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW : 0) + state.build.setback;
      var x = s[k].x + nx * off, z = s[k].z + nz * off;
      var p = state.plate;
      if (Math.abs(x) > p.width * 0.5 - 4 || Math.abs(z) > p.depth * 0.5 - 4) continue;
      if (underWater(x, z)) continue;
      var kind = kinds[(rnd() * kinds.length) | 0];
      var o = addObject(kind, x, z, {
        rotY: Math.atan2(-nx, -nz) + (rnd() - 0.5) * 0.14,
        scale: lerp(0.92, 1.1, rnd()), align: 0
      });
      if (!o) continue;
      flattenFootprint(o.x, o.z, o.radius * o.scale, heightAt(o.x, o.z));
      o.y = heightAt(o.x, o.z);
      updateObject(o);
      made.push(o);
    }
  }
  return made;
}
export function templateScatter(kinds, count, cfg) {
  if (!kinds || !kinds.length) return [];
  var p = state.plate, made = [];
  var tries = count * 6;
  for (var i = 0; i < tries && made.length < count; i++) {
    var x = (rnd() - 0.5) * p.width * 0.96, z = (rnd() - 0.5) * p.depth * 0.96;
    var y = heightAt(x, z);
    if (cfg.minAlt !== undefined && y < cfg.minAlt) continue;
    if (cfg.maxAlt !== undefined && y > cfg.maxAlt) continue;
    if (cfg.minNormalY !== undefined && normalYAt(x, z) < cfg.minNormalY) continue;
    if (underWater(x, z)) continue;
    if (roadCovers(x, z)) continue;
    if (nearestObjectDist(x, z, cfg.spacing || 3) < (cfg.spacing || 3)) continue;
    var o = addObject(kinds[(rnd() * kinds.length) | 0], x, z, {
      rotY: rnd() * TAU, scale: lerp(cfg.min || 0.8, cfg.max || 1.3, rnd()), align: cfg.align === undefined ? 0.25 : cfg.align
    });
    if (o) made.push(o);
  }
  return made;
}

export function resetForTemplate(plate) {
  clearWorldObjects(null);
  World.roads.length = 0; World.paths.length = 0;
  World.folders.length = 0; World.nextFolderId = 1;
  Roads.nextId = 1; Paths.nextId = 1;
  Grass.count = 0; Dens.grid.fill(0); Dens.dirty = true; markDirty(0, MAX_BLADES - 1);
  for (var k in plate) state.plate[k] = plate[k];
  Terrain.sculpt.fill(0);
  // Fog is an absolute density, so scale it to the world being built —
  // otherwise a 200 u map disappears behind haze at the default setting.
  var maxDim = Math.max(state.plate.width, state.plate.depth);
  state.env.fogDensity = 0.66 / (1.45 * maxDim);
  rebuildPlate();
  rebuildWater();
  rebuildAllRoads();
}
export function finishTemplate(name) {
  syncGrassUniforms(); syncGroundUniforms(); syncEnvUniforms();
  applyLayerVisibility();
  // A brand-new world starts you at the first station, whatever you were
  // doing in the last one.
  clearSelection();
  state.world.mode = 'terrain';
  state.tool = 'sculpt';
  if (!modeHasTool('terrain', state.sculpt.mode)) state.sculpt.mode = 'raise';
  History.undo.length = 0; History.redo.length = 0; History.bytes = 0;
  emit('history');
  cam.frame(state.plate.width, state.plate.depth, Terrain.max);
  cam.tSph.ph = Math.PI * 0.36;
  cam.snap();
  emit('scene'); emit('state'); emit('env'); emit('stats');
  markSceneDirty();
  ui.toast(name + ' is ready', 'ok', 3000);
}

/* One world to start from, and it is empty. The finished scenes that used
   to live here made the first thing a person did be deleting someone
   else's work; everything in the world should be something they put
   there. The grid is the only furniture, and it is there to judge
   distance by. */
export var TEMPLATES = [
  {
    id: 'baseplate', name: 'Blank Baseplate',
    desc: 'Flat grey ground with a grid, and nothing else. Build it all yourself.',
    run: function () {
      // What a first run opens on. No grass, no roads, nothing placed: the
      // point is that every single thing in the world was put there by the
      // person, and the grid is there to judge distance while they do it.
      resetForTemplate({
        mode: 'terrain', landform: 'flat', amplitude: 0, frequency: 0.03, octaves: 1,
        heightScale: 1, width: 180, depth: 180, resolution: 128,
        water: false, snowOn: false, autoTex: false,
        pattern: 'checker', baseColor: '#8e9491', secColor: '#848a87', checkerScale: 8,
        grid: true, gridSpacing: 4, gridOpacity: 0.5
      });
      finishTemplate('Blank Baseplate');
    }
  }
];
