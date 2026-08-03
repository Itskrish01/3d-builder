import { emit, ui } from './host.js';
import { Paths, kindsOfType, populateWorld } from './actors.js';
import { syncEnvUniforms, syncGrassUniforms, syncGroundUniforms } from './field.js';
import { Dens, Grass, markDirty } from './grass.js';
import { History, fillPlate } from './history.js';
import { modeHasTool } from './modes.js';
import { markSceneDirty } from './persistence.js';
import { cam } from './renderer.js';
import { Roads, applyRoadToTerrain, applyRoadTypeDefaults, clearGrassUnderRoads, decorateRoad, newRoad, rebuildAllRoads, roadCovers, roadSamples } from './roads.js';
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
  },
  {
    id: 'plain', name: 'Empty Plain', desc: 'A gently rolling green field, ready for anything.',
    run: function () {
      resetForTemplate({ mode: 'terrain', landform: 'rolling', amplitude: 1.6, frequency: 0.03,
        octaves: 3, heightScale: 1, width: 120, depth: 120, resolution: 256, water: false,
        autoTex: true, snowOn: false, grid: false });
      fillPlate();
      finishTemplate('Empty Plain');
    }
  },
  {
    id: 'village', name: 'Small Village', desc: 'A curving lane, cottages facing the street, trees and traffic.',
    run: function () {
      resetForTemplate({ mode: 'terrain', landform: 'rolling', amplitude: 3.4, frequency: 0.022,
        octaves: 4, heightScale: 1, width: 150, depth: 150, resolution: 256, water: false,
        autoTex: true, snowOn: false, grid: false });
      state.build.setback = 5;
      var main = templateRoad('residential', [
        { x: -70, z: -18 }, { x: -30, z: -6 }, { x: 8, z: 4 }, { x: 42, z: -6 }, { x: 70, z: -20 }
      ], { lights: true, trees: true });
      var side = templateRoad('dirt', [{ x: 6, z: 3 }, { x: 14, z: 32 }, { x: 30, z: 58 }], { trees: true });
      templateFinishRoads();
      templateStreetBuildings(main, kindsOfType('building'), 17, [-1, 1], 12);
      templateStreetBuildings(side, kindsOfType('building'), 20, [1], 14);
      templateScatter(kindsOfType('nature'), 220, { spacing: 4.5, min: 0.8, max: 1.4, minNormalY: 0.7 });
      templateScatter(kindsOfType('nature'), 90, { spacing: 3, min: 0.7, max: 1.3 });
      fillPlate();
      clearGrassUnderRoads();
      populateWorld(0.9);
      finishTemplate('Small Village');
    }
  },
  {
    id: 'mountain', name: 'Mountain Town', desc: 'A snow-capped range with a road threading the valley floor.',
    run: function () {
      resetForTemplate({ mode: 'terrain', landform: 'mountains', amplitude: 16, frequency: 0.016,
        octaves: 5, heightScale: 1, width: 200, depth: 200, resolution: 256, water: false,
        autoTex: true, snowOn: true, snowline: 12, snowBlend: 4, rockSlope: 0.78, grid: false });
      state.build.setback = 6;
      var road = templateRoad('street', [
        { x: -90, z: 30 }, { x: -40, z: 10 }, { x: 0, z: 18 }, { x: 45, z: 4 }, { x: 92, z: 20 }
      ], { lights: true });
      templateFinishRoads();
      templateStreetBuildings(road, kindsOfType('building'), 22, [-1, 1], 20);
      templateScatter(kindsOfType('nature'), 500, { spacing: 3.4, min: 0.8, max: 1.5, minNormalY: 0.68, maxAlt: 16 });
      templateScatter(kindsOfType('nature'), 220, { spacing: 4, min: 0.8, max: 1.8, minNormalY: 0.4 });
      state.grass.height = 0.8;
      state.plate.maxGrassSlope = 0.78;
      fillPlate();
      clearGrassUnderRoads();
      populateWorld(0.6);
      finishTemplate('Mountain Town');
    }
  },
  {
    id: 'city', name: 'City Block', desc: 'A street grid with towers, shops, pavements and heavy traffic.',
    run: function () {
      resetForTemplate({ mode: 'terrain', landform: 'flat', amplitude: 0, frequency: 0.03,
        octaves: 2, heightScale: 1, width: 180, depth: 180, resolution: 128, water: false,
        autoTex: false, pattern: 'solid', baseColor: '#5c5f58', snowOn: false, grid: false });
      state.build.setback = 3.5;
      var roads = [];
      for (var i = -1; i <= 1; i++) {
        roads.push(templateRoad('street', [{ x: -85, z: i * 46 }, { x: 0, z: i * 46 }, { x: 85, z: i * 46 }], { lights: true, signs: true }));
        roads.push(templateRoad('street', [{ x: i * 46, z: -85 }, { x: i * 46, z: 0 }, { x: i * 46, z: 85 }], { lights: true }));
      }
      templateFinishRoads();
      for (var r = 0; r < roads.length; r++)
        templateStreetBuildings(roads[r], kindsOfType('building'), 20, [-1, 1], 14);
      templateScatter(kindsOfType('prop'), 120, { spacing: 5, min: 0.9, max: 1.1, align: 0 });
      state.grass.height = 0.5;
      fillPlate();
      clearGrassUnderRoads();
      populateWorld(2.2);
      finishTemplate('City Block');
    }
  },
  {
    id: 'island', name: 'Coastal Island', desc: 'Warm water, palms along the beach and a track to the headland.',
    run: function () {
      resetForTemplate({ mode: 'terrain', landform: 'island', amplitude: 11, frequency: 0.014,
        octaves: 4, heightScale: 1, width: 170, depth: 170, resolution: 256,
        water: true, waterLevel: -0.6, waterColor: '#31879f', waterDeep: '#0f3c52', foam: 1.2,
        autoTex: true, snowOn: false, grassColor: '#5c8a3a', dirtColor: '#b09a68', grid: false });
      var road = templateRoad('dirt', [{ x: -34, z: 34 }, { x: -6, z: 10 }, { x: 22, z: -14 }, { x: 40, z: -34 }], {});
      templateFinishRoads();
      templateStreetBuildings(road, kindsOfType('building'), 26, [1], 18);
      templateScatter(kindsOfType('nature'), 180, { spacing: 4, min: 0.85, max: 1.4, minNormalY: 0.72, maxAlt: 3.2 });
      templateScatter(kindsOfType('nature'), 120, { spacing: 4.5, min: 0.8, max: 1.3, minAlt: 3, minNormalY: 0.7 });
      templateScatter(kindsOfType('nature'), 90, { spacing: 2.2, min: 0.8, max: 1.3, maxAlt: 0.6 });
      templateScatter(kindsOfType('nature'), 90, { spacing: 4, min: 0.7, max: 1.5, minNormalY: 0.35 });
      state.plate.maxGrassSlope = 0.7;
      fillPlate();
      clearGrassUnderRoads();
      populateWorld(0.5);
      finishTemplate('Coastal Island');
    }
  },
  {
    id: 'farm', name: 'Countryside Farm', desc: 'Barn, windmill, fenced fields and a dirt track through the crop.',
    run: function () {
      resetForTemplate({ mode: 'terrain', landform: 'rolling', amplitude: 2.6, frequency: 0.018,
        octaves: 3, heightScale: 1, width: 160, depth: 160, resolution: 256, water: false,
        autoTex: true, snowOn: false, grassColor: '#6b8a34', dirtColor: '#7d6a44', grid: false });
      templateRoad('dirt', [{ x: -78, z: 20 }, { x: -20, z: 6 }, { x: 30, z: 16 }, { x: 78, z: 2 }], { trees: true });
      templateFinishRoads();
      // fenced paddock
      templateScatter(kindsOfType('nature'), 40, { spacing: 5, min: 0.9, max: 1.2, align: 0 });
      templateScatter(kindsOfType('nature'), 130, { spacing: 6, min: 0.8, max: 1.4, minNormalY: 0.75 });
      state.grass.height = 1.5;
      state.grass.baseColor = '#7a7a2e';
      state.grass.tipColor = '#d8c878';
      fillPlate();
      clearGrassUnderRoads();
      populateWorld(0.4);
      finishTemplate('Countryside Farm');
    }
  }
];
