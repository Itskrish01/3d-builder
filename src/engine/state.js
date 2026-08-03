/* ==========================================================================
   GRASS PAINTER
   --------------------------------------------------------------------------
   Section map:
     1  STATE            central source of truth; UI writes it, systems read it
     2  MATH             deterministic RNG, simplex noise, colour helpers
     3  SHADERS          GLSL for grass / ground / sky / ball / brush ring
     4  RENDERER + CAM   WebGL setup and the orbit camera
     5  ENVIRONMENT      time-of-day model, sky, fog
     6  TERRAIN          heightfield, ground mesh, ray marching, sculpting
     7  GRASS SYSTEM     instanced buffers, add/remove, density grid
     8  PUSH FIELD       damped spring field that drives interactive bending
     9  BRUSH            stamping, stroke interpolation, tools
    10  HISTORY          undo / redo
    11  PRESETS
    12  PERSISTENCE      save / load / autosave / PNG
    13  UI               control components + panel schema
    14  INPUT            pointer + keyboard
    15  LOOP

   Everything below lives inside __GP_MAIN__, which the CDN loader calls once
   THREE is guaranteed to be present — so no statement here can run too early.
   ========================================================================== */


/* ==========================================================================
   1. STATE
   ========================================================================== */

export var MAX_BLADES = 300000;          // hard capacity of the instanced buffers
export var DENS_N     = 128;             // density / contact-shadow grid resolution
export var FIELD_N    = 160;             // interaction (push) field resolution

function baseState() {
  return {
    tool: 'paint',
    brush: {
      radius: 3.2,
      flow: 0.55,
      falloff: 0.55,
      scatter: 0.85,
      maxDensity: 90,
      tilt: 0.22,
      sculpt: 'raise',
      sculptStrength: 0.5
    },
    grass: {
      height: 1.05, heightVar: 0.42,
      width: 0.062, widthVar: 0.28,
      taper: 1.05,
      curve: 0.5, curveVar: 0.45,
      segments: 5,
      bladeCurl: 0.55,
      baseColor: '#2c521e',
      tipColor: '#8cc84b',
      gradPow: 1.5,
      hueVar: 0.05, satVar: 0.2, valVar: 0.24,
      density: 1.0,
      stiffMin: 0.55, stiffMax: 1.5,
      ao: 0.62,
      translucency: 1.0,
      specular: 0.22,
      roughness: 0.6
    },
    wind: {
      strength: 0.5,
      direction: 42,
      speed: 0.34,
      turbulence: 0.62,
      waveScale: 0.075,
      gustFreq: 0.17,
      gustStrength: 0.85,
      gustSpeed: 1.5
    },
    interact: {
      radius: 2.6, strength: 1.25, recovery: 5.5, damping: 0.62, wake: 0.6,
      ball: false, ballRadius: 1.3
    },
    plate: {
      width: 42, depth: 42,
      mode: 'flat',
      amplitude: 1.7, frequency: 0.055, octaves: 4,
      pattern: 'checker',
      baseColor: '#3b4034', secColor: '#2b3026',
      checkerScale: 2.5,
      roughness: 0.85,
      grid: true, gridSpacing: 2, gridOpacity: 0.22
    },
    /* The render is its own scene. Keeping its light separate is the point:
       you can shoot the village at midnight while building it at noon. */
    render: {
      quality: 'good',
      matchWorld: true,
      timeOfDay: 18.6,
      exposure: 1.05,
      sunStrength: 1,
      skyStrength: 1,
      showSky: true
    },
    env: {
      timeOfDay: 15.4,
      exposure: 1.05,
      modelFill: 0.5,
      fogDensity: 0.003,
      fogAuto: true,
      fogColor: '#8fa4b2',
      shadows: true,
      shadowStrength: 0.55,
      sky: true
    },
    scene: { autosave: true }
  };
}

export var state = baseState();

/* Loading a world used to rebind `state` to a fresh object. Every module now
   holds its own reference, so the contents are swapped instead — which was
   always the honest thing to do, it just did not matter inside one closure. */
export function replaceState(next) {
  for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) delete state[k];
  for (var n in next) if (Object.prototype.hasOwnProperty.call(next, n)) state[n] = next[n];
}

/* --------------------------------------------------------------------------
   Tiny path helpers so UI controls can bind to "grass.height" etc.
   -------------------------------------------------------------------------- */
export function getPath(obj, path) {
  var p = path.split('.'), o = obj;
  for (var i = 0; i < p.length; i++) o = o[p[i]];
  return o;
}
export function setPath(obj, path, v) {
  var p = path.split('.'), o = obj;
  for (var i = 0; i < p.length - 1; i++) o = o[p[i]];
  o[p[p.length - 1]] = v;
}
export function deepMerge(dst, src) {
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) &&
        dst[k] && typeof dst[k] === 'object') deepMerge(dst[k], src[k]);
    else if (dst[k] !== undefined) dst[k] = src[k];
  }
  return dst;
}


/* ==========================================================================
   1b. WORLD-BUILDER STATE
   --------------------------------------------------------------------------
   Phase 2 extends the same single state object rather than introducing a
   parallel one. defaultState() is wrapped so every consumer of it — the UI
   default table, scene loading, presets — picks the new keys up automatically.
   ========================================================================== */

/* deepMerge() above deliberately only touches keys that already exist (so a
   stale save file cannot inject junk). Extending the schema needs the opposite:
   add anything missing, recursively. */
export function assignDeep(dst, src) {
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    var v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
      assignDeep(dst[k], v);
    } else if (Array.isArray(v)) {
      if (!Array.isArray(dst[k])) dst[k] = v.slice();
    } else if (dst[k] === undefined) {
      dst[k] = v;
    }
  }
  return dst;
}

export function worldDefaults() {
  return {
    ui: { moreOpen: false },

    world: {
      mode: 'terrain',
      quality: 'high',
      simulate: true,
      seenIntro: false,
      showLayers: true
    },

    plate: {
      /* --- heightmap --- */
      resolution: 256,
      landform: 'rolling',
      seed: 20260802,
      heightScale: 1,
      /* --- slope + altitude auto-texturing --- */
      autoTex: true,
      grassColor: '#46702c',
      dirtColor: '#6d5c3e',
      rockColor: '#6a6b6e',
      snowColor: '#e6edf2',
      rockSlope: 0.74,       // surface normal .y below this reads as cliff
      rockBlend: 0.14,
      snowOn: false,
      snowline: 7,
      snowBlend: 2.4,
      maxGrassSlope: 0.62,   // blades refuse to grow where normal.y is lower
      /* --- water --- */
      water: false,
      waterLevel: -0.8,
      waterColor: '#2f6f8f',
      waterDeep: '#123648',
      waterOpacity: 0.86,
      waveScale: 0.55,
      waveSpeed: 0.55,
      foam: 1
    },

    sculpt: {
      mode: 'raise',
      strength: 0.55,
      noiseScale: 0.65,
      talus: 0.55,
      erodeIters: 3
    },

    road: {
      type: 'street',
      material: 'asphalt',
      width: 7,
      markings: true,
      curb: 0.14,
      sidewalkL: true,
      sidewalkR: true,
      sidewalkW: 1.9,
      flatten: 0.9,
      carve: 0.8,
      clearGrass: true,
      autoLights: false, lightSpacing: 16, lightKind: '',
      autoTrees: false, treeSpacing: 12, treeKind: '',
      autoSigns: false, signKind: '',
      decoJitter: 0.35
    },

    /* One station places everything, so one record says what is selected and
       how big it goes down. The per-kind knobs below are still what the
       engine reads — buildings take the `build` set, everything else takes
       the `nature` set — the Place panel just drives both. */
    place: {
      kind: '',      // the one that a click puts down
      kinds: [],     // the mix the scatter brush draws from
      size: 1
    },

    build: {
      kind: '',
      snap: 'free',
      gridSize: 2,
      setback: 5,
      upright: true,
      rotJitter: 8,
      scaleMin: 0.92, scaleMax: 1.1,
      spacing: 8,
      density: 0.5,
      flatten: true,
      rotation: 0,
      scale: 1
    },

    nature: {
      kinds: [],
      density: 0.45,
      scaleMin: 0.75, scaleMax: 1.35,
      rotJitter: 180,
      spacing: 1.8,
      minNormalY: 0.72,
      minAlt: -999, maxAlt: 999,
      alignNormal: 0.35
    },

    people: {
      count: 12,
      speed: 1.15, speedVar: 0.4,
      pose: 'stand',
      place: '',
      pathWidth: 1.6
    },

    traffic: {
      count: 6,
      speed: 8, speedVar: 0.25,
      spacing: 16
    },

    /* Remove takes objects, not grass — grass has its own eraser one station
       up, and wiping a field by accident is the worst surprise in the tool. */
    eraseMask: { grass: false, nature: true, props: true, buildings: true, people: true, vehicles: true },

    sel: { gizmo: 'move', nudge: 0.5 },

    cam: {
      fov: 52,            // vertical field of view, degrees
      flySpeed: 22,       // units per second with WASD
      boost: 3.5,         // Shift multiplier
      lookSens: 1,
      invertY: false
    }
  };
}

/* The world-builder keys were bolted on in a second pass, and used to be merged
   in by reassigning defaultState at load time. One function is clearer, and it
   is the single answer every consumer needs — the live state below, the values
   a slider resets to, and every scene that gets loaded. */
export function defaultState() {
  return assignDeep(baseState(), worldDefaults());
}

assignDeep(state, worldDefaults());

/* ---- capacities ---------------------------------------------------------
   Instance layers grow on demand up to these ceilings; the stats overlay
   surfaces how much of each is in use. */
export var CAP = {
  nature: 60000,
  props: 20000,
  buildings: 4000,
  people: 2000,
  vehicles: 600
};

/* ---- quality presets ----------------------------------------------------
   One slider that moves draw distance, grass density, animation budget and
   terrain detail together. */
export var QUALITY = {
  low:    { label: 'Low',    draw: 90,  grass: 0.45, anim: 24,  fade: 0.55, shadow: 0.35, water: 0 },
  medium: { label: 'Medium', draw: 150, grass: 0.7,  anim: 60,  fade: 0.7,  shadow: 0.45, water: 1 },
  high:   { label: 'High',   draw: 260, grass: 1.0,  anim: 140, fade: 0.85, shadow: 0.55, water: 1 },
  ultra:  { label: 'Ultra',  draw: 460, grass: 1.0,  anim: 400, fade: 1.0,  shadow: 0.65, water: 1 }
};
export function Q() { return QUALITY[state.world.quality] || QUALITY.high; }


