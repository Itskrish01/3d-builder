'use strict';
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
function __GP_MAIN__() {

/* ==========================================================================
   1. STATE
   ========================================================================== */

var MAX_BLADES = 300000;          // hard capacity of the instanced buffers
var DENS_N     = 128;             // density / contact-shadow grid resolution
var FIELD_N    = 160;             // interaction (push) field resolution

function defaultState() {
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
    env: {
      timeOfDay: 15.4,
      exposure: 1.05,
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

var state = defaultState();

/* --------------------------------------------------------------------------
   Tiny path helpers so UI controls can bind to "grass.height" etc.
   -------------------------------------------------------------------------- */
function getPath(obj, path) {
  var p = path.split('.'), o = obj;
  for (var i = 0; i < p.length; i++) o = o[p[i]];
  return o;
}
function setPath(obj, path, v) {
  var p = path.split('.'), o = obj;
  for (var i = 0; i < p.length - 1; i++) o = o[p[i]];
  o[p[p.length - 1]] = v;
}
function deepMerge(dst, src) {
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) &&
        dst[k] && typeof dst[k] === 'object') deepMerge(dst[k], src[k]);
    else if (dst[k] !== undefined) dst[k] = src[k];
  }
  return dst;
}

/* ==========================================================================
   2. MATH
   ========================================================================== */

var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
var lerp  = function (a, b, t) { return a + (b - a) * t; };
var smoothstep = function (e0, e1, x) {
  var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t);
};
var TAU = Math.PI * 2;
var DEG = Math.PI / 180;

/* Deterministic 32-bit PRNG (mulberry32) — used so a "fill" is reproducible
   within a session and so noise seeds stay stable. */
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
var rnd = Math.random;

/* ---- 2D simplex noise (CPU side, drives the terrain heightfield) --------- */
var SN = (function () {
  var grad = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  var perm = new Uint8Array(512), pm = new Uint8Array(512);
  var r = rng(1337), p = new Uint8Array(256);
  for (var i = 0; i < 256; i++) p[i] = i;
  for (var i2 = 255; i2 > 0; i2--) {
    var j = (r() * (i2 + 1)) | 0, t = p[i2]; p[i2] = p[j]; p[j] = t;
  }
  for (var k = 0; k < 512; k++) { perm[k] = p[k & 255]; pm[k] = perm[k] % 8; }

  var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;

  function noise(xin, yin) {
    var s = (xin + yin) * F2;
    var i = Math.floor(xin + s), j = Math.floor(yin + s);
    var t = (i + j) * G2;
    var x0 = xin - (i - t), y0 = yin - (j - t);
    var i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    var ii = i & 255, jj = j & 255, n = 0, g, tt;

    tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) { g = grad[pm[ii + perm[jj]]]; tt *= tt; n += tt * tt * (g[0] * x0 + g[1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) { g = grad[pm[ii + i1 + perm[jj + j1]]]; tt *= tt; n += tt * tt * (g[0] * x1 + g[1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) { g = grad[pm[ii + 1 + perm[jj + 1]]]; tt *= tt; n += tt * tt * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  }
  function fbm(x, y, oct) {
    var a = 0.5, f = 1, sum = 0, norm = 0;
    for (var o = 0; o < oct; o++) { sum += a * noise(x * f, y * f); norm += a; a *= 0.5; f *= 2.03; }
    return sum / norm;
  }
  return { noise: noise, fbm: fbm };
})();

/* ---- colour helpers ------------------------------------------------------ */
function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgb2hex(r, g, b) {
  var f = function (v) { var s = Math.round(clamp(v, 0, 1) * 255).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + f(r) + f(g) + f(b);
}
function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
/* sRGB hex -> linear vec3, because every shader works in linear light. */
function hexLin(h, out) {
  var c = hex2rgb(h);
  out = out || new THREE.Vector3();
  return out.set(s2l(c[0]), s2l(c[1]), s2l(c[2]));
}
function mixArr(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* ---- misc ---------------------------------------------------------------- */
function fmtInt(n) { return n.toLocaleString('en-US'); }
function nowMs() { return (performance && performance.now) ? performance.now() : Date.now(); }
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
function assignDeep(dst, src) {
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

function worldDefaults() {
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
      flySpeed: 22,       // units per second with WASD
      boost: 3.5,         // Shift multiplier
      lookSens: 1,
      invertY: false
    }
  };
}

/* Wrap the factory so DEFAULTS, presets and scene loads all agree. */
(function () {
  var base = defaultState;
  defaultState = function () { return assignDeep(base(), worldDefaults()); };
})();
assignDeep(state, worldDefaults());

/* ---- capacities ---------------------------------------------------------
   Instance layers grow on demand up to these ceilings; the stats overlay
   surfaces how much of each is in use. */
var CAP = {
  nature: 60000,
  props: 20000,
  buildings: 4000,
  people: 2000,
  vehicles: 600
};

/* ---- quality presets ----------------------------------------------------
   One slider that moves draw distance, grass density, animation budget and
   terrain detail together. */
var QUALITY = {
  low:    { label: 'Low',    draw: 90,  grass: 0.45, anim: 24,  fade: 0.55, shadow: 0.35, water: 0 },
  medium: { label: 'Medium', draw: 150, grass: 0.7,  anim: 60,  fade: 0.7,  shadow: 0.45, water: 1 },
  high:   { label: 'High',   draw: 260, grass: 1.0,  anim: 140, fade: 0.85, shadow: 0.55, water: 1 },
  ultra:  { label: 'Ultra',  draw: 460, grass: 1.0,  anim: 400, fade: 1.0,  shadow: 0.65, water: 1 }
};
function Q() { return QUALITY[state.world.quality] || QUALITY.high; }
/* ==========================================================================
   3. SHADERS
   ========================================================================== */

/* ---- shared GLSL ---------------------------------------------------------
   Ashima / Stefan Gustavson 2D simplex noise. Cheap enough to evaluate a
   couple of times per vertex, and — unlike value noise — it has no visible
   axis-aligned grid, which matters a lot when it drives a wind field.
   -------------------------------------------------------------------------- */
var GLSL_NOISE = `
vec3 gp_mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 gp_mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 gp_permute(vec3 x){ return gp_mod289(((x*34.0)+1.0)*x); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = gp_mod289(i);
  vec3 p = gp_permute( gp_permute( i.y + vec3(0.0, i1.y, 1.0))
                     + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x  = 2.0 * fract(p * C.www) - 1.0;
  vec3 h  = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x   + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm2(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += a * snoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
float hash11(float p){ return fract(sin(p * 127.1) * 43758.5453123); }
vec2 rot2(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }
`;

var GLSL_COLOR = `
vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a*x + b)) / (x * (c*x + d) + e), 0.0, 1.0);
}
// Single output path for every material: ACES filmic tone map + gamma.
// Doing it here (instead of relying on renderer post-state) keeps the whole
// scene consistent no matter which material drew the pixel.
vec4 gp_out(vec3 c, float exposure){
  return vec4(pow(aces(c * exposure), vec3(0.45454545)), 1.0);
}
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0*d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`;

var GLSL_FOG = `
uniform vec3  uFogColor;
uniform float uFogDensity;
vec3 gp_fog(vec3 c, float dist){
  float f = 1.0 - exp(-pow(max(dist,0.0) * uFogDensity, 2.0));
  return mix(c, uFogColor, clamp(f, 0.0, 1.0));
}
`;

/* ==========================================================================
   GRASS — vertex shader
   --------------------------------------------------------------------------
   The blade template geometry is a strip in "blade space":
       position.x = side   (-1 .. +1, 0 at the tip vertex)
       position.y = t      ( 0 ..  1, arc-length parameter along the blade)
   Nothing about the blade's world placement lives in the template — every
   blade is one instance, and all animation happens right here.
   ========================================================================== */
var GRASS_VS = GLSL_NOISE + GLSL_COLOR + `
attribute vec3  aOffset;   // root position, world space
attribute vec3  aNormal;   // ground normal at the root
attribute float aRot;      // yaw
attribute vec2  aSize;     // (height mul, width mul)
attribute vec2  aShape;    // (droop mul, stiffness)
attribute float aSeed;     // 0..1 per-blade random

uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindStrength, uWindSpeed, uTurbulence, uWaveScale;
uniform float uGustScale, uGustSpeed, uGustStrength;
uniform float uHeight, uWidth, uTaper, uCurve, uBladeCurl;
uniform float uDensity;
uniform vec2  uPlateHalf, uPlateSize;
uniform sampler2D uPushTex;
uniform float uPushEnc;
uniform vec3  uBaseColor, uTipColor;
uniform float uGradPow, uHueVar, uSatVar, uValVar;

varying float vT, vWind, vAO;
varying vec3  vN, vW, vCol;

/* A circular arc starting at O, initially travelling along U, curving toward
   D with curvature k (1/radius). Because the arc is parameterised by
   arc-length s, the blade's length is preserved EXACTLY for any bend — this
   is the whole reason we use arcs instead of shearing the vertices. */
vec3 arcPos(vec3 O, vec3 U, vec3 D, float k, float s){
  if (abs(k) < 1e-4) return O + U * s;
  return O + D * ((1.0 - cos(k*s)) / k) + U * (sin(k*s) / k);
}
vec3 arcTan(vec3 U, vec3 D, float k, float s){
  return D * sin(k*s) + U * cos(k*s);
}
vec3 safeDir(vec3 v, vec3 fb){
  float l = length(v);
  return (l < 1e-4) ? fb : v / l;
}

void main(){
  float t    = position.y;
  float side = position.x;
  vec3  root = aOffset;

  /* ---- culling -----------------------------------------------------------
     The density slider and the plate bounds both cull here rather than on the
     CPU, so changing either is instant and never touches a buffer. */
  float dseed = hash11(aSeed * 91.7 + 3.1);
  bool alive = (dseed < uDensity) &&
               (abs(root.x) <= uPlateHalf.x) && (abs(root.z) <= uPlateHalf.y);
  if (!alive){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  float H = uHeight * aSize.x;
  float W = uWidth  * aSize.y;
  float stiff = max(0.25, aShape.y);

  /* ======================================================================
     WIND
     ----------------------------------------------------------------------
     Everything below is evaluated from the blade ROOT only, so a blade bends
     as one coherent object instead of rippling within itself.

     The field is built from four independent contributions:

       1. SWELL   – one octave of simplex noise whose domain is scrolled
                    against the wind direction. Large wavelength, so whole
                    regions of the field lean together. This is the "body" of
                    the wind.
       2. CHOP    – a second, ~3x higher-frequency octave. It breaks the swell
                    into patches and also jitters the local wind DIRECTION,
                    which is what stops the field reading as one sine wave.
       3. GUST    – a travelling plane wave along the wind axis. sin() is
                    remapped to 0..1 and sharpened with pow(), which narrows
                    the crest into a band. That band sweeps across the plate
                    at gustSpeed/gustScale units per second and is visible as
                    a discrete wave of bent grass, not a global wobble. The
                    crest is modulated by the chop octave so the front is
                    ragged rather than a perfect straight line.
       4. FLUTTER – a fast per-blade oscillator (phase and rate derived from
                    aSeed) that is applied ONLY to the upper arc segment, so
                    it chatters the tip without moving the root.
     ====================================================================== */
  vec2 wdir = uWindDir;
  vec2 q    = root.xz * uWaveScale - wdir * (uTime * uWindSpeed);

  float swell = snoise(q);                       // (1)
  float chop  = snoise(q * 2.9 + vec2(17.3, -8.1)); // (2)

  float gPhase = dot(root.xz, wdir) * uGustScale - uTime * uGustSpeed;  // (3)
  float gust   = pow(sin(gPhase) * 0.5 + 0.5, 5.0);
  gust *= (0.5 + 0.5 * chop) * uGustStrength;

  // Base sway is biased positive: air pushes, it does not pull, so grass
  // should mostly lean downwind and only occasionally stand back up.
  float sway    = 0.5 + 0.5 * swell + 0.28 * chop * uTurbulence;
  float windAmt = uWindStrength * max(0.0, sway + gust) / stiff;

  // Local direction jitter — the single biggest cue that this is a turbulent
  // field and not a scrolling texture.
  wdir = rot2(wdir, chop * uTurbulence * 0.85);

  /* ---- interactive push --------------------------------------------------
     A CPU-simulated damped-spring field is uploaded as a texture. RG holds a
     signed 2D displacement in the same "bend radians" unit as the wind, so it
     simply adds into the bend vector below. Because that field springs back
     over time rather than tracking the cursor, fast sweeps leave a wake. */
  vec2 puv  = clamp(root.xz / uPlateSize + 0.5, vec2(0.001), vec2(0.999));
  vec2 push = (texture2D(uPushTex, puv).rg * 2.0 - 1.0) * uPushEnc / stiff;

  /* ---- total bend --------------------------------------------------------
     Natural droop, wind and push are summed as VECTORS in the ground plane.
     The magnitude of that sum is the total tip angle in radians; its
     direction is the direction the blade leans. Summing before converting to
     an angle means the three effects blend instead of fighting. */
  vec2 face   = vec2(-sin(aRot), cos(aRot));           // the blade's own lean
  vec2 bendXZ = face * (aShape.x * uCurve) + wdir * windAmt + push;

  float total = min(length(bendXZ), 2.5);
  vec2  bdir  = (length(bendXZ) > 1e-5) ? normalize(bendXZ) : vec2(0.0, 1.0);

  // Flutter (4): fast, small, per-blade phase, scaled by how hard the wind is
  // blowing so still air produces still grass.
  float ph   = aSeed * 43.7;
  float flut = sin(uTime * (5.5 + 3.0 * hash11(aSeed * 7.7)) + ph) * 0.6
             + sin(uTime * (11.0 + 5.0 * hash11(aSeed * 3.3)) + ph * 1.7) * 0.4;
  flut *= uTurbulence * uWindStrength * (0.25 + 0.75 * max(0.0, sway)) * 0.55 / stiff;

  /* ---- two-segment arc ---------------------------------------------------
     The blade is built from TWO circular arcs joined end to end:
       base arc  – 55% of the length, carries only 30% of the total angle
       tip arc   – 45% of the length, carries 70% of the angle plus flutter
     Both arcs are exact, so total length is preserved; the uneven angle split
     is what makes the tip travel far while the root barely moves, and the
     independent tip direction lets the upper half chatter sideways. */
  float h1 = H * 0.55, h2 = max(H - h1, 1e-4);
  float k1 = (total * 0.30) / max(h1, 1e-4);
  float k2 = (total * 0.70) / h2 + flut * 0.9 / h2;

  vec2 perp   = vec2(-bdir.y, bdir.x);
  vec2 tipXZ  = normalize(bdir + perp * flut * 1.1 + vec2(1e-6, 0.0));

  vec3 up = normalize(aNormal);
  vec3 D1 = safeDir(vec3(bdir.x, 0.0, bdir.y) - up * dot(vec3(bdir.x, 0.0, bdir.y), up), vec3(0.0, 0.0, 1.0));

  float s  = t * H;
  float s1 = min(s, h1);
  vec3  P  = arcPos(root, up, D1, k1, s1);
  vec3  T  = arcTan(up, D1, k1, s1);

  if (s > h1){
    vec3 dw = vec3(tipXZ.x, 0.0, tipXZ.y);
    vec3 D2 = safeDir(dw - T * dot(dw, T), D1);
    float s2 = s - h1;
    P = arcPos(P, T, D2, k2, s2);
    T = arcTan(T, D2, k2, s2);
  }

  /* ---- width, cross-section curl ---------------------------------------- */
  vec3 r0 = vec3(cos(aRot), 0.0, sin(aRot));
  vec3 R  = safeDir(r0 - T * dot(r0, T), vec3(1.0, 0.0, 0.0));
  float wprof = pow(max(1.0 - t, 0.0), uTaper);
  vec3 pos = P + R * (side * W * 0.5 * wprof);

  // Blades are modelled flat but shaded as if curled across their width; the
  // normal is rotated about the blade tangent by the vertex's side, which
  // produces a soft highlight band down the middle instead of a flat card.
  vec3 N = normalize(cross(R, T));
  float curl = side * uBladeCurl;
  N = normalize(N * cos(curl) + R * sin(curl));

  /* ---- per-blade colour (computed here, interpolated for free) ----------- */
  vec3 col = mix(uBaseColor, uTipColor, pow(t, uGradPow));
  vec3 hsv = rgb2hsv(max(col, vec3(1e-5)));
  float r1 = hash11(aSeed * 13.1), r2 = hash11(aSeed * 29.3), r3 = hash11(aSeed * 57.9);
  hsv.x = fract(hsv.x + (r1 * 2.0 - 1.0) * uHueVar);
  hsv.y = clamp(hsv.y * (1.0 + (r2 * 2.0 - 1.0) * uSatVar), 0.0, 1.0);
  hsv.z = max(hsv.z * (1.0 + (r3 * 2.0 - 1.0) * uValVar), 0.0);
  vCol = hsv2rgb(hsv);

  vT    = t;
  vN    = N;
  vW    = pos;
  vWind = clamp(total * 0.5, 0.0, 1.0);
  vAO   = smoothstep(0.0, 0.55, t);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

var GRASS_FS = GLSL_COLOR + GLSL_FOG + `
uniform vec3  uSunDir, uSunColor, uSkyColor, uGroundColor;
uniform float uAmbient, uAO, uTranslucency, uSpecular, uRoughness, uExposure;
varying float vT, vWind, vAO;
varying vec3  vN, vW, vCol;

void main(){
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = uSunDir;

  // Wrapped ("half lambert") diffuse: real grass scatters so much light that a
  // hard N.L terminator looks wrong — the wrap keeps the shadow side readable.
  float wrap = 0.5;
  float ndl  = max(0.0, (dot(N, L) + wrap) / (1.0 + wrap));

  // Ambient occlusion darkening toward the base of the blade.
  float ao = mix(1.0 - uAO, 1.0, vAO);

  // Subsurface scattering: when the viewer is roughly opposite the sun the
  // blade glows, more strongly toward the thin tip.
  float sss = pow(max(0.0, dot(V, -L)), 3.0) * uTranslucency * (0.2 + 0.8 * vT);

  vec3  Hv   = normalize(L + V);
  float spec = pow(max(0.0, dot(N, Hv)), mix(90.0, 5.0, uRoughness)) * uSpecular;

  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;
  vec3 col = vCol * (1.0 + vWind * 0.12);   // bent blades catch a little more light

  vec3 lit = col * (uSunColor * ndl + amb) * ao
           + col * uSunColor * sss
           + uSunColor * spec * ao;

  lit = gp_fog(lit, length(cameraPosition - vW));
  gl_FragColor = gp_out(lit, uExposure);
}
`;
/* ==========================================================================
   GROUND
   ========================================================================== */
var GROUND_VS = `
varying vec3 vW, vN;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

var GROUND_FS = GLSL_NOISE + GLSL_COLOR + GLSL_FOG + `
uniform vec3  uBaseColor, uSecColor;
uniform float uPattern, uCheckerScale, uRoughness;
uniform vec2  uPlateSize;
uniform float uGrid, uGridSpacing, uGridOpacity;
uniform vec3  uSunDir, uSunColor, uSkyColor, uGroundColor;
uniform float uAmbient, uExposure;
uniform sampler2D uDensTex;
uniform float uShadow, uShadowStrength;
uniform vec2  uShadowOffset;
uniform float uAutoTex, uRockSlope, uRockBlend, uSnowOn, uSnowline, uSnowBlend;
uniform vec3  uGrassCol, uDirtCol, uRockCol, uSnowCol;
varying vec3 vW, vN;

/* Analytically anti-aliased checker (filters the pattern by the pixel
   footprint instead of point-sampling it, so distant ground stays calm). */
float checkerAA(vec2 p){
  vec2 w = fwidth(p) + 1e-4;
  vec2 i = 2.0 * (abs(fract((p - 0.5*w) * 0.5) - 0.5) -
                  abs(fract((p + 0.5*w) * 0.5) - 0.5)) / w;
  return 0.5 - 0.5 * i.x * i.y;
}
float gridAA(vec2 p, float spacing){
  vec2 c = p / spacing;
  vec2 g = abs(fract(c - 0.5) - 0.5) / (fwidth(c) + 1e-5);
  return 1.0 - min(min(g.x, g.y), 1.0);
}

void main(){
  vec3 N = normalize(vN);
  vec2 P = vW.xz;

  /* ---- ground pattern --------------------------------------------------- */
  vec3 col = uBaseColor;
  if (uPattern > 0.5 && uPattern < 1.5){
    col = mix(uBaseColor, uSecColor, checkerAA(P / max(uCheckerScale, 0.01)));
  } else if (uPattern > 1.5 && uPattern < 2.5){
    float d = length(P / (uPlateSize * 0.5));
    col = mix(uBaseColor, uSecColor, smoothstep(0.05, 1.15, d));
  } else if (uPattern > 2.5){
    float n = fbm2(P * (0.16 / max(uCheckerScale, 0.01) * 2.5)) * 0.5 + 0.5;
    float m = smoothstep(0.34, 0.66, n);
    col = mix(uBaseColor, uSecColor, m);
    col *= 0.88 + 0.24 * (snoise(P * 3.1) * 0.5 + 0.5);
  }

  /* ---- slope + altitude auto-texturing ----------------------------------
     Layered by surface normal first (flat ground keeps grass, steep faces go
     to rock) then by height for the snowline. Every threshold is broken up
     with noise so the transitions read as terrain rather than contour bands,
     and snow refuses to settle on anything close to vertical. */
  if (uAutoTex > 0.5){
    float brk = snoise(P * 0.09) * 0.5 + snoise(P * 0.31) * 0.25;
    float ny = clamp(N.y + brk * 0.055, 0.0, 1.0);

    float dirtM = 1.0 - smoothstep(0.86, 0.965, ny);
    float rockM = 1.0 - smoothstep(uRockSlope - uRockBlend, uRockSlope + uRockBlend, ny);

    vec3 g = uGrassCol * (0.9 + 0.2 * (snoise(P * 0.42) * 0.5 + 0.5));
    vec3 t = mix(g, uDirtCol, clamp(dirtM, 0.0, 1.0));
    t = mix(t, uRockCol * (0.85 + 0.3 * (snoise(P * 1.7) * 0.5 + 0.5)), clamp(rockM, 0.0, 1.0));

    if (uSnowOn > 0.5){
      float h = vW.y + brk * uSnowBlend * 0.5;
      float snowM = smoothstep(uSnowline - uSnowBlend, uSnowline + uSnowBlend, h);
      snowM *= smoothstep(0.52, 0.84, ny);
      t = mix(t, uSnowCol, clamp(snowM, 0.0, 1.0));
    }
    col = t;
  }

  if (uGrid > 0.5){
    float g2 = gridAA(P, max(uGridSpacing, 0.05));
    col = mix(col, col * 0.34 + vec3(0.05), g2 * uGridOpacity);
  }

  /* ---- contact shadow ---------------------------------------------------
     Cheap stand-in for a shadow map: the same density grid that limits how
     much grass a brush stroke can pack into a cell is sampled again here,
     offset along the sun's ground projection, and used to darken the plate.
     Costs one texture fetch and reads as grass sitting IN the ground. */
  float shade = 1.0;
  if (uShadow > 0.5){
    vec2 uv = P / uPlateSize + 0.5 + uShadowOffset;
    float d = texture2D(uDensTex, clamp(uv, vec2(0.0), vec2(1.0))).r;
    shade = 1.0 - smoothstep(0.0, 1.0, d) * uShadowStrength;
  }

  vec3 L = uSunDir;
  float ndl = max(0.0, dot(N, L));
  vec3  V = normalize(cameraPosition - vW);
  vec3  Hv = normalize(L + V);
  float spec = pow(max(0.0, dot(N, Hv)), mix(70.0, 3.0, uRoughness)) * (1.0 - uRoughness) * 0.35;

  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;
  vec3 lit = col * (uSunColor * ndl * shade + amb * mix(0.55, 1.0, shade))
           + uSunColor * spec * shade;

  lit = gp_fog(lit, length(cameraPosition - vW));
  gl_FragColor = gp_out(lit, uExposure);
}
`;

/* ==========================================================================
   SKY — full-screen quad; the view ray is rebuilt from the inverse
   view-projection so no geometry or HDRI is involved.
   ========================================================================== */
var SKY_VS = `
uniform mat4 uInvVP;
varying vec3 vDir;
void main(){
  vec4 p = uInvVP * vec4(position.xy, 1.0, 1.0);
  vDir = p.xyz / p.w - cameraPosition;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

var SKY_FS = GLSL_NOISE + GLSL_COLOR + `
uniform vec3  uZenith, uHorizon, uSunColor, uSunDir, uFogColor;
uniform float uExposure, uSunSize;
varying vec3 vDir;

void main(){
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);

  // Gradient: horizon band compressed with a power curve so the transition
  // sits low in the frame the way a real sky does.
  float k = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, k);

  // Below the horizon fade into the fog colour so the plate edge dissolves.
  col = mix(col, uFogColor, smoothstep(0.0, -0.16, h));

  // Sun disc + broad forward-scattering halo.
  float cd = max(0.0, dot(d, uSunDir));
  float disc = smoothstep(0.9985, 0.99965, cd) * 14.0;
  float halo = pow(cd, 220.0) * 2.2 + pow(cd, 12.0) * 0.30 + pow(cd, 3.0) * 0.07;
  col += uSunColor * (disc + halo) * smoothstep(-0.12, 0.05, uSunDir.y);

  gl_FragColor = gp_out(col, uExposure);
}
`;

/* ==========================================================================
   BALL — the draggable object that parts the grass.
   ========================================================================== */
var BALL_VS = `
varying vec3 vW, vN;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
var BALL_FS = GLSL_COLOR + GLSL_FOG + `
uniform vec3  uSunDir, uSunColor, uSkyColor, uGroundColor, uColor;
uniform float uAmbient, uExposure;
varying vec3 vW, vN;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = max(0.0, dot(N, uSunDir));
  vec3 Hv = normalize(uSunDir + V);
  float spec = pow(max(0.0, dot(N, Hv)), 46.0) * 0.55;
  float rim  = pow(1.0 - max(0.0, dot(N, V)), 3.0) * 0.5;
  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;
  vec3 lit = uColor * (uSunColor * ndl + amb) + uSunColor * spec + uSkyColor * rim;
  lit = gp_fog(lit, length(cameraPosition - vW));
  gl_FragColor = gp_out(lit, uExposure);
}
`;

/* ==========================================================================
   BRUSH RING — unlit overlay ribbon that follows the ground surface.
   ========================================================================== */
var RING_VS = `
attribute float aAlpha;
varying float vA;
void main(){
  vA = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
var RING_FS = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main(){
  gl_FragColor = vec4(uColor, vA * uOpacity);
}
`;
/* ==========================================================================
   3b. WORLD OBJECT SHADERS
   --------------------------------------------------------------------------
   One material serves every placed object — trees, buildings, props, people,
   vehicles. Geometry is non-indexed with baked face normals, which gives the
   flat-shaded low-poly look without a second pass.

   Vertex attributes (baked into the asset):
     position   vec3
     normal     vec3   face normal, flat shaded
     aColSlot   vec4   rgb = baked colour, w = palette slot (0 = use rgb)
     aPS        vec2   x = animated part id, y = wind sway weight

   Instance attributes:
     iPosSeed   vec4   world position + per-instance random
     iQuat      vec4   orientation
     iSclSway   vec4   scale.xyz + wind response multiplier
     iPal0/1/2  vec3   the three recolourable palette slots
     iAnim      vec4   x = anim phase, y = anim rate, z = pose, w = selected
   ========================================================================== */
/* ==========================================================================
   WATER — a grid that only exists where the terrain sits below the water
   line. Depth is baked per vertex on the CPU, which is what drives both the
   deep/shallow colour ramp and the shoreline foam without a depth prepass.
   ========================================================================== */
var WATER_VS = `
attribute float aDepth;
uniform float uTime, uWaveScale, uWaveSpeed, uLevel, uSimulate;
varying float vDepth;
varying vec3 vW;
varying vec2 vRipple;

void main(){
  vec3 p = position;
  vDepth = aDepth;
  float t = uTime * uWaveSpeed * uSimulate;
  // Two crossing wave trains: enough motion to read as water, cheap enough to
  // run on a 128x128 grid every frame.
  float w = sin(p.x * uWaveScale * 1.7 + t * 1.6) * 0.5
          + sin((p.x * 0.7 + p.z) * uWaveScale * 2.3 - t * 2.1) * 0.3
          + sin(p.z * uWaveScale * 3.1 + t * 2.7) * 0.2;
  p.y = uLevel + w * 0.075 * smoothstep(0.0, 0.6, aDepth);
  vRipple = vec2(
    cos(p.x * uWaveScale * 1.7 + t * 1.6) * 0.09 + cos(p.z * uWaveScale * 3.1 + t * 2.7) * 0.05,
    cos((p.x * 0.7 + p.z) * uWaveScale * 2.3 - t * 2.1) * 0.08
  );
  vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

var WATER_FS = GLSL_COLOR + GLSL_FOG + `
uniform vec3 uShallow, uDeep, uSunDir, uSunColor, uSkyColor;
uniform float uExposure, uOpacity, uFoam;
varying float vDepth;
varying vec3 vW;
varying vec2 vRipple;

void main(){
  vec3 N = normalize(vec3(vRipple.x, 1.0, vRipple.y));
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - max(0.0, dot(N, V)), 3.0);

  vec3 col = mix(uShallow, uDeep, smoothstep(0.0, 3.2, vDepth));
  col = mix(col, uSkyColor * 1.6, fres * 0.7);

  vec3 Hv = normalize(uSunDir + V);
  col += uSunColor * pow(max(0.0, dot(N, Hv)), 180.0) * 0.9;

  // Shoreline foam: a band where the water is only a few centimetres deep,
  // broken up by the ripple so it is not a perfect contour line.
  float band = 1.0 - smoothstep(0.0, 0.38, vDepth - abs(vRipple.x) * 0.9);
  float foam = clamp(band, 0.0, 1.0) * uFoam;
  col = mix(col, vec3(0.92, 0.96, 0.98), foam * 0.75);

  float a = mix(uOpacity * 0.55, uOpacity, smoothstep(0.0, 1.2, vDepth));
  a = max(a, foam * 0.9);
  col = gp_fog(col, length(cameraPosition - vW));
  vec4 o = gp_out(col, uExposure);
  o.a = a * smoothstep(0.0, 0.06, vDepth);
  gl_FragColor = o;
}
`;

/* ==========================================================================
   ROAD — ribbon geometry. Lane markings, curbs and wear are all shader-side
   off the ribbon's (across, along) coordinates, so a road needs no textures.
   ========================================================================== */
var ROAD_VS = `
attribute vec2 aUV;      // x = -1..1 across the ribbon, y = metres along it
attribute float aKind;   // 0 road surface, 1 sidewalk, 2 junction patch
varying vec2 vUV;
varying vec3 vW, vN;
varying float vKind;
void main(){
  vUV = aUV; vKind = aKind;
  vN = normal;
  vW = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

var ROAD_FS = GLSL_NOISE + GLSL_COLOR + GLSL_FOG + `
uniform vec3 uSurface, uEdge, uLine, uWalk;
uniform float uMarkings, uExposure, uAmbient, uGrain, uWater, uTime;
uniform vec3 uSunDir, uSunColor, uSkyColor, uGroundColor;
varying vec2 vUV;
varying vec3 vW, vN;
varying float vKind;

void main(){
  vec3 col = (vKind > 0.5 && vKind < 1.5) ? uWalk : uSurface;
  float a = abs(vUV.x);

  /* Rivers reuse this ribbon but shade as water: a scrolling ripple normal,
     a fresnel sky term and foam where the banks pinch in. */
  if (uWater > 0.5){
    vec2 rp = vW.xz * 0.7 + vec2(uTime * 0.35, uTime * 0.22);
    float r1 = snoise(rp), r2 = snoise(rp * 2.3 - 4.1);
    vec3 N = normalize(vec3(r1 * 0.22, 1.0, r2 * 0.22));
    vec3 V = normalize(cameraPosition - vW);
    float fres = pow(1.0 - max(0.0, dot(N, V)), 3.0);
    col = mix(uSurface, uEdge, 0.5 + 0.5 * r2);
    col = mix(col, uSkyColor * 1.7, fres * 0.65);
    vec3 Hw = normalize(uSunDir + V);
    col += uSunColor * pow(max(0.0, dot(N, Hw)), 150.0) * 0.8;
    float bank = smoothstep(0.72, 0.99, a);
    col = mix(col, vec3(0.9, 0.94, 0.96), bank * 0.5);
    col = gp_fog(col, length(cameraPosition - vW));
    gl_FragColor = gp_out(col, uExposure);
    return;
  }

  if (vKind < 0.5){
    // darker, more worn toward the shoulder
    col = mix(col, uEdge, smoothstep(0.55, 1.0, a));
    if (uMarkings > 0.5){
      // dashed centre line
      float dash = step(0.5, fract(vUV.y * 0.14));
      float centre = 1.0 - smoothstep(0.028, 0.055, a);
      col = mix(col, uLine, centre * dash);
      // solid edge lines
      float edge = smoothstep(0.80, 0.845, a) - smoothstep(0.875, 0.92, a);
      col = mix(col, uLine, clamp(edge, 0.0, 1.0) * 0.85);
    }
  } else if (vKind > 1.5){
    col = mix(col, uEdge, 0.12);
  } else {
    // paving joints across the sidewalk
    float j = 1.0 - smoothstep(0.02, 0.06, abs(fract(vUV.y * 0.62) - 0.5) * 2.0 - 0.9);
    col = mix(col, col * 0.86, clamp(j, 0.0, 1.0));
  }

  col *= 0.94 + 0.12 * (snoise(vW.xz * 2.7) * 0.5 + 0.5) * uGrain;

  vec3 N = normalize(vN);
  float ndl = max(0.0, dot(N, uSunDir));
  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;
  vec3 lit = col * (uSunColor * ndl + amb);
  lit = gp_fog(lit, length(cameraPosition - vW));
  gl_FragColor = gp_out(lit, uExposure);
}
`;

/* ==========================================================================
   OUTLINE — unlit lines for selection boxes, spline control cages and the
   transform gizmo.
   ========================================================================== */
var LINE_VS = `
attribute vec3 aColor;
varying vec3 vC;
void main(){
  vC = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
var LINE_FS = `
uniform float uOpacity;
varying vec3 vC;
void main(){ gl_FragColor = vec4(vC, uOpacity); }
`;
/* ==========================================================================
   4. RENDERER + CAMERA
   ========================================================================== */

var canvas, renderer, scene, camera, cam;   // `cam` = the orbit controller
var viewW = 1, viewH = 1, basePR = 1;

function initRenderer() {
  canvas = document.getElementById('view');
  renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, alpha: false,
    powerPreference: 'high-performance', stencil: false
  });
  // All tone mapping / gamma is done explicitly inside the shaders (gp_out),
  // so the renderer stays in raw linear pass-through mode.
  if (THREE.ColorManagement) THREE.ColorManagement.enabled = false;
  renderer.outputEncoding = THREE.LinearEncoding;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 1);

  basePR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(basePR);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(52, 1, 0.1, 6000);
  cam = new OrbitCam(camera);

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    toast('WebGL context lost — reload the page to continue', 'err', 8000);
  });

  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  var st = document.getElementById('stage');
  viewW = Math.max(1, st.clientWidth);
  viewH = Math.max(1, st.clientHeight);
  renderer.setSize(viewW, viewH, false);
  camera.aspect = viewW / viewH;
  camera.updateProjectionMatrix();
}

/* --------------------------------------------------------------------------
   Orbit camera. Written from scratch (rather than pulling in OrbitControls)
   so the tool can remap mouse buttons per active tool and so damping is
   frame-rate independent instead of a fixed per-frame lerp.
   -------------------------------------------------------------------------- */
function OrbitCam(camera) {
  this.cam = camera;
  this.target = new THREE.Vector3(0, 0.5, 0);
  this.tTarget = this.target.clone();
  this.sph = { r: 30, th: Math.PI * 0.28, ph: Math.PI * 0.34 };
  this.tSph = { r: 30, th: Math.PI * 0.28, ph: Math.PI * 0.34 };
  this.minR = 1.5; this.maxR = 500;
  // A fly camera has to be able to look up, so the pitch range covers most
  // of the sphere rather than stopping at the horizon like a pure orbit rig.
  this.minPh = 0.06; this.maxPh = Math.PI - 0.06;
  this.resp = 15;
  this._r = new THREE.Vector3(); this._u = new THREE.Vector3();
  this._fwd = new THREE.Vector3(); this._rgt = new THREE.Vector3();
  this._off = new THREE.Vector3(); this._pos = new THREE.Vector3();
}

/* Offset from focus point to camera for a given spherical setting. */
OrbitCam.prototype.offsetVec = function (s, out) {
  var sp = Math.sin(s.ph), cp = Math.cos(s.ph);
  return out.set(s.r * sp * Math.sin(s.th), s.r * cp, s.r * sp * Math.cos(s.th));
};
/* Where the camera is heading, i.e. the un-damped position. */
OrbitCam.prototype.goalPos = function (out) {
  this.offsetVec(this.tSph, this._off);
  return out.copy(this.tTarget).add(this._off);
};
/* Unit view direction (camera -> focus point). */
OrbitCam.prototype.forward = function (out) {
  this.offsetVec(this.tSph, this._off);
  return out.copy(this._off).multiplyScalar(-1).normalize();
};
OrbitCam.prototype.orbit = function (dx, dy) {
  this.tSph.th -= dx * 0.0052;
  this.tSph.ph = clamp(this.tSph.ph - dy * 0.0052, this.minPh, this.maxPh);
};
/* Roblox-style free look: the camera stays put and the focus point swings
   around it, instead of the camera swinging around the focus point. */
OrbitCam.prototype.look = function (dx, dy) {
  var sens = 0.0052 * (state.cam ? state.cam.lookSens : 1);
  this.goalPos(this._pos);
  this.tSph.th -= dx * sens;
  this.tSph.ph = clamp(this.tSph.ph - dy * sens * ((state.cam && state.cam.invertY) ? -1 : 1),
                       this.minPh, this.maxPh);
  this.offsetVec(this.tSph, this._off);
  this.tTarget.copy(this._pos).sub(this._off);
};

/* Slide the whole rig along its view direction. */
OrbitCam.prototype.moveAlongView = function (d) {
  this.forward(this._fwd);
  this.tTarget.addScaledVector(this._fwd, d);
};

/* WASD / QE. W follows the full look direction — pitch down and W descends,
   which is what makes flying feel direct rather than tank-like. */
OrbitCam.prototype.flyStep = function (dt) {
  var m = Keys.move;
  var f = (m.f ? 1 : 0) - (m.b ? 1 : 0);
  var r = (m.r ? 1 : 0) - (m.l ? 1 : 0);
  var u = (m.u ? 1 : 0) - (m.d ? 1 : 0);
  if (!f && !r && !u) return false;
  var c = state.cam;
  var speed = c.flySpeed * (Keys.shift ? c.boost : 1) * dt;
  this.forward(this._fwd);
  // right = forward x worldUp
  this._rgt.set(-this._fwd.z, 0, this._fwd.x);
  if (this._rgt.lengthSq() < 1e-6) this._rgt.set(1, 0, 0);
  this._rgt.normalize();
  if (f) this.tTarget.addScaledVector(this._fwd, f * speed);
  if (r) this.tTarget.addScaledVector(this._rgt, r * speed);
  if (u) this.tTarget.y += u * speed;
  return true;
};

/* Frame a point at a sensible distance — used by F on a selection. */
OrbitCam.prototype.focusOn = function (x, y, z, radius) {
  var want = clamp((radius || 1) * 3.2, 3, this.maxR);
  this.tTarget.set(x, y, z);
  this.tSph.r = want;
};

OrbitCam.prototype.pan = function (dx, dy) {
  var h = 2 * this.sph.r * Math.tan(this.cam.fov * 0.5 * DEG) / Math.max(viewH, 1);
  var m = this.cam.matrix;
  this._r.set(m.elements[0], m.elements[1], m.elements[2]);
  this._u.set(m.elements[4], m.elements[5], m.elements[6]);
  this.tTarget.addScaledVector(this._r, -dx * h).addScaledVector(this._u, dy * h);
};
/* Scroll zooms toward the focus point, and once it gets there keeps pushing
   the whole rig forward — so you can scroll straight through a scene instead
   of stalling at a pivot. */
OrbitCam.prototype.dolly = function (f) {
  var nr = this.tSph.r * f;
  if (nr < this.minR) { this.moveAlongView(this.minR - nr); nr = this.minR; }
  else if (nr > this.maxR) { this.moveAlongView(-(nr - this.maxR)); nr = this.maxR; }
  this.tSph.r = nr;
};
OrbitCam.prototype.frame = function (w, d, h) {
  var rad = Math.max(w, d) * 0.72 + (h || 0);
  // Fit against whichever axis is tighter: on a portrait viewport the
  // horizontal field of view is the limit, not the vertical one.
  var tv = Math.tan(this.cam.fov * 0.5 * DEG);
  var th = tv * Math.max(this.cam.aspect, 0.01);
  this.tSph.r = clamp(rad / Math.min(tv, th) * 0.62, this.minR, this.maxR);
  this.tTarget.set(0, (h || 0) * 0.3, 0);
};
OrbitCam.prototype.snap = function () {
  this.sph.r = this.tSph.r; this.sph.th = this.tSph.th; this.sph.ph = this.tSph.ph;
  this.target.copy(this.tTarget); this.apply();
};
OrbitCam.prototype.update = function (dt) {
  var a = 1 - Math.exp(-dt * this.resp);
  this.sph.r  += (this.tSph.r  - this.sph.r)  * a;
  this.sph.th += (this.tSph.th - this.sph.th) * a;
  this.sph.ph += (this.tSph.ph - this.sph.ph) * a;
  this.target.lerp(this.tTarget, a);
  this.apply();
};
OrbitCam.prototype.apply = function () {
  var s = this.sph, sp = Math.sin(s.ph), cp = Math.cos(s.ph);
  this.cam.position.set(
    this.target.x + s.r * sp * Math.sin(s.th),
    this.target.y + s.r * cp,
    this.target.z + s.r * sp * Math.cos(s.th)
  );
  this.cam.lookAt(this.target);
  this.cam.updateMatrixWorld();
};

/* ==========================================================================
   5. ENVIRONMENT — time of day drives sun, sky, ambient and fog together.
   ========================================================================== */

/* Keyframes indexed by the sun's height above the horizon. Values are LINEAR
   light, not sRGB, so they can exceed 1 for the sun. */
var SUN_KEYS = [
  { y: -0.40, sun: [0.010, 0.014, 0.032], zen: [0.008, 0.012, 0.030], hor: [0.028, 0.036, 0.062], amb: [0.030, 0.044, 0.090], gnd: [0.012, 0.014, 0.022] },
  { y: -0.09, sun: [0.120, 0.070, 0.062], zen: [0.020, 0.034, 0.082], hor: [0.150, 0.100, 0.110], amb: [0.070, 0.088, 0.150], gnd: [0.024, 0.026, 0.036] },
  { y:  0.02, sun: [1.150, 0.430, 0.180], zen: [0.055, 0.098, 0.215], hor: [0.680, 0.330, 0.230], amb: [0.150, 0.160, 0.230], gnd: [0.055, 0.048, 0.048] },
  { y:  0.14, sun: [1.420, 0.760, 0.400], zen: [0.115, 0.215, 0.470], hor: [0.860, 0.610, 0.470], amb: [0.240, 0.260, 0.340], gnd: [0.085, 0.080, 0.070] },
  { y:  0.40, sun: [1.400, 1.130, 0.860], zen: [0.140, 0.300, 0.720], hor: [0.560, 0.680, 0.860], amb: [0.330, 0.390, 0.500], gnd: [0.110, 0.110, 0.098] },
  { y:  0.85, sun: [1.380, 1.330, 1.220], zen: [0.120, 0.310, 0.860], hor: [0.640, 0.780, 0.960], amb: [0.380, 0.440, 0.560], gnd: [0.125, 0.125, 0.115] }
];

var Env = {
  sunDir: new THREE.Vector3(0, 1, 0),
  sun:    new THREE.Vector3(),
  zenith: new THREE.Vector3(),
  horizon:new THREE.Vector3(),
  amb:    new THREE.Vector3(),
  gnd:    new THREE.Vector3(),
  fog:    new THREE.Vector3(),
  ambient: 1
};

function updateEnv() {
  var e = state.env;
  var h = e.timeOfDay;

  // Sun path: elevation follows a sine keyed to 06:00 rise / 18:00 set, and
  // the azimuth sweeps through the day so shadows rotate rather than flip.
  var a  = (h - 6) / 12 * Math.PI;
  var el = Math.sin(a) * (Math.PI * 0.5) * 0.94;
  var az = Math.PI * 0.28 + (h / 24) * Math.PI * 1.35;
  Env.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();

  // Blend the keyframe table by sun height.
  var y = Env.sunDir.y, i = 0;
  while (i < SUN_KEYS.length - 2 && y > SUN_KEYS[i + 1].y) i++;
  var k0 = SUN_KEYS[i], k1 = SUN_KEYS[i + 1];
  var t = clamp((y - k0.y) / (k1.y - k0.y), 0, 1);
  t = t * t * (3 - 2 * t);

  var sun = mixArr(k0.sun, k1.sun, t);
  var zen = mixArr(k0.zen, k1.zen, t);
  var hor = mixArr(k0.hor, k1.hor, t);
  var amb = mixArr(k0.amb, k1.amb, t);
  var gnd = mixArr(k0.gnd, k1.gnd, t);

  Env.sun.fromArray(sun);
  Env.zenith.fromArray(zen);
  Env.horizon.fromArray(hor);
  Env.amb.fromArray(amb);
  Env.gnd.fromArray(gnd);
  Env.ambient = 1;

  if (e.fogAuto) {
    Env.fog.set(lerp(hor[0], zen[0], 0.3), lerp(hor[1], zen[1], 0.3), lerp(hor[2], zen[2], 0.3));
  } else {
    hexLin(e.fogColor, Env.fog);
  }
}

/* Human-readable clock for the time-of-day slider. */
function clockLabel(h) {
  var hh = Math.floor(h) % 24, mm = Math.floor((h - Math.floor(h)) * 60);
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}
/* ==========================================================================
   6. TERRAIN / BASEPLATE
   ========================================================================== */

var Terrain = {
  N: 1,                       // segments per side (grid is (N+1)^2 vertices)
  h: new Float32Array(4),     // final height = procedural base + sculpt
  base: new Float32Array(4),
  sculpt: new Float32Array(4),
  min: 0, max: 0,
  mesh: null, geo: null, mat: null
};

var sky = null, ball = null, ring = null;

function terrainSegs() {
  if (state.plate.mode === 'flat') return 1;
  return clamp(Math.round(Math.max(state.plate.width, state.plate.depth) * 2.6), 48, 192);
}

/* Resample the user's sculpt offsets when the grid resolution changes, so
   resizing the plate or toggling modes never throws sculpting away. */
function resampleSculpt(oldN, oldArr, newN) {
  var out = new Float32Array((newN + 1) * (newN + 1));
  if (!oldArr || oldN < 1) return out;
  var oW = oldN + 1, nW = newN + 1;
  for (var j = 0; j < nW; j++) {
    var v = j / newN * oldN, jj = Math.min(oldN - 1, v | 0), fv = v - jj;
    if (oldN === 0) { jj = 0; fv = 0; }
    for (var i = 0; i < nW; i++) {
      var u = i / newN * oldN, ii = Math.min(oldN - 1, u | 0), fu = u - ii;
      var a = oldArr[jj * oW + ii], b = oldArr[jj * oW + Math.min(ii + 1, oldN)];
      var c = oldArr[Math.min(jj + 1, oldN) * oW + ii], d = oldArr[Math.min(jj + 1, oldN) * oW + Math.min(ii + 1, oldN)];
      out[j * nW + i] = lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
    }
  }
  return out;
}

function computeTerrainHeights() {
  var p = state.plate, N = Terrain.N, W = N + 1;
  var base = Terrain.base, h = Terrain.h, sc = Terrain.sculpt;
  var mn = 1e9, mx = -1e9;
  if (p.mode === 'flat') {
    for (var k = 0; k < W * W; k++) { base[k] = 0; h[k] = 0; }
    Terrain.min = 0; Terrain.max = 0;
    return;
  }
  var oct = Math.max(1, Math.round(p.octaves));
  for (var j = 0; j < W; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = 0; i < W; i++) {
      var x = (i / N - 0.5) * p.width;
      var n = SN.fbm(x * p.frequency, z * p.frequency, oct);
      var idx = j * W + i;
      base[idx] = n * p.amplitude;
      var v = base[idx] + sc[idx];
      h[idx] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  Terrain.min = mn; Terrain.max = mx;
}

function buildGroundGeometry() {
  var N = Terrain.N, W = N + 1, p = state.plate;
  var need = !Terrain.geo || Terrain.geo.userData.N !== N;
  if (need) {
    if (Terrain.geo) Terrain.geo.dispose();
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(W * W * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(W * W * 3), 3));
    var idx = (W * W > 65535) ? new Uint32Array(N * N * 6) : new Uint16Array(N * N * 6);
    var o = 0;
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        var a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.userData.N = N;
    Terrain.geo = g;
    if (Terrain.mesh) Terrain.mesh.geometry = g;
  }
  updateGroundVerts(0, N);
  Terrain.geo.computeBoundingSphere();
}

/* Rewrite vertex rows j0..j1 (inclusive) from the heightfield. */
function updateGroundVerts(j0, j1) {
  var N = Terrain.N, W = N + 1, p = state.plate, h = Terrain.h;
  var pos = Terrain.geo.attributes.position, nrm = Terrain.geo.attributes.normal;
  var pa = pos.array, na = nrm.array;
  var cx = p.width / N, cz = p.depth / N;
  j0 = clamp(j0, 0, N); j1 = clamp(j1, 0, N);
  for (var j = j0; j <= j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = 0; i < W; i++) {
      var k = j * W + i, o = k * 3;
      pa[o] = (i / N - 0.5) * p.width;
      pa[o + 1] = h[k];
      pa[o + 2] = z;
      // Analytic normal from central differences on the heightfield.
      var hl = h[j * W + Math.max(i - 1, 0)], hr = h[j * W + Math.min(i + 1, N)];
      var hd = h[Math.max(j - 1, 0) * W + i], hu = h[Math.min(j + 1, N) * W + i];
      var dx = (hr - hl) / (cx * (i === 0 || i === N ? 1 : 2));
      var dz = (hu - hd) / (cz * (j === 0 || j === N ? 1 : 2));
      var nx = -dx, ny = 1, nz = -dz;
      var il = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      na[o] = nx * il; na[o + 1] = ny * il; na[o + 2] = nz * il;
    }
  }
  var off = j0 * W * 3, cnt = (j1 - j0 + 1) * W * 3;
  pos.updateRange.offset = off; pos.updateRange.count = cnt; pos.needsUpdate = true;
  nrm.updateRange.offset = off; nrm.updateRange.count = cnt; nrm.needsUpdate = true;
}

/* Rebuild the whole plate. `keepSculpt` survives resolution changes. */
function rebuildPlate() {
  var newN = terrainSegs();
  if (newN !== Terrain.N || Terrain.sculpt.length !== (newN + 1) * (newN + 1)) {
    Terrain.sculpt = resampleSculpt(Terrain.N, Terrain.sculpt, newN);
    Terrain.N = newN;
    var n = (newN + 1) * (newN + 1);
    Terrain.h = new Float32Array(n);
    Terrain.base = new Float32Array(n);
  }
  computeTerrainHeights();
  buildGroundGeometry();
  syncGroundUniforms();
  rebuildDensityGrid();
  resnapAll();
  updateGrassBounds();
  if (Water.mesh) rebuildWater();
  if (Roads.group) { for (var r = 0; r < World.roads.length; r++) World.roads[r]._dirty = true; rebuildAllRoads(); }
  resnapWorld();
}

function heightAt(x, z) {
  if (state.plate.mode === 'flat') return 0;
  var p = state.plate, N = Terrain.N, W = N + 1, T = Terrain.h;
  var u = clamp((x / p.width + 0.5) * N, 0, N - 1e-5);
  var v = clamp((z / p.depth + 0.5) * N, 0, N - 1e-5);
  var i = u | 0, j = v | 0, fu = u - i, fv = v - j;
  var a = T[j * W + i], b = T[j * W + i + 1], c = T[(j + 1) * W + i], d = T[(j + 1) * W + i + 1];
  return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
}

var _nrmTmp = new THREE.Vector3();
function normalAt(x, z, out) {
  out = out || _nrmTmp;
  if (state.plate.mode === 'flat') return out.set(0, 1, 0);
  var e = Math.max(state.plate.width, state.plate.depth) / Terrain.N;
  var dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  var dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return out.set(-dx, 1, -dz).normalize();
}

/* --------------------------------------------------------------------------
   Ray marching against the heightfield. Much faster and more robust than
   raycasting 70k triangles, and it degenerates to an exact plane test when
   the plate is flat.
   -------------------------------------------------------------------------- */
function raycastGround(ro, rd, out) {
  var p = state.plate, hw = p.width * 0.5, hd = p.depth * 0.5;
  out = out || new THREE.Vector3();

  if (p.mode === 'flat') {
    if (Math.abs(rd.y) < 1e-7) return null;
    var t = -ro.y / rd.y;
    if (t <= 0) return null;
    var x = ro.x + rd.x * t, z = ro.z + rd.z * t;
    if (Math.abs(x) > hw || Math.abs(z) > hd) return null;
    return out.set(x, 0, z);
  }

  // Clip the ray to the terrain's bounding slab first.
  var t0 = 0, t1 = 1e9;
  var lo = [-hw, Terrain.min - 1, -hd], hi = [hw, Terrain.max + 1, hd];
  var o = [ro.x, ro.y, ro.z], d = [rd.x, rd.y, rd.z];
  for (var ax = 0; ax < 3; ax++) {
    if (Math.abs(d[ax]) < 1e-9) { if (o[ax] < lo[ax] || o[ax] > hi[ax]) return null; continue; }
    var ta = (lo[ax] - o[ax]) / d[ax], tb = (hi[ax] - o[ax]) / d[ax];
    if (ta > tb) { var tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  t0 = Math.max(t0, 0);

  var span = t1 - t0;
  if (span <= 0) return null;
  var steps = 256, step = span / steps;
  var pt = t0, prev = ro.y + rd.y * t0 - heightAt(ro.x + rd.x * t0, ro.z + rd.z * t0);
  if (prev < 0) {
    // started underground — walk backwards is not useful, just accept entry
    return out.set(ro.x + rd.x * t0, heightAt(ro.x + rd.x * t0, ro.z + rd.z * t0), ro.z + rd.z * t0);
  }
  for (var s = 1; s <= steps; s++) {
    var tc = t0 + s * step;
    var cx = ro.x + rd.x * tc, cz = ro.z + rd.z * tc;
    var cur = ro.y + rd.y * tc - heightAt(cx, cz);
    if (cur <= 0) {
      // bisect between pt and tc
      var lo2 = pt, hi2 = tc;
      for (var b = 0; b < 14; b++) {
        var mid = (lo2 + hi2) * 0.5;
        var mx = ro.x + rd.x * mid, mz = ro.z + rd.z * mid;
        if (ro.y + rd.y * mid - heightAt(mx, mz) > 0) lo2 = mid; else hi2 = mid;
      }
      var tf = (lo2 + hi2) * 0.5;
      var fx = ro.x + rd.x * tf, fz = ro.z + rd.z * tf;
      if (Math.abs(fx) > hw + 1e-3 || Math.abs(fz) > hd + 1e-3) return null;
      return out.set(fx, heightAt(fx, fz), fz);
    }
    pt = tc; prev = cur;
  }
  return null;
}

var _rayO = new THREE.Vector3(), _rayD = new THREE.Vector3(), _ndc = new THREE.Vector3();
function screenRay(px, py) {
  _ndc.set((px / viewW) * 2 - 1, -(py / viewH) * 2 + 1, 0.5);
  _ndc.unproject(camera);
  _rayO.copy(camera.position);
  _rayD.copy(_ndc).sub(_rayO).normalize();
  return true;
}

/* --------------------------------------------------------------------------
   Sculpt brush — raise / lower / smooth / flatten on the sculpt offset grid.
   -------------------------------------------------------------------------- */
function sculptStamp(cx, cz, dt) {
  var p = state.plate, b = state.brush, N = Terrain.N, W = N + 1;
  if (p.mode !== 'terrain') return;
  var r = b.radius, sc = Terrain.sculpt;
  var i0 = clamp(Math.floor((( cx - r) / p.width + 0.5) * N), 0, N);
  var i1 = clamp(Math.ceil ((( cx + r) / p.width + 0.5) * N), 0, N);
  var j0 = clamp(Math.floor((( cz - r) / p.depth + 0.5) * N), 0, N);
  var j1 = clamp(Math.ceil ((( cz + r) / p.depth + 0.5) * N), 0, N);
  var amount = b.sculptStrength * dt * 4.0;
  var mode = b.sculpt;
  var edge = lerp(0.05, 0.96, b.falloff);

  // For flatten we need the height under the brush centre first.
  var flatH = heightAt(cx, cz);

  for (var j = j0; j <= j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = i0; i <= i1; i++) {
      var x = (i / N - 0.5) * p.width;
      var dx = x - cx, dz = z - cz;
      var dd = Math.sqrt(dx * dx + dz * dz) / r;
      if (dd > 1) continue;
      var w = 1 - smoothstep(edge, 1, dd);
      var k = j * W + i;
      if (mode === 'raise')       sc[k] += amount * w;
      else if (mode === 'lower')  sc[k] -= amount * w;
      else if (mode === 'flatten') sc[k] += (flatH - Terrain.h[k]) * clamp(amount * w * 1.4, 0, 1);
      else { // smooth
        var hl = Terrain.h[j * W + Math.max(i - 1, 0)], hr = Terrain.h[j * W + Math.min(i + 1, N)];
        var hb = Terrain.h[Math.max(j - 1, 0) * W + i], ht = Terrain.h[Math.min(j + 1, N) * W + i];
        var avg = (hl + hr + hb + ht) * 0.25;
        sc[k] += (avg - Terrain.h[k]) * clamp(amount * w * 1.6, 0, 1);
      }
      var nv = Terrain.base[k] + sc[k];
      Terrain.h[k] = nv;
      if (nv < Terrain.min) Terrain.min = nv;
      if (nv > Terrain.max) Terrain.max = nv;
    }
  }
  updateGroundVerts(Math.max(j0 - 1, 0), Math.min(j1 + 1, N));
  resnapRegion(cx, cz, r + 1.5);
}
/* ==========================================================================
   6b. HEIGHTMAP TERRAIN
   --------------------------------------------------------------------------
   Replaces the Phase 1 baseplate noise with a seeded landform generator plus a
   full sculpt brush set. These are plain function declarations that shadow the
   Phase 1 versions of the same name, so every existing caller — heightAt(),
   raycastGround(), grass re-snapping — keeps working unchanged.
   ========================================================================== */

var RES_CHOICES = [64, 128, 256, 512];

function terrainSegs() {
  if (state.plate.mode === 'flat') return 1;
  var r = state.plate.resolution;
  var best = RES_CHOICES[0];
  for (var i = 0; i < RES_CHOICES.length; i++) if (Math.abs(RES_CHOICES[i] - r) < Math.abs(best - r)) best = RES_CHOICES[i];
  return best;
}

/* Seed only shifts the sample domain — cheaper than reseeding the permutation
   table and just as effective for "give me a different mountain range". */
function seedOffsets() {
  var s = state.plate.seed >>> 0;
  return [((s % 9973) * 0.731) % 5000 + 13.7, (((s >>> 7) % 9871) * 0.917) % 5000 - 21.3];
}

function landformSample(x, z, ox, oz) {
  var p = state.plate;
  var f = Math.max(0.0005, p.frequency);
  var oct = clamp(Math.round(p.octaves), 1, 6);
  var n = SN.fbm((x + ox) * f, (z + oz) * f, oct);

  switch (p.landform) {
    case 'flat': return 0;

    case 'rolling': return n;

    case 'mountains': {
      // Ridged multifractal: folding the noise about zero turns smooth hills
      // into sharp crests, then a low-frequency mask keeps some areas low so
      // the range has passes and foothills instead of uniform spikes.
      var r = SN.fbm((x + ox) * f * 0.62, (z + oz) * f * 0.62, oct);
      var ridge = 1 - Math.abs(r);
      ridge = ridge * ridge * ridge;
      var mask = SN.fbm((x + ox) * f * 0.21, (z + oz) * f * 0.21, 2) * 0.5 + 0.5;
      return (ridge * 2.3 - 0.55) * (0.3 + 1.0 * mask) + n * 0.18;
    }

    case 'valley': {
      var wob = SN.noise((z + oz) * f * 0.55, 11.3) * p.width * 0.18;
      var d = Math.abs(x - wob) / (p.width * 0.5);
      return n * 0.3 + smoothstep(0.10, 0.9, d) * 1.7 - 0.42;
    }

    case 'island': {
      var rx = x / (p.width * 0.5), rz = z / (p.depth * 0.5);
      var dd = Math.sqrt(rx * rx + rz * rz);
      var fall = 1 - smoothstep(0.30, 1.0, dd + n * 0.09);
      return (n * 0.5 + 0.6) * fall * 2.1 - 0.55;
    }

    case 'plateau': {
      var v = n * 0.5 + 0.5;
      var st = v * 3.4;
      var base = Math.floor(st) / 3.4;
      // soften the riser so the terraces are cut, not stamped
      var frac = st - Math.floor(st);
      return (base + smoothstep(0.62, 0.98, frac) * (1 / 3.4)) * 2 - 1;
    }

    case 'canyon': {
      var cxx = SN.noise((z + oz) * f * 0.42, 4.7) * p.width * 0.3;
      var d3 = Math.abs(x - cxx) / (p.width * 0.5);
      var carve = 1 - smoothstep(0.015, 0.16, d3);
      var walls = smoothstep(0.10, 0.30, d3);
      return n * 0.35 + 0.45 * walls - carve * 2.4;
    }
  }
  return n;
}

function computeTerrainHeights() {
  var p = state.plate, N = Terrain.N, W = N + 1;
  var base = Terrain.base, h = Terrain.h, sc = Terrain.sculpt;
  if (p.mode === 'flat') {
    for (var k = 0; k < W * W; k++) { base[k] = 0; h[k] = 0; }
    Terrain.min = 0; Terrain.max = 0;
    return;
  }
  var off = seedOffsets(), ox = off[0], oz = off[1];
  var amp = p.amplitude * p.heightScale;
  var mn = 1e9, mx = -1e9;
  for (var j = 0; j < W; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = 0; i < W; i++) {
      var x = (i / N - 0.5) * p.width;
      var idx = j * W + i;
      base[idx] = landformSample(x, z, ox, oz) * amp;
      var v = base[idx] + sc[idx];
      h[idx] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  Terrain.min = mn; Terrain.max = mx;
}

function recomputeTerrainBounds() {
  var mn = 1e9, mx = -1e9, h = Terrain.h;
  for (var k = 0; k < h.length; k++) { if (h[k] < mn) mn = h[k]; if (h[k] > mx) mx = h[k]; }
  Terrain.min = mn; Terrain.max = mx;
}

/* Full regenerate: new seed / landform / resolution. Everything sitting on the
   surface is re-projected afterwards. */
function regenerateTerrain(newSeed) {
  if (newSeed !== undefined) state.plate.seed = newSeed >>> 0;
  Terrain.sculpt.fill(0);
  rebuildPlate();
  rebuildWater();
  resnapWorld();
  markSceneDirty();
}

/* ==========================================================================
   SCULPT BRUSHES
   ========================================================================== */
var SCULPT_INVERT = { raise: 'lower', lower: 'raise', smooth: 'noise', noise: 'smooth',
                      flatten: 'flatten', erode: 'erode', ramp: 'ramp' };

var Sculpt = {
  holdT: 0,
  flatH: 0,
  snap: null,          // sculpt array copy taken at stroke start
  ramp: null,          // {ax, az, ah}
  dirty: false
};

function sculptCellRect(cx, cz, r) {
  var p = state.plate, N = Terrain.N;
  return {
    i0: clamp(Math.floor(((cx - r) / p.width + 0.5) * N), 0, N),
    i1: clamp(Math.ceil(((cx + r) / p.width + 0.5) * N), 0, N),
    j0: clamp(Math.floor(((cz - r) / p.depth + 0.5) * N), 0, N),
    j1: clamp(Math.ceil(((cz + r) / p.depth + 0.5) * N), 0, N)
  };
}

function beginSculptStroke(cx, cz) {
  Sculpt.holdT = 0;
  Sculpt.flatH = heightAt(cx, cz);
  Sculpt.snap = Terrain.sculpt.slice();
  Sculpt.ramp = { ax: cx, az: cz, ah: heightAt(cx, cz) };
}

/* Diff the stroke against its opening snapshot and store only the rectangle
   that actually moved — a 512 grid would otherwise cost 1 MB per undo step. */
function endSculptStroke() {
  if (!Sculpt.snap) return;
  var N = Terrain.N, W = N + 1, sc = Terrain.sculpt, sn = Sculpt.snap;
  var i0 = 1e9, j0 = 1e9, i1 = -1, j1 = -1;
  for (var j = 0; j < W; j++) {
    for (var i = 0; i < W; i++) {
      var k = j * W + i;
      if (sc[k] !== sn[k]) {
        if (i < i0) i0 = i; if (i > i1) i1 = i;
        if (j < j0) j0 = j; if (j > j1) j1 = j;
      }
    }
  }
  Sculpt.snap = null;
  if (i1 < 0) return;
  var w = i1 - i0 + 1, hgt = j1 - j0 + 1;
  var before = new Float32Array(w * hgt), after = new Float32Array(w * hgt);
  for (var jj = 0; jj < hgt; jj++) {
    for (var ii = 0; ii < w; ii++) {
      var src = (j0 + jj) * W + (i0 + ii), dst = jj * w + ii;
      before[dst] = sn[src]; after[dst] = sc[src];
    }
  }
  recordOp({ t: 'terr', N: N, i0: i0, j0: j0, w: w, h: hgt, before: before, after: after,
             data: after });   // `data` so the history byte accounting sees it
}

function applyTerrainPatch(op, useBefore) {
  if (op.N !== Terrain.N) return;                 // resolution changed underneath
  var W = Terrain.N + 1, src = useBefore ? op.before : op.after;
  for (var j = 0; j < op.h; j++)
    for (var i = 0; i < op.w; i++)
      Terrain.sculpt[(op.j0 + j) * W + (op.i0 + i)] = src[j * op.w + i];
  for (var k = 0; k < Terrain.h.length; k++) Terrain.h[k] = Terrain.base[k] + Terrain.sculpt[k];
  recomputeTerrainBounds();
  updateGroundVerts(0, Terrain.N);
  Terrain.geo.computeBoundingSphere();
  resnapAll();
  resnapWorld();
  Water.dirty = true;
}

/* Writes a height delta into the sculpt layer and keeps Terrain.h in step. */
function sculptWrite(k, delta) {
  Terrain.sculpt[k] += delta;
  Terrain.h[k] = Terrain.base[k] + Terrain.sculpt[k];
}

function sculptStamp(cx, cz, dt) {
  var p = state.plate, b = state.brush, s = state.sculpt;
  if (p.mode !== 'terrain') return;
  var N = Terrain.N, W = N + 1, r = b.radius;
  var mode = s.mode;
  if (Keys.alt) mode = SCULPT_INVERT[mode] || mode;
  if (mode === 'ramp') return;                    // applied on release

  // Strength ramps the longer the brush is held in one place, so a peak grows
  // under a parked cursor instead of needing twenty passes.
  Sculpt.holdT += dt;
  var ramp = 1 + Math.min(Sculpt.holdT * 0.7, 2.2);
  var amt = s.strength * dt * 5.0 * ramp;
  var edge = lerp(0.05, 0.96, b.falloff);
  var rc = sculptCellRect(cx, cz, r);
  var cw = p.width / N, cd = p.depth / N;
  var off = seedOffsets();

  if (mode === 'erode') { erodeStamp(cx, cz, dt); }
  else {
    for (var j = rc.j0; j <= rc.j1; j++) {
      var z = (j / N - 0.5) * p.depth;
      for (var i = rc.i0; i <= rc.i1; i++) {
        var x = (i / N - 0.5) * p.width;
        var dx = x - cx, dz = z - cz;
        var dd = Math.sqrt(dx * dx + dz * dz) / r;
        if (dd > 1) continue;
        var w = 1 - smoothstep(edge, 1, dd);
        var k = j * W + i;

        if (mode === 'raise') sculptWrite(k, amt * w);
        else if (mode === 'lower') sculptWrite(k, -amt * w);
        else if (mode === 'flatten') {
          sculptWrite(k, (Sculpt.flatH - Terrain.h[k]) * clamp(amt * w * 1.6, 0, 1));
        } else if (mode === 'smooth') {
          var hl = Terrain.h[j * W + Math.max(i - 1, 0)], hr = Terrain.h[j * W + Math.min(i + 1, N)];
          var hb = Terrain.h[Math.max(j - 1, 0) * W + i], ht = Terrain.h[Math.min(j + 1, N) * W + i];
          sculptWrite(k, ((hl + hr + hb + ht) * 0.25 - Terrain.h[k]) * clamp(amt * w * 1.8, 0, 1));
        } else if (mode === 'noise') {
          var ns = Math.max(0.02, s.noiseScale);
          var v = SN.fbm((x + off[0]) / ns * 0.5, (z + off[1]) / ns * 0.5, 3);
          sculptWrite(k, v * amt * w * 1.4);
        }
      }
    }
  }

  Terrain.min = Math.min(Terrain.min, -1e-6);
  recomputeTerrainBounds();
  updateGroundVerts(Math.max(rc.j0 - 1, 0), Math.min(rc.j1 + 1, N));
  resnapRegion(cx, cz, r + 1.5);
  resnapWorldRegion(cx, cz, r + 2.5);
  Water.dirty = true;
  Sculpt.dirty = true;
}

/* --------------------------------------------------------------------------
   Thermal erosion. For every cell steeper than the talus angle, material
   slides to its lowest neighbour. A few iterations per stamp is enough to cut
   gullies into a ridge and settle scree at the base of a cliff.
   -------------------------------------------------------------------------- */
function erodeStamp(cx, cz, dt) {
  var p = state.plate, b = state.brush, s = state.sculpt;
  var N = Terrain.N, W = N + 1, r = b.radius;
  var rc = sculptCellRect(cx, cz, r);
  var cw = p.width / N;
  var talus = Math.max(0.05, s.talus) * cw;
  var rate = clamp(s.strength * dt * 6, 0, 0.55);
  var edge = lerp(0.05, 0.96, b.falloff);
  var iters = clamp(Math.round(s.erodeIters), 1, 6);
  var NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (var it = 0; it < iters; it++) {
    for (var j = rc.j0; j <= rc.j1; j++) {
      var z = (j / N - 0.5) * p.depth;
      for (var i = rc.i0; i <= rc.i1; i++) {
        var x = (i / N - 0.5) * p.width;
        var dx = x - cx, dz = z - cz;
        var dd = Math.sqrt(dx * dx + dz * dz) / r;
        if (dd > 1) continue;
        var w = (1 - smoothstep(edge, 1, dd)) * rate;
        if (w <= 0) continue;
        var k = j * W + i;
        var lowest = -1, drop = 0;
        for (var q = 0; q < 4; q++) {
          var ni = i + NB[q][0], nj = j + NB[q][1];
          if (ni < 0 || nj < 0 || ni > N || nj > N) continue;
          var nk = nj * W + ni;
          var d2 = Terrain.h[k] - Terrain.h[nk];
          if (d2 > drop) { drop = d2; lowest = nk; }
        }
        if (lowest >= 0 && drop > talus) {
          var move = (drop - talus) * 0.42 * w;
          sculptWrite(k, -move);
          sculptWrite(lowest, move);
        }
      }
    }
  }
}

/* Ramp: press at A, release at B. The graded surface runs linearly between
   the two sampled heights, blended in by the brush falloff across its width. */
function applyRamp(bx, bz) {
  var a = Sculpt.ramp;
  if (!a) return;
  var p = state.plate, b = state.brush, N = Terrain.N, W = N + 1;
  var bh = heightAt(bx, bz);
  var vx = bx - a.ax, vz = bz - a.az;
  var len2 = vx * vx + vz * vz;
  if (len2 < 1e-4) return;
  var r = b.radius, edge = lerp(0.05, 0.96, b.falloff);
  var minX = Math.min(a.ax, bx) - r, maxX = Math.max(a.ax, bx) + r;
  var minZ = Math.min(a.az, bz) - r, maxZ = Math.max(a.az, bz) + r;
  var i0 = clamp(Math.floor((minX / p.width + 0.5) * N), 0, N);
  var i1 = clamp(Math.ceil((maxX / p.width + 0.5) * N), 0, N);
  var j0 = clamp(Math.floor((minZ / p.depth + 0.5) * N), 0, N);
  var j1 = clamp(Math.ceil((maxZ / p.depth + 0.5) * N), 0, N);

  for (var j = j0; j <= j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = i0; i <= i1; i++) {
      var x = (i / N - 0.5) * p.width;
      var t = ((x - a.ax) * vx + (z - a.az) * vz) / len2;
      var tc = clamp(t, 0, 1);
      var px = a.ax + vx * tc, pz = a.az + vz * tc;
      var dx = x - px, dz = z - pz;
      var dd = Math.sqrt(dx * dx + dz * dz) / r;
      if (dd > 1) continue;
      var w = 1 - smoothstep(edge, 1, dd);
      var target = lerp(a.ah, bh, tc);
      var k = j * W + i;
      sculptWrite(k, (target - Terrain.h[k]) * w);
    }
  }
  recomputeTerrainBounds();
  updateGroundVerts(0, N);
  Terrain.geo.computeBoundingSphere();
  resnapAll();
  resnapWorld();
  Water.dirty = true;
}

/* Surface steepness helper shared by grass placement and scatter limits. */
var _slopeN = new THREE.Vector3();
function normalYAt(x, z) {
  if (state.plate.mode === 'flat') return 1;
  normalAt(x, z, _slopeN);
  return _slopeN.y;
}
/* ==========================================================================
   6c. WATER
   --------------------------------------------------------------------------
   A grid laid over the plate whose per-vertex depth is baked on the CPU. The
   depth attribute drives the shallow/deep ramp, the shoreline foam and the
   alpha cutoff, so there is no depth prepass and no render target involved.
   ========================================================================== */
var Water = { mesh: null, geo: null, mat: null, N: 0, dirty: true, lastBuild: 0 };

function waterSegs() {
  return clamp(Math.min(Terrain.N, 160), 8, 160);
}

function createWater() {
  Water.mat = new THREE.ShaderMaterial({
    vertexShader: WATER_VS,
    fragmentShader: WATER_FS,
    uniforms: {
      uTime: { value: 0 },
      uWaveScale: { value: 0.55 }, uWaveSpeed: { value: 0.55 },
      uLevel: { value: -0.8 }, uSimulate: { value: 1 },
      uShallow: { value: new THREE.Vector3() }, uDeep: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Vector3() },
      uSkyColor: { value: new THREE.Vector3() },
      uExposure: { value: 1.05 }, uOpacity: { value: 0.86 }, uFoam: { value: 1 },
      uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0.0075 }
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  Water.mesh = new THREE.Mesh(new THREE.BufferGeometry(), Water.mat);
  Water.mesh.frustumCulled = false;
  Water.mesh.renderOrder = 40;
  Water.mesh.visible = false;
  scene.add(Water.mesh);
  rebuildWater();
}

function rebuildWater() {
  var p = state.plate;
  Water.mesh.visible = !!p.water && Q().water > 0;
  Water.dirty = false;
  if (!Water.mesh.visible) return;

  var N = waterSegs(), W = N + 1;
  var rebuildIndex = (Water.N !== N) || !Water.geo;
  if (rebuildIndex) {
    if (Water.geo) Water.geo.dispose();
    Water.geo = new THREE.BufferGeometry();
    Water.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(W * W * 3), 3));
    Water.geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(W * W), 1));
    var idx = (W * W > 65535) ? new Uint32Array(N * N * 6) : new Uint16Array(N * N * 6);
    var o = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
      var a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    Water.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    Water.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    Water.N = N;
    Water.mesh.geometry = Water.geo;
  }

  var pos = Water.geo.attributes.position.array;
  var dep = Water.geo.attributes.aDepth.array;
  var lvl = p.waterLevel;
  for (var jj = 0; jj < W; jj++) {
    var z = (jj / N - 0.5) * p.depth;
    for (var ii = 0; ii < W; ii++) {
      var x = (ii / N - 0.5) * p.width;
      var k = jj * W + ii, o3 = k * 3;
      pos[o3] = x; pos[o3 + 1] = lvl; pos[o3 + 2] = z;
      dep[k] = lvl - heightAt(x, z);
    }
  }
  Water.geo.attributes.position.needsUpdate = true;
  Water.geo.attributes.aDepth.needsUpdate = true;
  syncWaterUniforms();
}

function syncWaterUniforms() {
  if (!Water.mat) return;
  var p = state.plate, u = Water.mat.uniforms;
  u.uLevel.value = p.waterLevel;
  u.uWaveScale.value = p.waveScale;
  u.uWaveSpeed.value = p.waveSpeed;
  u.uOpacity.value = p.waterOpacity;
  u.uFoam.value = p.foam;
  hexLin(p.waterColor, u.uShallow.value);
  hexLin(p.waterDeep, u.uDeep.value);
  u.uSunDir.value.copy(Env.sunDir);
  u.uSunColor.value.copy(Env.sun);
  u.uSkyColor.value.copy(Env.amb);
  u.uExposure.value = state.env.exposure;
  u.uFogColor.value.copy(Env.fog);
  u.uFogDensity.value = state.env.fogDensity;
  u.uSimulate.value = state.world.simulate ? 1 : 0;
}

/* Terrain edits invalidate the depth field; throttle the rebuild so dragging a
   sculpt brush does not re-bake the whole water grid every frame. */
function waterTick(now) {
  if (!Water.dirty) return;
  if (now - Water.lastBuild < 120) return;
  Water.lastBuild = now;
  rebuildWater();
}

/* Height of the world surface including water, used when placing props that
   should sit on a lake rather than under it. */
function surfaceY(x, z) {
  var h = heightAt(x, z);
  if (state.plate.water && state.plate.waterLevel > h) return state.plate.waterLevel;
  return h;
}
function underWater(x, z) {
  return !!state.plate.water && state.plate.waterLevel > heightAt(x, z);
}
/* ==========================================================================
   7. GRASS SYSTEM
   ========================================================================== */

var BLADE_ATTRS = [['aOffset', 3], ['aNormal', 3], ['aRot', 1], ['aSize', 2], ['aShape', 2], ['aSeed', 1]];
var BLADE_STRIDE = 12;   // floats per blade across all attributes

var Grass = {
  geo: null, mat: null, mesh: null,
  count: 0,
  attr: {},          // name -> InstancedBufferAttribute
  arr: {},           // name -> Float32Array
  dirtyMin: Infinity, dirtyMax: -1
};

/* Blade template: a tapered strip in blade space.
      position.x = side (-1 / +1, and 0 for the single tip vertex)
      position.y = t    (0 at the root, 1 at the tip)
   Rebuilt only when the segment-count slider moves. */
function bladeTemplate(S) {
  S = clamp(Math.round(S), 3, 7);
  var vcount = 2 * S + 1;
  var pos = new Float32Array(vcount * 3), o = 0;
  for (var i = 0; i < S; i++) {
    var t = i / S;
    pos[o++] = -1; pos[o++] = t; pos[o++] = 0;
    pos[o++] =  1; pos[o++] = t; pos[o++] = 0;
  }
  pos[o++] = 0; pos[o++] = 1; pos[o++] = 0;

  var tris = 2 * (S - 1) + 1;
  var idx = new Uint16Array(tris * 3), k = 0;
  for (var j = 0; j < S - 1; j++) {
    var a = 2 * j, b = a + 1, c = a + 2, d = a + 3;
    idx[k++] = a; idx[k++] = c; idx[k++] = b;
    idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  idx[k++] = 2 * (S - 1); idx[k++] = 2 * S; idx[k++] = 2 * (S - 1) + 1;
  return { pos: pos, idx: idx };
}

function grassUniforms() {
  return {
    uTime:        { value: 0 },
    uWindDir:     { value: new THREE.Vector2(1, 0) },
    uWindStrength:{ value: 0.5 }, uWindSpeed: { value: 0.34 },
    uTurbulence:  { value: 0.6 }, uWaveScale: { value: 0.075 },
    uGustScale:   { value: 0.17 }, uGustSpeed: { value: 1.5 }, uGustStrength: { value: 0.85 },
    uHeight:      { value: 1 }, uWidth: { value: 0.06 }, uTaper: { value: 1 },
    uCurve:       { value: 0.5 }, uBladeCurl: { value: 0.55 },
    uDensity:     { value: 1 },
    uPlateHalf:   { value: new THREE.Vector2(21, 21) },
    uPlateSize:   { value: new THREE.Vector2(42, 42) },
    uPushTex:     { value: null }, uPushEnc: { value: 3 },
    uBaseColor:   { value: new THREE.Vector3() }, uTipColor: { value: new THREE.Vector3() },
    uGradPow:     { value: 1.5 },
    uHueVar:      { value: 0.05 }, uSatVar: { value: 0.2 }, uValVar: { value: 0.24 },
    uSunDir:      { value: new THREE.Vector3(0, 1, 0) },
    uSunColor:    { value: new THREE.Vector3(1, 1, 1) },
    uSkyColor:    { value: new THREE.Vector3(0.3, 0.4, 0.6) },
    uGroundColor: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
    uAmbient:     { value: 1 }, uAO: { value: 0.6 },
    uTranslucency:{ value: 1 }, uSpecular: { value: 0.22 }, uRoughness: { value: 0.6 },
    uExposure:    { value: 1.05 },
    uFogColor:    { value: new THREE.Vector3(0.5, 0.6, 0.7) },
    uFogDensity:  { value: 0.0075 }
  };
}

function createGrass() {
  var geo = new THREE.InstancedBufferGeometry();
  var tpl = bladeTemplate(state.grass.segments);
  geo.setAttribute('position', new THREE.BufferAttribute(tpl.pos, 3));
  geo.setIndex(new THREE.BufferAttribute(tpl.idx, 1));

  for (var i = 0; i < BLADE_ATTRS.length; i++) {
    var name = BLADE_ATTRS[i][0], size = BLADE_ATTRS[i][1];
    var arr = new Float32Array(MAX_BLADES * size);
    var a = new THREE.InstancedBufferAttribute(arr, size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    Grass.attr[name] = a;
    Grass.arr[name] = arr;
  }
  geo.instanceCount = 0;
  // The template's bounding sphere is meaningless for instances; culling is
  // handled by the plate-bounds test in the vertex shader instead.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  var mat = new THREE.ShaderMaterial({
    vertexShader: GRASS_VS,
    fragmentShader: GRASS_FS,
    uniforms: grassUniforms(),
    side: THREE.DoubleSide
  });

  Grass.geo = geo; Grass.mat = mat;
  Grass.mesh = new THREE.Mesh(geo, mat);
  Grass.mesh.frustumCulled = false;
  scene.add(Grass.mesh);
  /* Note: a depth prepass was tried here and measured ~4x SLOWER at 158k
     blades. Grass is bound by vertex + rasterisation of ~1.4M sliver
     triangles, not by fragment shading, so paying for a second geometry pass
     to save overdraw is a straight loss. One pass it is. */
}

/* Segment count changed -> swap the template. The instance attributes are
   reused verbatim, so no blade data is touched. */
function rebuildBladeTemplate() {
  var tpl = bladeTemplate(state.grass.segments);
  var g = Grass.geo;
  g.deleteAttribute('position');
  g.setAttribute('position', new THREE.BufferAttribute(tpl.pos, 3));
  g.setIndex(new THREE.BufferAttribute(tpl.idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
}

function markDirty(from, to) {
  if (from < Grass.dirtyMin) Grass.dirtyMin = from;
  if (to > Grass.dirtyMax) Grass.dirtyMax = to;
}

/* Upload only the instance range that actually changed this frame. */
function flushGrass() {
  Grass.geo.instanceCount = Grass.count;
  if (Grass.dirtyMin > Grass.dirtyMax) return;
  var lo = Math.max(0, Grass.dirtyMin), hi = Math.min(MAX_BLADES - 1, Grass.dirtyMax);
  for (var i = 0; i < BLADE_ATTRS.length; i++) {
    var name = BLADE_ATTRS[i][0], size = BLADE_ATTRS[i][1], a = Grass.attr[name];
    a.updateRange.offset = lo * size;
    a.updateRange.count = (hi - lo + 1) * size;
    a.needsUpdate = true;
  }
  Grass.dirtyMin = Infinity; Grass.dirtyMax = -1;
}

/* ---- blade read / write -------------------------------------------------- */
function writeBlade(i, x, y, z, nx, ny, nz, rot, hm, wm, bend, stiff, seed) {
  var A = Grass.arr;
  var o3 = i * 3, o2 = i * 2;
  A.aOffset[o3] = x; A.aOffset[o3 + 1] = y; A.aOffset[o3 + 2] = z;
  A.aNormal[o3] = nx; A.aNormal[o3 + 1] = ny; A.aNormal[o3 + 2] = nz;
  A.aRot[i] = rot;
  A.aSize[o2] = hm; A.aSize[o2 + 1] = wm;
  A.aShape[o2] = bend; A.aShape[o2 + 1] = stiff;
  A.aSeed[i] = seed;
  markDirty(i, i);
}
function readBlade(i, out) {
  var A = Grass.arr, o3 = i * 3, o2 = i * 2;
  out = out || new Float32Array(BLADE_STRIDE);
  out[0] = A.aOffset[o3]; out[1] = A.aOffset[o3 + 1]; out[2] = A.aOffset[o3 + 2];
  out[3] = A.aNormal[o3]; out[4] = A.aNormal[o3 + 1]; out[5] = A.aNormal[o3 + 2];
  out[6] = A.aRot[i];
  out[7] = A.aSize[o2]; out[8] = A.aSize[o2 + 1];
  out[9] = A.aShape[o2]; out[10] = A.aShape[o2 + 1];
  out[11] = A.aSeed[i];
  return out;
}
function writeBladeArr(i, d, off) {
  off = off || 0;
  writeBlade(i, d[off], d[off + 1], d[off + 2], d[off + 3], d[off + 4], d[off + 5],
             d[off + 6], d[off + 7], d[off + 8], d[off + 9], d[off + 10], d[off + 11]);
}
function copyBlade(src, dst) {
  var A = Grass.arr;
  for (var i = 0; i < BLADE_ATTRS.length; i++) {
    var n = BLADE_ATTRS[i][0], s = BLADE_ATTRS[i][1], a = A[n];
    for (var k = 0; k < s; k++) a[dst * s + k] = a[src * s + k];
  }
  markDirty(dst, dst);
}

/* ---- re-snapping to the surface ----------------------------------------- */
var _snapN = new THREE.Vector3();
function resnapAll() {
  var A = Grass.arr, n = Grass.count;
  if (!n) return;
  for (var i = 0; i < n; i++) {
    var o = i * 3, x = A.aOffset[o], z = A.aOffset[o + 2];
    A.aOffset[o + 1] = heightAt(x, z);
    normalAt(x, z, _snapN);
    A.aNormal[o] = _snapN.x; A.aNormal[o + 1] = _snapN.y; A.aNormal[o + 2] = _snapN.z;
  }
  markDirty(0, n - 1);
}
function resnapRegion(cx, cz, r) {
  var A = Grass.arr, n = Grass.count, r2 = r * r, lo = -1, hi = -1;
  for (var i = 0; i < n; i++) {
    var o = i * 3, dx = A.aOffset[o] - cx, dz = A.aOffset[o + 2] - cz;
    if (dx * dx + dz * dz > r2) continue;
    var x = A.aOffset[o], z = A.aOffset[o + 2];
    A.aOffset[o + 1] = heightAt(x, z);
    normalAt(x, z, _snapN);
    A.aNormal[o] = _snapN.x; A.aNormal[o + 1] = _snapN.y; A.aNormal[o + 2] = _snapN.z;
    if (lo < 0) lo = i; hi = i;
  }
  if (lo >= 0) markDirty(lo, hi);
}

/* ==========================================================================
   DENSITY GRID — doubles as the paint saturation limiter and as the source
   texture for contact shadows.
   ========================================================================== */
var Dens = {
  n: DENS_N,
  grid: new Int32Array(DENS_N * DENS_N),
  data: new Uint8Array(DENS_N * DENS_N * 4),
  tex: null,
  dirty: true
};

function densCell(x, z) {
  var p = state.plate;
  var i = ((x / p.width + 0.5) * Dens.n) | 0;
  var j = ((z / p.depth + 0.5) * Dens.n) | 0;
  if (i < 0 || j < 0 || i >= Dens.n || j >= Dens.n) return -1;
  return j * Dens.n + i;
}
function densCellArea() {
  return (state.plate.width / Dens.n) * (state.plate.depth / Dens.n);
}
function densBump(x, z, d) {
  var c = densCell(x, z);
  if (c >= 0) { Dens.grid[c] += d; if (Dens.grid[c] < 0) Dens.grid[c] = 0; Dens.dirty = true; }
}
function rebuildDensityGrid() {
  Dens.grid.fill(0);
  var A = Grass.arr;
  for (var i = 0; i < Grass.count; i++) {
    var c = densCell(A.aOffset[i * 3], A.aOffset[i * 3 + 2]);
    if (c >= 0) Dens.grid[c]++;
  }
  Dens.dirty = true;
}
function uploadDensity() {
  if (!Dens.dirty || !Dens.tex) return;
  var target = Math.max(1, state.brush.maxDensity * densCellArea());
  var g = Dens.grid, d = Dens.data;
  for (var i = 0, n = g.length; i < n; i++) {
    var v = g[i] / target;
    d[i * 4] = v >= 1 ? 255 : (v * 255) | 0;
  }
  Dens.tex.needsUpdate = true;
  Dens.dirty = false;
}

/* ==========================================================================
   SCENE OBJECTS
   ========================================================================== */
function createScene() {
  /* --- sky (full-screen quad) --- */
  var skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    uniforms: {
      uInvVP: { value: new THREE.Matrix4() },
      uZenith: { value: new THREE.Vector3() }, uHorizon: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Vector3() }, uExposure: { value: 1 }, uSunSize: { value: 1 }
    },
    depthTest: false, depthWrite: false
  });
  sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  /* --- density texture --- */
  Dens.tex = new THREE.DataTexture(Dens.data, Dens.n, Dens.n, THREE.RGBAFormat, THREE.UnsignedByteType);
  Dens.tex.minFilter = THREE.LinearFilter;
  Dens.tex.magFilter = THREE.LinearFilter;
  Dens.tex.wrapS = Dens.tex.wrapT = THREE.ClampToEdgeWrapping;
  Dens.tex.needsUpdate = true;

  /* --- ground --- */
  Terrain.mat = new THREE.ShaderMaterial({
    vertexShader: GROUND_VS, fragmentShader: GROUND_FS,
    uniforms: {
      uBaseColor: { value: new THREE.Vector3() }, uSecColor: { value: new THREE.Vector3() },
      uPattern: { value: 1 }, uCheckerScale: { value: 2.5 }, uRoughness: { value: 0.85 },
      uPlateSize: { value: new THREE.Vector2(42, 42) },
      uGrid: { value: 1 }, uGridSpacing: { value: 2 }, uGridOpacity: { value: 0.22 },
      uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Vector3() },
      uSkyColor: { value: new THREE.Vector3() }, uGroundColor: { value: new THREE.Vector3() },
      uAmbient: { value: 1 }, uExposure: { value: 1.05 },
      uDensTex: { value: Dens.tex },
      uShadow: { value: 1 }, uShadowStrength: { value: 0.55 },
      uShadowOffset: { value: new THREE.Vector2() },
      uAutoTex: { value: 1 },
      uGrassCol: { value: new THREE.Vector3() }, uDirtCol: { value: new THREE.Vector3() },
      uRockCol: { value: new THREE.Vector3() }, uSnowCol: { value: new THREE.Vector3() },
      uRockSlope: { value: 0.74 }, uRockBlend: { value: 0.14 },
      uSnowOn: { value: 0 }, uSnowline: { value: 7 }, uSnowBlend: { value: 2.4 },
      uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0.0075 }
    },
    extensions: { derivatives: true },
    side: THREE.FrontSide
  });
  Terrain.N = 1;
  Terrain.h = new Float32Array(4); Terrain.base = new Float32Array(4); Terrain.sculpt = new Float32Array(4);
  computeTerrainHeights();
  buildGroundGeometry();
  Terrain.mesh = new THREE.Mesh(Terrain.geo, Terrain.mat);
  Terrain.mesh.frustumCulled = false;
  scene.add(Terrain.mesh);

  /* --- interactive ball --- */
  var ballMat = new THREE.ShaderMaterial({
    vertexShader: BALL_VS, fragmentShader: BALL_FS,
    uniforms: {
      uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Vector3() },
      uSkyColor: { value: new THREE.Vector3() }, uGroundColor: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Vector3(0.62, 0.16, 0.14) },
      uAmbient: { value: 1 }, uExposure: { value: 1.05 },
      uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0.0075 }
    }
  });
  ball = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 26), ballMat);
  ball.visible = false;
  ball.position.set(0, 1.3, 0);
  scene.add(ball);

  /* --- brush ring --- */
  var RSEG = 128;
  var rgeo = new THREE.BufferGeometry();
  var rv = (RSEG + 1) * 2 * 2;                    // two rings, ribbon of 2 verts each
  rgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rv * 3), 3));
  var alpha = new Float32Array(rv);
  for (var s = 0; s <= RSEG; s++) {
    alpha[s * 2] = 1; alpha[s * 2 + 1] = 1;
    alpha[(RSEG + 1) * 2 + s * 2] = 0.42; alpha[(RSEG + 1) * 2 + s * 2 + 1] = 0.42;
  }
  rgeo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  var ridx = [], base;
  for (var ringI = 0; ringI < 2; ringI++) {
    base = ringI * (RSEG + 1) * 2;
    for (var s2 = 0; s2 < RSEG; s2++) {
      var a0 = base + s2 * 2, b0 = a0 + 1, c0 = a0 + 2, d0 = a0 + 3;
      ridx.push(a0, c0, b0, b0, c0, d0);
    }
  }
  rgeo.setIndex(ridx);
  rgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  ring = new THREE.Mesh(rgeo, new THREE.ShaderMaterial({
    vertexShader: RING_VS, fragmentShader: RING_FS,
    uniforms: { uColor: { value: new THREE.Vector3(0.49, 0.85, 0.34) }, uOpacity: { value: 1 } },
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide
  }));
  ring.frustumCulled = false;
  ring.renderOrder = 999;
  ring.visible = false;
  ring.userData.RSEG = RSEG;
  scene.add(ring);
}
/* ==========================================================================
   8. PUSH FIELD
   --------------------------------------------------------------------------
   A low-resolution 2D field covering the plate. Each texel holds a signed
   displacement vector (in the same "bend radians" unit the wind uses) and its
   velocity, integrated as a damped harmonic oscillator:

        a = (target - D) * K  -  V * C        K = w^2,  C = 2*zeta*w

   Because D chases the target through a spring rather than being assigned to
   it, three things fall out for free:
     * the grass parts around a stationary cursor,
     * it springs back with overshoot instead of snapping when the cursor
       leaves,
     * and a fast sweep leaves a bent wake that recovers behind you.
   ========================================================================== */
var Field = {
  n: FIELD_N,
  Dx: null, Dz: null, Vx: null, Vz: null, Tx: null, Tz: null,
  data: null, tex: null,
  enc: 3.0,
  live: false,
  inf: []
};

function initField() {
  var n = Field.n, c = n * n;
  Field.Dx = new Float32Array(c); Field.Dz = new Float32Array(c);
  Field.Vx = new Float32Array(c); Field.Vz = new Float32Array(c);
  Field.Tx = new Float32Array(c); Field.Tz = new Float32Array(c);
  Field.data = new Uint8Array(c * 4);
  for (var i = 0; i < c; i++) { Field.data[i * 4] = 128; Field.data[i * 4 + 1] = 128; Field.data[i * 4 + 3] = 255; }
  Field.tex = new THREE.DataTexture(Field.data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  Field.tex.minFilter = THREE.LinearFilter;
  Field.tex.magFilter = THREE.LinearFilter;
  Field.tex.wrapS = Field.tex.wrapT = THREE.ClampToEdgeWrapping;
  Field.tex.needsUpdate = true;
}

/* Queue an influence for this frame. vx/vz are the influencer's ground
   velocity, which biases the push downstream and produces the wake. */
function pushInfluence(x, z, radius, strength, vx, vz) {
  Field.inf.push({ x: x, z: z, r: radius, s: strength, vx: vx || 0, vz: vz || 0 });
}

function updateField(dt) {
  var n = Field.n, c = n * n, p = state.plate, it = state.interact;
  var inf = Field.inf;

  if (!Field.live && inf.length === 0) { Field.inf.length = 0; return; }

  Field.Tx.fill(0); Field.Tz.fill(0);

  var cw = p.width / n, cd = p.depth / n;
  for (var q = 0; q < inf.length; q++) {
    var f = inf[q], r = f.r, r2 = r * r;
    var i0 = clamp(Math.floor((f.x - r) / p.width * n + n * 0.5), 0, n - 1);
    var i1 = clamp(Math.ceil ((f.x + r) / p.width * n + n * 0.5), 0, n - 1);
    var j0 = clamp(Math.floor((f.z - r) / p.depth * n + n * 0.5), 0, n - 1);
    var j1 = clamp(Math.ceil ((f.z + r) / p.depth * n + n * 0.5), 0, n - 1);
    for (var j = j0; j <= j1; j++) {
      var wz = (j + 0.5) / n * p.depth - p.depth * 0.5;
      for (var i = i0; i <= i1; i++) {
        var wx = (i + 0.5) / n * p.width - p.width * 0.5;
        var dx = wx - f.x, dz = wz - f.z;
        var d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        var d = Math.sqrt(d2);
        var u = d / r;
        var w = 1 - smoothstep(0, 1, u);      // soft radial falloff
        var idx = j * n + i;
        if (d > 1e-4) {
          var inv = 1 / d;
          Field.Tx[idx] += dx * inv * f.s * w;
          Field.Tz[idx] += dz * inv * f.s * w;
        }
        // Downstream bias: grass ahead of a moving influencer gets shoved
        // along its direction of travel, which is what reads as a wake.
        Field.Tx[idx] += f.vx * w * it.wake;
        Field.Tz[idx] += f.vz * w * it.wake;
      }
    }
  }
  Field.inf.length = 0;

  // Sub-step so a long frame can never make the spring explode.
  var steps = clamp(Math.ceil(dt / (1 / 90)), 1, 4), h = dt / steps;
  var w0 = Math.max(0.5, it.recovery), K = w0 * w0, C = 2 * clamp(it.damping, 0.05, 2) * w0;
  var Dx = Field.Dx, Dz = Field.Dz, Vx = Field.Vx, Vz = Field.Vz, Tx = Field.Tx, Tz = Field.Tz;
  var energy = 0;

  for (var s = 0; s < steps; s++) {
    var last = (s === steps - 1);
    energy = 0;
    for (var k = 0; k < c; k++) {
      var ax = (Tx[k] - Dx[k]) * K - Vx[k] * C;
      var az = (Tz[k] - Dz[k]) * K - Vz[k] * C;
      var vx = Vx[k] + ax * h, vz = Vz[k] + az * h;
      var dxv = Dx[k] + vx * h, dzv = Dz[k] + vz * h;
      Vx[k] = vx; Vz[k] = vz; Dx[k] = dxv; Dz[k] = dzv;
      if (last) energy += Math.abs(dxv) + Math.abs(dzv) + Math.abs(vx) + Math.abs(vz);
    }
  }

  // Encode to the texture (signed -> 0..255 around 128).
  var data = Field.data, e = Field.enc, inv2 = 0.5 / e;
  for (var m = 0; m < c; m++) {
    var a = (Dx[m] * inv2 + 0.5) * 255;
    var b = (Dz[m] * inv2 + 0.5) * 255;
    data[m * 4]     = a < 0 ? 0 : (a > 255 ? 255 : a | 0);
    data[m * 4 + 1] = b < 0 ? 0 : (b > 255 ? 255 : b | 0);
  }
  Field.tex.needsUpdate = true;
  Field.live = energy > 0.004 * c * 0.02;
}

/* ==========================================================================
   UNIFORM SYNC — the only bridge from `state` into the GPU.
   ========================================================================== */
var _v3a = new THREE.Vector3(), _v3b = new THREE.Vector3();

function updateGrassBounds() {
  var p = state.plate, u = Grass.mat.uniforms;
  u.uPlateHalf.value.set(p.width * 0.5, p.depth * 0.5);
  u.uPlateSize.value.set(p.width, p.depth);
  Terrain.mat.uniforms.uPlateSize.value.set(p.width, p.depth);
}

function syncGrassUniforms() {
  var g = state.grass, w = state.wind, u = Grass.mat.uniforms;
  u.uHeight.value = g.height;
  u.uWidth.value = g.width;
  u.uTaper.value = g.taper;
  u.uCurve.value = g.curve;
  u.uBladeCurl.value = g.bladeCurl;
  u.uDensity.value = g.density;
  u.uGradPow.value = g.gradPow;
  u.uHueVar.value = g.hueVar;
  u.uSatVar.value = g.satVar;
  u.uValVar.value = g.valVar;
  u.uAO.value = g.ao;
  u.uTranslucency.value = g.translucency;
  u.uSpecular.value = g.specular;
  u.uRoughness.value = g.roughness;
  hexLin(g.baseColor, u.uBaseColor.value);
  hexLin(g.tipColor, u.uTipColor.value);

  var a = w.direction * DEG;
  u.uWindDir.value.set(Math.sin(a), Math.cos(a)).normalize();
  u.uWindStrength.value = w.strength;
  u.uWindSpeed.value = w.speed;
  u.uTurbulence.value = w.turbulence;
  u.uWaveScale.value = w.waveScale;
  u.uGustScale.value = w.gustFreq;
  u.uGustSpeed.value = w.gustSpeed;
  u.uGustStrength.value = w.gustStrength;

  u.uPushTex.value = Field.tex;
  u.uPushEnc.value = Field.enc;
  updateGrassBounds();
}

function syncGroundUniforms() {
  var p = state.plate, u = Terrain.mat.uniforms;
  hexLin(p.baseColor, u.uBaseColor.value);
  hexLin(p.secColor, u.uSecColor.value);
  u.uPattern.value = ({ solid: 0, checker: 1, radial: 2, noise: 3 })[p.pattern] || 0;
  u.uCheckerScale.value = p.checkerScale;
  u.uRoughness.value = p.roughness;
  u.uGrid.value = p.grid ? 1 : 0;
  u.uGridSpacing.value = p.gridSpacing;
  u.uGridOpacity.value = p.gridOpacity;
  u.uPlateSize.value.set(p.width, p.depth);

  // slope + altitude auto-texturing
  u.uAutoTex.value = (p.autoTex && p.mode === 'terrain') ? 1 : 0;
  hexLin(p.grassColor, u.uGrassCol.value);
  hexLin(p.dirtColor, u.uDirtCol.value);
  hexLin(p.rockColor, u.uRockCol.value);
  hexLin(p.snowColor, u.uSnowCol.value);
  u.uRockSlope.value = p.rockSlope;
  u.uRockBlend.value = Math.max(0.01, p.rockBlend);
  u.uSnowOn.value = p.snowOn ? 1 : 0;
  u.uSnowline.value = p.snowline;
  u.uSnowBlend.value = Math.max(0.05, p.snowBlend);
  syncWaterUniforms();
}

function syncEnvUniforms() {
  updateEnv();
  var e = state.env;
  var gu = Grass.mat.uniforms, tu = Terrain.mat.uniforms,
      su = sky.material.uniforms, bu = ball.material.uniforms;

  var amb = Env.amb, gnd = Env.gnd;
  var sunLit = Env.sun;

  gu.uSunDir.value.copy(Env.sunDir);
  gu.uSunColor.value.copy(sunLit);
  gu.uSkyColor.value.copy(amb);
  gu.uGroundColor.value.copy(gnd);
  gu.uAmbient.value = Env.ambient;
  gu.uExposure.value = e.exposure;
  gu.uFogColor.value.copy(Env.fog);
  gu.uFogDensity.value = e.fogDensity;

  tu.uSunDir.value.copy(Env.sunDir);
  tu.uSunColor.value.copy(sunLit);
  tu.uSkyColor.value.copy(amb);
  tu.uGroundColor.value.copy(gnd);
  tu.uAmbient.value = Env.ambient;
  tu.uExposure.value = e.exposure;
  tu.uFogColor.value.copy(Env.fog);
  tu.uFogDensity.value = e.fogDensity;
  tu.uShadow.value = e.shadows ? 1 : 0;
  tu.uShadowStrength.value = e.shadowStrength;
  // Project grass height along the sun to find where its shadow lands.
  var sy = Math.max(0.18, Env.sunDir.y);
  var k = state.grass.height * 0.55 / sy;
  tu.uShadowOffset.value.set(
    Env.sunDir.x * k / state.plate.width,
    Env.sunDir.z * k / state.plate.depth
  );

  su.uZenith.value.copy(Env.zenith);
  su.uHorizon.value.copy(Env.horizon);
  su.uSunColor.value.copy(sunLit);
  su.uSunDir.value.copy(Env.sunDir);
  su.uFogColor.value.copy(Env.fog);
  su.uExposure.value = e.exposure;
  sky.visible = e.sky;

  bu.uSunDir.value.copy(Env.sunDir);
  bu.uSunColor.value.copy(sunLit);
  bu.uSkyColor.value.copy(amb);
  bu.uGroundColor.value.copy(gnd);
  bu.uAmbient.value = Env.ambient;
  bu.uExposure.value = e.exposure;
  bu.uFogColor.value.copy(Env.fog);
  bu.uFogDensity.value = e.fogDensity;

  syncWaterUniforms();
  syncObjectEnv();

  if (!e.sky) renderer.setClearColor(new THREE.Color(
    Math.pow(clamp(Env.fog.x, 0, 1), 1 / 2.2),
    Math.pow(clamp(Env.fog.y, 0, 1), 1 / 2.2),
    Math.pow(clamp(Env.fog.z, 0, 1), 1 / 2.2)), 1);
}

/* ==========================================================================
   BRUSH RING PREVIEW — a ribbon that hugs the ground surface.
   ========================================================================== */
function updateRing(cx, cz, radius, visible) {
  ring.visible = visible;
  if (!visible) return;
  var RSEG = ring.userData.RSEG;
  var pos = ring.geometry.attributes.position, pa = pos.array;
  var inner = radius * clamp(1 - state.brush.falloff * 0.62, 0.06, 0.99);
  var thick = Math.max(0.015, radius * 0.014);
  var o = 0;
  for (var r = 0; r < 2; r++) {
    var rr = (r === 0) ? radius : inner;
    for (var s = 0; s <= RSEG; s++) {
      var a = s / RSEG * TAU, ca = Math.cos(a), sa = Math.sin(a);
      var r0 = rr - thick, r1 = rr + thick;
      var x0 = cx + ca * r0, z0 = cz + sa * r0;
      var x1 = cx + ca * r1, z1 = cz + sa * r1;
      pa[o++] = x0; pa[o++] = heightAt(x0, z0) + 0.02; pa[o++] = z0;
      pa[o++] = x1; pa[o++] = heightAt(x1, z1) + 0.02; pa[o++] = z1;
    }
  }
  pos.needsUpdate = true;
}
/* ==========================================================================
   9. HISTORY (undo / redo)
   --------------------------------------------------------------------------
   A stroke is a list of primitive ops recorded in the order they happened;
   undo replays them backwards. Only two primitives exist:
     add : n blades appended at `start`
     rm  : blades removed at descending indices (so each removal is exact)
   ========================================================================== */
var History = {
  undo: [], redo: [], cur: null, bytes: 0,
  MAX_ENTRIES: 80, MAX_BYTES: 180 * 1024 * 1024
};

function beginStroke(label) {
  History.cur = { label: label, ops: [], bytes: 0 };
}
function endStroke() {
  var s = History.cur; History.cur = null;
  if (!s || !s.ops.length) return;
  History.undo.push(s);
  History.bytes += s.bytes;
  History.redo.length = 0;
  while (History.undo.length > History.MAX_ENTRIES ||
        (History.bytes > History.MAX_BYTES && History.undo.length > 30)) {
    History.bytes -= History.undo.shift().bytes;
  }
  markSceneDirty();
  refreshHistoryButtons();
}
function recordOp(op) {
  if (!History.cur) return;
  History.cur.ops.push(op);
  var b = (op.data && op.data.byteLength ? op.data.byteLength : 0) +
          (op.idx && op.idx.byteLength ? op.idx.byteLength : 0) + (op.bytes || 0);
  History.cur.bytes += b;
}

function applyUndoOp(op) {
  // world-builder op types (terrain patches, objects, roads) register here
  if (WORLD_OPS[op.t]) { WORLD_OPS[op.t].undo(op); return; }
  if (op.t === 'add') {
    Grass.count = op.start;
    markDirty(op.start, op.start + op.n);
  } else {
    // Restore in reverse removal order.
    for (var k = op.idx.length - 1; k >= 0; k--) {
      var i = op.idx[k], last = Grass.count;
      if (i !== last) copyBlade(i, last);
      writeBladeArr(i, op.data, k * BLADE_STRIDE);
      Grass.count++;
    }
    markDirty(0, Grass.count);
  }
}
function applyRedoOp(op) {
  if (WORLD_OPS[op.t]) { WORLD_OPS[op.t].redo(op); return; }
  if (op.t === 'add') {
    for (var k = 0; k < op.n; k++) writeBladeArr(op.start + k, op.data, k * BLADE_STRIDE);
    Grass.count = op.start + op.n;
    markDirty(op.start, Grass.count);
  } else {
    for (var m = 0; m < op.idx.length; m++) {
      var i = op.idx[m], last = Grass.count - 1;
      if (i !== last) copyBlade(last, i);
      Grass.count--;
    }
    markDirty(0, Math.max(Grass.count, 0));
  }
}

function doUndo() {
  if (!History.undo.length) { toast('Nothing to undo'); return; }
  var s = History.undo.pop();
  for (var i = s.ops.length - 1; i >= 0; i--) applyUndoOp(s.ops[i]);
  History.redo.push(s);
  History.bytes -= s.bytes;
  afterHistory(s.label + ' undone');
}
function doRedo() {
  if (!History.redo.length) { toast('Nothing to redo'); return; }
  var s = History.redo.pop();
  for (var i = 0; i < s.ops.length; i++) applyRedoOp(s.ops[i]);
  History.undo.push(s);
  History.bytes += s.bytes;
  afterHistory(s.label + ' redone');
}
function afterHistory(msg) {
  rebuildDensityGrid();
  markDirty(0, MAX_BLADES - 1);
  ogridRebuild();
  if (Roads.dirty) rebuildAllRoads();
  applyLayerVisibility();
  refreshSelectionVisuals();
  refreshSelectionUI();
  markSceneDirty();
  refreshHistoryButtons();
  toast(msg);
}
function refreshHistoryButtons() {
  var u = document.getElementById('b-undo'), r = document.getElementById('b-redo');
  if (u) u.disabled = !History.undo.length;
  if (r) r.disabled = !History.redo.length;
}

/* ==========================================================================
   10. BRUSH / PAINTING
   ========================================================================== */
var Brush = {
  down: false,
  active: null,           // the tool actually being applied this stroke
  last: new THREE.Vector3(),
  hasLast: false,
  start: new THREE.Vector3(),
  axis: 0,                // shift-constrain axis: 0 none, 1 x, 2 z
  leftover: 0,
  eraseQueue: []
};

/* Probability that a candidate at normalised distance u survives the brush
   falloff. falloff=0 -> very soft edge, 1 -> hard edge. */
function falloffAt(u) {
  var edge = lerp(0.04, 0.97, state.brush.falloff);
  return 1 - smoothstep(edge, 1, u);
}

function bladeCapacityLeft() { return MAX_BLADES - Grass.count; }

/* ---- PAINT --------------------------------------------------------------- */
var _tmpN = new THREE.Vector3();
function paintStamp(cx, cz, scale) {
  var b = state.brush, g = state.grass, p = state.plate;
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var want = Math.max(1, Math.round(b.flow * b.radius * b.radius * 34 * (scale === undefined ? 1 : scale)));
  var room = bladeCapacityLeft();
  if (room <= 0) return 0;
  if (want > room) want = room;

  var target = Math.max(1, b.maxDensity * densCellArea());
  var lattice = 1 / Math.sqrt(Math.max(b.maxDensity, 0.5));
  var start = Grass.count, added = 0;
  var A = Grass.arr;

  for (var n = 0; n < want; n++) {
    var ang = rnd() * TAU, rr = b.radius * Math.sqrt(rnd());
    var u = rr / b.radius;
    if (rnd() > falloffAt(u)) continue;

    var x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
    // Scatter: 0 snaps candidates onto a lattice (tidy lawn), 1 is fully
    // random (natural). Anything between blends the two.
    if (b.scatter < 0.999) {
      var gx = Math.round(x / lattice) * lattice, gz = Math.round(z / lattice) * lattice;
      x = gx + (x - gx) * b.scatter;
      z = gz + (z - gz) * b.scatter;
    }
    if (x < -hw || x > hw || z < -hd || z > hd) continue;

    var cell = densCell(x, z);
    if (cell < 0 || Dens.grid[cell] >= target) continue;
    // world-builder rules: no blades on cliffs, in roads or under water
    if (normalYAt(x, z) < p.maxGrassSlope) continue;
    if (roadCovers(x, z)) continue;
    if (underWater(x, z)) continue;

    var y = heightAt(x, z);
    normalAt(x, z, _tmpN);
    // Random tilt away from the surface normal so blades are not perfectly
    // perpendicular to the ground.
    if (b.tilt > 0.001) {
      var ta = rnd() * TAU, tm = rnd() * b.tilt;
      _tmpN.x += Math.cos(ta) * tm; _tmpN.z += Math.sin(ta) * tm;
      _tmpN.normalize();
    }

    var i = Grass.count;
    writeBlade(i, x, y, z, _tmpN.x, _tmpN.y, _tmpN.z,
      rnd() * TAU,
      Math.max(0.12, 1 + (rnd() * 2 - 1) * g.heightVar),
      Math.max(0.12, 1 + (rnd() * 2 - 1) * g.widthVar),
      Math.max(0, 1 + (rnd() * 2 - 1) * g.curveVar),
      lerp(g.stiffMin, g.stiffMax, rnd()),
      rnd());
    Grass.count++;
    Dens.grid[cell]++;
    Dens.dirty = true;
    added++;
  }

  if (added) {
    var data = new Float32Array(added * BLADE_STRIDE);
    for (var k = 0; k < added; k++) readBladeInto(start + k, data, k * BLADE_STRIDE);
    recordOp({ t: 'add', start: start, n: added, data: data });
  }
  return added;
}
function readBladeInto(i, dst, off) {
  var A = Grass.arr, o3 = i * 3, o2 = i * 2;
  dst[off] = A.aOffset[o3]; dst[off + 1] = A.aOffset[o3 + 1]; dst[off + 2] = A.aOffset[o3 + 2];
  dst[off + 3] = A.aNormal[o3]; dst[off + 4] = A.aNormal[o3 + 1]; dst[off + 5] = A.aNormal[o3 + 2];
  dst[off + 6] = A.aRot[i];
  dst[off + 7] = A.aSize[o2]; dst[off + 8] = A.aSize[o2 + 1];
  dst[off + 9] = A.aShape[o2]; dst[off + 10] = A.aShape[o2 + 1];
  dst[off + 11] = A.aSeed[i];
}

/* ---- ERASE ---------------------------------------------------------------
   Removals are collected for the whole frame and applied in one pass so a
   fast drag costs a single scan of the blade array. */
function flushErase() {
  var q = Brush.eraseQueue;
  if (!q.length) return;
  var A = Grass.arr, n = Grass.count, hits = [];
  for (var i = 0; i < n; i++) {
    var o = i * 3, x = A.aOffset[o], z = A.aOffset[o + 2];
    for (var s = 0; s < q.length; s++) {
      var st = q[s], dx = x - st.x, dz = z - st.z;
      var d2 = dx * dx + dz * dz;
      if (d2 > st.r2) continue;
      if (rnd() < st.p * falloffAt(Math.sqrt(d2) / st.r)) { hits.push(i); break; }
    }
  }
  q.length = 0;
  if (!hits.length) return;
  removeBlades(hits);
}

/* Removes the given indices (any order). Descending order guarantees the
   swap-remove source is never itself scheduled for removal. */
function removeBlades(list) {
  list.sort(function (a, b) { return b - a; });
  var idx = new Int32Array(list.length);
  var data = new Float32Array(list.length * BLADE_STRIDE);
  var A = Grass.arr;
  for (var k = 0; k < list.length; k++) {
    var i = list[k];
    idx[k] = i;
    readBladeInto(i, data, k * BLADE_STRIDE);
    densBump(A.aOffset[i * 3], A.aOffset[i * 3 + 2], -1);
    var last = Grass.count - 1;
    if (i !== last) copyBlade(last, i);
    Grass.count--;
  }
  markDirty(0, Math.max(Grass.count, 0));
  recordOp({ t: 'rm', idx: idx, data: data });
}

/* ---- SMOOTH --------------------------------------------------------------
   Evens out density: bins the blades under the brush, then thins the
   over-populated bins and seeds the under-populated ones toward the local
   mean, weighted by the brush falloff. */
function smoothStamp(cx, cz, dt) {
  var b = state.brush, g = state.grass, p = state.plate;
  var GX = 7, r = b.radius, cell = (r * 2) / GX;
  var bins = [], counts = new Int32Array(GX * GX);
  for (var i = 0; i < GX * GX; i++) bins.push([]);

  var A = Grass.arr, n = Grass.count, r2 = r * r;
  for (var k = 0; k < n; k++) {
    var o = k * 3, dx = A.aOffset[o] - cx, dz = A.aOffset[o + 2] - cz;
    if (dx * dx + dz * dz > r2) continue;
    var gi = clamp(Math.floor((dx + r) / cell), 0, GX - 1);
    var gj = clamp(Math.floor((dz + r) / cell), 0, GX - 1);
    bins[gj * GX + gi].push(k);
    counts[gj * GX + gi]++;
  }

  var total = 0, live = 0;
  for (var j = 0; j < GX; j++) for (var i2 = 0; i2 < GX; i2++) {
    var ccx = (i2 + 0.5) * cell - r, ccz = (j + 0.5) * cell - r;
    if (ccx * ccx + ccz * ccz > r2) continue;
    total += counts[j * GX + i2]; live++;
  }
  if (!live) return;
  var mean = total / live;
  var rate = clamp(dt * 5.5, 0, 0.85);

  var toRemove = [], addStart = Grass.count, added = 0;
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var densTarget = Math.max(1, b.maxDensity * densCellArea());

  for (var j2 = 0; j2 < GX; j2++) {
    for (var i3 = 0; i3 < GX; i3++) {
      var ci = j2 * GX + i3;
      var ccx2 = (i3 + 0.5) * cell - r, ccz2 = (j2 + 0.5) * cell - r;
      var dist = Math.sqrt(ccx2 * ccx2 + ccz2 * ccz2);
      if (dist > r) continue;
      var w = falloffAt(dist / r) * rate;
      var diff = counts[ci] - mean;

      if (diff > 0.5) {
        var kill = Math.min(bins[ci].length, Math.round(diff * w));
        for (var q = 0; q < kill; q++) {
          var pick = (rnd() * bins[ci].length) | 0;
          toRemove.push(bins[ci][pick]);
          bins[ci].splice(pick, 1);
        }
      } else if (diff < -0.5 && bladeCapacityLeft() > 8) {
        var grow = Math.min(bladeCapacityLeft() - 4, Math.round(-diff * w));
        for (var q2 = 0; q2 < grow; q2++) {
          // Retry a couple of times: a candidate rejected for landing off the
          // plate or in a saturated cell would otherwise silently thin the
          // field instead of redistributing it.
          var x = 0, z = 0, dc = -1, tries = 0;
          while (tries++ < 3) {
            x = cx + ccx2 + (rnd() - 0.5) * cell;
            z = cz + ccz2 + (rnd() - 0.5) * cell;
            if (x < -hw || x > hw || z < -hd || z > hd) { dc = -1; continue; }
            dc = densCell(x, z);
            if (dc >= 0 && Dens.grid[dc] < densTarget) break;
            dc = -1;
          }
          if (dc < 0) continue;
          var y = heightAt(x, z);
          normalAt(x, z, _tmpN);
          if (b.tilt > 0.001) {
            var ta = rnd() * TAU, tm = rnd() * b.tilt;
            _tmpN.x += Math.cos(ta) * tm; _tmpN.z += Math.sin(ta) * tm; _tmpN.normalize();
          }
          writeBlade(Grass.count, x, y, z, _tmpN.x, _tmpN.y, _tmpN.z,
            rnd() * TAU,
            Math.max(0.12, 1 + (rnd() * 2 - 1) * g.heightVar),
            Math.max(0.12, 1 + (rnd() * 2 - 1) * g.widthVar),
            Math.max(0, 1 + (rnd() * 2 - 1) * g.curveVar),
            lerp(g.stiffMin, g.stiffMax, rnd()), rnd());
          Grass.count++; Dens.grid[dc]++; Dens.dirty = true; added++;
        }
      }
    }
  }

  if (toRemove.length) removeBlades(toRemove);
  if (added) {
    var data = new Float32Array(added * BLADE_STRIDE);
    for (var a2 = 0; a2 < added; a2++) readBladeInto(addStart + a2, data, a2 * BLADE_STRIDE);
    recordOp({ t: 'add', start: addStart, n: added, data: data });
  }
}

/* ---- EYEDROPPER ---------------------------------------------------------- */
function eyedrop(cx, cz) {
  var A = Grass.arr, best = -1, bd = 1e18;
  var r2 = state.brush.radius * state.brush.radius;
  for (var i = 0; i < Grass.count; i++) {
    var o = i * 3, dx = A.aOffset[o] - cx, dz = A.aOffset[o + 2] - cz;
    var d = dx * dx + dz * dz;
    if (d < bd && d <= r2) { bd = d; best = i; }
  }
  if (best < 0) { toast('No grass under the cursor', 'err'); return; }
  var hm = A.aSize[best * 2], wm = A.aSize[best * 2 + 1];
  var bd2 = A.aShape[best * 2], st = A.aShape[best * 2 + 1];
  state.grass.heightVar = clamp(Math.abs(hm - 1) * 0.5 + 0.02, 0.02, 1);
  state.grass.widthVar = clamp(Math.abs(wm - 1) * 0.5 + 0.02, 0.02, 1);
  state.grass.curveVar = clamp(Math.abs(bd2 - 1) * 0.5 + 0.02, 0.02, 1);
  state.grass.height = clamp(state.grass.height * hm, 0.05, 6);
  state.grass.width = clamp(state.grass.width * wm, 0.005, 0.5);
  state.grass.stiffMin = clamp(st - 0.08, 0.15, 3);
  state.grass.stiffMax = clamp(st + 0.08, 0.15, 3);
  syncGrassUniforms();
  refreshUI();
  markSceneDirty();
  toast('Sampled: height ' + (state.grass.height).toFixed(2) + ', stiffness ' + st.toFixed(2), 'ok');
}

/* ---- FILL / CLEAR -------------------------------------------------------- */
function fillPlate() {
  var p = state.plate, b = state.brush, g = state.grass;
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var spacing = 1 / Math.sqrt(Math.max(b.maxDensity, 0.5));
  var nx = Math.floor(p.width / spacing), nz = Math.floor(p.depth / spacing);
  var estimate = nx * nz;
  if (estimate > bladeCapacityLeft()) {
    var f = bladeCapacityLeft() / estimate;
    spacing = spacing / Math.sqrt(Math.max(f, 0.001));
    nx = Math.floor(p.width / spacing); nz = Math.floor(p.depth / spacing);
  }
  beginStroke('Fill');
  var start = Grass.count, added = 0;
  var jit = b.scatter;
  for (var j = 0; j < nz; j++) {
    for (var i = 0; i < nx; i++) {
      if (bladeCapacityLeft() < 2) break;
      var x = -hw + (i + 0.5) * spacing + (rnd() - 0.5) * spacing * jit;
      var z = -hd + (j + 0.5) * spacing + (rnd() - 0.5) * spacing * jit;
      if (x < -hw || x > hw || z < -hd || z > hd) continue;
      var dc = densCell(x, z);
      if (dc < 0) continue;
      if (normalYAt(x, z) < p.maxGrassSlope) continue;
      if (roadCovers(x, z)) continue;
      if (underWater(x, z)) continue;
      var y = heightAt(x, z);
      normalAt(x, z, _tmpN);
      if (b.tilt > 0.001) {
        var ta = rnd() * TAU, tm = rnd() * b.tilt;
        _tmpN.x += Math.cos(ta) * tm; _tmpN.z += Math.sin(ta) * tm; _tmpN.normalize();
      }
      writeBlade(Grass.count, x, y, z, _tmpN.x, _tmpN.y, _tmpN.z,
        rnd() * TAU,
        Math.max(0.12, 1 + (rnd() * 2 - 1) * g.heightVar),
        Math.max(0.12, 1 + (rnd() * 2 - 1) * g.widthVar),
        Math.max(0, 1 + (rnd() * 2 - 1) * g.curveVar),
        lerp(g.stiffMin, g.stiffMax, rnd()), rnd());
      Grass.count++; Dens.grid[dc]++; added++;
    }
  }
  Dens.dirty = true;
  if (added) {
    var data = new Float32Array(added * BLADE_STRIDE);
    for (var k = 0; k < added; k++) readBladeInto(start + k, data, k * BLADE_STRIDE);
    recordOp({ t: 'add', start: start, n: added, data: data });
  }
  endStroke();
  markDirty(0, Grass.count);
  toast('Filled plate with ' + fmtInt(added) + ' blades', 'ok');
}

function clearAll() {
  if (!Grass.count) { toast('Nothing to clear'); return; }
  var n = Grass.count;
  var idx = new Int32Array(n), data = new Float32Array(n * BLADE_STRIDE);
  for (var k = 0; k < n; k++) {
    var i = n - 1 - k;                     // descending -> pure truncation
    idx[k] = i;
    readBladeInto(i, data, k * BLADE_STRIDE);
  }
  beginStroke('Clear');
  recordOp({ t: 'rm', idx: idx, data: data });
  endStroke();
  Grass.count = 0;
  Dens.grid.fill(0); Dens.dirty = true;
  markDirty(0, n);
  markSceneDirty();
  toast('Cleared ' + fmtInt(n) + ' blades', 'ok');
}
/* ==========================================================================
   11. PRESETS
   ========================================================================== */
var PRESETS = [
  {
    name: 'Lawn', swatch: '#5f9d33',
    grass: { height: 0.55, heightVar: 0.22, width: 0.05, widthVar: 0.2, taper: 1.15,
             curve: 0.34, curveVar: 0.3, segments: 4, bladeCurl: 0.5,
             baseColor: '#2b5720', tipColor: '#79bd3f', gradPow: 1.6,
             hueVar: 0.03, satVar: 0.14, valVar: 0.18, density: 1,
             stiffMin: 0.9, stiffMax: 1.7, ao: 0.6, translucency: 0.75,
             specular: 0.18, roughness: 0.62 },
    wind: { strength: 0.28, direction: 40, speed: 0.3, turbulence: 0.4,
            waveScale: 0.12, gustFreq: 0.22, gustStrength: 0.5, gustSpeed: 1.7 },
    plate: { pattern: 'checker', baseColor: '#3e4436', secColor: '#333a2c',
             checkerScale: 2.5, grid: false, gridOpacity: 0.2, roughness: 0.85 },
    env: { timeOfDay: 14.5, exposure: 1.05, fogDensity: 0.006, fogAuto: true,
           shadows: true, shadowStrength: 0.5 },
    brush: { maxDensity: 190, scatter: 0.35, tilt: 0.1 }
  },
  {
    name: 'Wild Meadow', swatch: '#8bbd4e',
    grass: { height: 1.35, heightVar: 0.55, width: 0.062, widthVar: 0.35, taper: 0.95,
             curve: 0.72, curveVar: 0.6, segments: 6, bladeCurl: 0.6,
             baseColor: '#2f5a1d', tipColor: '#a6cf5c', gradPow: 1.4,
             hueVar: 0.08, satVar: 0.26, valVar: 0.3, density: 1,
             stiffMin: 0.45, stiffMax: 1.5, ao: 0.66, translucency: 1.15,
             specular: 0.22, roughness: 0.58 },
    wind: { strength: 0.62, direction: 62, speed: 0.38, turbulence: 0.78,
            waveScale: 0.07, gustFreq: 0.16, gustStrength: 0.95, gustSpeed: 1.5 },
    plate: { pattern: 'noise', baseColor: '#3a3f30', secColor: '#4a4433',
             checkerScale: 3.2, grid: false, roughness: 0.9 },
    env: { timeOfDay: 17.6, exposure: 1.1, fogDensity: 0.009, fogAuto: true,
           shadows: true, shadowStrength: 0.55 },
    brush: { maxDensity: 120, scatter: 1, tilt: 0.28 }
  },
  {
    name: 'Dry Savanna', swatch: '#c9a957',
    grass: { height: 1.7, heightVar: 0.6, width: 0.05, widthVar: 0.3, taper: 0.8,
             curve: 0.95, curveVar: 0.55, segments: 6, bladeCurl: 0.45,
             baseColor: '#6a5a26', tipColor: '#d8c078', gradPow: 1.15,
             hueVar: 0.05, satVar: 0.3, valVar: 0.3, density: 0.82,
             stiffMin: 0.35, stiffMax: 1.1, ao: 0.58, translucency: 1.35,
             specular: 0.3, roughness: 0.5 },
    wind: { strength: 0.85, direction: 108, speed: 0.5, turbulence: 0.85,
            waveScale: 0.055, gustFreq: 0.12, gustStrength: 1.35, gustSpeed: 2.1 },
    plate: { pattern: 'noise', baseColor: '#6b5a3c', secColor: '#87724a',
             checkerScale: 4, grid: false, roughness: 0.95 },
    env: { timeOfDay: 18.4, exposure: 1.15, fogDensity: 0.011, fogAuto: true,
           shadows: true, shadowStrength: 0.6 },
    brush: { maxDensity: 85, scatter: 1, tilt: 0.32 }
  },
  {
    name: 'Wheat Field', swatch: '#dcb64e',
    grass: { height: 2.35, heightVar: 0.24, width: 0.038, widthVar: 0.2, taper: 0.6,
             curve: 1.15, curveVar: 0.3, segments: 7, bladeCurl: 0.35,
             baseColor: '#8a7326', tipColor: '#efd583', gradPow: 1.9,
             hueVar: 0.03, satVar: 0.2, valVar: 0.24, density: 1,
             stiffMin: 0.7, stiffMax: 1.1, ao: 0.7, translucency: 1.5,
             specular: 0.4, roughness: 0.42 },
    wind: { strength: 0.72, direction: 22, speed: 0.26, turbulence: 0.42,
            waveScale: 0.032, gustFreq: 0.085, gustStrength: 1.5, gustSpeed: 1.15 },
    plate: { pattern: 'solid', baseColor: '#6d5c33', secColor: '#5a4c2b',
             grid: false, roughness: 0.92 },
    env: { timeOfDay: 17.1, exposure: 1.12, fogDensity: 0.008, fogAuto: true,
           shadows: true, shadowStrength: 0.5 },
    brush: { maxDensity: 150, scatter: 0.75, tilt: 0.12 }
  },
  {
    name: 'Alien / Neon', swatch: '#3fe0c8',
    grass: { height: 1.5, heightVar: 0.5, width: 0.085, widthVar: 0.4, taper: 1.5,
             curve: 0.85, curveVar: 0.7, segments: 7, bladeCurl: 1.1,
             baseColor: '#0f3a56', tipColor: '#54ffe0', gradPow: 1.1,
             hueVar: 0.16, satVar: 0.4, valVar: 0.35, density: 0.95,
             stiffMin: 0.3, stiffMax: 1.8, ao: 0.5, translucency: 2.1,
             specular: 0.85, roughness: 0.22 },
    wind: { strength: 0.68, direction: 200, speed: 0.55, turbulence: 1.1,
            waveScale: 0.11, gustFreq: 0.26, gustStrength: 1.1, gustSpeed: 2.6 },
    plate: { pattern: 'radial', baseColor: '#121a2c', secColor: '#2a1240',
             checkerScale: 2, grid: true, gridSpacing: 2, gridOpacity: 0.45, roughness: 0.3 },
    env: { timeOfDay: 18.35, exposure: 1.9, fogDensity: 0.012, fogAuto: false,
           fogColor: '#2a1b4a', shadows: true, shadowStrength: 0.4 },
    brush: { maxDensity: 100, scatter: 1, tilt: 0.35 }
  },
  {
    name: 'Snow-dusted', swatch: '#cfdbe4',
    grass: { height: 0.8, heightVar: 0.45, width: 0.055, widthVar: 0.3, taper: 1.0,
             curve: 0.7, curveVar: 0.55, segments: 5, bladeCurl: 0.5,
             baseColor: '#3f4d3f', tipColor: '#dfe9ef', gradPow: 2.4,
             hueVar: 0.02, satVar: 0.16, valVar: 0.2, density: 0.9,
             stiffMin: 0.8, stiffMax: 1.9, ao: 0.7, translucency: 0.55,
             specular: 0.5, roughness: 0.35 },
    wind: { strength: 0.3, direction: 300, speed: 0.24, turbulence: 0.5,
            waveScale: 0.09, gustFreq: 0.2, gustStrength: 0.6, gustSpeed: 1.3 },
    plate: { pattern: 'noise', baseColor: '#b9c6d0', secColor: '#8e9daa',
             checkerScale: 3.5, grid: false, roughness: 0.55 },
    env: { timeOfDay: 9.2, exposure: 0.98, fogDensity: 0.016, fogAuto: false,
           fogColor: '#b9c7d4', shadows: true, shadowStrength: 0.35 },
    brush: { maxDensity: 110, scatter: 1, tilt: 0.25 }
  }
];

function applyPreset(i) {
  var p = PRESETS[i];
  if (!p) return;
  if (p.grass) deepMerge(state.grass, p.grass);
  if (p.wind) deepMerge(state.wind, p.wind);
  if (p.plate) deepMerge(state.plate, p.plate);
  if (p.env) deepMerge(state.env, p.env);
  if (p.brush) deepMerge(state.brush, p.brush);
  rebuildBladeTemplate();
  syncGrassUniforms();
  syncGroundUniforms();
  syncEnvUniforms();
  Dens.dirty = true;
  refreshUI();
  markSceneDirty();
  toast('Preset: ' + p.name, 'ok');
}

/* ==========================================================================
   12. PERSISTENCE
   ========================================================================== */
var SAVE_VERSION = 1;
var LS_KEY = 'grasspainter.scene.v1';

function b64enc(u8) {
  var s = '', C = 0x8000;
  for (var i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
  return btoa(s);
}
function b64dec(str) {
  var bin = atob(str), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* 12 bytes per blade. Height is not stored — it is recomputed from the
   restored plate, which keeps the file small and keeps grass welded to the
   surface even if the terrain is regenerated. */
function encodeBlades() {
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
function decodeBlades(u8) {
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
  rebuildDensityGrid();
}

function encodeSculpt() {
  var sc = Terrain.sculpt, any = false;
  for (var i = 0; i < sc.length; i++) if (sc[i] !== 0) { any = true; break; }
  if (!any) return null;
  var buf = new ArrayBuffer(sc.length * 2), dv = new DataView(buf);
  for (var k = 0; k < sc.length; k++)
    dv.setInt16(k * 2, clamp(Math.round(sc[k] * 200), -32768, 32767), true);
  return { n: Terrain.N, data: b64enc(new Uint8Array(buf)) };
}

function serializeScene() {
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

function deserializeScene(obj) {
  if (!obj || obj.app !== 'grass-painter') throw new Error('Not a Grass Painter scene file');
  var fresh = defaultState();
  deepMerge(fresh, obj.state || {});
  state = fresh;

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
  refreshHistoryButtons();
  refreshUI();
  setTool(state.tool || 'paint');
}

function downloadBlob(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

function saveScene() {
  try {
    var json = JSON.stringify(serializeScene());
    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadBlob(new Blob([json], { type: 'application/json' }), 'grass-scene-' + stamp + '.json');
    toast('Saved ' + fmtInt(Grass.count) + ' blades', 'ok');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err', 6000);
  }
}

function loadSceneFile(file) {
  var fr = new FileReader();
  fr.onload = function () {
    try {
      deserializeScene(JSON.parse(fr.result));
      toast('Loaded ' + fmtInt(Grass.count) + ' blades', 'ok');
      markSceneDirty();
    } catch (e) {
      toast('Load failed: ' + e.message, 'err', 6000);
    }
  };
  fr.onerror = function () { toast('Could not read the file', 'err'); };
  fr.readAsText(file);
}

/* ---- autosave ------------------------------------------------------------
   A full field serialises to a couple of megabytes, which overflows
   localStorage's ~5 MB (UTF-16) quota. IndexedDB has no such limit, so it is
   the primary store; localStorage stays as a fallback for private-mode
   browsers and holds a settings-only copy when the blades will not fit.
   -------------------------------------------------------------------------- */
var IDB_NAME = 'grasspainter', IDB_STORE = 'scenes', IDB_KEY = 'autosave';
var _idbPromise = null;

function idbOpen() {
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
function idbPut(value) {
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
function idbGet() {
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

var _sceneDirty = false, _lastAuto = 0, _autoBusy = false, _autoWarned = false;
function markSceneDirty() { _sceneDirty = true; }

function autosaveTick(now) {
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
    if (ok) { flashSaved(); try { localStorage.removeItem(LS_KEY); } catch (e) {} return; }
    // No IndexedDB — fall back to localStorage, shedding the blades if the
    // quota rejects the full scene.
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(snap));
      flashSaved();
    } catch (e2) {
      try {
        snap.blades = { count: 0, data: '' };
        snap.tooBig = true;
        localStorage.setItem(LS_KEY, JSON.stringify(snap));
      } catch (e3) { /* nothing we can do */ }
      if (!_autoWarned) {
        _autoWarned = true;
        toast('Autosave storage is full — settings only. Use Save to keep the grass.', 'err', 7000);
      }
    }
  }, function () { _autoBusy = false; });
}

/* Async because IndexedDB is; calls back with true if a scene was restored. */
function restoreAutosave(done) {
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
function exportPNG(scale) {
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
    toast('Exported PNG at ' + Math.round(viewW * basePR * scale) + ' × ' + Math.round(viewH * basePR * scale), 'ok');
  } catch (e) {
    toast('Export failed: ' + e.message, 'err');
  } finally {
    renderer.setPixelRatio(pr);
    renderer.setSize(viewW, viewH, false);
  }
}
/* ==========================================================================
   17. SKETCHFAB CLIENT
   --------------------------------------------------------------------------
   Search, authenticated download and an IndexedDB cache of the downloaded
   GLB bytes. The cache is what makes a saved scene reloadable: a scene file
   stores model UIDs, and reopening it re-hydrates from cache instead of
   pulling 6 MB per model off the network again.

   The API token lives in localStorage, never in this file — anyone who opens
   the page can read the source, so a baked-in token would be public.
   ========================================================================== */
var SF = {
  API: 'https://api.sketchfab.com/v3',
  token: '',
  db: null,
  loaderReady: false,
  cacheIndex: {}
};

var SF_TOKEN_KEY = 'grasspainter.sketchfab.token';

function sfLoadToken() {
  try { SF.token = localStorage.getItem(SF_TOKEN_KEY) || ''; } catch (e) { SF.token = ''; }
  return SF.token;
}
function sfSaveToken(t) {
  SF.token = (t || '').trim();
  try {
    if (SF.token) localStorage.setItem(SF_TOKEN_KEY, SF.token);
    else localStorage.removeItem(SF_TOKEN_KEY);
  } catch (e) {}
}
function sfHeaders() {
  return SF.token ? { Authorization: 'Token ' + SF.token } : {};
}

/* ---- GLTFLoader ----------------------------------------------------------
   Loaded on demand from the last three.js release that shipped a non-module
   build of it, which is what keeps this page a single dependency-light file. */
var GLTF_SOURCES = [
  'https://unpkg.com/three@0.147.0/examples/js/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/GLTFLoader.js'
];
function sfEnsureLoader() {
  if (SF.loaderReady && THREE.GLTFLoader) return Promise.resolve(true);
  var i = 0;
  function attempt() {
    if (i >= GLTF_SOURCES.length) return Promise.reject(new Error('Could not load the glTF loader'));
    var src = GLTF_SOURCES[i++];
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res; s.onerror = function () { rej(new Error('script')); };
      document.head.appendChild(s);
    }).then(function () {
      if (!THREE.GLTFLoader) throw new Error('missing');
      SF.loaderReady = true;
      return true;
    }, attempt);
  }
  return attempt();
}

/* ---- search --------------------------------------------------------------
   Face count is capped by default: this is a world builder that instances
   models hundreds of times, and a 500k-triangle "house" makes that
   impossible. The cap is exposed in the UI. */
function sfSearch(opts) {
  var q = [
    'type=models',
    'downloadable=true',
    'archives_flavours=false',
    'count=' + (opts.count || 24),
    'sort_by=' + (opts.sort || '-likeCount')
  ];
  if (opts.q) q.push('q=' + encodeURIComponent(opts.q));
  if (opts.maxFaces) q.push('max_face_count=' + Math.round(opts.maxFaces));
  if (opts.cursor) q.push('cursor=' + encodeURIComponent(opts.cursor));
  if (opts.categories) q.push('categories=' + encodeURIComponent(opts.categories));
  return fetch(SF.API + '/search?' + q.join('&'), { headers: sfHeaders() })
    .then(function (r) {
      if (!r.ok) throw new Error('Search failed (' + r.status + ')');
      return r.json();
    })
    .then(function (j) {
      return {
        next: j.cursors && j.cursors.next,
        results: (j.results || []).map(function (m) {
          var thumb = null;
          if (m.thumbnails && m.thumbnails.images && m.thumbnails.images.length) {
            // smallest image at least 128 px wide, else the smallest available
            var imgs = m.thumbnails.images.slice().sort(function (a, b) { return a.width - b.width; });
            thumb = imgs[0].url;
            for (var i = 0; i < imgs.length; i++) if (imgs[i].width >= 128) { thumb = imgs[i].url; break; }
          }
          return {
            uid: m.uid,
            name: m.name || 'Untitled',
            author: (m.user && (m.user.displayName || m.user.username)) || 'unknown',
            faces: m.faceCount || 0,
            license: (m.license && (m.license.label || m.license.slug)) || '',
            thumb: thumb,
            viewer: m.viewerUrl
          };
        })
      };
    });
}

/* ---- download ------------------------------------------------------------ */
function sfDownloadGLB(uid, onProgress) {
  if (!SF.token) return Promise.reject(new Error('Add your Sketchfab API token first'));
  return fetch(SF.API + '/models/' + uid + '/download', { headers: sfHeaders() })
    .then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error('Token rejected by Sketchfab (401/403)');
      if (!r.ok) throw new Error('Download request failed (' + r.status + ')');
      return r.json();
    })
    .then(function (j) {
      var entry = j.glb || j.gltf;
      if (!entry || !entry.url) throw new Error('This model has no glTF download');
      var isZip = !j.glb;
      if (isZip) throw new Error('Only glTF binary (.glb) downloads are supported');
      return fetchWithProgress(entry.url, onProgress);
    });
}

/* Streamed fetch so a 6 MB model can show a progress bar instead of hanging. */
function fetchWithProgress(url, onProgress) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('Asset fetch failed (' + r.status + ')');
    var total = parseInt(r.headers.get('content-length') || '0', 10);
    if (!r.body || !r.body.getReader || !total) return r.arrayBuffer();
    var reader = r.body.getReader(), chunks = [], got = 0;
    return (function pump() {
      return reader.read().then(function (res) {
        if (res.done) {
          var out = new Uint8Array(got), off = 0;
          for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
          return out.buffer;
        }
        chunks.push(res.value);
        got += res.value.length;
        if (onProgress) onProgress(got / total);
        return pump();
      });
    })();
  });
}

/* ==========================================================================
   MODEL CACHE (IndexedDB)
   ========================================================================== */
var SFDB_NAME = 'grasspainter-models', SFDB_STORE = 'glb';
function sfDB() {
  if (SF.db) return SF.db;
  SF.db = new Promise(function (resolve) {
    var idb = window.indexedDB;
    if (!idb) { resolve(null); return; }
    var req;
    try { req = idb.open(SFDB_NAME, 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(SFDB_STORE)) db.createObjectStore(SFDB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = req.onblocked = function () { resolve(null); };
  });
  return SF.db;
}
function sfCachePut(uid, meta, buffer) {
  return sfDB().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(SFDB_STORE, 'readwrite');
        tx.objectStore(SFDB_STORE).put({ meta: meta, glb: buffer }, uid);
        tx.oncomplete = function () { SF.cacheIndex[uid] = meta; resolve(true); };
        tx.onerror = tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  });
}
function sfCacheGet(uid) {
  return sfDB().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(SFDB_STORE, 'readonly');
        var rq = tx.objectStore(SFDB_STORE).get(uid);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  });
}
function sfCacheList() {
  return sfDB().then(function (db) {
    if (!db) return [];
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(SFDB_STORE, 'readonly');
        var store = tx.objectStore(SFDB_STORE);
        var keys = store.getAllKeys ? store.getAllKeys() : null;
        if (!keys) { resolve([]); return; }
        keys.onsuccess = function () { resolve(keys.result || []); };
        keys.onerror = function () { resolve([]); };
      } catch (e) { resolve([]); }
    });
  });
}
function sfCacheDelete(uid) {
  return sfDB().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(SFDB_STORE, 'readwrite');
        tx.objectStore(SFDB_STORE).delete(uid);
        tx.oncomplete = function () { delete SF.cacheIndex[uid]; resolve(true); };
        tx.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  });
}
function sfCacheSize() {
  return sfDB().then(function (db) {
    if (!db) return 0;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(SFDB_STORE, 'readonly');
        var rq = tx.objectStore(SFDB_STORE).getAll();
        rq.onsuccess = function () {
          var n = 0, all = rq.result || [];
          for (var i = 0; i < all.length; i++) n += (all[i].glb ? all[i].glb.byteLength : 0);
          resolve(n);
        };
        rq.onerror = function () { resolve(0); };
      } catch (e) { resolve(0); }
    });
  });
}
/* ==========================================================================
   18. GLB IMPORT
   --------------------------------------------------------------------------
   Converts a downloaded glTF into something this renderer can instance.

   Sketchfab models arrive as dozens or hundreds of separate submeshes — the
   test house was 276 meshes for 8k triangles. Instancing that as-is would cost
   276 draw calls per building, so everything is baked into world space and
   merged into one geometry per distinct material. Textures are re-encoded down
   to a size cap, because a handful of 4K maps will exhaust VRAM long before
   the triangle budget bites.
   ========================================================================== */
var IMPORT_TEX_MAX = 1024;

function materialKey(m) {
  if (!m) return 'none';
  var t = m.map && m.map.image ? (m.map.uuid) : '';
  var c = m.color ? m.color.getHexString() : 'ffffff';
  var a = (m.transparent ? 1 : 0) + '|' + (m.alphaTest || 0);
  return t + '|' + c + '|' + a + '|' + (m.side === undefined ? 2 : m.side);
}

/* Re-encode a texture at or below the size cap. glTF textures are flipY:false,
   and a canvas copy has to preserve that or every model renders upside down. */
function downscaleTexture(tex, max) {
  if (!tex || !tex.image) return null;
  var img = tex.image;
  var w = img.width || img.videoWidth || 0, h = img.height || img.videoHeight || 0;
  if (!w || !h) return tex;
  if (w <= max && h <= max) {
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }
  var s = max / Math.max(w, h);
  var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  var cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  var ctx = cv.getContext('2d');
  try { ctx.drawImage(img, 0, 0, cw, ch); }
  catch (e) { tex.flipY = false; return tex; }
  var out = new THREE.CanvasTexture(cv);
  out.flipY = false;
  out.wrapS = tex.wrapS; out.wrapT = tex.wrapT;
  out.minFilter = THREE.LinearMipmapLinearFilter;
  out.magFilter = THREE.LinearFilter;
  out.generateMipmaps = true;
  out.needsUpdate = true;
  return out;
}

/* Bake every submesh of a group into one geometry, in the model's own space. */
var _impM = new THREE.Matrix4(), _impN = new THREE.Matrix3(), _impV = new THREE.Vector3();
function mergeGroup(items) {
  var vTotal = 0, iTotal = 0, i, g;
  for (i = 0; i < items.length; i++) {
    g = items[i].geometry;
    if (!g.attributes.position) continue;
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  if (!vTotal) return null;
  var pos = new Float32Array(vTotal * 3);
  var nrm = new Float32Array(vTotal * 3);
  var uv = new Float32Array(vTotal * 2);
  var idx = (vTotal > 65535) ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  var vo = 0, io = 0;

  for (i = 0; i < items.length; i++) {
    var mesh = items[i];
    g = mesh.geometry;
    if (!g.attributes.position) continue;
    if (!g.attributes.normal) g.computeVertexNormals();
    _impM.copy(mesh.matrixWorld);
    _impN.getNormalMatrix(_impM);
    var p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    var count = p.count;
    for (var v = 0; v < count; v++) {
      _impV.set(p.getX(v), p.getY(v), p.getZ(v)).applyMatrix4(_impM);
      pos[(vo + v) * 3] = _impV.x; pos[(vo + v) * 3 + 1] = _impV.y; pos[(vo + v) * 3 + 2] = _impV.z;
      if (n) {
        _impV.set(n.getX(v), n.getY(v), n.getZ(v)).applyMatrix3(_impN).normalize();
        nrm[(vo + v) * 3] = _impV.x; nrm[(vo + v) * 3 + 1] = _impV.y; nrm[(vo + v) * 3 + 2] = _impV.z;
      } else { nrm[(vo + v) * 3 + 1] = 1; }
      if (t) { uv[(vo + v) * 2] = t.getX(v); uv[(vo + v) * 2 + 1] = t.getY(v); }
    }
    if (g.index) {
      var gi = g.index;
      for (var k = 0; k < gi.count; k++) idx[io + k] = gi.getX(k) + vo;
      io += gi.count;
    } else {
      for (var k2 = 0; k2 < count; k2++) idx[io + k2] = vo + k2;
      io += count;
    }
    vo += count;
  }

  var out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* Recentre on XZ and sit the model on y = 0, so placement, snapping and the
   flatten-under-footprint logic all behave the same as they did for the
   procedural assets. */
function normalizeParts(parts) {
  var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], i, k;
  for (i = 0; i < parts.length; i++) {
    var p = parts[i].geo.attributes.position.array;
    for (k = 0; k < p.length; k += 3) {
      if (p[k] < mn[0]) mn[0] = p[k]; if (p[k] > mx[0]) mx[0] = p[k];
      if (p[k + 1] < mn[1]) mn[1] = p[k + 1]; if (p[k + 1] > mx[1]) mx[1] = p[k + 1];
      if (p[k + 2] < mn[2]) mn[2] = p[k + 2]; if (p[k + 2] > mx[2]) mx[2] = p[k + 2];
    }
  }
  var cx = (mn[0] + mx[0]) * 0.5, cz = (mn[2] + mx[2]) * 0.5, base = mn[1];
  var h = mx[1] - mn[1];

  // Sketchfab models are usually in metres, which already matches this world.
  // Anything wildly outside that is in centimetres or inches, so normalise it.
  var scale = 1;
  if (h > 0 && (h > 120 || h < 0.12)) scale = 3.5 / h;

  for (i = 0; i < parts.length; i++) {
    var a = parts[i].geo.attributes.position.array;
    for (k = 0; k < a.length; k += 3) {
      a[k] = (a[k] - cx) * scale;
      a[k + 1] = (a[k + 1] - base) * scale;
      a[k + 2] = (a[k + 2] - cz) * scale;
    }
    parts[i].geo.attributes.position.needsUpdate = true;
    parts[i].geo.computeBoundingSphere();
  }
  var dx = (mx[0] - mn[0]) * 0.5 * scale, dz = (mx[2] - mn[2]) * 0.5 * scale;
  return {
    height: h * scale,
    radius: Math.sqrt(dx * dx + dz * dz),
    size: [(mx[0] - mn[0]) * scale, h * scale, (mx[2] - mn[2]) * scale],
    autoScaled: scale !== 1
  };
}

/* GLB bytes -> renderable parts. */
function importGLB(buffer, name) {
  return sfEnsureLoader().then(function () {
    return new Promise(function (resolve, reject) {
      new THREE.GLTFLoader().parse(buffer, '', resolve, reject);
    });
  }).then(function (gltf) {
    var root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!root) throw new Error('The file contains no scene');
    root.updateMatrixWorld(true);

    var groups = {}, order = [];
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      var m = Array.isArray(o.material) ? o.material[0] : o.material;
      var key = materialKey(m);
      if (!groups[key]) { groups[key] = { mat: m, items: [] }; order.push(key); }
      groups[key].items.push(o);
    });
    if (!order.length) throw new Error('The file contains no meshes');

    var parts = [], tris = 0, submeshes = 0;
    for (var i = 0; i < order.length; i++) {
      var grp = groups[order[i]];
      submeshes += grp.items.length;
      var geo = mergeGroup(grp.items);
      if (!geo) continue;
      var m2 = grp.mat || {};
      var col = m2.color ? [m2.color.r, m2.color.g, m2.color.b] : [1, 1, 1];
      var tex = m2.map ? downscaleTexture(m2.map, IMPORT_TEX_MAX) : null;
      var cut = 0;
      if (m2.alphaTest) cut = m2.alphaTest;
      else if (m2.transparent && tex) cut = 0.35;      // typical foliage cutout
      tris += geo.index.count / 3;
      parts.push({ geo: geo, tex: tex, color: col, alphaTest: cut });
    }
    var info = normalizeParts(parts);
    return {
      name: name || 'Model',
      parts: parts,
      tris: Math.round(tris),
      submeshes: submeshes,
      height: info.height,
      radius: info.radius,
      size: info.size,
      autoScaled: info.autoScaled
    };
  });
}

/* Free everything a model owns. Called when a model is removed from the
   library so repeated import/remove cycles do not leak GPU memory. */
function disposeModel(model) {
  if (!model || !model.parts) return;
  for (var i = 0; i < model.parts.length; i++) {
    var p = model.parts[i];
    if (p.geo) p.geo.dispose();
    if (p.tex && p.tex.dispose) p.tex.dispose();
  }
  model.parts.length = 0;
}
/* ==========================================================================
   19. IMPORTED ASSET LIBRARY
   --------------------------------------------------------------------------
   Every placeable object in the world now comes from Sketchfab. An imported
   model becomes an "asset kind" with one instanced layer per merged material,
   so a hundred copies of a house still cost one draw call per material rather
   than per copy.

   Imported models keep their own textures but are lit by this scene's sun,
   ambient, fog and tone mapping, so they sit in the same image as the terrain,
   roads and grass instead of looking pasted in.
   ========================================================================== */
var IMP_VS = GLSL_NOISE + `
attribute vec4 iPosSeed;
attribute vec4 iQuat;
attribute vec4 iSclSway;
attribute vec3 iTint;
attribute vec4 iAnim;

uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindStrength, uWindSpeed, uTurbulence, uWaveScale;
uniform float uGustScale, uGustSpeed, uGustStrength;
uniform float uDrawDist, uFadeK, uAnimDist, uSimulate, uGhost, uModelH;

varying vec3 vN, vW, vTint;
varying vec2 vUv;
varying float vSel, vFade;

vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

void main(){
  vec3 root = iPosSeed.xyz;
  float seed = iPosSeed.w;

  float dist = distance(root, cameraPosition);
  if (dist > uDrawDist){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vFade = 1.0 - smoothstep(uDrawDist * uFadeK, uDrawDist, dist);

  vec3 p = position;

  // Gentle idle motion for anything given a non-zero rate (characters); no
  // skeleton is involved, so this is deliberately subtle.
  if (iAnim.y > 0.0 && dist < uAnimDist){
    p.y += abs(sin(uTime * iAnim.y * uSimulate + iAnim.x)) * 0.025 * uModelH;
  }

  p *= iSclSway.xyz;
  p = qrot(iQuat, p);
  vec3 n = normalize(qrot(iQuat, normal / max(iSclSway.xyz, vec3(1e-4))));
  vec3 wp = root + p;

  /* ---- wind ------------------------------------------------------------
     The same field, the same uniform objects and the same gust phase the
     grass uses, so imported foliage crests with the blades instead of
     drifting out of sync. Sway weight comes from height up the model, which
     keeps trunks and foundations planted. */
  float swayW = iSclSway.w * clamp(position.y / max(uModelH, 0.001), 0.0, 1.0);
  if (swayW > 0.001 && uWindStrength > 0.0){
    vec2 q = root.xz * uWaveScale - uWindDir * (uTime * uWindSpeed * uSimulate);
    float swell = snoise(q);
    float chop  = snoise(q * 2.9 + vec2(17.3, -8.1));
    float gPhase = dot(root.xz, uWindDir) * uGustScale - uTime * uGustSpeed * uSimulate;
    float gust = pow(sin(gPhase) * 0.5 + 0.5, 5.0) * (0.5 + 0.5 * chop) * uGustStrength;
    float amt = uWindStrength * max(0.0, 0.5 + 0.5 * swell + 0.28 * chop * uTurbulence + gust);
    vec2 dir = rot2(uWindDir, chop * uTurbulence * 0.7);
    float flut = sin(uTime * 3.1 * uSimulate + seed * 39.7) * 0.25 * uTurbulence;
    float k = swayW * swayW * amt * 0.42;
    wp.xz += dir * k + vec2(-dir.y, dir.x) * k * flut;
    wp.y  -= k * k * 0.35;
  }

  vTint = iTint;
  vSel = iAnim.w;
  vUv = uv;
  vN = n;
  vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

var IMP_FS = GLSL_COLOR + GLSL_FOG + `
uniform sampler2D uMap;
uniform float uHasMap, uAlphaTest, uGhost, uExposure, uAmbient;
uniform vec3 uColor, uSunDir, uSunColor, uSkyColor, uGroundColor;
varying vec3 vN, vW, vTint;
varying vec2 vUv;
varying float vSel, vFade;

void main(){
  vec4 base = vec4(uColor, 1.0);
  if (uHasMap > 0.5){
    vec4 t = texture2D(uMap, vUv);
    // glTF base-colour maps are sRGB; this pipeline works in linear light and
    // gamma-encodes once at the end, so undo the encoding here.
    base.rgb = pow(t.rgb, vec3(2.2)) * uColor;
    base.a = t.a;
  }
  if (uAlphaTest > 0.0 && base.a < uAlphaTest) discard;
  base.rgb *= vTint;

  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  float ndl = max(0.0, dot(N, uSunDir));
  float wrap = 0.3;
  ndl = (ndl + wrap) / (1.0 + wrap);
  vec3 Hv = normalize(uSunDir + V);
  float spec = pow(max(0.0, dot(N, Hv)), 26.0) * 0.10;
  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uAmbient;

  vec3 lit = base.rgb * (uSunColor * ndl + amb) + uSunColor * spec;

  if (vSel > 0.5){
    float rim = pow(1.0 - max(0.0, dot(N, V)), 2.0);
    lit = mix(lit, vec3(0.36, 0.78, 0.22), 0.20 + rim * 0.55);
  }

  lit = gp_fog(lit, length(cameraPosition - vW));
  vec4 o = gp_out(lit, uExposure);
  if (uGhost > 0.5){
    float rim2 = pow(1.0 - max(0.0, dot(N, V)), 1.6);
    o.rgb = mix(o.rgb, vec3(0.49, 0.85, 0.34), 0.35 + rim2 * 0.35);
    o.a = 0.55 + rim2 * 0.3;
  } else {
    o.a = vFade;
  }
  gl_FragColor = o;
}
`;

/* ==========================================================================
   REGISTRY
   ========================================================================== */
var ASSETS = {};
var ASSET_CATS = [];
var LIB_KEY = 'grasspainter.library.v1';

var IMP_KINDS = [
  { id: 'building', label: 'Buildings', cat: 'buildings' },
  { id: 'nature',   label: 'Nature',    cat: 'nature' },
  { id: 'prop',     label: 'Props',     cat: 'props' },
  { id: 'person',   label: 'People',    cat: 'people' },
  { id: 'vehicle',  label: 'Vehicles',  cat: 'vehicles' }
];

function rebuildAssetCats() {
  ASSET_CATS.length = 0;
  for (var i = 0; i < IMP_KINDS.length; i++) {
    var k = IMP_KINDS[i], kinds = [];
    for (var id in ASSETS) if (ASSETS[id].kind === k.id) kinds.push(id);
    kinds.sort(function (a, b) { return (ASSETS[a].label || '').localeCompare(ASSETS[b].label || ''); });
    var group = (k.id === 'building') ? 'build' :
                (k.id === 'person' || k.id === 'vehicle') ? 'people' : 'nature';
    ASSET_CATS.push({ id: 'imp_' + k.id, label: k.label, group: group, kinds: kinds });
  }
}

/* Register an imported model as a placeable kind. */
function defImported(uid, model, opt) {
  opt = opt || {};
  var def = {
    id: uid,
    uid: uid,
    label: opt.label || model.name || 'Model',
    kind: opt.kind || 'prop',
    cat: 'imp_' + (opt.kind || 'prop'),
    sway: opt.sway === undefined ? 0 : opt.sway,
    scale: opt.scale === undefined ? 1 : opt.scale,
    author: opt.author || '',
    license: opt.license || '',
    parts: model.parts,
    tris: model.tris,
    submeshes: model.submeshes,
    height: model.height,
    radius: model.radius,
    size: model.size,
    pivots: null,
    imported: true
  };
  ASSETS[uid] = def;
  rebuildAssetCats();
  return def;
}

function removeImported(uid) {
  var def = ASSETS[uid];
  if (!def) return;
  // drop every placed instance first, then the layers, then the GPU resources
  var doomed = [];
  for (var i = 0; i < World.objs.length; i++) if (World.objs[i].kind === uid) doomed.push(World.objs[i]);
  for (var d = 0; d < doomed.length; d++) deleteObject(doomed[d]);
  for (var L = Layers.list.length - 1; L >= 0; L--) {
    if (Layers.list[L].kind !== uid) continue;
    Layers.list[L].dispose();
    delete Layers.map[Layers.list[L].id];
    Layers.list.splice(L, 1);
  }
  disposeModel(def);
  delete ASSETS[uid];
  rebuildAssetCats();
  saveLibraryIndex();
}

/* Compatibility shims: the rest of the app was written against the old
   procedural registry. Imported models have no variants, so the key is empty
   and the "palette" collapses to a single per-instance tint. */
function assetKey() { return ''; }
function assetGeometry(kind, partIndex) {
  var d = ASSETS[kind];
  if (!d || !d.parts || !d.parts[partIndex || 0]) return null;
  return d.parts[partIndex || 0].geo;
}
function assetPartCount(kind) {
  var d = ASSETS[kind];
  return d && d.parts ? d.parts.length : 0;
}
function assetPalette() { return [[1, 1, 1], [1, 1, 1], [1, 1, 1]]; }

/* ==========================================================================
   MATERIALS — one per (model, part) so each can carry its own texture and,
   for small detail parts, its own shorter draw distance.
   ========================================================================== */
var ImpMat = { shared: null, list: [] };

function impSharedUniforms() {
  if (ImpMat.shared) return ImpMat.shared;
  var gu = Grass.mat.uniforms;
  ImpMat.shared = {
    uTime: gu.uTime,
    uWindDir: gu.uWindDir,
    uWindStrength: gu.uWindStrength,
    uWindSpeed: gu.uWindSpeed,
    uTurbulence: gu.uTurbulence,
    uWaveScale: gu.uWaveScale,
    uGustScale: gu.uGustScale,
    uGustSpeed: gu.uGustSpeed,
    uGustStrength: gu.uGustStrength,
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSkyColor: { value: new THREE.Vector3(0.3, 0.4, 0.6) },
    uGroundColor: { value: new THREE.Vector3(0.1, 0.1, 0.1) },
    uAmbient: { value: 1 },
    uExposure: { value: 1.05 },
    uFogColor: { value: new THREE.Vector3() },
    uFogDensity: { value: 0.0075 },
    uAnimDist: { value: 90 },
    uSimulate: { value: 1 }
  };
  return ImpMat.shared;
}

function makeImpMaterial(def, part, partIndex, ghost) {
  var shared = impSharedUniforms(), u = {};
  for (var k in shared) u[k] = shared[k];
  u.uMap = { value: part.tex || null };
  u.uHasMap = { value: part.tex ? 1 : 0 };
  u.uAlphaTest = { value: part.alphaTest || 0 };
  u.uColor = { value: new THREE.Vector3(part.color[0], part.color[1], part.color[2]) };
  u.uModelH = { value: Math.max(def.height, 0.001) };
  u.uGhost = { value: ghost ? 1 : 0 };
  // Detail LOD: parts that carry a small share of the model's triangles fade
  // out much closer to the camera than the silhouette-defining ones.
  u.uDrawDist = { value: 260 };
  u.uFadeK = { value: 0.85 };
  var m = new THREE.ShaderMaterial({
    vertexShader: IMP_VS,
    fragmentShader: IMP_FS,
    uniforms: u,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: !ghost
  });
  m.userData.detail = part.detail || 1;
  if (!ghost) ImpMat.list.push(m);
  return m;
}

function syncObjectEnv() {
  var u = impSharedUniforms(), e = state.env, q = Q();
  u.uSunDir.value.copy(Env.sunDir);
  u.uSunColor.value.copy(Env.sun);
  u.uSkyColor.value.copy(Env.amb);
  u.uGroundColor.value.copy(Env.gnd);
  u.uAmbient.value = Env.ambient;
  u.uExposure.value = e.exposure;
  u.uFogColor.value.copy(Env.fog);
  u.uFogDensity.value = e.fogDensity;
  u.uAnimDist.value = Math.min(q.draw * 0.55, 40 + q.anim * 0.55);
  u.uSimulate.value = state.world.simulate ? 1 : 0;
  for (var i = 0; i < ImpMat.list.length; i++) {
    var m = ImpMat.list[i];
    m.uniforms.uDrawDist.value = q.draw * m.userData.detail;
    m.uniforms.uFadeK.value = q.fade;
  }
}

/* ==========================================================================
   LIBRARY PERSISTENCE
   --------------------------------------------------------------------------
   The index (which models, their category and settings) lives in
   localStorage; the GLB bytes live in IndexedDB. Together they let the
   library survive a reload without touching the network.
   ========================================================================== */
function saveLibraryIndex() {
  var out = [];
  for (var id in ASSETS) {
    var d = ASSETS[id];
    out.push({ uid: d.uid, label: d.label, kind: d.kind, sway: d.sway, scale: d.scale,
               author: d.author, license: d.license });
  }
  try { localStorage.setItem(LIB_KEY, JSON.stringify(out)); } catch (e) {}
}
function loadLibraryIndex() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch (e) { return []; }
}

/* Rebuild the whole library from cache on startup. Runs in sequence so a big
   library reports progress instead of stalling silently. */
function restoreLibrary(onStep) {
  var idx = loadLibraryIndex();
  if (!idx.length) return Promise.resolve(0);
  var i = 0, ok = 0;
  function step() {
    if (i >= idx.length) return Promise.resolve(ok);
    var rec = idx[i++];
    if (onStep) onStep(i, idx.length, rec.label);
    return sfCacheGet(rec.uid).then(function (hit) {
      if (!hit || !hit.glb) return null;
      return importGLB(hit.glb, rec.label).then(function (model) {
        defImported(rec.uid, model, rec);
        ok++;
      }, function () { return null; });
    }).then(step, step);
  }
  return step();
}

/* Import a model that is already in the cache, or fetch it and cache it. */
function acquireModel(uid, meta, onProgress) {
  return sfCacheGet(uid).then(function (hit) {
    if (hit && hit.glb) return hit.glb;
    return sfDownloadGLB(uid, onProgress).then(function (buf) {
      return sfCachePut(uid, meta || {}, buf).then(function () { return buf; });
    });
  });
}
/* ==========================================================================
   20. INSTANCE LAYERS
   --------------------------------------------------------------------------
   One layer per (model, merged material). Placing a model allocates a slot in
   every one of its part layers, so N copies of a building cost one draw call
   per material rather than one per copy. Layers grow by doubling; growth
   rebuilds the geometry outright so no GPU buffer is orphaned.
   ========================================================================== */
var OBJ_ATTRS = [
  ['iPosSeed', 4], ['iQuat', 4], ['iSclSway', 4], ['iTint', 3], ['iAnim', 4]
];

function InstanceLayer(kind, partIndex, initial) {
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
var Layers = { map: {}, list: [] };

function layerFor(kind, partIndex) {
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

function disposeEmptyLayers() {
  for (var i = Layers.list.length - 1; i >= 0; i--) {
    var L = Layers.list[i];
    if (L.count === 0 && L.cap > 32) {
      L.dispose();
      delete Layers.map[L.id];
      Layers.list.splice(i, 1);
    }
  }
}
function clearAllLayers() {
  for (var i = 0; i < Layers.list.length; i++) Layers.list[i].dispose();
  Layers.list.length = 0;
  Layers.map = {};
}
function flushLayers() {
  for (var i = 0; i < Layers.list.length; i++) Layers.list[i].flush();
}
function layerStats() {
  var tris = 0, draws = 0;
  for (var i = 0; i < Layers.list.length; i++) {
    var L = Layers.list[i];
    if (!L.count || !L.mesh.visible) continue;
    draws++;
    tris += (L.base.index ? L.base.index.count / 3 : 0) * L.count;
  }
  return { draws: draws, tris: Math.round(tris) };
}
/* ==========================================================================
   21. WORLD OBJECTS
   --------------------------------------------------------------------------
   One registry for everything that is not terrain, grass or road geometry.
   Each record knows which instance layers and slots render it — an imported
   model has one slot per merged material — so selection, undo, save/load and
   culling all operate on the same objects.
   ========================================================================== */
var World = {
  objs: [],
  byId: {},
  nextId: 1,
  roads: [],
  paths: [],
  prefabs: []
};

var CATS = ['terrain', 'grass', 'roads', 'buildings', 'nature', 'props', 'people', 'vehicles'];
var CAT_OF = { building: 'buildings', nature: 'nature', prop: 'props', person: 'people', vehicle: 'vehicles' };
var CAT_COLOR = {
  terrain: '#8a7a4a', grass: '#7ed957', roads: '#9aa4ad', buildings: '#d8a45c',
  nature: '#4b9a3a', props: '#6f9fd4', people: '#e07a9c', vehicles: '#c9645a'
};
var LayerState = {};
(function () { for (var i = 0; i < CATS.length; i++) LayerState[CATS[i]] = { vis: true, lock: false }; })();

function catVisible(assetKind) { var c = CAT_OF[assetKind] || 'props'; return LayerState[c].vis; }
function catLocked(cat) { return LayerState[cat] && LayerState[cat].lock; }

function applyLayerVisibility() {
  for (var i = 0; i < Layers.list.length; i++) {
    var L = Layers.list[i];
    L.mesh.visible = ASSETS[L.kind] ? catVisible(ASSETS[L.kind].kind) : false;
  }
  Grass.mesh.visible = LayerState.grass.vis;
  Terrain.mesh.visible = LayerState.terrain.vis;
  if (Roads.group) Roads.group.visible = LayerState.roads.vis;
  if (Water.mesh) Water.mesh.visible = LayerState.terrain.vis && !!state.plate.water && Q().water > 0;
}

/* ---- transforms ---------------------------------------------------------- */
var _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion();
var _upV = new THREE.Vector3(0, 1, 0), _nV = new THREE.Vector3();

function computeQuat(o) {
  _qA.setFromAxisAngle(_upV, o.rotY);
  if (o.align > 0.001 && state.plate.mode === 'terrain') {
    normalAt(o.x, o.z, _nV);
    _qB.setFromUnitVectors(_upV, _nV);
    _qC.set(0, 0, 0, 1).slerp(_qB, clamp(o.align, 0, 1));
    _qA.premultiply(_qC);
  }
  o.qx = _qA.x; o.qy = _qA.y; o.qz = _qA.z; o.qw = _qA.w;
}

function pushObject(o) {
  o.idx = World.objs.length;
  World.objs.push(o);
  World.byId[o.id] = o;
  ogridAdd(o);
}
function popObject(o) {
  var last = World.objs.length - 1;
  if (o.idx !== last) { World.objs[o.idx] = World.objs[last]; World.objs[o.idx].idx = o.idx; }
  World.objs.pop();
  delete World.byId[o.id];
  ogridRemove(o);
}

/* ---- creation ------------------------------------------------------------ */
function makeObject(kind, x, z, opt) {
  opt = opt || {};
  var def = ASSETS[kind];
  if (!def) return null;
  var seed = (opt.seed === undefined) ? Math.floor(rnd() * 1e9) : opt.seed;
  var o = {
    id: opt.id || World.nextId++,
    kind: kind,
    cat: CAT_OF[def.kind] || 'props',
    seed: seed,
    x: x, z: z, y: 0,
    rotY: opt.rotY === undefined ? 0 : opt.rotY,
    scale: (opt.scale === undefined ? 1 : opt.scale) * (def.scale || 1),
    align: opt.align === undefined ? 0 : opt.align,
    tint: opt.tint ? opt.tint.slice() : [1, 1, 1],
    tintCustom: !!opt.tint,
    sway: def.sway === undefined ? 0 : def.sway,
    pose: 0,
    phase: opt.phase === undefined ? rnd() * TAU : opt.phase,
    rate: opt.rate === undefined ? 0 : opt.rate,
    sel: false,
    radius: def.radius || 1,
    height: def.height || 1,
    yOff: opt.yOff || 0,
    slots: []
  };
  if (World.nextId <= o.id) World.nextId = o.id + 1;
  o.sx = o.sy = o.sz = o.scale;
  o.y = surfaceOrTerrainY(o) + o.yOff;
  computeQuat(o);
  return o;
}

function surfaceOrTerrainY(o) { return heightAt(o.x, o.z); }

/* An imported model spans several layers; the record keeps a slot in each. */
function attachObject(o) {
  var def = ASSETS[o.kind];
  if (!def) return o;
  o.slots = [];
  for (var p = 0; p < def.parts.length; p++) {
    var L = layerFor(o.kind, p);
    var slot = L.alloc(o);
    o.slots[p] = slot;
    L.write(slot, o);
  }
  return o;
}
function detachObject(o) {
  var def = ASSETS[o.kind];
  if (!def || !o.slots) return;
  for (var p = def.parts.length - 1; p >= 0; p--) {
    var L = Layers.map[o.kind + '#' + p];
    if (L && o.slots[p] !== undefined && o.slots[p] >= 0) L.remove(o.slots[p]);
  }
  o.slots = [];
}
function updateObject(o) {
  o.sx = o.sy = o.sz = o.scale;
  computeQuat(o);
  var def = ASSETS[o.kind];
  if (!def || !o.slots) return;
  for (var p = 0; p < def.parts.length; p++) {
    var L = Layers.map[o.kind + '#' + p];
    if (L && o.slots[p] !== undefined) L.write(o.slots[p], o);
  }
}

function addObject(kind, x, z, opt) {
  var o = makeObject(kind, x, z, opt);
  if (!o) return null;
  pushObject(o);
  attachObject(o);
  return o;
}
function deleteObject(o) {
  detachObject(o);
  popObject(o);
}

/* ---- serialisation ------------------------------------------------------- */
function serObj(o) {
  var r = { i: o.id, k: o.kind, s: o.seed,
            x: +o.x.toFixed(3), z: +o.z.toFixed(3),
            r: +o.rotY.toFixed(4), c: +o.scale.toFixed(3),
            a: +o.align.toFixed(3), yo: +o.yOff.toFixed(3) };
  if (o.tintCustom) r.tn = o.tint;
  // the lane offset has to travel with the actor: without it roadPose() gets
  // an undefined offset on reload and the actor lands at NaN
  if (o.pathId) { r.pa = o.pathId; r.t = +o.t.toFixed(4); r.sp = +o.speed.toFixed(3); r.ln = +(o.lane || 0).toFixed(3); }
  if (o.roadId !== undefined && o.roadId !== null) { r.rd = o.roadId; r.t = +o.t.toFixed(4); r.sp = +o.speed.toFixed(3); r.dr = o.dir; r.ln = +(o.lane || 0).toFixed(3); }
  return r;
}
function deserObj(r) {
  if (!ASSETS[r.k]) return null;              // model no longer in the library
  var o = addObject(r.k, r.x, r.z, {
    id: r.i, seed: r.s, rotY: r.r, align: r.a, tint: r.tn, yOff: r.yo
  });
  if (!o) return null;
  o.scale = r.c; o.sx = o.sy = o.sz = r.c;
  if (r.pa !== undefined) { o.pathId = r.pa; o.t = r.t; o.speed = r.sp; o.lane = r.ln || 0; o.rate = 2.4; }
  if (r.rd !== undefined) { o.roadId = r.rd; o.t = r.t; o.speed = r.sp; o.dir = r.dr; o.lane = r.ln || 0; }
  updateObject(o);
  return o;
}

/* ---- undo ops ------------------------------------------------------------ */
var WORLD_OPS = {
  oadd: {
    undo: function (op) { for (var i = 0; i < op.recs.length; i++) { var o = World.byId[op.recs[i].i]; if (o) deleteObject(o); } },
    redo: function (op) { for (var i = 0; i < op.recs.length; i++) deserObj(op.recs[i]); }
  },
  odel: {
    undo: function (op) { for (var i = 0; i < op.recs.length; i++) deserObj(op.recs[i]); },
    redo: function (op) { for (var i = 0; i < op.recs.length; i++) { var o = World.byId[op.recs[i].i]; if (o) deleteObject(o); } }
  },
  omod: {
    undo: function (op) { applyObjRecords(op.before); },
    redo: function (op) { applyObjRecords(op.after); }
  },
  terr: {
    undo: function (op) { applyTerrainPatch(op, true); },
    redo: function (op) { applyTerrainPatch(op, false); }
  },
  radd: {
    undo: function (op) { for (var i = 0; i < op.ids.length; i++) removeRoadById(op.ids[i], true); },
    redo: function (op) { for (var i = 0; i < op.recs.length; i++) addRoadRecord(op.recs[i]); rebuildAllRoads(); }
  },
  rdel: {
    undo: function (op) { for (var i = 0; i < op.recs.length; i++) addRoadRecord(op.recs[i]); rebuildAllRoads(); },
    redo: function (op) { for (var i = 0; i < op.ids.length; i++) removeRoadById(op.ids[i], true); }
  },
  rmod: {
    undo: function (op) { applyRoadRecords(op.before); },
    redo: function (op) { applyRoadRecords(op.after); }
  }
};
function applyObjRecords(list) {
  for (var i = 0; i < list.length; i++) {
    var r = list[i], o = World.byId[r.i];
    if (!o) { deserObj(r); continue; }
    o.x = r.x; o.z = r.z; o.rotY = r.r; o.scale = r.c; o.align = r.a;
    o.yOff = r.yo || 0;
    if (r.tn) { o.tint = r.tn.slice(); o.tintCustom = true; }
    o.y = surfaceOrTerrainY(o) + o.yOff;
    ogridMove(o);
    updateObject(o);
  }
}
function recordObjAdd(objs) {
  if (!objs.length) return;
  var recs = [];
  for (var i = 0; i < objs.length; i++) recs.push(serObj(objs[i]));
  recordOp({ t: 'oadd', recs: recs, bytes: recs.length * 96 });
}
function recordObjDel(objs) {
  if (!objs.length) return;
  var recs = [];
  for (var i = 0; i < objs.length; i++) recs.push(serObj(objs[i]));
  recordOp({ t: 'odel', recs: recs, bytes: recs.length * 96 });
}

/* ==========================================================================
   SPATIAL HASH — spacing checks, brush erasing and click selection.
   ========================================================================== */
var OGrid = { cell: 5, map: {} };
function ogKey(x, z) { return (Math.floor(x / OGrid.cell)) + ',' + (Math.floor(z / OGrid.cell)); }
function ogridAdd(o) {
  var k = ogKey(o.x, o.z);
  (OGrid.map[k] || (OGrid.map[k] = [])).push(o);
  o._gk = k;
}
function ogridRemove(o) {
  var a = OGrid.map[o._gk];
  if (!a) return;
  var i = a.indexOf(o);
  if (i >= 0) a.splice(i, 1);
}
function ogridMove(o) { ogridRemove(o); ogridAdd(o); }
function ogridRebuild() {
  OGrid.map = {};
  for (var i = 0; i < World.objs.length; i++) ogridAdd(World.objs[i]);
}
function ogridQuery(x, z, r, fn) {
  var c = OGrid.cell;
  var i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
  var j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
  for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
    var a = OGrid.map[i + ',' + j];
    if (!a) continue;
    for (var k = a.length - 1; k >= 0; k--) fn(a[k]);
  }
}
function nearestObjectDist(x, z, r, catFilter) {
  var best = 1e9;
  ogridQuery(x, z, r, function (o) {
    if (catFilter && o.cat !== catFilter) return;
    var dx = o.x - x, dz = o.z - z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < best) best = d;
  });
  return best;
}

/* ==========================================================================
   RE-PROJECTION — anything standing on the ground follows a sculpt edit.
   ========================================================================== */
function resnapWorld() {
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.pathId || o.roadId !== undefined) continue;   // actors re-solve each frame
    o.y = surfaceOrTerrainY(o) + o.yOff;
    updateObject(o);
  }
}
function resnapWorldRegion(cx, cz, r) {
  var r2 = r * r;
  ogridQuery(cx, cz, r, function (o) {
    var dx = o.x - cx, dz = o.z - cz;
    if (dx * dx + dz * dz > r2) return;
    o.y = surfaceOrTerrainY(o) + o.yOff;
    updateObject(o);
  });
}

/* Level the ground under a footprint so a building never floats or clips. */
function flattenFootprint(cx, cz, radius, targetH) {
  if (state.plate.mode !== 'terrain') return;
  var p = state.plate, N = Terrain.N, W = N + 1;
  var rc = sculptCellRect(cx, cz, radius * 1.9);
  var h = (targetH === undefined) ? heightAt(cx, cz) : targetH;
  for (var j = rc.j0; j <= rc.j1; j++) {
    var z = (j / N - 0.5) * p.depth;
    for (var i = rc.i0; i <= rc.i1; i++) {
      var x = (i / N - 0.5) * p.width;
      var dx = x - cx, dz = z - cz;
      var d = Math.sqrt(dx * dx + dz * dz);
      var w = 1 - smoothstep(radius * 0.85, radius * 1.85, d);
      if (w <= 0) continue;
      var k = j * W + i;
      sculptWrite(k, (h - Terrain.h[k]) * w);
    }
  }
  recomputeTerrainBounds();
  updateGroundVerts(Math.max(rc.j0 - 1, 0), Math.min(rc.j1 + 1, N));
  resnapRegion(cx, cz, radius * 2.2);
  resnapWorldRegion(cx, cz, radius * 2.4);
  Water.dirty = true;
}

/* ==========================================================================
   PLACEMENT
   ========================================================================== */
function placementOpts(kind, x, z, over) {
  var b = state.build, s = state.nature;
  var def = ASSETS[kind];
  var o = { seed: Math.floor(rnd() * 1e9) };
  // state.place.size is the one Size slider in the Place panel; it multiplies
  // whichever per-kind variation set applies, so it means the same thing for
  // a house as it does for a fern.
  if (def.kind === 'building') {
    o.rotY = b.rotation * DEG + (rnd() - 0.5) * b.rotJitter * DEG;
    o.scale = state.place.size * b.scale * lerp(b.scaleMin, b.scaleMax, rnd());
    o.align = b.upright ? 0 : 0.4;
  } else {
    o.rotY = rnd() * s.rotJitter * DEG * 2;
    o.scale = state.place.size * lerp(s.scaleMin, s.scaleMax, rnd());
    o.align = s.alignNormal;
  }
  if (over) for (var k in over) if (over[k] !== undefined) o[k] = over[k];
  return o;
}

/* Buildings snap to the grid or face the nearest road with a setback — that
   road-facing rule is what turns a row of houses into a street. */
function resolvePlacement(kind, x, z) {
  var b = state.build, def = ASSETS[kind];
  var out = { x: x, z: z, rotY: b.rotation * DEG, snapped: false };
  if (!def || def.kind !== 'building') return out;
  if (b.snap === 'grid') {
    var g = Math.max(0.25, b.gridSize);
    out.x = Math.round(x / g) * g;
    out.z = Math.round(z / g) * g;
  } else if (b.snap === 'road') {
    var info = nearestRoadPoint(x, z, 60);
    if (info) {
      var nx = info.nx, nz = info.nz;                 // unit normal away from road
      var half = info.width * 0.5 + b.setback;
      out.x = info.px + nx * half;
      out.z = info.pz + nz * half;
      // (nx, nz) points from the road out to the plot, so facing the street is
      // the reverse of the offset direction.
      out.rotY = Math.atan2(-nx, -nz);
      out.snapped = true;
    }
  }
  return out;
}

function placeObjectAt(kind, x, z, opt) {
  var b = state.build, def = ASSETS[kind];
  if (!def) return null;
  var res = resolvePlacement(kind, x, z);
  var o2 = placementOpts(kind, res.x, res.z, opt);
  if (def.kind === 'building') {
    o2.rotY = res.rotY + (rnd() - 0.5) * b.rotJitter * DEG;
    if (opt && opt.rotY !== undefined) o2.rotY = opt.rotY;
  }
  var o = addObject(kind, res.x, res.z, o2);
  if (!o) return null;
  if (def.kind === 'building' && b.flatten) {
    flattenFootprint(o.x, o.z, o.radius * o.scale, heightAt(o.x, o.z));
    o.y = heightAt(o.x, o.z) + o.yOff;
    updateObject(o);
  }
  return o;
}

/* ==========================================================================
   SCATTER BRUSH — filtered by slope, altitude and a minimum spacing.
   ========================================================================== */
function scatterStamp(cx, cz, cfg, kinds) {
  var p = state.plate, b = state.brush;
  var live = [];
  for (var q = 0; q < kinds.length; q++) if (ASSETS[kinds[q]]) live.push(kinds[q]);
  if (!live.length) return [];
  var hw = p.width * 0.5, hd = p.depth * 0.5;
  var tries = Math.max(1, Math.round(cfg.density * b.radius * b.radius * 0.55));
  var added = [];
  var edge = lerp(0.04, 0.97, b.falloff);
  for (var n = 0; n < tries; n++) {
    var ang = rnd() * TAU, rr = b.radius * Math.sqrt(rnd());
    var u = rr / b.radius;
    if (rnd() > 1 - smoothstep(edge, 1, u)) continue;
    var x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
    if (x < -hw || x > hw || z < -hd || z > hd) continue;
    var y = heightAt(x, z);
    if (y < cfg.minAlt || y > cfg.maxAlt) continue;
    if (normalYAt(x, z) < cfg.minNormalY) continue;
    if (underWater(x, z)) continue;
    if (nearestObjectDist(x, z, cfg.spacing) < cfg.spacing) continue;
    if (roadCovers(x, z, 0.6)) continue;
    var kind = live[(rnd() * live.length) | 0];
    var o = addObject(kind, x, z, {
      rotY: rnd() * cfg.rotJitter * DEG * 2,
      scale: (cfg.size === undefined ? state.place.size : cfg.size) * lerp(cfg.scaleMin, cfg.scaleMax, rnd()),
      align: cfg.alignNormal === undefined ? 0.25 : cfg.alignNormal
    });
    if (o) added.push(o);
  }
  return added;
}

/* ==========================================================================
   ERASE — one brush, filtered by category so grass can be painted around
   finished buildings without touching them.
   ========================================================================== */
function eraseWorldStamp(cx, cz, r, mask) {
  var hits = [];
  var r2 = r * r;
  ogridQuery(cx, cz, r, function (o) {
    if (!mask[o.cat]) return;
    if (catLocked(o.cat)) return;
    var dx = o.x - cx, dz = o.z - cz;
    if (dx * dx + dz * dz > r2) return;
    hits.push(o);
  });
  if (!hits.length) return 0;
  recordObjDel(hits);
  for (var i = 0; i < hits.length; i++) deleteObject(hits[i]);
  return hits.length;
}

function objectCounts() {
  var c = { buildings: 0, nature: 0, props: 0, people: 0, vehicles: 0 };
  for (var i = 0; i < World.objs.length; i++) c[World.objs[i].cat]++;
  return c;
}

function clearWorldObjects(cats) {
  var kill = [];
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (!cats || cats.indexOf(o.cat) >= 0) kill.push(o);
  }
  for (var k = 0; k < kill.length; k++) deleteObject(kill[k]);
  disposeEmptyLayers();
}
/* ==========================================================================
   22. ROADS
   --------------------------------------------------------------------------
   Roads are Catmull-Rom splines sampled into ribbons. They follow the terrain
   through a smoothed height profile and then flatten (or, for rivers, carve)
   the ground beneath themselves, so they can never float or clip. Geometry is
   merged per material, which keeps the whole network to a handful of draws.
   ========================================================================== */
var ROAD_TYPES = {
  highway:     { label: 'Highway',     width: 13, material: 'asphalt',  markings: true,  sw: false, prio: 5 },
  street:      { label: 'City street', width: 8.5, material: 'asphalt', markings: true,  sw: true,  prio: 4 },
  residential: { label: 'Residential', width: 6.2, material: 'concrete', markings: false, sw: true, prio: 3 },
  dirt:        { label: 'Dirt path',   width: 3.4, material: 'dirt',     markings: false, sw: false, prio: 2 },
  foot:        { label: 'Footpath',    width: 2.1, material: 'cobble',   markings: false, sw: false, prio: 2 },
  river:       { label: 'River',       width: 10, material: 'water',     markings: false, sw: false, prio: 1 }
};
var ROAD_MATS = {
  asphalt:  { surface: '#3b3f45', edge: '#2e3238', line: '#d8d2be', walk: '#9a9a94', grain: 1, water: 0 },
  concrete: { surface: '#8d8c85', edge: '#77766f', line: '#e0dccc', walk: '#a3a29a', grain: 0.7, water: 0 },
  cobble:   { surface: '#7d7367', edge: '#655d53', line: '#c9c2b2', walk: '#8d8478', grain: 1.5, water: 0 },
  gravel:   { surface: '#8a8175', edge: '#6f6759', line: '#c9c2b2', walk: '#96907f', grain: 1.8, water: 0 },
  dirt:     { surface: '#6d5940', edge: '#57462f', line: '#c9c2b2', walk: '#7a6749', grain: 1.6, water: 0 },
  water:    { surface: '#2f6f8f', edge: '#1e4d66', line: '#ffffff', walk: '#2f6f8f', grain: 0.4, water: 1 }
};
var ROAD_MAT_LIST = ['asphalt', 'concrete', 'cobble', 'gravel', 'dirt', 'water'];

var Roads = { group: null, meshes: {}, mask: null, maskN: 96, dirty: true, nextId: 1 };

function createRoads() {
  Roads.group = new THREE.Group();
  scene.add(Roads.group);
  Roads.mask = new Uint8Array(Roads.maskN * Roads.maskN);
  for (var i = 0; i < ROAD_MAT_LIST.length; i++) {
    var m = ROAD_MAT_LIST[i], cfg = ROAD_MATS[m];
    var mat = new THREE.ShaderMaterial({
      vertexShader: ROAD_VS, fragmentShader: ROAD_FS,
      uniforms: {
        uSurface: { value: hexLin(cfg.surface, new THREE.Vector3()) },
        uEdge: { value: hexLin(cfg.edge, new THREE.Vector3()) },
        uLine: { value: hexLin(cfg.line, new THREE.Vector3()) },
        uWalk: { value: hexLin(cfg.walk, new THREE.Vector3()) },
        uMarkings: { value: 1 }, uGrain: { value: cfg.grain }, uWater: { value: cfg.water },
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Vector3() },
        uSkyColor: { value: new THREE.Vector3() }, uGroundColor: { value: new THREE.Vector3() },
        uAmbient: { value: 1 }, uExposure: { value: 1.05 },
        uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0.0075 }
      },
      side: THREE.DoubleSide,
      transparent: cfg.water > 0,
      depthWrite: cfg.water === 0
    });
    var mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = cfg.water > 0 ? 30 : 5;
    Roads.group.add(mesh);
    Roads.meshes[m] = mesh;
  }
}

function syncRoadUniforms() {
  for (var i = 0; i < ROAD_MAT_LIST.length; i++) {
    var mesh = Roads.meshes[ROAD_MAT_LIST[i]];
    if (!mesh) continue;
    var u = mesh.material.uniforms;
    u.uSunDir.value.copy(Env.sunDir);
    u.uSunColor.value.copy(Env.sun);
    u.uSkyColor.value.copy(Env.amb);
    u.uGroundColor.value.copy(Env.gnd);
    u.uAmbient.value = Env.ambient;
    u.uExposure.value = state.env.exposure;
    u.uFogColor.value.copy(Env.fog);
    u.uFogDensity.value = state.env.fogDensity;
  }
}

/* ---- spline -------------------------------------------------------------- */
function catmull(p0, p1, p2, p3, t) {
  var t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function splinePoint(pts, u) {
  var n = pts.length;
  if (n === 0) return { x: 0, z: 0 };
  if (n === 1) return { x: pts[0].x, z: pts[0].z };
  var seg = clamp(Math.floor(u), 0, n - 2);
  var t = clamp(u - seg, 0, 1);
  var p0 = pts[Math.max(seg - 1, 0)], p1 = pts[seg], p2 = pts[seg + 1], p3 = pts[Math.min(seg + 2, n - 1)];
  return { x: catmull(p0.x, p1.x, p2.x, p3.x, t), z: catmull(p0.z, p1.z, p2.z, p3.z, t) };
}

/* Sample the spline at roughly uniform spacing and attach a smoothed terrain
   height profile — a raw terrain sample makes the surface wobble. */
function roadSamples(rd) {
  if (rd._s && !rd._dirty) return rd._s;
  var pts = rd.pts;
  if (pts.length < 2) { rd._s = []; rd._dirty = false; return rd._s; }
  var per = 6;
  var out = [];
  var total = pts.length - 1;
  var dist = 0, px = 0, pz = 0;
  for (var s = 0; s < total; s++) {
    var approx = Math.hypot(pts[s + 1].x - pts[s].x, pts[s + 1].z - pts[s].z);
    var steps = clamp(Math.ceil(approx / 1.4), 2, 90);
    for (var i = 0; i < steps; i++) {
      var u = s + i / steps;
      var p = splinePoint(pts, u);
      if (out.length) dist += Math.hypot(p.x - px, p.z - pz);
      px = p.x; pz = p.z;
      out.push({ x: p.x, z: p.z, d: dist, y: 0, tx: 0, tz: 0 });
    }
  }
  var last = splinePoint(pts, total);
  dist += Math.hypot(last.x - px, last.z - pz);
  out.push({ x: last.x, z: last.z, d: dist, y: 0, tx: 0, tz: 0 });

  for (var k = 0; k < out.length; k++) out[k].y0 = heightAt(out[k].x, out[k].z);
  // moving average smooths the height profile without moving the road plan
  var win = Math.max(1, Math.round(rd.flatten * 9));
  for (var k2 = 0; k2 < out.length; k2++) {
    var acc = 0, cnt = 0;
    for (var w = -win; w <= win; w++) {
      var idx = clamp(k2 + w, 0, out.length - 1);
      acc += out[idx].y0; cnt++;
    }
    out[k2].y = acc / cnt;
  }
  for (var k3 = 0; k3 < out.length; k3++) {
    var a = out[Math.max(k3 - 1, 0)], b = out[Math.min(k3 + 1, out.length - 1)];
    var dx = b.x - a.x, dz = b.z - a.z;
    var l = Math.hypot(dx, dz) || 1;
    out[k3].tx = dx / l; out[k3].tz = dz / l;
  }
  rd._s = out; rd._dirty = false;
  rd.length = dist;
  return out;
}

function roadDefaults(type) {
  var t = ROAD_TYPES[type] || ROAD_TYPES.street, r = state.road;
  return {
    type: type, width: r.width || t.width, material: r.material || t.material,
    markings: r.markings && t.markings, curb: r.curb,
    swL: r.sidewalkL && t.sw, swR: r.sidewalkR && t.sw, swW: r.sidewalkW,
    flatten: r.flatten, carve: type === 'river' ? r.carve : 0,
    prio: t.prio
  };
}

function newRoad(type, pts) {
  var d = roadDefaults(type);
  var rd = {
    id: Roads.nextId++, type: type, pts: pts.slice(),
    width: d.width, material: d.material, markings: d.markings, curb: d.curb,
    swL: d.swL, swR: d.swR, swW: d.swW, flatten: d.flatten, carve: d.carve, prio: d.prio,
    deco: { lights: state.road.autoLights, trees: state.road.autoTrees, signs: state.road.autoSigns },
    decoIds: [], _dirty: true
  };
  return rd;
}
function serRoad(rd) {
  return {
    i: rd.id, t: rd.type, p: rd.pts.map(function (p) { return [+p.x.toFixed(2), +p.z.toFixed(2)]; }),
    w: rd.width, m: rd.material, mk: rd.markings ? 1 : 0, cu: rd.curb,
    l: rd.swL ? 1 : 0, r: rd.swR ? 1 : 0, sw: rd.swW, f: rd.flatten, cv: rd.carve, pr: rd.prio,
    d: [rd.deco.lights ? 1 : 0, rd.deco.trees ? 1 : 0, rd.deco.signs ? 1 : 0]
  };
}
function addRoadRecord(r) {
  var rd = {
    id: r.i, type: r.t, pts: r.p.map(function (p) { return { x: p[0], z: p[1] }; }),
    width: r.w, material: r.m, markings: !!r.mk, curb: r.cu,
    swL: !!r.l, swR: !!r.r, swW: r.sw, flatten: r.f, carve: r.cv, prio: r.pr,
    deco: { lights: !!r.d[0], trees: !!r.d[1], signs: !!r.d[2] }, decoIds: [], _dirty: true
  };
  World.roads.push(rd);
  if (Roads.nextId <= rd.id) Roads.nextId = rd.id + 1;
  return rd;
}
function applyRoadRecords(list) {
  for (var i = 0; i < list.length; i++) {
    var r = list[i], rd = roadById(r.i);
    if (!rd) { addRoadRecord(r); continue; }
    rd.pts = r.p.map(function (p) { return { x: p[0], z: p[1] }; });
    rd.width = r.w; rd.material = r.m; rd.markings = !!r.mk; rd.curb = r.cu;
    rd.swL = !!r.l; rd.swR = !!r.r; rd.swW = r.sw; rd.flatten = r.f; rd.carve = r.cv;
    rd._dirty = true;
  }
  rebuildAllRoads();
}
function roadById(id) {
  for (var i = 0; i < World.roads.length; i++) if (World.roads[i].id === id) return World.roads[i];
  return null;
}
function removeRoadById(id, silent) {
  for (var i = 0; i < World.roads.length; i++) {
    if (World.roads[i].id !== id) continue;
    clearRoadDeco(World.roads[i]);
    World.roads.splice(i, 1);
    break;
  }
  if (!silent) rebuildAllRoads(); else Roads.dirty = true;
}

/* ---- terrain shaping ----------------------------------------------------- */
function applyRoadToTerrain(rd) {
  if (state.plate.mode !== 'terrain') return;
  var s = roadSamples(rd);
  if (s.length < 2) return;
  var p = state.plate, N = Terrain.N, W = N + 1;
  var half = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW : 0);
  var reach = half * 1.9;
  for (var k = 0; k < s.length; k++) {
    var pt = s[k];
    var target = pt.y - (rd.carve || 0);
    var rc = sculptCellRect(pt.x, pt.z, reach);
    for (var j = rc.j0; j <= rc.j1; j++) {
      var z = (j / N - 0.5) * p.depth;
      for (var i = rc.i0; i <= rc.i1; i++) {
        var x = (i / N - 0.5) * p.width;
        var dx = x - pt.x, dz = z - pt.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d > reach) continue;
        var w = 1 - smoothstep(half * 0.9, reach, d);
        if (w <= 0) continue;
        var idx = j * W + i;
        var cur = Terrain.base[idx] + Terrain.sculpt[idx];
        Terrain.sculpt[idx] += (target - cur) * w * (rd.carve ? 1 : rd.flatten);
        Terrain.h[idx] = Terrain.base[idx] + Terrain.sculpt[idx];
      }
    }
  }
  recomputeTerrainBounds();
  updateGroundVerts(0, N);
  Terrain.geo.computeBoundingSphere();
  Water.dirty = true;
}

/* ---- geometry ------------------------------------------------------------ */
function rebuildAllRoads() {
  var buckets = {};
  for (var m = 0; m < ROAD_MAT_LIST.length; m++) buckets[ROAD_MAT_LIST[m]] = { p: [], n: [], uv: [], k: [] };

  for (var r = 0; r < World.roads.length; r++) emitRoad(World.roads[r], buckets);
  emitJunctions(buckets);

  for (var mm = 0; mm < ROAD_MAT_LIST.length; mm++) {
    var name = ROAD_MAT_LIST[mm], b = buckets[name], mesh = Roads.meshes[name];
    if (!mesh) continue;
    var g = mesh.geometry;
    g.dispose();
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.n), 3));
    g.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(b.k), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    mesh.geometry = g;
    mesh.material.uniforms.uMarkings.value = 1;
    mesh.visible = b.p.length > 0 && LayerState.roads.vis;
  }
  rebuildRoadMask();
  Roads.dirty = false;
}

function pushStrip(b, ax, ay, az, bx, by, bz, cx, cy, cz, dx2, dy2, dz2, u0, u1, v0, v1, kind) {
  var P = b.p, N = b.n, U = b.uv, K = b.k;
  function tri(x1, y1, z1, x2, y2, z2, x3, y3, z3, ua, va, ub, vb, uc, vc) {
    var ux = x2 - x1, uy = y2 - y1, uz = z2 - z1;
    var vx = x3 - x1, vy = y3 - y1, vz = z3 - z1;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    P.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
    N.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
    U.push(ua, va, ub, vb, uc, vc);
    K.push(kind, kind, kind);
  }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, u0, v0, u1, v0, u1, v1);
  tri(ax, ay, az, cx, cy, cz, dx2, dy2, dz2, u0, v0, u1, v1, u0, v1);
}

function emitRoad(rd, buckets) {
  var s = roadSamples(rd);
  if (s.length < 2) return;
  var b = buckets[rd.material] || buckets.asphalt;
  var half = rd.width * 0.5;
  // Priority lift: wider / more important roads sit fractionally higher so
  // overlaps resolve deterministically instead of z-fighting.
  var lift = 0.02 + rd.prio * 0.006;
  var swb = buckets[rd.material === 'water' ? 'concrete' : rd.material] || b;

  for (var i = 0; i < s.length - 1; i++) {
    var a = s[i], c = s[i + 1];
    var anx = -a.tz, anz = a.tx, cnx = -c.tz, cnz = c.tx;
    pushStrip(b,
      a.x + anx * half, a.y + lift, a.z + anz * half,
      a.x - anx * half, a.y + lift, a.z - anz * half,
      c.x - cnx * half, c.y + lift, c.z - cnz * half,
      c.x + cnx * half, c.y + lift, c.z + cnz * half,
      1, -1, a.d, c.d, 0);

    if (rd.swL || rd.swR) {
      var sides = [];
      if (rd.swL) sides.push(1);
      if (rd.swR) sides.push(-1);
      for (var q = 0; q < sides.length; q++) {
        var sgn = sides[q];
        var o0 = half, o1 = half + rd.swW;
        var cy = lift + rd.curb;
        pushStrip(swb,
          a.x + anx * o0 * sgn, a.y + cy, a.z + anz * o0 * sgn,
          a.x + anx * o1 * sgn, a.y + cy, a.z + anz * o1 * sgn,
          c.x + cnx * o1 * sgn, c.y + cy, c.z + cnz * o1 * sgn,
          c.x + cnx * o0 * sgn, c.y + cy, c.z + cnz * o0 * sgn,
          0, 1, a.d, c.d, 1);
        // curb face
        pushStrip(swb,
          a.x + anx * o0 * sgn, a.y + lift, a.z + anz * o0 * sgn,
          a.x + anx * o0 * sgn, a.y + cy, a.z + anz * o0 * sgn,
          c.x + cnx * o0 * sgn, c.y + cy, c.z + cnz * o0 * sgn,
          c.x + cnx * o0 * sgn, c.y + lift, c.z + cnz * o0 * sgn,
          0, 0.4, a.d, c.d, 1);
      }
    }
  }
}

/* Where two centrelines cross, drop a patch sized to the wider road on top of
   both ribbons. One clean quad instead of two overlapping surfaces. */
function segIntersect(a1, a2, b1, b2) {
  var d1x = a2.x - a1.x, d1z = a2.z - a1.z;
  var d2x = b2.x - b1.x, d2z = b2.z - b1.z;
  var den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return null;
  var t = ((b1.x - a1.x) * d2z - (b1.z - a1.z) * d2x) / den;
  var u = ((b1.x - a1.x) * d1z - (b1.z - a1.z) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + d1x * t, z: a1.z + d1z * t, t: t };
}
function emitJunctions(buckets) {
  var R = World.roads;
  for (var i = 0; i < R.length; i++) {
    var A = R[i];
    if (A.type === 'river') continue;
    var sa = roadSamples(A);
    for (var j = i + 1; j < R.length; j++) {
      var B = R[j];
      if (B.type === 'river') continue;
      var sb = roadSamples(B);
      var found = [];
      for (var a = 0; a < sa.length - 1; a += 2) {
        for (var b2 = 0; b2 < sb.length - 1; b2 += 2) {
          var hit = segIntersect(sa[a], sa[a + 2] || sa[sa.length - 1], sb[b2], sb[b2 + 2] || sb[sb.length - 1]);
          if (!hit) continue;
          var dup = false;
          for (var f = 0; f < found.length; f++)
            if (Math.hypot(found[f].x - hit.x, found[f].z - hit.z) < Math.max(A.width, B.width)) { dup = true; break; }
          if (dup) continue;
          found.push(hit);
          var wide = Math.max(A.width, B.width) * 0.5 + 0.15;
          var y = Math.max(heightAt(hit.x, hit.z), 0) * 0 + interpRoadY(sa, hit) + 0.02 +
                  Math.max(A.prio, B.prio) * 0.006 + 0.004;
          var tx = sa[a].tx, tz = sa[a].tz;
          var nx = -tz, nz = tx;
          var bucket = buckets[A.width >= B.width ? A.material : B.material] || buckets.asphalt;
          pushStrip(bucket,
            hit.x + (tx + nx) * wide, y, hit.z + (tz + nz) * wide,
            hit.x + (tx - nx) * wide, y, hit.z + (tz - nz) * wide,
            hit.x + (-tx - nx) * wide, y, hit.z + (-tz - nz) * wide,
            hit.x + (-tx + nx) * wide, y, hit.z + (-tz + nz) * wide,
            1, -1, 0, wide * 2, 2);
        }
      }
    }
  }
}
function interpRoadY(s, hit) {
  var best = 1e9, y = 0;
  for (var i = 0; i < s.length; i++) {
    var d = (s[i].x - hit.x) * (s[i].x - hit.x) + (s[i].z - hit.z) * (s[i].z - hit.z);
    if (d < best) { best = d; y = s[i].y; }
  }
  return y;
}

/* ---- coverage mask ------------------------------------------------------- */
function rebuildRoadMask() {
  var n = Roads.maskN, p = state.plate;
  Roads.mask.fill(0);
  for (var r = 0; r < World.roads.length; r++) {
    var rd = World.roads[r], s = roadSamples(rd);
    var half = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW : 0);
    for (var k = 0; k < s.length; k++) {
      var pt = s[k];
      var i0 = clamp(Math.floor(((pt.x - half) / p.width + 0.5) * n), 0, n - 1);
      var i1 = clamp(Math.ceil(((pt.x + half) / p.width + 0.5) * n), 0, n - 1);
      var j0 = clamp(Math.floor(((pt.z - half) / p.depth + 0.5) * n), 0, n - 1);
      var j1 = clamp(Math.ceil(((pt.z + half) / p.depth + 0.5) * n), 0, n - 1);
      for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) Roads.mask[j * n + i] = 1;
    }
  }
}
function roadCovers(x, z, margin) {
  var n = Roads.maskN, p = state.plate;
  var i = ((x / p.width + 0.5) * n) | 0, j = ((z / p.depth + 0.5) * n) | 0;
  if (i < 0 || j < 0 || i >= n || j >= n) return false;
  return Roads.mask[j * n + i] === 1;
}

/* Nearest point on any road, with the outward normal — drives building snap. */
function nearestRoadPoint(x, z, maxDist) {
  var best = null, bd = maxDist * maxDist;
  for (var r = 0; r < World.roads.length; r++) {
    var rd = World.roads[r];
    if (rd.type === 'river') continue;
    var s = roadSamples(rd);
    for (var k = 0; k < s.length; k++) {
      var dx = s[k].x - x, dz = s[k].z - z;
      var d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        var nx = -s[k].tz, nz = s[k].tx;
        var side = (x - s[k].x) * nx + (z - s[k].z) * nz;
        if (side < 0) { nx = -nx; nz = -nz; }
        best = { px: s[k].x, pz: s[k].z, nx: nx, nz: nz, width: rd.width + (rd.swL || rd.swR ? rd.swW * 2 : 0),
                 road: rd, idx: k };
      }
    }
  }
  return best;
}

/* ---- decoration ---------------------------------------------------------- */
function clearRoadDeco(rd) {
  for (var i = 0; i < rd.decoIds.length; i++) {
    var o = World.byId[rd.decoIds[i]];
    if (o) deleteObject(o);
  }
  rd.decoIds.length = 0;
}
/* Auto-decoration needs to know which imported model is a lamp post and which
   is a tree — the panel picks those, and anything left unset falls back to any
   model of a sensible category. */
function decoKind(pref, type) {
  if (pref && ASSETS[pref] && ASSETS[pref].kind === type) return pref;
  var list = kindsOfType(type);
  return list.length ? list[0] : null;
}
function decorateRoad(rd) {
  clearRoadDeco(rd);
  var s = roadSamples(rd);
  if (s.length < 2) return [];
  var cfg = state.road, added = [];
  var half = rd.width * 0.5 + (rd.swL || rd.swR ? rd.swW * 0.55 : 0.6);
  var jit = cfg.decoJitter;

  function along(spacing, fn) {
    if (spacing <= 0.5) return;
    var next = spacing * 0.5;
    for (var k = 0; k < s.length; k++) {
      if (s[k].d < next) continue;
      next += spacing;
      fn(s[k], k);
    }
  }
  var lightK = decoKind(cfg.lightKind, 'prop');
  var treeK = cfg.treeKind && ASSETS[cfg.treeKind] ? cfg.treeKind : (kindsOfType('nature')[0] || null);
  var signK = decoKind(cfg.signKind, 'prop');
  if (rd.deco.lights && lightK) along(cfg.lightSpacing, function (pt, k) {
    var side = (k % 2) ? 1 : -1;
    var nx = -pt.tz * side, nz = pt.tx * side;
    var o = addObject(lightK, pt.x + nx * (half + 0.5), pt.z + nz * (half + 0.5), {
      rotY: Math.atan2(-nx, -nz), scale: 1, align: 0
    });
    if (o) { rd.decoIds.push(o.id); added.push(o); }
  });
  if (rd.deco.trees && treeK) along(cfg.treeSpacing, function (pt, k) {
    for (var side = -1; side <= 1; side += 2) {
      var nx = -pt.tz * side, nz = pt.tx * side;
      var jx = (rnd() - 0.5) * jit * 3, jz = (rnd() - 0.5) * jit * 3;
      var x = pt.x + nx * (half + 2.2) + jx, z = pt.z + nz * (half + 2.2) + jz;
      if (roadCovers(x, z)) continue;
      var o = addObject(treeK, x, z, {
        rotY: rnd() * TAU, scale: lerp(0.8, 1.15, rnd()), align: 0.2
      });
      if (o) { rd.decoIds.push(o.id); added.push(o); }
    }
  });
  if (rd.deco.signs && signK) along(cfg.lightSpacing * 2.4, function (pt, k) {
    var side = (k % 3) ? 1 : -1;
    var nx = -pt.tz * side, nz = pt.tx * side;
    var o = addObject(signK, pt.x + nx * (half + 0.9), pt.z + nz * (half + 0.9), {
      rotY: Math.atan2(-nx, -nz), scale: 1, align: 0
    });
    if (o) { rd.decoIds.push(o.id); added.push(o); }
  });
  return added;
}

/* ---- grass clearing ------------------------------------------------------ */
function clearGrassUnderRoads() {
  if (!Grass.count) return;
  var A = Grass.arr, kill = [];
  for (var i = 0; i < Grass.count; i++) {
    var x = A.aOffset[i * 3], z = A.aOffset[i * 3 + 2];
    if (roadCovers(x, z)) kill.push(i);
  }
  if (kill.length) removeBlades(kill);
}

/* ---- commit -------------------------------------------------------------- */
function commitRoad(rd) {
  beginStroke('Road');
  if (state.plate.mode === 'terrain') Sculpt.snap = Terrain.sculpt.slice();
  World.roads.push(rd);
  applyRoadToTerrain(rd);
  rebuildAllRoads();
  var deco = decorateRoad(rd);
  if (state.road.clearGrass) clearGrassUnderRoads();
  resnapAll();
  resnapWorld();
  recordOp({ t: 'radd', ids: [rd.id], recs: [serRoad(rd)], bytes: 400 });
  if (deco.length) recordObjAdd(deco);
  if (state.plate.mode === 'terrain') endSculptStroke();
  endStroke();
  markSceneDirty();
}

function reshapeRoad(rd, beforeRec) {
  beginStroke('Edit road');
  if (state.plate.mode === 'terrain') Sculpt.snap = Terrain.sculpt.slice();
  rd._dirty = true;
  applyRoadToTerrain(rd);
  rebuildAllRoads();
  var deco = decorateRoad(rd);
  if (state.road.clearGrass) clearGrassUnderRoads();
  resnapAll(); resnapWorld();
  recordOp({ t: 'rmod', before: [beforeRec], after: [serRoad(rd)], bytes: 800 });
  if (state.plate.mode === 'terrain') endSculptStroke();
  endStroke();
  markSceneDirty();
}

function deleteRoad(rd) {
  beginStroke('Delete road');
  var decoObjs = [];
  for (var i = 0; i < rd.decoIds.length; i++) { var o = World.byId[rd.decoIds[i]]; if (o) decoObjs.push(o); }
  if (decoObjs.length) recordObjDel(decoObjs);
  recordOp({ t: 'rdel', ids: [rd.id], recs: [serRoad(rd)], bytes: 400 });
  removeRoadById(rd.id);
  endStroke();
  markSceneDirty();
}

/* ---- vehicle routing ------------------------------------------------------
   Roads form a graph through their endpoints; a car reaching the end of one
   picks any road whose end is close by and continues onto it, which is what
   produces turns at intersections rather than cars vanishing. */
function roadEndpoint(rd, atEnd) {
  var s = roadSamples(rd);
  if (!s.length) return null;
  return atEnd ? s[s.length - 1] : s[0];
}
function pickNextRoad(rd, atEnd) {
  var here = roadEndpoint(rd, atEnd);
  if (!here) return null;
  var opts = [];
  for (var i = 0; i < World.roads.length; i++) {
    var o = World.roads[i];
    if (o.type === 'river' || o.type === 'foot') continue;
    if (o.id === rd.id) continue;
    var a = roadEndpoint(o, false), b = roadEndpoint(o, true);
    if (a && Math.hypot(a.x - here.x, a.z - here.z) < Math.max(o.width, rd.width) * 1.4) opts.push({ rd: o, dir: 1 });
    if (b && Math.hypot(b.x - here.x, b.z - here.z) < Math.max(o.width, rd.width) * 1.4) opts.push({ rd: o, dir: -1 });
  }
  if (!opts.length) return null;
  return opts[(rnd() * opts.length) | 0];
}
function roadPose(rd, dist, lane) {
  var s = roadSamples(rd);
  if (s.length < 2) return null;
  var d = clamp(dist, 0, s[s.length - 1].d);
  var lo = 0, hi = s.length - 1;
  while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (s[mid].d < d) lo = mid; else hi = mid; }
  var a = s[lo], b = s[hi];
  var t = (b.d - a.d) > 1e-6 ? (d - a.d) / (b.d - a.d) : 0;
  var x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t), y = lerp(a.y, b.y, t);
  var tx = lerp(a.tx, b.tx, t), tz = lerp(a.tz, b.tz, t);
  var l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
  var nx = -tz, nz = tx;
  return { x: x + nx * lane, y: y, z: z + nz * lane, tx: tx, tz: tz, total: s[s.length - 1].d };
}
/* ==========================================================================
   23. PEOPLE, PATHS AND TRAFFIC
   --------------------------------------------------------------------------
   Actors are ordinary world objects with a route attached. Their positions are
   solved on the CPU (a hundred of them is nothing) while the walk cycle and
   wheel spin run in the vertex shader, so they stay in the same instanced
   draw call as every other prop.
   ========================================================================== */
var Paths = { nextId: 1 };

/* The library is whatever has been imported, so actors ask for a kind by
   category rather than by a hard-coded model name. */
function kindsOfType(t) {
  var out = [];
  for (var id in ASSETS) if (ASSETS[id].kind === t) out.push(id);
  return out;
}
function pickKind(t, preferred) {
  if (preferred && ASSETS[preferred] && ASSETS[preferred].kind === t) return preferred;
  var list = kindsOfType(t);
  return list.length ? list[(rnd() * list.length) | 0] : null;
}

function newPath(pts) {
  return { id: Paths.nextId++, pts: pts.slice(), _dirty: true };
}
function pathById(id) {
  for (var i = 0; i < World.paths.length; i++) if (World.paths[i].id === id) return World.paths[i];
  return null;
}
function serPath(p) {
  return { i: p.id, p: p.pts.map(function (q) { return [+q.x.toFixed(2), +q.z.toFixed(2)]; }) };
}
function addPathRecord(r) {
  var p = { id: r.i, pts: r.p.map(function (q) { return { x: q[0], z: q[1] }; }), _dirty: true };
  World.paths.push(p);
  if (Paths.nextId <= p.id) Paths.nextId = p.id + 1;
  return p;
}

/* Sample a walking path. Points close to a road are pulled onto its pavement,
   which is what makes "draw a path near the street" produce pedestrians
   walking on the sidewalk rather than through the traffic lane. */
function pathSamples(path) {
  if (path._s && !path._dirty) return path._s;
  var pts = path.pts;
  if (pts.length < 2) { path._s = []; path._dirty = false; return path._s; }
  var out = [], dist = 0, px = 0, pz = 0;
  for (var s = 0; s < pts.length - 1; s++) {
    var approx = Math.hypot(pts[s + 1].x - pts[s].x, pts[s + 1].z - pts[s].z);
    var steps = clamp(Math.ceil(approx / 1.1), 2, 80);
    for (var i = 0; i < steps; i++) {
      var q = splinePoint(pts, s + i / steps);
      var x = q.x, z = q.z;
      var near = nearestRoadPoint(x, z, 14);
      if (near && near.road.type !== 'river') {
        var walkOff = near.road.width * 0.5 + (near.road.swL || near.road.swR ? near.road.swW * 0.5 : 0.8);
        var dx = x - near.px, dz = z - near.pz;
        var d = Math.hypot(dx, dz);
        if (d < walkOff + 3.5) {
          x = near.px + near.nx * walkOff;
          z = near.pz + near.nz * walkOff;
        }
      }
      if (out.length) dist += Math.hypot(x - px, z - pz);
      px = x; pz = z;
      out.push({ x: x, z: z, d: dist });
    }
  }
  for (var k = 0; k < out.length; k++) {
    var a = out[Math.max(k - 1, 0)], b = out[Math.min(k + 1, out.length - 1)];
    var tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    out[k].tx = tx / l; out[k].tz = tz / l;
  }
  path._s = out; path._dirty = false;
  path.length = dist;
  return out;
}
function pathPose(path, dist) {
  var s = pathSamples(path);
  if (s.length < 2) return null;
  var total = s[s.length - 1].d;
  var d = ((dist % total) + total) % total;
  var lo = 0, hi = s.length - 1;
  while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (s[mid].d < d) lo = mid; else hi = mid; }
  var a = s[lo], b = s[hi];
  var t = (b.d - a.d) > 1e-6 ? (d - a.d) / (b.d - a.d) : 0;
  return {
    x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t),
    tx: lerp(a.tx, b.tx, t), tz: lerp(a.tz, b.tz, t), total: total
  };
}

/* ---- populate ------------------------------------------------------------ */
function addPeopleToPath(path, count) {
  var cfg = state.people, added = [];
  var s = pathSamples(path);
  if (s.length < 2) return added;
  var total = s[s.length - 1].d;
  for (var i = 0; i < count; i++) {
    // stagger both the start offset and the speed so nobody marches in step
    var t0 = (i / count) * total + rnd() * total * 0.06;
    var pose = pathPose(path, t0);
    var lane = (rnd() - 0.5) * cfg.pathWidth;
    var kind = pickKind('person', state.people.place);
    if (!kind) break;
    var o = addObject(kind, pose.x - pose.tz * lane, pose.z + pose.tx * lane, {
      rotY: Math.atan2(pose.tx, pose.tz),
      scale: lerp(0.92, 1.1, rnd()), align: 0
    });
    if (!o) continue;
    o.pathId = path.id;
    o.t = t0;
    o.lane = lane;
    o.speed = Math.max(0.25, cfg.speed * (1 + (rnd() - 0.5) * cfg.speedVar * 2));
    o.rate = 2.2 + rnd() * 0.8;
    o.phase = rnd() * TAU;
    updateObject(o);
    added.push(o);
  }
  return added;
}

function addVehiclesToRoad(rd, count) {
  var cfg = state.traffic, added = [];
  var s = roadSamples(rd);
  if (s.length < 2 || rd.type === 'river' || rd.type === 'foot') return added;
  var total = s[s.length - 1].d;
  for (var i = 0; i < count; i++) {
    var dir = (i % 2) ? -1 : 1;
    var t0 = (i / Math.max(1, count)) * total + rnd() * cfg.spacing * 0.4;
    var lane = rd.width * 0.24 * dir;
    var kind = pickKind('vehicle');
    if (!kind) break;
    var pose = roadPose(rd, t0, lane);
    if (!pose) continue;
    var o = addObject(kind, pose.x, pose.z, {
      rotY: Math.atan2(pose.tx * dir, pose.tz * dir), scale: 1, align: 0
    });
    if (!o) continue;
    o.roadId = rd.id;
    o.t = t0;
    o.dir = dir;
    o.lane = lane;
    o.speed = Math.max(1, cfg.speed * (1 + (rnd() - 0.5) * cfg.speedVar * 2));
    o.rate = 0;
    o.yOff = 0.02;
    updateObject(o);
    added.push(o);
  }
  return added;
}

/* One click fills every road with a believable mix of traffic and pedestrians
   walking the pavements beside it. */
function populateWorld(density) {
  var added = [], i;
  beginStroke('Populate');
  var budget = Q().anim;
  var roads = World.roads.filter(function (r) { return r.type !== 'river'; });
  for (i = 0; i < roads.length && added.length < budget; i++) {
    var rd = roads[i];
    var s = roadSamples(rd);
    if (s.length < 2) continue;
    var len = s[s.length - 1].d;

    if (rd.type !== 'foot') {
      var cars = Math.max(0, Math.round(len / Math.max(6, state.traffic.spacing) * density));
      added = added.concat(addVehiclesToRoad(rd, Math.min(cars, 24)));
    }
    // pedestrians follow a path that traces the road, so pathSamples() snaps
    // them onto the pavement automatically
    var pp = newPath(rd.pts.slice());
    World.paths.push(pp);
    var peds = Math.max(1, Math.round(len / 14 * density * 2));
    added = added.concat(addPeopleToPath(pp, Math.min(peds, 40)));
  }
  if (added.length) recordObjAdd(added);
  endStroke();
  markSceneDirty();
  return added.length;
}

/* ---- per-frame update ---------------------------------------------------- */
var _actorQ = new THREE.Quaternion();
function updateActors(dt) {
  if (!state.world.simulate) return;
  var sim = dt;
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];

    if (o.pathId) {
      var path = pathById(o.pathId);
      if (!path) { o.pathId = null; continue; }
      o.t += o.speed * sim;
      var ps = pathPose(path, o.t);
      if (!ps) continue;
      var lane = isFinite(o.lane) ? o.lane : 0;
      o.x = ps.x - ps.tz * lane;
      o.z = ps.z + ps.tx * lane;
      o.rotY = Math.atan2(ps.tx, ps.tz);
      o.y = heightAt(o.x, o.z);
      ogridMove(o);
      updateObject(o);

    } else if (o.roadId !== undefined && o.roadId !== null) {
      var rd = roadById(o.roadId);
      if (!rd) { o.roadId = null; continue; }
      o.t += o.speed * sim * o.dir;
      if (!isFinite(o.lane)) o.lane = rd.width * 0.24 * (o.dir > 0 ? 1 : -1);
      var rs = roadPose(rd, o.t, o.lane);
      if (!rs) continue;
      // reached an end: turn onto a connected road, or reverse if it is a dead end
      if (o.t > rs.total || o.t < 0) {
        var atEnd = o.t > rs.total;
        var next = pickNextRoad(rd, atEnd);
        if (next) {
          o.roadId = next.rd.id;
          var ns = roadSamples(next.rd);
          var nlen = ns.length ? ns[ns.length - 1].d : 0;
          o.dir = next.dir;
          o.t = next.dir > 0 ? 0.5 : nlen - 0.5;
          o.lane = next.rd.width * 0.24 * (next.dir > 0 ? 1 : -1);
        } else {
          o.dir = -o.dir;
          o.t = clamp(o.t, 0.5, rs.total - 0.5);
          o.lane = -o.lane;
        }
        continue;
      }
      o.x = rs.x; o.z = rs.z;
      o.y = rs.y + o.yOff;
      o.rotY = Math.atan2(rs.tx * o.dir, rs.tz * o.dir);
      ogridMove(o);
      updateObject(o);
    }
  }
}

/* Sitting / standing people placed by hand still need to face somewhere
   sensible, and props with a spin (windmills) need a non-zero rate. */
function placePerson(x, z, pose) {
  var cfg = state.people;
  var kind = pickKind('person', state.people.place);
  if (!kind) { toast('Import a character model first', 'err'); return null; }
  var o = addObject(kind, x, z, {
    rotY: rnd() * TAU, scale: lerp(0.92, 1.1, rnd()), align: 0
  });
  if (!o) return null;
  o.rate = 1.4;
  o.y = heightAt(x, z) + o.yOff;
  updateObject(o);
  return o;
}

function actorCount() {
  var n = 0;
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.pathId || (o.roadId !== undefined && o.roadId !== null)) n++;
  }
  return n;
}
/* ==========================================================================
   24. SELECTION, GIZMO AND PREFABS
   ========================================================================== */
var Sel = { objs: [], road: null, roadPt: -1, outline: null, gizmo: null, drag: null };

function createSelectionVisuals() {
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
  Sel.gizmo = lines(1024, 998);
}

function setLines(mesh, segs) {
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

function boxEdges(cx, cy, cz, hx, hy, hz, col, out) {
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

/* ---- selection state ----------------------------------------------------- */
function clearSelection() {
  for (var i = 0; i < Sel.objs.length; i++) { Sel.objs[i].sel = false; updateObject(Sel.objs[i]); }
  Sel.objs.length = 0;
  Sel.road = null; Sel.roadPt = -1;
  refreshSelectionUI();
}
function selectObjects(list, additive) {
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
  refreshSelectionUI();
}
function selectRoad(rd) {
  clearSelection();
  Sel.road = rd;
  refreshSelectionUI();
}
function selectionCenter() {
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
function pickObject(px, py) {
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
function pickRoad(x, z) {
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
function pickRoadPoint(rd, x, z) {
  var best = -1, bd = 4.5;
  for (var i = 0; i < rd.pts.length; i++) {
    var d = Math.hypot(rd.pts[i].x - x, rd.pts[i].z - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* Screen-space rectangle select. */
var _projV = new THREE.Vector3();
function boxSelect(x0, y0, x1, y1, additive) {
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
function refreshSelectionVisuals() {
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

function gizmoScale(center) {
  return Math.max(0.6, camera.position.distanceTo(center) * 0.13);
}
function refreshGizmo() {
  var c = selectionCenter();
  if (!c || Sel.road) { Sel.gizmo.visible = false; return; }
  var s = gizmoScale(c), segs = [];
  var mode = state.sel.gizmo;
  var R = [0.92, 0.32, 0.28], G = [0.42, 0.86, 0.34], B = [0.34, 0.56, 0.94], W = [0.95, 0.95, 0.95];

  if (mode === 'move') {
    var ax = [[[1, 0, 0], R], [[0, 1, 0], G], [[0, 0, 1], B]];
    for (var i = 0; i < 3; i++) {
      var d = ax[i][0], col = ax[i][1];
      segs.push([c.x, c.y, c.z, c.x + d[0] * s, c.y + d[1] * s, c.z + d[2] * s, col]);
      var tipx = c.x + d[0] * s, tipy = c.y + d[1] * s, tipz = c.z + d[2] * s;
      var px = d[1] !== 0 ? 1 : 0, pz = d[1] !== 0 ? 0 : (d[0] !== 0 ? 0 : 1);
      var qx = d[0] !== 0 ? 0 : (d[1] !== 0 ? 0 : 1), qy = d[0] !== 0 ? 1 : 0;
      segs.push([tipx, tipy, tipz, tipx - d[0] * s * 0.22 + px * s * 0.08, tipy - d[1] * s * 0.22 + qy * s * 0.08, tipz - d[2] * s * 0.22 + pz * s * 0.08, col]);
      segs.push([tipx, tipy, tipz, tipx - d[0] * s * 0.22 - px * s * 0.08, tipy - d[1] * s * 0.22 - qy * s * 0.08, tipz - d[2] * s * 0.22 - pz * s * 0.08, col]);
    }
  } else if (mode === 'rotate') {
    for (var k = 0; k < 48; k++) {
      var a0 = k / 48 * TAU, a1 = (k + 1) / 48 * TAU;
      segs.push([c.x + Math.cos(a0) * s, c.y, c.z + Math.sin(a0) * s,
                 c.x + Math.cos(a1) * s, c.y, c.z + Math.sin(a1) * s, G]);
    }
  } else {
    boxEdges(c.x, c.y, c.z, s * 0.16, s * 0.16, s * 0.16, W, segs);
    segs.push([c.x, c.y, c.z, c.x, c.y + s, c.z, G]);
    boxEdges(c.x, c.y + s, c.z, s * 0.1, s * 0.1, s * 0.1, G, segs);
  }
  setLines(Sel.gizmo, segs);
}

/* Which gizmo handle is under the cursor, in screen space. */
function gizmoHit(px, py) {
  var c = selectionCenter();
  if (!c || Sel.road) return null;
  var s = gizmoScale(c), mode = state.sel.gizmo;
  function toScreen(x, y, z) {
    _projV.set(x, y, z).project(camera);
    return { x: (_projV.x * 0.5 + 0.5) * viewW, y: (-_projV.y * 0.5 + 0.5) * viewH };
  }
  var cs = toScreen(c.x, c.y, c.z);
  if (mode === 'move') {
    var ax = [['x', 1, 0, 0], ['y', 0, 1, 0], ['z', 0, 0, 1]];
    for (var i = 0; i < 3; i++) {
      var t = toScreen(c.x + ax[i][1] * s, c.y + ax[i][2] * s, c.z + ax[i][3] * s);
      if (Math.hypot(t.x - px, t.y - py) < 16) return { mode: 'move', axis: ax[i][0], center: c };
    }
    if (Math.hypot(cs.x - px, cs.y - py) < 15) return { mode: 'move', axis: 'xz', center: c };
  } else if (mode === 'rotate') {
    var d = Math.hypot(cs.x - px, cs.y - py);
    var edge = toScreen(c.x + s, c.y, c.z);
    var rad = Math.hypot(edge.x - cs.x, edge.y - cs.y);
    if (Math.abs(d - rad) < 18) return { mode: 'rotate', center: c, start: Math.atan2(py - cs.y, px - cs.x) };
  } else {
    var top = toScreen(c.x, c.y + s, c.z);
    if (Math.hypot(top.x - px, top.y - py) < 16 || Math.hypot(cs.x - px, cs.y - py) < 15)
      return { mode: 'scale', center: c, ref: Math.hypot(cs.x - px, cs.y - py) || 1 };
  }
  return null;
}

/* ---- transforms ---------------------------------------------------------- */
function snapshotSelection() {
  var out = [];
  for (var i = 0; i < Sel.objs.length; i++) out.push(serObj(Sel.objs[i]));
  return out;
}
function commitSelectionChange(before, label) {
  var after = snapshotSelection();
  if (!before.length) return;
  beginStroke(label || 'Transform');
  recordOp({ t: 'omod', before: before, after: after, bytes: before.length * 190 });
  endStroke();
  markSceneDirty();
}
function moveSelection(dx, dy, dz) {
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    o.x += dx; o.z += dz;
    if (dy) o.yOff += dy;
    o.y = surfaceOrTerrainY(o) + o.yOff;
    ogridMove(o);
    updateObject(o);
  }
  refreshSelectionVisuals();
  refreshSelectionUI();
}
function rotateSelection(da) {
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
  refreshSelectionUI();
}
function scaleSelection(f) {
  for (var i = 0; i < Sel.objs.length; i++) {
    var o = Sel.objs[i];
    o.scale = clamp(o.scale * f, 0.05, 20);
    updateObject(o);
  }
  refreshSelectionVisuals();
  refreshSelectionUI();
}
function deleteSelection() {
  if (Sel.road) { deleteRoad(Sel.road); clearSelection(); return; }
  if (!Sel.objs.length) return;
  var list = Sel.objs.slice();
  beginStroke('Delete');
  recordObjDel(list);
  for (var i = 0; i < list.length; i++) deleteObject(list[i]);
  endStroke();
  Sel.objs.length = 0;
  refreshSelectionUI();
  toast('Deleted ' + list.length + ' object' + (list.length === 1 ? '' : 's'));
}
function duplicateSelection() {
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
  toast('Duplicated ' + made.length);
}

/* ---- prefabs ------------------------------------------------------------- */
function groupSelectionToPrefab(name) {
  if (Sel.objs.length < 1) { toast('Select some objects first', 'err'); return null; }
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
  toast('Saved "' + pf.name + '" with ' + items.length + ' objects', 'ok');
  return pf;
}
function stampPrefab(pf, x, z, rotY) {
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
/* ==========================================================================
   13. UI — one component vocabulary. Every control is built by these helpers
   so spacing, hover, focus and timing are identical everywhere.
   --------------------------------------------------------------------------
   Two lists of live controls: the ones in the settings panel, and the ones
   in whatever modal is open. Both are refreshed by refreshUI(); the modal
   list is emptied when the modal closes, so nothing accumulates.
   ========================================================================== */
var DEFAULTS = defaultState();
var UI = { controls: [], transient: [], sink: null, tipEl: null, tipTimer: 0 };

function uiPush(c) { (UI.sink || UI.controls).push(c); }

function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}
function svgIcon(path, extra) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
    (extra || 1.9) + '" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
}

/* ---- tooltips ------------------------------------------------------------ */
function initTooltips() {
  UI.tipEl = document.getElementById('tip');
  document.addEventListener('pointerover', function (e) {
    var t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) return;
    clearTimeout(UI.tipTimer);
    UI.tipTimer = setTimeout(function () { showTip(t); }, 420);
  });
  document.addEventListener('pointerout', function (e) {
    var t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) return;
    clearTimeout(UI.tipTimer);
    UI.tipEl.classList.remove('on');
  });
  window.addEventListener('pointerdown', function () {
    clearTimeout(UI.tipTimer); UI.tipEl.classList.remove('on');
  }, true);
}
function showTip(t) {
  var e = UI.tipEl;
  var key = t.getAttribute('data-key');
  e.innerHTML = '';
  e.appendChild(document.createTextNode(t.getAttribute('data-tip')));
  if (key) {
    var k = el('span', 'k');
    k.textContent = key;
    e.appendChild(k);
  }
  e.classList.add('on');
  var r = t.getBoundingClientRect(), er = e.getBoundingClientRect();
  var x = r.left + r.width / 2 - er.width / 2;
  var y = r.top - er.height - 10;
  if (y < 6) y = r.bottom + 10;
  e.style.left = clamp(x, 8, window.innerWidth - er.width - 8) + 'px';
  e.style.top = y + 'px';
}

/* ---- toasts -------------------------------------------------------------- */
/* Pass an id to reuse the same toast instead of stacking a new one — used by
   readouts that fire repeatedly, like fly speed while scrolling. */
var _toastById = {};
function toast(msg, kind, ms, id) {
  var host = document.getElementById('toasts');
  if (id && _toastById[id] && _toastById[id].parentNode) {
    var ex = _toastById[id];
    ex.textContent = msg;
    clearTimeout(ex._t);
    ex._t = setTimeout(function () {
      ex.style.transition = 'opacity 200ms';
      ex.style.opacity = '0';
      setTimeout(function () { ex.remove(); delete _toastById[id]; }, 220);
    }, ms || 2400);
    return ex;
  }
  var t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  host.appendChild(t);
  if (id) _toastById[id] = t;
  t._t = setTimeout(function () {
    t.style.transition = 'opacity 200ms';
    t.style.opacity = '0';
    setTimeout(function () { t.remove(); if (id) delete _toastById[id]; }, 220);
  }, ms || 2400);
  return t;
}

/* ---- modal --------------------------------------------------------------- */
var _modal = null;
function openModal(title, buildBody, actions, opts) {
  closeModal();
  var scrim = el('div', 'scrim');
  var m = el('div', 'modal' + (opts && opts.wide ? ' wide-modal' : ''));
  var head = el('div', 'modal-head');
  head.appendChild(el('b', null, title));
  var x = el('button', 'btn icon ghost');
  x.innerHTML = svgIcon('<path d="M18 6 6 18M6 6l12 12"/>');
  x.setAttribute('data-tip', 'Close');
  x.onclick = closeModal;
  head.appendChild(x);
  var body = el('div', 'modal-body');

  UI.transient.length = 0;
  UI.sink = UI.transient;
  buildBody(body);
  UI.sink = null;

  if (actions && actions.length) {
    var row = el('div', 'btn-row');
    actions.forEach(function (a) {
      var b = el('button', 'btn' + (a.kind ? ' ' + a.kind : ''), a.label);
      b.onclick = function () { closeModal(); a.run && a.run(); };
      row.appendChild(b);
    });
    body.appendChild(row);
  }
  m.appendChild(head); m.appendChild(body); scrim.appendChild(m);
  scrim.addEventListener('pointerdown', function (e) { if (e.target === scrim) closeModal(); });
  document.body.appendChild(scrim);
  _modal = scrim;
}
function closeModal() {
  if (!_modal) return;
  _modal.remove(); _modal = null;
  UI.sink = null; UI.transient.length = 0;
}

function confirmDialog(title, message, okLabel, run) {
  openModal(title, function (b) {
    b.appendChild(el('p', null, message));
  }, [
    { label: 'Cancel' },
    { label: okLabel, kind: 'dgr', run: run }
  ]);
}

/* ---- change dispatcher --------------------------------------------------- */
function applyChange(tags) {
  if (!tags) { markSceneDirty(); return; }
  if (tags.indexOf('template') >= 0) rebuildBladeTemplate();
  if (tags.indexOf('plate') >= 0) rebuildPlate();
  if (tags.indexOf('grass') >= 0) syncGrassUniforms();
  if (tags.indexOf('ground') >= 0) syncGroundUniforms();
  if (tags.indexOf('env') >= 0) syncEnvUniforms();
  if (tags.indexOf('dens') >= 0) { Dens.dirty = true; }
  if (tags.indexOf('water') >= 0) rebuildWater();
  if (tags.indexOf('roads') >= 0) rebuildAllRoads();
  markSceneDirty();
}

/* ---- layout blocks -------------------------------------------------------
   A group is a titled run of controls. There is no accordion any more: a mode
   shows what it needs, and everything else is behind one "All settings" line.
   -------------------------------------------------------------------------- */
function addGroup(host, title) {
  var g = el('div', 'group');
  if (title) g.appendChild(el('div', 'group-title wide', title));
  var body = el('div');
  g.appendChild(body);
  host.appendChild(g);
  return body;
}
function addNote(host, text) {
  var n = el('div', 'note');
  n.innerHTML = text;
  host.appendChild(n);
  return n;
}

/* ---- controls bind either to a state path or to an explicit get/set pair -- */
function ctrlGet(cfg) { return cfg.get ? cfg.get() : getPath(state, cfg.path); }
function ctrlSet(cfg, v) { if (cfg.set) cfg.set(v); else setPath(state, cfg.path, v); }

/* ---- SLIDER --------------------------------------------------------------
   Drag anywhere on the track, shift-drag for fine control, double-click to
   reset to the default, and direct numeric entry in the value box.
   -------------------------------------------------------------------------- */
function addSlider(parent, cfg) {
  var def = (cfg.def !== undefined) ? cfg.def : (cfg.path ? getPath(DEFAULTS, cfg.path) : ctrlGet(cfg));
  var dec = (cfg.dec === undefined) ? 2 : cfg.dec;
  var unit = cfg.unit || '';

  var row = el('div', 'ctrl');
  var top = el('div', 'ctrl-top');
  var lab = el('div', 'ctrl-label', cfg.label);
  var val = el('input', 'ctrl-val');
  val.type = 'text'; val.spellcheck = false;
  top.appendChild(lab); top.appendChild(val);

  var sl = el('div', 'slider');
  var trk = el('div', 'trk'), fill = el('div', 'fill'), knob = el('div', 'knob');
  sl.appendChild(trk); sl.appendChild(fill); sl.appendChild(knob);
  row.appendChild(top); row.appendChild(sl);
  parent.appendChild(row);

  row.setAttribute('data-tip', cfg.tip || cfg.label);
  if (cfg.key) row.setAttribute('data-key', cfg.key);

  function fmt(v) { return cfg.format ? cfg.format(v) : (v.toFixed(dec) + unit); }
  function paint() {
    var v = ctrlGet(cfg);
    var t = clamp((v - cfg.min) / (cfg.max - cfg.min), 0, 1);
    fill.style.width = (t * 100) + '%';
    knob.style.left = (t * 100) + '%';
    if (document.activeElement !== val) val.value = fmt(v);
  }
  function commit(v) {
    v = clamp(v, cfg.min, cfg.max);
    if (cfg.step) v = Math.round(v / cfg.step) * cfg.step;
    v = clamp(v, cfg.min, cfg.max);
    var cur = ctrlGet(cfg);
    if (v === cur) { paint(); return; }
    ctrlSet(cfg, v);
    paint();
    applyChange(cfg.apply);
    if (cfg.onChange) cfg.onChange(v);
  }
  function fromX(cx) {
    var r = sl.getBoundingClientRect();
    commit(cfg.min + clamp((cx - r.left) / r.width, 0, 1) * (cfg.max - cfg.min));
  }

  var dragging = false, lastX = 0;
  sl.addEventListener('pointerdown', function (e) {
    dragging = true; lastX = e.clientX;
    sl.setPointerCapture(e.pointerId);
    sl.classList.add('act');
    if (!e.shiftKey) fromX(e.clientX);
    e.preventDefault(); e.stopPropagation();
  });
  sl.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    if (e.shiftKey) {
      sl.classList.add('fine');
      var w = sl.getBoundingClientRect().width || 1;
      commit(ctrlGet(cfg) + (e.clientX - lastX) / w * (cfg.max - cfg.min) * 0.16);
    } else {
      sl.classList.remove('fine');
      fromX(e.clientX);
    }
    lastX = e.clientX;
  });
  function stop(e) {
    if (!dragging) return;
    dragging = false;
    sl.classList.remove('act', 'fine');
    try { sl.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  sl.addEventListener('pointerup', stop);
  sl.addEventListener('pointercancel', stop);
  sl.addEventListener('dblclick', function () { commit(def); toast(cfg.label + ' back to normal'); });

  val.addEventListener('focus', function () { val.select(); });
  val.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { val.blur(); }
    else if (e.key === 'Escape') { paint(); val.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      var s = (cfg.step || (cfg.max - cfg.min) / 100) * (e.shiftKey ? 10 : 1);
      commit(ctrlGet(cfg) + (e.key === 'ArrowUp' ? s : -s));
      e.preventDefault();
    }
    e.stopPropagation();
  });
  val.addEventListener('blur', function () {
    var n = parseFloat(String(val.value).replace(/[^0-9.+-eE]/g, ''));
    if (isFinite(n)) commit(n); else paint();
  });

  uiPush({ refresh: paint });
  paint();
  return row;
}

/* ---- SELECT --------------------------------------------------------------- */
function addSelect(parent, cfg) {
  var row = el('div', 'ctrl');
  if (cfg.label) {
    var top = el('div', 'ctrl-top');
    top.appendChild(el('div', 'ctrl-label', cfg.label));
    row.appendChild(top);
  }
  var wrap = el('div', 'sel');
  var s = el('select');
  cfg.options.forEach(function (o) {
    var op = el('option', null, o.label);
    op.value = o.value;
    s.appendChild(op);
  });
  wrap.appendChild(s);
  wrap.insertAdjacentHTML('beforeend', svgIcon('<path d="m6 9 6 6 6-6"/>', 2));
  row.appendChild(wrap);
  parent.appendChild(row);
  row.setAttribute('data-tip', cfg.tip || cfg.label);

  function paint() { s.value = String(ctrlGet(cfg)); }
  s.addEventListener('change', function () {
    ctrlSet(cfg, s.value);
    applyChange(cfg.apply);
    if (cfg.onChange) cfg.onChange(s.value);
    refreshUI();
  });
  uiPush({ refresh: paint });
  paint();
  return row;
}

/* ---- SEGMENTED ------------------------------------------------------------ */
function addSegment(parent, cfg) {
  var row = el('div', 'ctrl');
  if (cfg.label) {
    var top = el('div', 'ctrl-top');
    top.appendChild(el('div', 'ctrl-label', cfg.label));
    row.appendChild(top);
  }
  var seg = el('div', 'seg');
  var btns = cfg.options.map(function (o) {
    var b = el('button', null, o.label);
    b.setAttribute('data-tip', o.tip || o.label);
    b.onclick = function () {
      ctrlSet(cfg, o.value);
      applyChange(cfg.apply);
      if (cfg.onChange) cfg.onChange(o.value);
      refreshUI();
    };
    seg.appendChild(b);
    return { b: b, v: o.value };
  });
  row.appendChild(seg);
  parent.appendChild(row);
  function paint() {
    var v = String(ctrlGet(cfg));
    btns.forEach(function (x) { x.b.setAttribute('aria-pressed', String(x.v) === v ? 'true' : 'false'); });
  }
  uiPush({ refresh: paint });
  paint();
  return row;
}

/* ---- CHIPS ---------------------------------------------------------------
   A wrapping row of named choices. Used where the options have real names
   worth reading — landforms, grass looks — rather than numbers to dial in.
   -------------------------------------------------------------------------- */
function addChips(parent, cfg) {
  var row = el('div', 'ctrl');
  if (cfg.label) {
    var top = el('div', 'ctrl-top');
    top.appendChild(el('div', 'ctrl-label', cfg.label));
    row.appendChild(top);
  }
  var wrap = el('div', 'chips');
  var btns = cfg.options.map(function (o) {
    var b = el('button', 'chip');
    if (o.swatch) {
      var sw = el('i');
      sw.style.background = o.swatch;
      b.appendChild(sw);
    }
    b.appendChild(document.createTextNode(o.label));
    b.setAttribute('data-tip', o.tip || o.label);
    b.onclick = function () {
      if (cfg.path || cfg.set) ctrlSet(cfg, o.value);
      applyChange(cfg.apply);
      if (cfg.onChange) cfg.onChange(o.value);
      refreshUI();
    };
    wrap.appendChild(b);
    return { b: b, v: o.value };
  });
  row.appendChild(wrap);
  parent.appendChild(row);
  function paint() {
    if (!cfg.path && !cfg.get) return;
    var v = String(ctrlGet(cfg));
    btns.forEach(function (x) { x.b.setAttribute('aria-pressed', String(x.v) === v ? 'true' : 'false'); });
  }
  uiPush({ refresh: paint });
  paint();
  return row;
}

/* ---- TOGGLE ---------------------------------------------------------------- */
function addToggle(parent, cfg) {
  var row = el('div', 'ctrl row');
  row.appendChild(el('div', 'ctrl-label', cfg.label));
  var t = el('button', 'tgl');
  row.appendChild(t);
  parent.appendChild(row);
  row.setAttribute('data-tip', cfg.tip || cfg.label);
  if (cfg.key) row.setAttribute('data-key', cfg.key);
  function paint() { t.setAttribute('aria-pressed', ctrlGet(cfg) ? 'true' : 'false'); }
  t.onclick = function () {
    ctrlSet(cfg, !ctrlGet(cfg));
    paint();
    applyChange(cfg.apply);
    if (cfg.onChange) cfg.onChange(ctrlGet(cfg));
  };
  uiPush({ refresh: paint });
  paint();
  return row;
}

/* ---- COLOUR ---------------------------------------------------------------- */
function addColor(parent, cfg) {
  var row = el('div', 'ctrl');
  var top = el('div', 'ctrl-top');
  top.appendChild(el('div', 'ctrl-label', cfg.label));
  row.appendChild(top);
  var c = el('div', 'col');
  var sw = el('div', 'sw');
  var inp = el('input'); inp.type = 'color';
  sw.appendChild(inp);
  var hex = el('input', 'hex'); hex.type = 'text'; hex.spellcheck = false;
  c.appendChild(sw); c.appendChild(hex);
  row.appendChild(c);
  parent.appendChild(row);
  row.setAttribute('data-tip', cfg.tip || cfg.label);

  function paint() {
    var v = ctrlGet(cfg);
    inp.value = v;
    if (document.activeElement !== hex) hex.value = v.toUpperCase();
    sw.style.background = v;
  }
  function commit(v) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(v) && !/^#?[0-9a-fA-F]{3}$/.test(v)) { paint(); return; }
    if (v[0] !== '#') v = '#' + v;
    if (v.length === 4) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    ctrlSet(cfg, v.toLowerCase());
    paint();
    applyChange(cfg.apply);
    if (cfg.onChange) cfg.onChange(v);
  }
  inp.addEventListener('input', function () { commit(inp.value); });
  hex.addEventListener('keydown', function (e) { if (e.key === 'Enter') hex.blur(); e.stopPropagation(); });
  hex.addEventListener('blur', function () { commit(hex.value.trim()); });
  uiPush({ refresh: paint });
  paint();
  return row;
}

/* ---- WIND DIAL -------------------------------------------------------------- */
function addDial(parent, cfg) {
  var wrap = el('div', 'dial');
  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  var rim = document.createElementNS(NS, 'circle');
  rim.setAttribute('cx', 50); rim.setAttribute('cy', 50); rim.setAttribute('r', 46);
  rim.setAttribute('class', 'dial-rim');
  svg.appendChild(rim);
  for (var a = 0; a < 12; a++) {
    var t = document.createElementNS(NS, 'line');
    var ang = a / 12 * TAU, r0 = a % 3 === 0 ? 32 : 38;
    t.setAttribute('x1', 50 + Math.sin(ang) * r0); t.setAttribute('y1', 50 - Math.cos(ang) * r0);
    t.setAttribute('x2', 50 + Math.sin(ang) * 42); t.setAttribute('y2', 50 - Math.cos(ang) * 42);
    t.setAttribute('class', 'dial-tick');
    svg.appendChild(t);
  }
  var arrow = document.createElementNS(NS, 'polygon');
  arrow.setAttribute('class', 'dial-arrow');
  svg.appendChild(arrow);
  var hub = document.createElementNS(NS, 'circle');
  hub.setAttribute('cx', 50); hub.setAttribute('cy', 50); hub.setAttribute('r', 6);
  hub.setAttribute('class', 'dial-hub');
  svg.appendChild(hub);

  var info = el('div', 'dial-info');
  wrap.appendChild(svg); wrap.appendChild(info);
  parent.appendChild(wrap);
  svg.setAttribute('data-tip', cfg.tip || 'Drag to point the wind somewhere else');

  addSlider(info, {
    label: cfg.label, path: cfg.path, min: 0, max: 360, step: 1, dec: 0, unit: '°',
    tip: cfg.tip, apply: cfg.apply, onChange: function () { paint(); }
  });
  if (cfg.extra) cfg.extra(info);

  function paint() {
    var deg = ctrlGet(cfg), r = deg * DEG;
    var sx = Math.sin(r), sy = -Math.cos(r);
    var px = 50 + sx * 30, py = 50 + sy * 30;
    var bx = 50 - sx * 12, by = 50 - sy * 12;
    var ox = -sy * 8, oy = sx * 8;
    arrow.setAttribute('points',
      px + ',' + py + ' ' + (bx + ox) + ',' + (by + oy) + ' ' + (bx - ox) + ',' + (by - oy));
  }
  var drag = false;
  function fromEvent(e) {
    var r = svg.getBoundingClientRect();
    var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    var deg = (Math.atan2(dx, -dy) / DEG + 360) % 360;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    setPath(state, cfg.path, Math.round(deg) % 360);
    paint(); refreshUI(); applyChange(cfg.apply);
  }
  svg.addEventListener('pointerdown', function (e) {
    drag = true; svg.setPointerCapture(e.pointerId); fromEvent(e); e.preventDefault();
  });
  svg.addEventListener('pointermove', function (e) { if (drag) fromEvent(e); });
  svg.addEventListener('pointerup', function (e) {
    drag = false; try { svg.releasePointerCapture(e.pointerId); } catch (x) {}
  });
  uiPush({ refresh: paint });
  paint();
}

/* ---- button rows ----------------------------------------------------------- */
function addButtons(parent, list) {
  var row = el('div', 'btn-row');
  list.forEach(function (b) {
    var e2 = el('button', 'btn' + (b.kind ? ' ' + b.kind : ''));
    if (b.icon) e2.innerHTML = svgIcon(b.icon);
    e2.appendChild(document.createTextNode(b.label));
    e2.setAttribute('data-tip', b.tip || b.label);
    if (b.key) e2.setAttribute('data-key', b.key);
    if (b.id) e2.id = b.id;
    e2.onclick = b.run;
    row.appendChild(e2);
  });
  parent.appendChild(row);
  return row;
}

function refreshUI() {
  var i;
  for (i = 0; i < UI.controls.length; i++) UI.controls[i].refresh();
  for (i = 0; i < UI.transient.length; i++) UI.transient[i].refresh();
}
/* ==========================================================================
   25. ICONS, THUMBNAILS, LAYER LIST, THE TOUR AND THE TOP BAR
   ========================================================================== */

var ICON = {
  raise:   '<path d="M12 20V6"/><path d="m5 12 7-7 7 7"/><path d="M3 22h18"/>',
  lower:   '<path d="M12 4v14"/><path d="m5 12 7 7 7-7"/><path d="M3 22h18"/>',
  smooth:  '<path d="M3 14c3 0 3-6 6-6s3 6 6 6 3-6 6-6"/><path d="M3 20h18"/>',
  flatten: '<path d="M3 10h18"/><path d="M6 16h12"/><path d="M3 20h18"/>',
  ramp:    '<path d="M3 20h18"/><path d="M4 18 18 6"/><path d="M18 6v12"/>',
  noise:   '<path d="m3 17 3-6 3 4 3-8 3 10 3-5 3 5"/>',
  erode:   '<path d="M4 5v6c0 5 3 8 8 8s8-3 8-8V5"/><path d="M8 5v5M16 5v5"/>',
  place:   '<path d="M12 21s7-5.5 7-11a7 7 0 0 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  brush:   '<path d="M9.5 14.5 3 21"/><path d="m6 18 1.6-4.2a3 3 0 0 1 .7-1.1l7-7a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3l-7 7a3 3 0 0 1-1.1.7Z"/>',
  scatter: '<circle cx="6" cy="7" r="2"/><circle cx="17" cy="5.5" r="1.6"/><circle cx="12" cy="13" r="2.2"/><circle cx="19" cy="16" r="1.8"/><circle cx="6.5" cy="18" r="1.7"/>',
  eraser:  '<path d="m5.5 14.5 4 4h9"/><path d="M13.4 3.6 3.6 13.4a2 2 0 0 0 0 2.8l4.2 4.2a2 2 0 0 0 2.8 0l9.8-9.8a2 2 0 0 0 0-2.8l-4.2-4.2a2 2 0 0 0-2.8 0Z"/>',
  dropper: '<path d="m11 9 4 4"/><path d="M17.5 2.5a2.1 2.1 0 0 1 3 3l-1.9 1.9 1 1a1.5 1.5 0 0 1 0 2.1l-.7.7-5.1-5.1.7-.7a1.5 1.5 0 0 1 2.1 0l1-1Z"/><path d="m13.8 8.2-8 8a2 2 0 0 0-.5.9L4.5 20l3-.8a2 2 0 0 0 .9-.5l8-8"/>',
  arrow:   '<path d="m4 4 7 16 2.2-6.8L20 11Z"/>',
  eye:     '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeoff:  '<path d="M4 4 20 20"/><path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4"/><path d="M6.3 8A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.9 9.9 0 0 0 3.5-.6"/>',
  lock:    '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock:  '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7.5-1.9"/>',
  check:   '<path d="m4 12 5 5L20 6"/>',
  plus:    '<path d="M12 5v14M5 12h14"/>',
  play:    '<path d="M7 4.5v15l13-7.5Z"/>',
  pause:   '<path d="M8 4.5v15M16 4.5v15"/>',
  wand:    '<path d="m5 19 9-9"/><path d="m15 5 1.2 2.8L19 9l-2.8 1.2L15 13l-1.2-2.8L11 9l2.8-1.2Z"/><path d="M4 5h2M5 4v2M18 17h2M19 16v2"/>',
  trash:   '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  copy:    '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  frame:   '<path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4"/>',
  people:  '<circle cx="9" cy="6" r="3"/><path d="M3 21v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2"/><path d="M17 8.5a2.5 2.5 0 1 0 0-5"/><path d="M17 13a4 4 0 0 1 4 4v4"/>'
};
var FRAME_ICON = ICON.frame;

/* --------------------------------------------------------------------------
   STATION GLYPHS — the signature.
   Every one is drawn in the same 44×26 frame with the same ground line at
   y = 21, so the four stations stack into strata of one continuous ground:
   whichever one you are at, you are working on the same piece of earth.
   -------------------------------------------------------------------------- */
function stationGlyph(form) {
  return '<svg viewBox="0 0 44 26" fill="none" stroke="currentColor" ' +
         'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
         '<path class="ground" d="M2 21h40"/>' +
         '<g class="form">' + form + '</g></svg>';
}
var STATION_FORM = {
  /* a hill rising off the ground */
  terrain: '<path d="M6 21 15 9l6 7 6-10 10 15"/>',
  /* blades standing on it */
  grass:   '<path d="M11 21c0-4 .8-7 2.6-9.5"/><path d="M18 21c0-6 1.2-10.5 3.4-13.5"/>' +
           '<path d="M25 21c0-5 .9-8.5 2.4-10.8"/><path d="M32 21c0-6.5 1.2-10.5 3-13"/>',
  /* something set down on it */
  place:   '<path d="M15 21v-8l7-4 7 4v8"/><path d="M20 21v-5h4v5"/>',
  /* something on it, picked out */
  select:  '<path d="M18 21v-5l4-2.4 4 2.4v5"/>' +
           '<path d="M9 11V6h5"/><path d="M30 6h5v5"/><path d="M9 16v5h5"/><path d="M35 16v5h-5"/>'
};

/* ==========================================================================
   THUMBNAILS — models are rendered with the real object shader into a small
   render target, so the picker shows exactly what will be placed.
   ========================================================================== */
var Thumbs = { rt: null, scene: null, cam: null, cache: {}, size: 128 };

function initThumbs() {
  Thumbs.rt = new THREE.WebGLRenderTarget(Thumbs.size, Thumbs.size, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat
  });
  Thumbs.scene = new THREE.Scene();
  Thumbs.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 400);
}

/* Fixed studio lighting so a thumbnail stays readable whatever the time of
   day is in the scene, and no fog so it is not washed out. */
function thumbMaterial(def, part) {
  var u = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: 0 }, uWindSpeed: { value: 0 }, uTurbulence: { value: 0 },
    uWaveScale: { value: 0.1 }, uGustScale: { value: 0.1 }, uGustSpeed: { value: 0 }, uGustStrength: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.72, 0.53).normalize() },
    uSunColor: { value: new THREE.Vector3(1.3, 1.26, 1.18) },
    uSkyColor: { value: new THREE.Vector3(0.38, 0.44, 0.54) },
    uGroundColor: { value: new THREE.Vector3(0.14, 0.14, 0.13) },
    uAmbient: { value: 1 }, uExposure: { value: 1.05 },
    uFogColor: { value: new THREE.Vector3() }, uFogDensity: { value: 0 },
    uDrawDist: { value: 1e6 }, uFadeK: { value: 1 }, uAnimDist: { value: 0 },
    uSimulate: { value: 0 }, uGhost: { value: 0 },
    uModelH: { value: Math.max(def.height, 0.001) },
    uMap: { value: part.tex || null },
    uHasMap: { value: part.tex ? 1 : 0 },
    uAlphaTest: { value: part.alphaTest || 0 },
    uColor: { value: new THREE.Vector3(part.color[0], part.color[1], part.color[2]) }
  };
  return new THREE.ShaderMaterial({
    vertexShader: IMP_VS, fragmentShader: IMP_FS, uniforms: u,
    side: THREE.DoubleSide, transparent: true
  });
}

/* Renders the model exactly as it will appear when placed — one draw per
   merged material, same shader as the world. */
function renderThumb(kind, canvas) {
  var def = ASSETS[kind];
  if (!def || !def.parts || !def.parts.length) return;
  var meshes = [], mats = [];
  for (var p = 0; p < def.parts.length; p++) {
    var part = def.parts[p], base = part.geo;
    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('normal', base.attributes.normal);
    g.setAttribute('uv', base.attributes.uv);
    if (base.index) g.setIndex(base.index);
    var d = { iPosSeed: [0, 0, 0, 0.5], iQuat: [0, 0, 0, 1], iSclSway: [1, 1, 1, 0],
              iTint: [1, 1, 1], iAnim: [0, 0, 0, 0] };
    for (var n in d) g.setAttribute(n, new THREE.InstancedBufferAttribute(new Float32Array(d[n]), d[n].length));
    g.instanceCount = 1;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    var mat = thumbMaterial(def, part);
    var mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    Thumbs.scene.add(mesh);
    meshes.push(mesh); mats.push(mat);
  }

  var r = Math.max(def.size ? Math.max(def.size[0], def.size[1], def.size[2]) : def.height, 0.2) * 0.62 + 0.15;
  var cy = def.height * 0.5;
  var c = Thumbs.cam;
  c.left = -r; c.right = r; c.top = r; c.bottom = -r;
  c.position.set(r * 1.6, cy + r * 1.15, r * 2.0);
  c.lookAt(0, cy, 0);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();

  var prev = renderer.getRenderTarget();
  renderer.setRenderTarget(Thumbs.rt);
  renderer.setClearColor(0x241F17, 1);
  renderer.clear();
  renderer.render(Thumbs.scene, c);
  var buf = new Uint8Array(Thumbs.size * Thumbs.size * 4);
  renderer.readRenderTargetPixels(Thumbs.rt, 0, 0, Thumbs.size, Thumbs.size, buf);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(0x000000, 1);
  for (var m = 0; m < meshes.length; m++) {
    Thumbs.scene.remove(meshes[m]);
    meshes[m].geometry.dispose();
    mats[m].dispose();
  }

  canvas.width = Thumbs.size; canvas.height = Thumbs.size;
  var ctx = canvas.getContext('2d');
  var img = ctx.createImageData(Thumbs.size, Thumbs.size);
  // readRenderTargetPixels is bottom-up; flip into the canvas
  for (var y = 0; y < Thumbs.size; y++) {
    var src = (Thumbs.size - 1 - y) * Thumbs.size * 4;
    img.data.set(buf.subarray(src, src + Thumbs.size * 4), y * Thumbs.size * 4);
  }
  ctx.putImageData(img, 0, 0);
}

/* A group of objects saved as one stamp has no single mesh to render. */
function drawGroupSwatch(canvas) {
  canvas.width = 128; canvas.height = 128;
  var g = canvas.getContext('2d');
  g.fillStyle = '#241F17'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#FFB43D'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(22, 96); g.lineTo(106, 96); g.stroke();
  g.beginPath();
  g.moveTo(34, 96); g.lineTo(34, 62); g.lineTo(52, 48); g.lineTo(70, 62); g.lineTo(70, 96);
  g.stroke();
  g.beginPath(); g.moveTo(88, 96); g.lineTo(88, 70); g.stroke();
  g.beginPath(); g.arc(88, 60, 12, 0, Math.PI * 2); g.stroke();
}

/* Templates set a road type before laying track; the roads engine reads these. */
function applyRoadTypeDefaults() {
  var t = ROAD_TYPES[state.road.type];
  if (!t) return;
  state.road.width = t.width;
  state.road.material = t.material;
  state.road.markings = t.markings;
  state.road.sidewalkL = t.sw;
  state.road.sidewalkR = t.sw;
}

/* ==========================================================================
   LAYER LIST — lives in the World sheet
   ========================================================================== */
function buildLayerList(host) {
  var wrap = el('div');
  host.appendChild(wrap);
  function paint() {
    wrap.innerHTML = '';
    var counts = objectCounts();
    CATS.forEach(function (c) {
      var st = LayerState[c];
      var row = el('div', 'layer' + (st.vis ? '' : ' off'));
      var sw = el('div', 'sw'); sw.style.background = CAT_COLOR[c];
      row.appendChild(sw);
      row.appendChild(el('div', 'nm', c.charAt(0).toUpperCase() + c.slice(1)));
      var n = c === 'grass' ? Grass.count : (c === 'roads' ? World.roads.length : (counts[c] === undefined ? '' : counts[c]));
      row.appendChild(el('div', 'ct', n === '' ? '' : fmtInt(n)));

      var vb = el('button', 'ic');
      vb.innerHTML = svgIcon(st.vis ? ICON.eye : ICON.eyeoff);
      vb.setAttribute('data-tip', st.vis ? 'Hide this layer' : 'Show this layer');
      vb.onclick = function () { st.vis = !st.vis; applyLayerVisibility(); paint(); markSceneDirty(); };
      row.appendChild(vb);

      var lb = el('button', 'ic');
      lb.innerHTML = svgIcon(st.lock ? ICON.lock : ICON.unlock);
      lb.setAttribute('aria-pressed', st.lock ? 'true' : 'false');
      lb.setAttribute('data-tip', st.lock ? 'Unlock — brushes and clicks can touch it again' : 'Lock — brushes and clicks pass straight through');
      lb.onclick = function () { st.lock = !st.lock; paint(); markSceneDirty(); };
      row.appendChild(lb);

      wrap.appendChild(row);
    });
  }
  paint();
  uiPush({ refresh: paint });
  return paint;
}

/* ==========================================================================
   THE TOUR
   --------------------------------------------------------------------------
   A spotlight and a card. The scrim is the spotlight's own box-shadow and
   nothing in the overlay takes pointer events except the card, so every step
   can be tried for real while it is still on screen. Steps that can be tried
   watch for it and move on by themselves.
   ========================================================================== */
var Tour = { i: -1, timer: 0, mark: 0, flew: false, on: false };

var TOUR = [
  {
    title: 'Let’s build a world',
    body: 'Four stations run down the left edge. You shape the <b>ground</b>, plant <b>grass</b> on it, ' +
          '<b>place</b> things on top, and <b>select</b> anything you want to move. That is the whole tool.',
    target: null
  },
  {
    title: 'Fly around first',
    body: 'Hold the <b>right mouse button</b> and move the mouse to look around. ' +
          '<b>W A S D</b> flies, <b>E</b> goes up, <b>Q</b> goes down. Roll the wheel while looking to fly faster or slower.',
    target: function () { return document.getElementById('stage'); },
    hint: 'Try it — hold right-click and look around',
    done: function () {
      if (Ptr.mode === 'look' || Keys.move.f || Keys.move.b || Keys.move.l || Keys.move.r) Tour.flew = true;
      return Tour.flew;
    }
  },
  {
    title: 'Shape the ground',
    body: 'Pick <b>Raise</b> and drag on the ground to push a hill up. Hold <b>Alt</b> while you drag to dig down instead. ' +
          '<b>Smooth</b> and <b>Flatten</b> settle it back again.',
    mode: 'terrain',
    target: function () { return document.querySelector('#rail .station'); },
    hint: 'Try it — drag on the ground',
    done: function () { return History.undo.length > Tour.mark; }
  },
  {
    title: 'The settings follow the station',
    body: 'Each station puts only its own controls here — the handful you actually reach for. ' +
          '<b>All settings</b> at the bottom opens everything else when you want it.',
    target: function () { return document.getElementById('panel'); }
  },
  {
    title: 'Paint the grass',
    body: 'Drag to plant grass, hold <b>Alt</b> to rub it out. The row of names under <b>Look</b> swaps the whole ' +
          'field between a lawn, a meadow, wheat and more.',
    mode: 'grass',
    target: function () { return document.querySelectorAll('#rail .station')[1]; },
    hint: 'Try it — drag on the ground',
    done: function () { return History.undo.length > Tour.mark; }
  },
  {
    title: 'Put things in it',
    body: 'Everything you can place — houses, trees, people, cars — comes from Sketchfab. Press <b>Add models</b>, ' +
          'search, pick one, then click on the ground. Put something in the wrong spot? The <b>Select</b> station ' +
          'moves and deletes it.',
    mode: 'place',
    target: function () { return document.querySelectorAll('#rail .station')[2]; }
  },
  {
    title: 'The world itself',
    body: 'Time of day, water, ground colour, quality and layers belong to the whole world, so they live here ' +
          'rather than in any one station.',
    target: function () { return document.getElementById('sun-btn'); }
  },
  {
    title: 'That’s everything',
    body: 'Your world saves itself into this browser as you go. <b>Save</b> writes a file you can keep or send to ' +
          'someone. <b>New world</b> starts you off from a finished scene. Press <b>?</b> any time for the key list.',
    target: function () { return document.getElementById('b-save'); }
  }
];

function startTour(from) {
  closeModal();
  Tour.i = (from || 0) - 1;
  Tour.on = true;
  Tour.flew = false;
  document.getElementById('tour').classList.add('on');
  clearInterval(Tour.timer);
  Tour.timer = setInterval(tourPoll, 350);
  window.addEventListener('resize', paintTour);
  tourGo(1);
}
function endTour() {
  Tour.on = false;
  clearInterval(Tour.timer);
  window.removeEventListener('resize', paintTour);
  document.getElementById('tour').classList.remove('on');
  state.world.seenIntro = true;
  markSceneDirty();
}
function tourGo(dir) {
  var next = Tour.i + dir;
  if (next < 0) next = 0;
  if (next >= TOUR.length) { endTour(); toast('Have fun. Press ? for the key list.', 'ok', 3600); return; }
  Tour.i = next;
  var s = TOUR[Tour.i];
  if (s.mode && state.world.mode !== s.mode) setMode(s.mode);
  Tour.mark = History.undo.length;
  drawTourCard();
  paintTour();
}
/* The card is rebuilt only when the step changes; the poll just re-measures,
   so hovering Next does not flicker under it. */
function tourPoll() {
  if (!Tour.on) return;
  var s = TOUR[Tour.i];
  if (s && s.done && s.done()) { tourGo(1); return; }
  paintTour();
}

function drawTourCard() {
  var s = TOUR[Tour.i];
  var card = document.getElementById('tour-card');
  card.innerHTML = '';
  card.appendChild(el('div', 'step-no num', (Tour.i + 1) + ' of ' + TOUR.length));
  card.appendChild(el('h3', 'wide', s.title));
  if (s.hint) card.appendChild(el('div', 'live', s.hint));
  var p = el('p');
  p.innerHTML = s.body;
  card.appendChild(p);

  var foot = el('div', 'tour-foot');
  var dots = el('div');
  dots.id = 'tour-dots';
  for (var i = 0; i < TOUR.length; i++) {
    var d = el('i');
    if (i === Tour.i) d.className = 'on';
    dots.appendChild(d);
  }
  foot.appendChild(dots);
  foot.appendChild(el('div', 'grow'));
  if (Tour.i > 0) {
    var back = el('button', 'btn ghost', 'Back');
    back.onclick = function () { tourGo(-1); };
    foot.appendChild(back);
  }
  var skip = el('button', 'btn ghost', 'Skip');
  skip.setAttribute('data-tip', 'Close the tour. The ? button brings it back.');
  skip.onclick = endTour;
  foot.appendChild(skip);
  var nx = el('button', 'btn pri', Tour.i === TOUR.length - 1 ? 'Start building' : 'Next');
  nx.onclick = function () { tourGo(1); };
  foot.appendChild(nx);
  card.appendChild(foot);
}

function paintTour() {
  if (!Tour.on) return;
  var s = TOUR[Tour.i];
  var hole = document.getElementById('tour-hole');
  var card = document.getElementById('tour-card');
  var vw = window.innerWidth, vh = window.innerHeight;

  var t = s.target ? s.target() : null;
  var r = t ? t.getBoundingClientRect() : null;
  if (r && (r.width < 2 || r.height < 2)) r = null;

  if (r) {
    var pad = 6;
    hole.classList.remove('hidden');
    hole.classList.toggle('pulse', !!s.done);
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';
  } else {
    hole.classList.add('hidden');
    hole.classList.remove('pulse');
    hole.style.left = (vw / 2) + 'px';
    hole.style.top = (vh / 2) + 'px';
    hole.style.width = '0px';
    hole.style.height = '0px';
  }

  // beside the spotlight if it fits, otherwise under it, and dead centre
  // when there is nothing to point at
  var cw = card.offsetWidth || 330, ch = card.offsetHeight || 220, gap = 18;
  var x, y;
  if (!r) {
    x = (vw - cw) / 2; y = (vh - ch) / 2;
  } else if (r.right + gap + cw < vw - 12) {
    x = r.right + gap; y = r.top;
  } else if (r.left - gap - cw > 12) {
    x = r.left - gap - cw; y = r.top;
  } else if (r.bottom + gap + ch < vh - 12) {
    x = r.left + r.width / 2 - cw / 2; y = r.bottom + gap;
  } else {
    x = r.left + r.width / 2 - cw / 2; y = r.top - gap - ch;
  }
  card.style.left = Math.round(clamp(x, 12, Math.max(12, vw - cw - 12))) + 'px';
  card.style.top = Math.round(clamp(y, 12, Math.max(12, vh - ch - 12))) + 'px';
}

/* ==========================================================================
   TOP BAR
   ========================================================================== */
/* The clock dot is the sky at that hour, so the button reads at a glance. */
function todColor(h) {
  var stops = [
    [0,  [0.10, 0.13, 0.22]], [5,  [0.16, 0.18, 0.30]], [6.5, [0.86, 0.47, 0.28]],
    [9,  [0.55, 0.74, 0.93]], [13, [0.47, 0.70, 0.95]], [17, [0.62, 0.72, 0.90]],
    [18.6, [0.93, 0.48, 0.24]], [20, [0.28, 0.22, 0.34]], [24, [0.10, 0.13, 0.22]]
  ];
  h = ((h % 24) + 24) % 24;
  for (var i = 0; i < stops.length - 1; i++) {
    if (h >= stops[i][0] && h <= stops[i + 1][0]) {
      var t = (h - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      var c = mixArr(stops[i][1], stops[i + 1][1], t);
      return rgb2hex(c[0], c[1], c[2]);
    }
  }
  return '#8FC8F0';
}

function buildTopExtras() {
  document.getElementById('sun-btn').onclick = showWorldSheet;
  document.getElementById('b-new').onclick = showTemplates;
  document.getElementById('b-help').onclick = showHelp;
  var saved = document.getElementById('saved');
  saved.innerHTML = svgIcon(ICON.check, 2.6) + '<span>Saved</span>';
  refreshTopExtras();
}
function refreshTopExtras() {
  var b = document.getElementById('sun-btn');
  if (!b) return;
  b.querySelector('.dot').style.background = todColor(state.env.timeOfDay);
  b.querySelector('b').textContent = clockLabel(state.env.timeOfDay);
}
function toggleSimulate() {
  state.world.simulate = !state.world.simulate;
  syncEnvUniforms();
  refreshUI();
  markSceneDirty();
  toast(state.world.simulate ? 'Everything is moving again' : 'Everything is frozen');
}
function setQuality(q) {
  state.world.quality = q;
  Grass.mat.uniforms.uDensity.value = state.grass.density * Q().grass;
  syncEnvUniforms();
  rebuildWater();
  refreshUI();
  markSceneDirty();
}
var _savedTimer = 0;
function flashSaved() {
  var s = document.getElementById('saved');
  if (!s) return;
  s.classList.add('on');
  clearTimeout(_savedTimer);
  _savedTimer = setTimeout(function () { s.classList.remove('on'); }, 1800);
}
/* ==========================================================================
   THE GRASS STATION
   --------------------------------------------------------------------------
   Every panel builder takes two hosts: `main` is what you see, `more` is what
   appears when you open "All settings". Nothing is deleted — it is sorted by
   how often a person actually reaches for it.
   ========================================================================== */
function panelGrass(main, more) {
  toolRow(main, 'grass');

  var b = addGroup(main, 'Brush');
  addSlider(b, { label: 'Brush size', path: 'brush.radius', min: 0.25, max: 40, step: 0.05, dec: 1, unit: ' m',
    tip: 'How wide a patch each drag covers.', key: '[  ]' });

  b = addGroup(main, 'Look');
  addChips(b, {
    options: PRESETS.map(function (p, i) { return { value: i, label: p.name, swatch: p.swatch,
      tip: 'Change the grass, wind and light to the ' + p.name + ' look. Grass you have already painted stays put.' }; }),
    onChange: function (i) { applyPreset(i); }
  });
  addSlider(b, { label: 'Blade height', path: 'grass.height', min: 0.05, max: 5, step: 0.01, dec: 2, unit: ' m',
    tip: 'How tall new and existing blades stand.', apply: ['grass'] });
  addColor(b, { label: 'Tip colour', path: 'grass.tipColor', tip: 'The colour at the top of every blade.', apply: ['grass'] });
  addColor(b, { label: 'Root colour', path: 'grass.baseColor', tip: 'The colour down at the soil.', apply: ['grass'] });

  b = addGroup(main, 'Wind');
  addDial(b, { label: 'Direction', path: 'wind.direction',
    tip: 'Drag the dial to point the wind somewhere else. Hold Shift to snap to 15° steps.', apply: ['grass'],
    extra: function (host) {
      addSlider(host, { label: 'Strength', path: 'wind.strength', min: 0, max: 2.5, step: 0.01, dec: 2,
        tip: 'How far the blades lean downwind.', apply: ['grass'] });
    } });

  b = addGroup(main, 'The whole field');
  addButtons(b, [
    { label: 'Fill everywhere', kind: 'pri', key: 'Shift F',
      tip: 'Cover the whole world with grass, skipping water, roads and cliffs.',
      icon: '<path d="M4 20h16"/><path d="M7 20V9M12 20V5M17 20v-8"/>', run: fillPlate },
    { label: 'Clear', kind: 'dgr', key: 'Ctrl Shift Del',
      tip: 'Remove every blade. You will be asked first, and Ctrl+Z brings it back.',
      icon: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>', run: askClear }
  ]);
  var meterLabel = el('div', 'note');
  var meter = el('div', 'meter');
  var meterFill = el('i');
  meter.appendChild(meterFill);
  b.appendChild(meter); b.appendChild(meterLabel);
  meterLabel.style.marginTop = '8px';
  UI.meter = { label: meterLabel, bar: meter, fill: meterFill };
  updateBladeMeter();

  /* ---------------- all settings ---------------- */
  var m = addGroup(more, 'Brush');
  addSlider(m, { label: 'How much per stroke', path: 'brush.flow', min: 0.02, max: 1, step: 0.01, dec: 2,
    tip: 'How many blades each stamp tries to plant. Higher fills an area faster.' });
  addSlider(m, { label: 'Edge softness', path: 'brush.falloff', min: 0, max: 1, step: 0.01, dec: 2,
    tip: '0 fades out gradually from the middle, 1 is a crisp circular cut.' });
  addSlider(m, { label: 'Scatter', path: 'brush.scatter', min: 0, max: 1, step: 0.01, dec: 2,
    tip: '0 snaps blades to a tidy lattice, 1 is fully natural scatter.' });
  addSlider(m, { label: 'Crowding limit', path: 'brush.maxDensity', min: 5, max: 400, step: 1, dec: 0, unit: '/m²',
    tip: 'A stroke stops adding blades to a spot once it reaches this many per square metre.', apply: ['dens'] });
  addSlider(m, { label: 'Random lean', path: 'brush.tilt', min: 0, max: 0.8, step: 0.01, dec: 2,
    tip: 'How far each blade may lean away from straight up when it is planted.' });
  addSlider(m, { label: 'Steepest ground grass grows on', path: 'plate.maxGrassSlope', min: 0, max: 0.98, step: 0.01, dec: 2,
    tip: 'Blades refuse to grow where the ground tips past this — it keeps grass off cliff faces.' });

  m = addGroup(more, 'Blade shape');
  addSlider(m, { label: 'Height variation', path: 'grass.heightVar', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'How much taller or shorter than average each new blade can be.' });
  addSlider(m, { label: 'Width', path: 'grass.width', min: 0.005, max: 0.4, step: 0.001, dec: 3, unit: ' m',
    tip: 'Blade width at the root.', apply: ['grass'] });
  addSlider(m, { label: 'Width variation', path: 'grass.widthVar', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'Random spread of blade width at paint time.' });
  addSlider(m, { label: 'Taper', path: 'grass.taper', min: 0.2, max: 3, step: 0.01, dec: 2,
    tip: 'How quickly the blade narrows to the tip. Low stays broad, high goes needle-like.', apply: ['grass'] });
  addSlider(m, { label: 'Droop', path: 'grass.curve', min: 0, max: 2, step: 0.01, dec: 2,
    tip: 'How far the blade curls over with no wind.', apply: ['grass'] });
  addSlider(m, { label: 'Droop variation', path: 'grass.curveVar', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'Random spread of resting droop at paint time.' });
  addSlider(m, { label: 'Smoothness', path: 'grass.segments', min: 3, max: 7, step: 1, dec: 0,
    tip: 'Points along each blade. Higher looks smoother and costs more.', apply: ['template'] });
  addSlider(m, { label: 'Cross-blade curl', path: 'grass.bladeCurl', min: 0, max: 1.4, step: 0.01, dec: 2,
    tip: 'Curvature across the width of the blade — this is what makes the highlight run down the middle.', apply: ['grass'] });

  m = addGroup(more, 'Colour');
  addSlider(m, { label: 'Where root meets tip', path: 'grass.gradPow', min: 0.3, max: 4, step: 0.01, dec: 2,
    tip: 'High values keep the root colour for longer up the blade.', apply: ['grass'] });
  addSlider(m, { label: 'Hue variation', path: 'grass.hueVar', min: 0, max: 0.5, step: 0.005, dec: 3,
    tip: 'Per-blade random hue shift.', apply: ['grass'] });
  addSlider(m, { label: 'Saturation variation', path: 'grass.satVar', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'Per-blade random saturation shift.', apply: ['grass'] });
  addSlider(m, { label: 'Brightness variation', path: 'grass.valVar', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'Per-blade random brightness shift.', apply: ['grass'] });
  addSlider(m, { label: 'Shade at the base', path: 'grass.ao', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'Darkening toward the bottom of each blade. It is what grounds the field.', apply: ['grass'] });
  addSlider(m, { label: 'Backlight glow', path: 'grass.translucency', min: 0, max: 3, step: 0.01, dec: 2,
    tip: 'How much light passes through a blade when the sun is behind it.', apply: ['grass'] });
  addSlider(m, { label: 'Sheen', path: 'grass.specular', min: 0, max: 1.5, step: 0.01, dec: 2,
    tip: 'Strength of the highlight.', apply: ['grass'] });
  addSlider(m, { label: 'Sheen spread', path: 'grass.roughness', min: 0.02, max: 1, step: 0.01, dec: 2,
    tip: 'Low is glossy, high is matte.', apply: ['grass'] });

  m = addGroup(more, 'Field');
  addSlider(m, { label: 'How thick it looks', path: 'grass.density', min: 0.02, max: 1, step: 0.01, dec: 2,
    tip: 'Draws only a fraction of the blades you painted. Thins the field without deleting anything.', apply: ['grass'] });
  addSlider(m, { label: 'Softest blades', path: 'grass.stiffMin', min: 0.15, max: 3, step: 0.01, dec: 2,
    tip: 'Soft blades bend much further in the same wind.' });
  addSlider(m, { label: 'Stiffest blades', path: 'grass.stiffMax', min: 0.15, max: 3, step: 0.01, dec: 2,
    tip: 'A wide soft-to-stiff range is what stops the field moving as one mass.' });

  m = addGroup(more, 'Wind detail');
  addSlider(m, { label: 'Speed', path: 'wind.speed', min: 0, max: 2, step: 0.01, dec: 2,
    tip: 'How fast the wind pattern scrolls across the world.', apply: ['grass'] });
  addSlider(m, { label: 'Turbulence', path: 'wind.turbulence', min: 0, max: 2, step: 0.01, dec: 2,
    tip: 'Chaos: jitters the local direction and flutters the tips.', apply: ['grass'] });
  addSlider(m, { label: 'Wave size', path: 'wind.waveScale', min: 0.005, max: 0.4, step: 0.001, dec: 3,
    tip: 'Low values make long, broad swells.', apply: ['grass'] });
  addSlider(m, { label: 'Gusts across the field', path: 'wind.gustFreq', min: 0.01, max: 0.7, step: 0.005, dec: 3,
    tip: 'Low values give one big sweeping wave.', apply: ['grass'] });
  addSlider(m, { label: 'Gust strength', path: 'wind.gustStrength', min: 0, max: 3, step: 0.01, dec: 2,
    tip: 'How hard the gust front bends the grass as it passes.', apply: ['grass'] });
  addSlider(m, { label: 'Gust speed', path: 'wind.gustSpeed', min: 0, max: 6, step: 0.01, dec: 2,
    tip: 'How quickly the gust front travels.', apply: ['grass'] });

  m = addGroup(more, 'Grass that reacts to you');
  addNote(m, 'The blades part around your cursor. These decide how that feels.');
  addSlider(m, { label: 'How far it parts', path: 'interact.radius', min: 0.3, max: 12, step: 0.05, dec: 2, unit: ' m',
    tip: 'How far from the cursor the grass is pushed aside.' });
  addSlider(m, { label: 'How hard', path: 'interact.strength', min: 0, max: 4, step: 0.01, dec: 2,
    tip: 'How far the grass is bent away from the cursor.' });
  addSlider(m, { label: 'Spring back', path: 'interact.recovery', min: 0.5, max: 20, step: 0.1, dec: 1,
    tip: 'Higher springs back faster.' });
  addSlider(m, { label: 'Wobble', path: 'interact.damping', min: 0.08, max: 1.6, step: 0.01, dec: 2,
    tip: 'Below 1 the grass overshoots and wobbles on the way back; at 1 it settles without bouncing.' });
  addSlider(m, { label: 'Drag behind', path: 'interact.wake', min: 0, max: 2, step: 0.01, dec: 2,
    tip: 'How much the grass is pulled along the way the cursor is travelling.' });
  addToggle(m, { label: 'Show the ball', path: 'interact.ball', tip: 'A ball you can drag through the grass.' });
  addSlider(m, { label: 'Ball size', path: 'interact.ballRadius', min: 0.2, max: 6, step: 0.05, dec: 2, unit: ' m',
    tip: 'How big the ball is.' });
}

function updateBladeMeter() {
  if (!UI.meter || !UI.meter.label.isConnected) return;
  var f = Grass.count / MAX_BLADES;
  UI.meter.label.textContent = fmtInt(Grass.count) + ' blades — room for ' + fmtInt(MAX_BLADES);
  UI.meter.fill.style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%';
  UI.meter.bar.classList.toggle('warn', f > 0.9);
}

function askClear() {
  confirmDialog('Clear all the grass?',
    'This removes all ' + fmtInt(Grass.count) + ' blades. Ctrl+Z brings them back.',
    'Clear the grass', clearAll);
}

/* ==========================================================================
   HELP — the tour, and the full shortcut list for people who want it
   ========================================================================== */
var SHORTCUTS = [];

function showHelp() {
  openModal('Help', function (body) {
    body.appendChild(el('p', null,
      'Grass Painter has four stations down the left. Pick one, then work directly on the ground.'));
    addButtons(body, [
      { label: 'Take the tour', kind: 'pri', icon: '<path d="M12 21s7-5.5 7-11a7 7 0 0 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
        tip: 'Walk through the whole tool, one station at a time.',
        run: function () { closeModal(); startTour(0); } },
      { label: 'Keyboard shortcuts', icon: '<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
        tip: 'Every key the tool listens for.',
        run: function () { closeModal(); showShortcuts(); } }
    ]);
  }, []);
}

function showShortcuts() {
  openModal('Keyboard shortcuts', function (body) {
    body.appendChild(el('p', null,
      'Sliders take a drag anywhere along the track, Shift-drag for fine control, a double-click to reset, and typed numbers.'));
    var g = el('div', 'keys');
    SHORTCUTS.forEach(function (group) {
      var col = el('div');
      col.appendChild(el('h4', null, group[0]));
      var dl = el('dl');
      group[1].forEach(function (row) {
        var dt = el('dt');
        row[0].split(/\s+/).forEach(function (k) { dt.appendChild(el('kbd', null, k)); });
        dl.appendChild(dt);
        dl.appendChild(el('dd', null, row[1]));
      });
      col.appendChild(dl);
      g.appendChild(col);
    });
    body.appendChild(g);
  }, [{ label: 'Done', kind: 'pri' }], { wide: true });
}
/* ==========================================================================
   26. STATIONS, THE RAIL, AND PANEL COMPOSITION
   --------------------------------------------------------------------------
   Four stations. Everything you add to the world — houses, trees, people,
   cars, saved groups — is placed from the one Place station, out of one
   library, so there is nothing to learn about which station holds what.
   Anything that belongs to the world rather than to a station (light, water,
   ground colour, quality, layers, the camera) lives in the World sheet.
   ========================================================================== */
var MODES = [
  { id: 'terrain', label: 'Terrain', key: '1',
    lede: 'Drag on the ground to push it up. Hold <b>Alt</b> to dig down.',
    tip: 'Shape the ground — hills, valleys, cliffs and flat building plots.' },
  { id: 'grass', label: 'Grass', key: '2',
    lede: 'Drag to plant grass. Hold <b>Alt</b> to rub it out.',
    tip: 'Plant grass and set how it looks and how it moves in the wind.' },
  { id: 'place', label: 'Place', key: '3',
    lede: 'Pick a model, then click on the ground to put one down.',
    tip: 'Put anything into the world — houses, trees, people, cars.' },
  { id: 'select', label: 'Select', key: '4',
    lede: 'Click something to pick it up. Drag on empty ground to lasso several.',
    tip: 'Pick things you already placed, then move, turn, resize or delete them.' }
];

var MODE_TOOLS = {
  terrain: [
    { id: 'raise', label: 'Raise', icon: ICON.raise, tip: 'Pull the ground up. Hold it still to grow a peak; Alt digs down.' },
    { id: 'lower', label: 'Lower', icon: ICON.lower, tip: 'Push the ground down for valleys and lake beds.' },
    { id: 'smooth', label: 'Smooth', icon: ICON.smooth, tip: 'Soften whatever is under the brush.' },
    { id: 'flatten', label: 'Flat', icon: ICON.flatten, tip: 'Level the ground to the height where you started the drag — good for building plots.' }
  ],
  grass: [
    { id: 'paint', label: 'Paint', icon: ICON.brush, tip: 'Plant grass. Alt rubs it out.' },
    { id: 'erase', label: 'Erase', icon: ICON.eraser, tip: 'Rub grass out.' },
    { id: 'smooth', label: 'Even out', icon: ICON.smooth, tip: 'Make thick and thin patches match.' }
  ],
  place: [
    { id: 'place_one', label: 'One', icon: ICON.place, tip: 'Click to put down a single model. Press R to turn it.' },
    { id: 'place_many', label: 'Scatter', icon: ICON.scatter, tip: 'Drag to sprinkle lots of them. Alt removes instead.' },
    { id: 'place_erase', label: 'Remove', icon: ICON.eraser, tip: 'Drag to take away whatever is under the brush.' }
  ],
  select: [
    { id: 'select', label: 'Select', icon: ICON.arrow, tip: 'Click to pick, Shift-click to add, drag on empty ground to lasso.' }
  ]
};

/* Brushes you reach for less often. Same tool row, one panel deeper. */
var EXTRA_TOOLS = {
  terrain: [
    { id: 'ramp', label: 'Ramp', icon: ICON.ramp, tip: 'Drag from A to B for a clean, even slope between the two heights.' },
    { id: 'noise', label: 'Roughen', icon: ICON.noise, tip: 'Add rocky bumpiness.' },
    { id: 'erode', label: 'Erode', icon: ICON.erode, tip: 'Let material slide downhill and settle, the way weather does it.' }
  ],
  grass: [
    { id: 'eyedropper', label: 'Copy look', icon: ICON.dropper, tip: 'Take the settings from the grass under the cursor.' }
  ],
  place: [],
  select: []
};

var MODE_HINTS = {
  terrain: '<kbd>Drag</kbd> shape it · <kbd>Alt</kbd> the other way · <kbd>[</kbd><kbd>]</kbd> brush size',
  grass:   '<kbd>Drag</kbd> plant · <kbd>Alt</kbd> rub out · <kbd>[</kbd><kbd>]</kbd> brush size',
  place:   '<kbd>Click</kbd> place · <kbd>Drag</kbd> scatter · <kbd>R</kbd> turn it',
  select:  '<kbd>Click</kbd> pick · <kbd>Shift</kbd> add · <kbd>Drag</kbd> lasso · <kbd>Del</kbd> remove'
};
var FLY_HINT = ' · <kbd>WASD</kbd> fly · <kbd>Right-drag</kbd> look';

/* Modes that no longer exist map onto the one that replaced them, so a scene
   saved before this redesign still opens somewhere sensible. */
var LEGACY_MODES = { build: 'place', nature: 'place', people: 'place', roads: 'terrain' };
function normalizeMode(id) {
  if (LEGACY_MODES[id]) return LEGACY_MODES[id];
  for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return id;
  return 'terrain';
}
function modeDef(id) {
  for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
  return MODES[0];
}
function allTools(mode) { return (MODE_TOOLS[mode] || []).concat(EXTRA_TOOLS[mode] || []); }
function modeHasTool(mode, id) {
  var list = allTools(mode);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return true;
  return false;
}

/* ---- mode / tool plumbing ------------------------------------------------- */
function currentTool() {
  if (state.world.mode === 'terrain') return state.sculpt.mode;
  return state.tool;
}
function setTool(id) {
  // Loading a scene saved before the redesign restores a mode and a tool that
  // no longer exist ("nature" / "nat_scatter"), and the base loader calls this
  // before anything else has had a chance to migrate them.
  var mode = state.world.mode = normalizeMode(state.world.mode);
  if (mode === 'terrain') {
    if (modeHasTool('terrain', id)) state.sculpt.mode = id;
    else if (!modeHasTool('terrain', state.sculpt.mode)) state.sculpt.mode = 'raise';
    state.tool = 'sculpt';
    if (state.plate.mode !== 'terrain') {
      state.plate.mode = 'terrain';
      rebuildPlate();
    }
  } else {
    state.tool = modeHasTool(mode, id) ? id : MODE_TOOLS[mode][0].id;
  }
  if (state.tool !== 'select') clearSelection();
  cancelPending();
  refreshToolButtons();
  refreshHint();
  canvas.classList.toggle('cam', false);
  markSceneDirty();
}
function setMode(id) {
  id = normalizeMode(id);
  if (state.world.mode === id) return;
  state.world.mode = id;
  cancelPending();
  if (id !== 'select') clearSelection();
  if (id === 'terrain') {
    state.tool = 'sculpt';
    if (!modeHasTool('terrain', state.sculpt.mode)) state.sculpt.mode = 'raise';
    if (state.plate.mode !== 'terrain') { state.plate.mode = 'terrain'; rebuildPlate(); }
  } else {
    state.tool = MODE_TOOLS[id][0].id;
  }
  buildRail();
  buildPanel();
  refreshHint();
  markSceneDirty();
}
function refreshToolButtons() {
  var cur = currentTool();
  var btns = document.querySelectorAll('#panel .tbtn');
  for (var i = 0; i < btns.length; i++)
    btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-tool') === cur ? 'true' : 'false');
}
function refreshHint() {
  var h = document.getElementById('hint');
  if (!h) return;
  var extra = '';
  if (Keys.alt) extra = ' · <b style="color:var(--accent)">Alt: the other way</b>';
  else if (Keys.shift) extra = ' · <b style="color:var(--accent)">Shift: straight line / add</b>';
  else if (Keys.space) extra = ' · <b style="color:var(--accent)">Space: orbit</b>';
  h.innerHTML = (MODE_HINTS[state.world.mode] || '') + FLY_HINT + extra;
}

/* F frames whatever is selected, falling back to the whole world. */
function focusSelection() {
  if (Sel.road) {
    var sp = roadSamples(Sel.road);
    if (sp.length) {
      var mid = sp[(sp.length / 2) | 0];
      cam.focusOn(mid.x, mid.y, mid.z, Math.max(Sel.road.width * 2, 12));
      return;
    }
  }
  if (Sel.objs.length) {
    var mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
    for (var i = 0; i < Sel.objs.length; i++) {
      var o = Sel.objs[i], rr = o.radius * o.scale, hh = o.height * o.scale;
      mnx = Math.min(mnx, o.x - rr); mxx = Math.max(mxx, o.x + rr);
      mnz = Math.min(mnz, o.z - rr); mxz = Math.max(mxz, o.z + rr);
      mny = Math.min(mny, o.y); mxy = Math.max(mxy, o.y + hh);
    }
    var dx = mxx - mnx, dy = mxy - mny, dz = mxz - mnz;
    cam.focusOn((mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2, Math.max(dx, dy, dz) * 0.6 + 1);
    return;
  }
  cam.frame(state.plate.width, state.plate.depth, Terrain.max);
}
function frameWorld() { cam.frame(state.plate.width, state.plate.depth, Terrain.max); }

/* ==========================================================================
   THE RAIL
   ========================================================================== */
var _railIntroDone = false;
function buildRail() {
  var rail = document.getElementById('rail');
  rail.innerHTML = '';
  // The strata draw themselves in once, on the first rail of the session.
  if (!_railIntroDone) {
    _railIntroDone = true;
    rail.classList.add('intro');
    setTimeout(function () { rail.classList.remove('intro'); }, 1000);
  }
  MODES.forEach(function (m) {
    var b = el('button', 'station');
    b.innerHTML = stationGlyph(STATION_FORM[m.id]) + '<span>' + m.label + '</span>';
    b.setAttribute('aria-pressed', state.world.mode === m.id ? 'true' : 'false');
    b.setAttribute('data-tip', m.tip);
    b.setAttribute('data-key', m.key);
    b.onclick = function () { setMode(m.id); };
    rail.appendChild(b);
  });
  var foot = el('div');
  foot.id = 'rail-foot';
  var fit = el('button', 'btn icon ghost');
  fit.innerHTML = svgIcon(ICON.frame);
  fit.setAttribute('data-tip', 'Pull back until the whole world fits on screen');
  fit.setAttribute('data-key', 'F');
  fit.onclick = frameWorld;
  foot.appendChild(fit);
  rail.appendChild(foot);
}

/* ==========================================================================
   SHARED PANEL BLOCKS
   ========================================================================== */
function toolRow(host, mode, list) {
  list = list || MODE_TOOLS[mode];
  if (!list.length) return;
  var g = el('div', 'tools');
  g.style.gridTemplateColumns = 'repeat(' + list.length + ',minmax(0,1fr))';
  list.forEach(function (t) {
    var b = el('button', 'tbtn');
    b.innerHTML = svgIcon(t.icon) + '<span>' + t.label + '</span>';
    b.setAttribute('data-tool', t.id);
    b.setAttribute('data-tip', t.tip);
    b.onclick = function () { setTool(t.id); };
    g.appendChild(b);
  });
  host.appendChild(g);
  refreshToolButtons();
}

/* ==========================================================================
   TERRAIN
   ========================================================================== */
function panelTerrain(main, more) {
  toolRow(main, 'terrain');

  var b = addGroup(main, 'Brush');
  addSlider(b, { label: 'Brush size', path: 'brush.radius', min: 0.25, max: 40, step: 0.05, dec: 1, unit: ' m',
    tip: 'How wide a patch each drag affects.', key: '[  ]' });
  addSlider(b, { label: 'Strength', path: 'sculpt.strength', min: 0.02, max: 2, step: 0.01, dec: 2,
    tip: 'How fast the ground moves. Holding still in one spot keeps building.' });

  b = addGroup(main, 'Shape of the land');
  addChips(b, { path: 'plate.landform', apply: ['plate'],
    options: [
      { value: 'flat', label: 'Flat' }, { value: 'rolling', label: 'Hills' },
      { value: 'mountains', label: 'Mountains' }, { value: 'valley', label: 'Valley' },
      { value: 'island', label: 'Island' }, { value: 'plateau', label: 'Plateau' },
      { value: 'canyon', label: 'Canyon' }
    ] });
  addSlider(b, { label: 'How tall', path: 'plate.heightScale', min: 0, max: 4, step: 0.01, dec: 2,
    tip: 'Stretches the whole landform up or squashes it flat.', apply: ['plate'] });
  addButtons(b, [{ label: 'Roll a new one', icon: ICON.wand,
    tip: 'Same kind of landscape, different shape. Anything you sculpted by hand is cleared.',
    run: function () { regenerateTerrain(Math.floor(rnd() * 999999) + 1); refreshUI(); } }]);

  /* ---------------- all settings ---------------- */
  var m = addGroup(more, 'More brushes');
  toolRow(m, 'terrain', EXTRA_TOOLS.terrain);
  addSlider(m, { label: 'Edge softness', path: 'brush.falloff', min: 0, max: 1, step: 0.01, dec: 2,
    tip: '0 fades out gradually, 1 is a crisp circular edge.' });
  addSlider(m, { label: 'Roughen size', path: 'sculpt.noiseScale', min: 0.05, max: 4, step: 0.01, dec: 2, unit: ' m',
    tip: 'How big the bumps the Roughen brush makes are.' });
  addSlider(m, { label: 'Slide angle', path: 'sculpt.talus', min: 0.1, max: 2, step: 0.01, dec: 2,
    tip: 'How steep a slope Erode leaves standing before material slides off it.' });
  addSlider(m, { label: 'Erode passes', path: 'sculpt.erodeIters', min: 1, max: 6, step: 1, dec: 0,
    tip: 'More passes cut deeper gullies.' });

  m = addGroup(more, 'The landform');
  addSlider(m, { label: 'Seed', path: 'plate.seed', min: 1, max: 999999, step: 1, dec: 0,
    tip: 'Changes the shape without changing its character.', apply: ['plate'] });
  addSlider(m, { label: 'Bumpiness', path: 'plate.amplitude', min: 0, max: 24, step: 0.05, dec: 2, unit: ' m',
    tip: 'How far the land rises and falls before "How tall" scales it.', apply: ['plate'] });
  addSlider(m, { label: 'Feature size', path: 'plate.frequency', min: 0.004, max: 0.3, step: 0.001, dec: 3,
    tip: 'Low values give broad landforms, high values give lots of small ones.', apply: ['plate'] });
  addSlider(m, { label: 'Layers of detail', path: 'plate.octaves', min: 1, max: 6, step: 1, dec: 0,
    tip: 'More layers add finer detail on top of the big shapes.', apply: ['plate'] });
  addSelect(m, { label: 'Ground detail', path: 'plate.resolution', apply: ['plate'],
    tip: 'A finer grid sculpts smaller detail and costs more to draw.',
    options: [{ value: '64', label: 'Coarse — fastest' }, { value: '128', label: 'Medium' },
              { value: '256', label: 'Fine' }, { value: '512', label: 'Very fine — heavy' }],
    onChange: function (v) { state.plate.resolution = parseInt(v, 10); rebuildPlate(); rebuildWater(); } });
  addSlider(m, { label: 'World width', path: 'plate.width', min: 20, max: 400, step: 1, dec: 0, unit: ' m',
    tip: 'How far the ground stretches east to west.', apply: ['plate'] });
  addSlider(m, { label: 'World depth', path: 'plate.depth', min: 20, max: 400, step: 1, dec: 0, unit: ' m',
    tip: 'How far the ground stretches north to south.', apply: ['plate'] });
}

/* ==========================================================================
   PLACE — one station, one library
   ========================================================================== */
var PlaceCat = 'all';
var PLACE_CATS = [
  { id: 'all', label: 'All' },
  { id: 'building', label: 'Buildings' },
  { id: 'nature', label: 'Trees & plants' },
  { id: 'prop', label: 'Props' },
  { id: 'person', label: 'People' },
  { id: 'vehicle', label: 'Vehicles' }
];

function placeSelect(kind, add) {
  var list = state.place.kinds;
  if (add) {
    var i = list.indexOf(kind);
    if (i >= 0) { if (list.length > 1) list.splice(i, 1); }
    else list.push(kind);
  } else {
    state.place.kinds = [kind];
  }
  state.place.kind = kind;
  markSceneDirty();
  buildPanel();
}

function modelPicker(host) {
  var ids = Object.keys(ASSETS);
  var counts = {};
  ids.forEach(function (id) { counts[ASSETS[id].kind] = (counts[ASSETS[id].kind] || 0) + 1; });

  var g = addGroup(host, 'Models');

  var live = PLACE_CATS.filter(function (c) { return c.id === 'all' || counts[c.id]; });
  if (!live.some(function (c) { return c.id === PlaceCat; })) PlaceCat = 'all';
  if (live.length > 2) {
    addChips(g, {
      get: function () { return PlaceCat; },
      set: function (v) { PlaceCat = v; },
      options: live.map(function (c) { return { value: c.id, label: c.label }; }),
      onChange: function () { buildPanel(); }
    });
  }

  var grid = el('div', 'mgrid');
  g.appendChild(grid);

  var add = el('button', 'mcard add');
  var ph = el('div', 'ph');
  ph.innerHTML = svgIcon(ICON.plus, 2.4);
  add.appendChild(ph);
  add.appendChild(el('b', null, 'Add models'));
  add.setAttribute('data-tip', 'Search Sketchfab and bring a model into your library');
  add.onclick = function () { showSketchfabBrowser(Browser.q); };
  grid.appendChild(add);

  var shown = ids.filter(function (id) { return PlaceCat === 'all' || ASSETS[id].kind === PlaceCat; });
  shown.sort(function (a, c) { return ASSETS[a].label.localeCompare(ASSETS[c].label); });

  if (!ids.length) {
    var e = el('div', 'empty');
    e.textContent = 'Nothing to place yet. Everything in this world comes from Sketchfab — press Add models to bring one in.';
    grid.appendChild(e);
    return;
  }

  shown.forEach(function (id) {
    modelCard(grid, ASSETS[id].label, 'asset', id,
      state.place.kinds.indexOf(id) >= 0,
      function (e) { placeSelect(id, e.shiftKey); });
  });

  World.prefabs.forEach(function (pf) {
    if (PlaceCat !== 'all') return;
    modelCard(grid, pf.name, 'group', pf.id, state.place.kind === pf.id,
      function () { placeSelect(pf.id, false); });
  });

  addNote(g, 'Click a model to choose it. <b>Shift-click</b> to mix several together when you scatter.');
}

function modelCard(grid, label, type, key, selected, onClick) {
  var b = el('button', 'mcard');
  b.setAttribute('aria-pressed', selected ? 'true' : 'false');
  b.setAttribute('data-tip', label);
  var cv = el('canvas');
  b.appendChild(cv);
  b.appendChild(el('b', null, label));
  var tick = el('span', 'tick');
  tick.innerHTML = svgIcon(ICON.check, 3);
  b.appendChild(tick);
  b.onclick = onClick;
  grid.appendChild(b);

  var ck = type + '|' + key;
  if (Thumbs.cache[ck]) {
    cv.width = 128; cv.height = 128;
    cv.getContext('2d').drawImage(Thumbs.cache[ck], 0, 0);
  } else {
    if (type === 'asset') { try { renderThumb(key, cv); } catch (e) {} }
    else drawGroupSwatch(cv);
    var store = document.createElement('canvas');
    store.width = cv.width || 128; store.height = cv.height || 128;
    store.getContext('2d').drawImage(cv, 0, 0);
    Thumbs.cache[ck] = store;
  }
}

function panelPlace(main, more) {
  toolRow(main, 'place');
  modelPicker(main);

  var b = addGroup(main, 'How it goes down');
  addSegment(b, { path: 'build.snap', tip: 'Where a click actually puts the model.',
    options: [
      { value: 'free', label: 'Anywhere', tip: 'Exactly where you click' },
      { value: 'grid', label: 'On a grid', tip: 'Snapped to a regular grid' },
      { value: 'road', label: 'Facing a road', tip: 'Set back from the nearest road and turned to face it' }
    ] });
  addSlider(b, { label: 'Size', path: 'place.size', min: 0.1, max: 6, step: 0.01, dec: 2, unit: '×',
    tip: 'How big each copy is placed. 1 is the model at its own size.' });
  addSlider(b, { label: 'Brush size', path: 'brush.radius', min: 1, max: 40, step: 0.25, dec: 1, unit: ' m',
    tip: 'How wide the Scatter and Remove brushes reach.', key: '[  ]' });
  addSlider(b, { label: 'How many scattered', path: 'nature.density', min: 0.02, max: 3, step: 0.01, dec: 2,
    tip: 'How thickly the Scatter brush drops models as you drag.' });

  /* ---------------- all settings ---------------- */
  var m = addGroup(more, 'Variety');
  addSlider(m, { label: 'Smallest', path: 'nature.scaleMin', min: 0.1, max: 2, step: 0.01, dec: 2,
    tip: 'Bottom of the random size range.' });
  addSlider(m, { label: 'Largest', path: 'nature.scaleMax', min: 0.1, max: 4, step: 0.01, dec: 2,
    tip: 'Top of the random size range.' });
  addSlider(m, { label: 'Turn each one', path: 'nature.rotJitter', min: 0, max: 180, step: 1, dec: 0, unit: '°',
    tip: 'Random spin so a group does not look stamped.' });
  addSlider(m, { label: 'Lean with the slope', path: 'nature.alignNormal', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'How much each model tips over with the ground it stands on.' });
  addSlider(m, { label: 'Smallest gap', path: 'nature.spacing', min: 0.2, max: 20, step: 0.1, dec: 2, unit: ' m',
    tip: 'Models never land closer together than this.' });

  m = addGroup(more, 'Buildings');
  addToggle(m, { label: 'Flatten the ground under it', path: 'build.flatten',
    tip: 'Level the terrain under a building so it does not float or sink.' });
  addToggle(m, { label: 'Always stand upright', path: 'build.upright',
    tip: 'Keep buildings vertical instead of tipping with the ground.' });
  addSlider(m, { label: 'Grid spacing', path: 'build.gridSize', min: 0.25, max: 20, step: 0.25, dec: 2, unit: ' m',
    tip: 'How far apart the grid lines are when snapping to a grid.' });
  addSlider(m, { label: 'Distance from the road', path: 'build.setback', min: 0, max: 30, step: 0.25, dec: 2, unit: ' m',
    tip: 'How far back from the kerb a road-facing building sits.' });
  addSlider(m, { label: 'Facing', path: 'build.rotation', min: 0, max: 360, step: 1, dec: 0, unit: '°',
    tip: 'Which way a building faces when it is not snapped to a road.' });
  addSlider(m, { label: 'Random facing', path: 'build.rotJitter', min: 0, max: 45, step: 0.5, dec: 1, unit: '°',
    tip: 'Small random turn so a row of houses is not perfectly aligned.' });

  m = addGroup(more, 'Where things are allowed');
  addSlider(m, { label: 'Flattest ground needed', path: 'nature.minNormalY', min: 0, max: 1, step: 0.01, dec: 2,
    tip: 'Refuse steeper ground than this — 1 means flat ground only.' });
  addSlider(m, { label: 'Not below', path: 'nature.minAlt', min: -60, max: 60, step: 0.5, dec: 1, unit: ' m',
    tip: 'Only place above this height — pines above the treeline.' });
  addSlider(m, { label: 'Not above', path: 'nature.maxAlt', min: -60, max: 60, step: 0.5, dec: 1, unit: ' m',
    tip: 'Only place below this height — palms near the water.' });

  m = addGroup(more, 'What Remove takes');
  addToggle(m, { label: 'Trees and plants', path: 'eraseMask.nature', tip: 'Include trees, rocks and plants.' });
  addToggle(m, { label: 'Props', path: 'eraseMask.props', tip: 'Include street furniture and yard props.' });
  addToggle(m, { label: 'Buildings', path: 'eraseMask.buildings', tip: 'Include buildings.' });
  addToggle(m, { label: 'People', path: 'eraseMask.people', tip: 'Include people.' });
  addToggle(m, { label: 'Vehicles', path: 'eraseMask.vehicles', tip: 'Include cars and trucks.' });
  addToggle(m, { label: 'Grass too', path: 'eraseMask.grass', tip: 'Also rub out grass blades under the brush.' });

  panelLibrary(more);
}

/* ==========================================================================
   SELECT
   ========================================================================== */
function panelSelect(main, more) {
  toolRow(main, 'select');

  var b = addGroup(main, 'Selection');
  UI.selInfo = addNote(b, 'Nothing picked yet');
  addSegment(b, { path: 'sel.gizmo', tip: 'What the handles on screen do.',
    options: [{ value: 'move', label: 'Move' }, { value: 'rotate', label: 'Turn' }, { value: 'scale', label: 'Resize' }],
    onChange: refreshSelectionVisuals });
  UI.xform = el('div');
  b.appendChild(UI.xform);
  addButtons(b, [
    { label: 'Duplicate', icon: ICON.copy, tip: 'Make a copy, just to one side.', key: 'Ctrl D', run: duplicateSelection },
    { label: 'Delete', kind: 'dgr', icon: ICON.trash, tip: 'Remove what is picked.', key: 'Del', run: deleteSelection }
  ]);

  var m = addGroup(more, 'Selection');
  addSlider(m, { label: 'Arrow-key step', path: 'sel.nudge', min: 0.05, max: 5, step: 0.05, dec: 2, unit: ' m',
    tip: 'How far the arrow keys shift what is picked.' });
  addButtons(m, [
    { label: 'Save as a group', icon: ICON.copy,
      tip: 'Turn what is picked into one stamp you can place again from the Place station.',
      run: function () { if (groupSelectionToPrefab()) buildPanel(); } }
  ]);
  if (World.prefabs.length) {
    var g = addGroup(more, 'Your groups');
    World.prefabs.forEach(function (pf) {
      addButtons(g, [{ label: pf.name + ' — ' + pf.items.length + ' pieces', icon: ICON.place,
        tip: 'Switch to Place with this group ready to stamp.',
        run: function () { state.place.kind = pf.id; state.place.kinds = [pf.id]; setMode('place'); } }]);
    });
  }
  refreshSelectionUI();
}

/* Numeric transforms, refreshed whenever the selection changes. */
function refreshSelectionUI() {
  if (!UI.xform || !UI.selInfo || !UI.selInfo.isConnected) return;
  var n = Sel.objs.length;
  UI.selInfo.textContent = Sel.road ? ('A road is picked — ' + Sel.road.pts.length + ' points')
    : (n === 0 ? 'Nothing picked yet'
      : (n === 1 ? ((ASSETS[Sel.objs[0].kind] || {}).label || 'One thing') + ' is picked'
        : (n + ' things are picked')));
  UI.xform.innerHTML = '';
  if (Sel.road && !n) {
    addButtons(UI.xform, [{ label: 'Delete this road', kind: 'dgr', icon: ICON.trash,
      tip: 'Remove the road and anything placed along it.',
      run: function () { deleteRoad(Sel.road); clearSelection(); buildPanel(); } }]);
    refreshSelectionVisuals();
    return;
  }
  if (n === 0) { refreshSelectionVisuals(); return; }
  var c = selectionCenter();
  var rows = [
    ['Pos', [c.x, c.y, c.z], function (i, v) {
      var d = [0, 0, 0]; d[i] = v - [c.x, c.y, c.z][i];
      moveSelection(d[0], d[1], d[2]);
    }],
    ['Turn', [0, Sel.objs[0].rotY / DEG, 0], function (i, v) {
      if (i !== 1) return;
      rotateSelection(v * DEG - Sel.objs[0].rotY);
    }],
    ['Size', [Sel.objs[0].scale, Sel.objs[0].scale, Sel.objs[0].scale], function (i, v) {
      scaleSelection(v / Math.max(Sel.objs[0].scale, 1e-4));
    }]
  ];
  rows.forEach(function (r) {
    var g = el('div', 'xform');
    g.appendChild(el('i', null, r[0].charAt(0)));
    for (var i = 0; i < 3; i++) (function (idx) {
      var inp = el('input');
      inp.type = 'text';
      inp.value = r[1][idx].toFixed(2);
      inp.setAttribute('data-tip', r[0] === 'Pos' ? 'Position' : (r[0] === 'Turn' ? 'Turn, in degrees (up-down axis only)' : 'Size'));
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
      inp.addEventListener('blur', function () {
        var v = parseFloat(inp.value);
        if (isFinite(v)) { var before = snapshotSelection(); r[2](idx, v); commitSelectionChange(before, 'Transform'); }
        refreshSelectionUI();
      });
      g.appendChild(inp);
    })(i);
    UI.xform.appendChild(g);
  });
  refreshSelectionVisuals();
}

/* ==========================================================================
   THE WORLD SHEET — everything that belongs to the world rather than to a
   station. One deliberate trip here instead of twenty-five controls sitting
   under every mode forever.
   ========================================================================== */
function showWorldSheet() {
  openModal('World', function (body) {
    var sheet = el('div', 'sheet');
    var L = el('div'), R = el('div');
    sheet.appendChild(L); sheet.appendChild(R);
    body.appendChild(sheet);

    /* ---- light ---- */
    var b = addGroup(L, 'Light');
    addSlider(b, { label: 'Time of day', path: 'env.timeOfDay', min: 0, max: 24, step: 0.05, dec: 2,
      format: function (v) { return clockLabel(v); }, apply: ['env'],
      tip: 'Moves the sun. Everything else — sky, shadows, the glow through the blades — follows it.',
      onChange: refreshTopExtras });
    addSlider(b, { label: 'Brightness', path: 'env.exposure', min: 0.2, max: 3, step: 0.01, dec: 2,
      tip: 'Overall exposure of the picture.', apply: ['env'] });
    addToggle(b, { label: 'Draw the sky', path: 'env.sky', apply: ['env'],
      tip: 'Off gives a flat background in the haze colour.' });
    addSlider(b, { label: 'Haze', path: 'env.fogDensity', min: 0, max: 0.06, step: 0.0002, dec: 4,
      tip: 'Distance fog. Small numbers already reach a long way across a big world.', apply: ['env'] });
    addToggle(b, { label: 'Haze matches the sky', path: 'env.fogAuto', apply: ['env'],
      tip: 'Take the haze colour from the sky instead of choosing it yourself.' });
    addColor(b, { label: 'Haze colour', path: 'env.fogColor', apply: ['env'],
      tip: 'Used when the haze does not follow the sky.' });
    addToggle(b, { label: 'Shadows under the grass', path: 'env.shadows', apply: ['env'],
      tip: 'Darken the ground beneath thick grass.' });
    addSlider(b, { label: 'Shadow strength', path: 'env.shadowStrength', min: 0, max: 1, step: 0.01, dec: 2,
      tip: 'How dark those shadows get.', apply: ['env'] });

    /* ---- ground ---- */
    b = addGroup(L, 'Ground');
    addToggle(b, { label: 'Colour it by steepness', path: 'plate.autoTex', apply: ['ground'],
      tip: 'Blend grass, dirt, rock and snow automatically by how steep and how high the ground is.' });
    addColor(b, { label: 'Flat ground', path: 'plate.grassColor', apply: ['ground'], tip: 'Colour where the ground is level.' });
    addColor(b, { label: 'Gentle slopes', path: 'plate.dirtColor', apply: ['ground'], tip: 'Colour on mild slopes.' });
    addColor(b, { label: 'Cliffs', path: 'plate.rockColor', apply: ['ground'], tip: 'Colour on steep faces.' });
    addSlider(b, { label: 'How steep counts as cliff', path: 'plate.rockSlope', min: 0.2, max: 0.99, step: 0.01, dec: 2,
      tip: 'Lower means only the very steepest faces turn to rock.', apply: ['ground'] });
    addSlider(b, { label: 'Cliff blend', path: 'plate.rockBlend', min: 0.01, max: 0.5, step: 0.01, dec: 2,
      tip: 'How softly grass fades into rock.', apply: ['ground'] });
    addToggle(b, { label: 'Snow on the tops', path: 'plate.snowOn', apply: ['ground'], tip: 'Cap high ground with snow.' });
    addColor(b, { label: 'Snow colour', path: 'plate.snowColor', apply: ['ground'], tip: 'Colour of the snow.' });
    addSlider(b, { label: 'Snow line', path: 'plate.snowline', min: -10, max: 60, step: 0.1, dec: 1, unit: ' m',
      tip: 'The height snow starts settling at.', apply: ['ground'] });
    addSlider(b, { label: 'Snow blend', path: 'plate.snowBlend', min: 0.1, max: 12, step: 0.1, dec: 1,
      tip: 'How gradually the snow line fades in.', apply: ['ground'] });
    addSelect(b, { label: 'Plain pattern instead', path: 'plate.pattern', apply: ['ground'],
      tip: 'A plain pattern for the ground.',
      options: [{ value: 'solid', label: 'Plain' }, { value: 'checker', label: 'Checker' },
                { value: 'radial', label: 'Fading circle' }, { value: 'noise', label: 'Patchy dirt' }] });
    addColor(b, { label: 'Pattern colour', path: 'plate.baseColor', apply: ['ground'], tip: 'Main colour of that pattern.' });
    addColor(b, { label: 'Second colour', path: 'plate.secColor', apply: ['ground'], tip: 'The other colour in that pattern.' });
    addToggle(b, { label: 'Measuring grid', path: 'plate.grid', apply: ['ground'], key: 'G',
      tip: 'Lines on the ground so you can judge distance.' });
    addSlider(b, { label: 'Grid spacing', path: 'plate.gridSpacing', min: 0.25, max: 20, step: 0.05, dec: 2, unit: ' m',
      tip: 'Distance between grid lines.', apply: ['ground'] });

    /* ---- water ---- */
    b = addGroup(L, 'Water');
    addToggle(b, { label: 'Flood the low ground', path: 'plate.water',
      tip: 'Fill everything below the water line.', onChange: function () { rebuildWater(); } });
    addSlider(b, { label: 'Water level', path: 'plate.waterLevel', min: -30, max: 30, step: 0.05, dec: 2, unit: ' m',
      tip: 'How high the water sits.', onChange: function () { rebuildWater(); } });
    addColor(b, { label: 'Near the shore', path: 'plate.waterColor', tip: 'Colour in the shallows.', onChange: syncWaterUniforms });
    addColor(b, { label: 'Out deep', path: 'plate.waterDeep', tip: 'Colour where it is deep.', onChange: syncWaterUniforms });
    addSlider(b, { label: 'See-through', path: 'plate.waterOpacity', min: 0.1, max: 1, step: 0.01, dec: 2,
      tip: 'How much of the lake bed shows through.', onChange: syncWaterUniforms });
    addSlider(b, { label: 'Ripple size', path: 'plate.waveScale', min: 0.05, max: 3, step: 0.01, dec: 2,
      tip: 'Size of the ripples on the surface.', onChange: syncWaterUniforms });
    addSlider(b, { label: 'Ripple speed', path: 'plate.waveSpeed', min: 0, max: 3, step: 0.01, dec: 2,
      tip: 'How fast the ripples travel.', onChange: syncWaterUniforms });
    addSlider(b, { label: 'Foam at the edge', path: 'plate.foam', min: 0, max: 2, step: 0.01, dec: 2,
      tip: 'The white band where water meets land.', onChange: syncWaterUniforms });

    /* ---- quality ---- */
    b = addGroup(R, 'Quality');
    addSegment(b, { path: 'world.quality',
      tip: 'Moves draw distance, grass density and the animation budget together.',
      options: Object.keys(QUALITY).map(function (k) {
        return { value: k, label: QUALITY[k].label, tip: QUALITY[k].label + ' detail' };
      }),
      onChange: function (v) { setQuality(v); } });
    addToggle(b, { label: 'Keep everything moving', path: 'world.simulate', key: 'P',
      tip: 'Turn off to freeze the wind, water, people and traffic for a clean screenshot.',
      onChange: function () { syncEnvUniforms(); } });
    var ro = el('div', 'readout');
    ro.innerHTML =
      '<div><i>Frames</i><b id="w-fps">—</b></div>' +
      '<div><i>Blades</i><b id="w-blades">0</b></div>' +
      '<div><i>Objects</i><b id="w-objs">0</b></div>' +
      '<div><i>Triangles</i><b id="w-tris">0</b></div>';
    b.appendChild(ro);

    /* ---- camera ---- */
    b = addGroup(R, 'Camera');
    addNote(b, 'Fly with <b>W A S D</b>, <b>E</b> up and <b>Q</b> down. Hold the right mouse button to look around, ' +
      'and roll the wheel while looking to change speed. <b>F</b> frames whatever is picked.');
    addSlider(b, { label: 'Fly speed', path: 'cam.flySpeed', min: 1, max: 400, step: 0.5, dec: 0, unit: ' m/s',
      tip: 'How fast W A S D moves you.' });
    addSlider(b, { label: 'Shift speeds it up by', path: 'cam.boost', min: 1, max: 12, step: 0.1, dec: 1, unit: '×',
      tip: 'Speed multiplier while Shift is held.' });
    addSlider(b, { label: 'Mouse sensitivity', path: 'cam.lookSens', min: 0.2, max: 3, step: 0.01, dec: 2,
      tip: 'How far the view turns per pixel of mouse movement.' });
    addToggle(b, { label: 'Invert up and down', path: 'cam.invertY', tip: 'Flip the vertical direction of looking around.' });

    /* ---- layers ---- */
    b = addGroup(R, 'Layers');
    addNote(b, 'Hide a layer to get it out of the way, or lock it so brushes and clicks pass straight through.');
    buildLayerList(b);

    /* ---- housekeeping ---- */
    b = addGroup(R, 'This world');
    addToggle(b, { label: 'Keep a copy in this browser', path: 'scene.autosave',
      tip: 'Your world comes back automatically when you reload the page.' });
    addButtons(b, [
      { label: 'Add people and traffic', icon: ICON.people,
        tip: 'Fill every road that a template built with a sensible mix of walkers and vehicles.',
        run: function () {
          var n = populateWorld(1);
          toast(n ? ('Added ' + n + ' people and vehicles') : 'Nothing to populate — templates build the roads', n ? 'ok' : null);
        } }
    ]);
    addButtons(b, [
      { label: 'Remove everything placed', kind: 'dgr', icon: ICON.trash,
        tip: 'Take out every model you or a template put down. Ground, grass and roads stay.',
        run: function () {
          confirmDialog('Remove everything you placed?',
            'This takes out every building, tree, prop, person and vehicle. The ground, the grass and the roads stay. Ctrl+Z brings it back.',
            'Remove them', function () {
              var list = World.objs.slice();
              if (!list.length) { toast('There is nothing placed'); return; }
              beginStroke('Clear objects');
              recordObjDel(list);
              for (var i = 0; i < list.length; i++) deleteObject(list[i]);
              endStroke();
              disposeEmptyLayers();
              buildPanel();
              toast('Removed ' + list.length + ' things', 'ok');
            });
        } }
    ]);
  }, [{ label: 'Done', kind: 'pri' }], { wide: true });
  refreshWorldReadout();
}

var _wFps, _wBlades, _wObjs, _wTris;
function refreshWorldReadout() {
  _wFps = document.getElementById('w-fps');
  _wBlades = document.getElementById('w-blades');
  _wObjs = document.getElementById('w-objs');
  _wTris = document.getElementById('w-tris');
}
function paintWorldReadout(fps) {
  if (!_wFps || !_wFps.isConnected) return;
  _wFps.textContent = fps.toFixed(0);
  _wFps.parentNode.classList.toggle('warn', fps < 40);
  _wBlades.textContent = fmtInt(Grass.count);
  _wObjs.textContent = fmtInt(World.objs.length);
  _wTris.textContent = fmtInt(renderer.info.render.triangles);
}

/* ==========================================================================
   PANEL COMPOSITION
   ========================================================================== */
function buildPanel() {
  var host = document.getElementById('panel-body');
  host.innerHTML = '';
  UI.controls.length = 0;
  UI.xform = null; UI.selInfo = null; UI.meter = null;

  var m = state.world.mode = normalizeMode(state.world.mode);
  var def = modeDef(m);
  document.getElementById('panel-title').textContent = def.label;
  document.getElementById('panel-lede').innerHTML = def.lede;

  var main = el('div');
  host.appendChild(main);

  var more = el('div');
  more.id = 'more';
  var btn = el('button');
  btn.id = 'more-btn';
  btn.innerHTML = svgIcon('<path d="m9 6 6 6-6 6"/>', 2.2) + '<span>All settings</span>';
  btn.setAttribute('data-tip', 'Everything else this station can do');
  var moreBody = el('div');
  moreBody.id = 'more-body';
  more.appendChild(btn); more.appendChild(moreBody);
  host.appendChild(more);
  btn.onclick = function () {
    state.ui.moreOpen = !more.classList.contains('open');
    more.classList.toggle('open', state.ui.moreOpen);
    markSceneDirty();
  };
  if (state.ui.moreOpen) more.classList.add('open');

  if (m === 'terrain') panelTerrain(main, moreBody);
  else if (m === 'grass') panelGrass(main, moreBody);
  else if (m === 'place') panelPlace(main, moreBody);
  else panelSelect(main, moreBody);

  refreshToolButtons();
}

/* Kept because the library, templates and scene loading all need to redraw
   the model picker after they change what is in the library. */
function refreshLibraryUI() {
  if (state.world.mode === 'place') buildPanel();
}
/* ==========================================================================
   29. SKETCHFAB BROWSER AND MODEL LIBRARY
   --------------------------------------------------------------------------
   Search Sketchfab, import a model, and it becomes a placeable kind usable by
   every tool that used to place a procedural asset — the placement brush, the
   scatter brush, road decoration, walking paths and traffic.
   ========================================================================== */
var Browser = { q: '', kind: 'building', maxFaces: 40000, sort: '-likeCount', results: [], next: null, busy: false };

/* Filing a model under a category is the only decision import asks for, so it
   defaults to whichever shelf the picker is currently filtered to. */
function importTargetKindForMode() {
  if (typeof PlaceCat === 'string' && PlaceCat !== 'all') return PlaceCat;
  return 'building';
}

function showSketchfabBrowser(presetQuery) {
  sfLoadToken();
  if (presetQuery !== undefined) Browser.q = presetQuery;
  Browser.kind = importTargetKindForMode();

  openModal('Import from Sketchfab', function (body) {
    /* ---- token ---- */
    var tokenWrap = el('div');
    body.appendChild(tokenWrap);
    function paintToken() {
      tokenWrap.innerHTML = '';
      if (SF.token) {
        var p = el('p', null, 'Signed in with a saved API token. ');
        var chg = el('button', 'btn');
        chg.textContent = 'Change token';
        chg.setAttribute('data-tip', 'Replace or clear the stored Sketchfab API token');
        chg.onclick = function () { sfSaveToken(''); paintToken(); };
        p.appendChild(chg);
        tokenWrap.appendChild(p);
      } else {
        tokenWrap.appendChild(el('p', null,
          'Paste your Sketchfab API token (Settings → Password & API on sketchfab.com). ' +
          'It is stored in this browser only — it is never written into the page source.'));
        var row = el('div', 'sfbar');
        var inp = el('input');
        inp.type = 'text';
        inp.placeholder = 'Sketchfab API token';
        inp.setAttribute('data-tip', 'Required to download models. Search works without it.');
        var save = el('button', 'btn pri', 'Save');
        save.onclick = function () {
          if (!inp.value.trim()) { toast('Enter a token first', 'err'); return; }
          sfSaveToken(inp.value);
          paintToken();
          toast('Token saved to this browser', 'ok');
        };
        row.appendChild(inp); row.appendChild(save);
        tokenWrap.appendChild(row);
      }
    }
    paintToken();

    /* ---- search bar ---- */
    var bar = el('div', 'sfbar');
    var q = el('input');
    q.type = 'text';
    q.placeholder = 'Search models — try "low poly house", "pine tree", "car"';
    q.value = Browser.q;
    q.setAttribute('data-tip', 'Only downloadable models are listed.');
    bar.appendChild(q);

    function selectEl(opts, value, tip) {
      var w = el('div', 'sel');
      var s = el('select');
      opts.forEach(function (o) { var op = el('option', null, o.label); op.value = o.value; s.appendChild(op); });
      s.value = value;
      w.appendChild(s);
      w.insertAdjacentHTML('beforeend', svgIcon('<path d="m6 9 6 6 6-6"/>', 2));
      w.setAttribute('data-tip', tip);
      return { wrap: w, sel: s };
    }
    var kindSel = selectEl(IMP_KINDS.map(function (k) { return { value: k.id, label: k.label }; }),
      Browser.kind, 'Which shelf the model is filed on. It only decides where you find it again.');
    bar.appendChild(kindSel.wrap);

    var faceSel = selectEl([
      { value: '8000', label: '≤ 8k faces' }, { value: '25000', label: '≤ 25k faces' },
      { value: '60000', label: '≤ 60k faces' }, { value: '150000', label: '≤ 150k faces' },
      { value: '0', label: 'Any size' }
    ], String(Browser.maxFaces), 'Face-count cap. This is a world builder — a 500k-face model cannot be instanced hundreds of times at 60 FPS.');
    bar.appendChild(faceSel.wrap);

    var go = el('button', 'btn pri', 'Search');
    bar.appendChild(go);
    body.appendChild(bar);

    var grid = el('div', 'sfgrid');
    var msg = el('div', 'sfmsg', 'Search Sketchfab for a model to import.');
    body.appendChild(msg);
    body.appendChild(grid);

    var more = el('div', 'btn-row');
    var moreBtn = el('button', 'btn', 'Load more');
    moreBtn.style.display = 'none';
    moreBtn.onclick = function () { run(true); };
    more.appendChild(moreBtn);
    body.appendChild(more);

    function run(append) {
      Browser.q = q.value.trim();
      Browser.kind = kindSel.sel.value;
      Browser.maxFaces = parseInt(faceSel.sel.value, 10) || 0;
      if (!append) { grid.innerHTML = ''; Browser.next = null; }
      msg.className = 'sfmsg';
      msg.textContent = 'Searching…';
      moreBtn.style.display = 'none';
      sfSearch({ q: Browser.q, maxFaces: Browser.maxFaces, count: 24, sort: Browser.sort,
                 cursor: append ? Browser.next : null })
        .then(function (res) {
          Browser.next = res.next;
          if (!res.results.length && !append) {
            msg.textContent = 'No downloadable models matched. Try a broader search or raise the face limit.';
            return;
          }
          msg.textContent = '';
          res.results.forEach(function (m) { grid.appendChild(resultCard(m)); });
          moreBtn.style.display = Browser.next ? '' : 'none';
        })
        .catch(function (e) {
          msg.className = 'sfmsg err';
          msg.textContent = e.message || String(e);
        });
    }

    function resultCard(m) {
      var card = el('button', 'sfcard');
      var img = el('img');
      if (m.thumb) img.src = m.thumb;
      img.alt = '';
      card.appendChild(img);
      var prog = el('div', 'sfprog');
      var bar2 = el('i');
      prog.appendChild(bar2);
      card.appendChild(prog);
      var meta = el('div', 'meta');
      meta.appendChild(el('b', null, m.name));
      meta.appendChild(el('span', null, 'by ' + m.author));
      meta.appendChild(el('span', 'fc', fmtInt(m.faces) + ' faces · ' + (m.license || 'see licence')));
      card.appendChild(meta);
      card.setAttribute('data-tip', 'Import "' + m.name + '" into the ' +
        (IMP_KINDS.filter(function (k) { return k.id === Browser.kind; })[0] || {}).label + ' library');

      if (ASSETS[m.uid]) { card.classList.add('done'); meta.lastChild.textContent = 'Already in your library'; }

      card.onclick = function () {
        if (ASSETS[m.uid]) { toast('Already imported', 'ok'); return; }
        if (!SF.token) { toast('Add your Sketchfab API token first', 'err'); return; }
        card.classList.add('busy');
        meta.lastChild.textContent = 'Downloading…';
        importFromSketchfab(m, Browser.kind, function (p) { bar2.style.width = Math.round(p * 100) + '%'; })
          .then(function (def) {
            card.classList.remove('busy');
            card.classList.add('done');
            bar2.style.width = '100%';
            meta.lastChild.textContent = fmtInt(def.tris) + ' tris · ' + def.parts.length + ' material' +
              (def.parts.length === 1 ? '' : 's');
            toast('Imported "' + def.label + '"', 'ok');
          })
          .catch(function (e) {
            card.classList.remove('busy');
            bar2.style.width = '0';
            meta.lastChild.textContent = e.message || 'Import failed';
            meta.lastChild.style.color = 'var(--danger)';
            toast(e.message || 'Import failed', 'err', 5000);
          });
      };
      return card;
    }

    go.onclick = function () { run(false); };
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(false); } e.stopPropagation(); });
    if (Browser.q) run(false);
  }, [{ label: 'Done', kind: 'pri', run: buildPanel }], { wide: true });
}

/* Download (or pull from cache), convert, register, and make it selectable. */
function importFromSketchfab(meta, kind, onProgress) {
  return acquireModel(meta.uid, { name: meta.name, author: meta.author, faces: meta.faces, license: meta.license }, onProgress)
    .then(function (buf) { return importGLB(buf, meta.name); })
    .then(function (model) {
      if (model.tris > 300000) {
        toast('"' + model.name + '" is ' + fmtInt(model.tris) + ' triangles — placing many copies will be slow', 'err', 6000);
      }
      var def = defImported(meta.uid, model, {
        label: meta.name, kind: kind, author: meta.author, license: meta.license,
        sway: kind === 'nature' ? 0.5 : 0,
        scale: 1
      });
      saveLibraryIndex();
      // select it straight away so the next click on the ground places it
      state.place.kind = meta.uid;
      state.place.kinds = [meta.uid];
      if (kind === 'person' || kind === 'vehicle') state.people.place = meta.uid;
      markSceneDirty();
      return def;
    });
}

/* ==========================================================================
   LIBRARY PANEL SECTION
   ========================================================================== */
/* One row per model: what it costs, which shelf it is on, how big and how
   much it moves in the wind. Everything a model needs, next to the model. */
function panelLibrary(host) {
  var b = addGroup(host, 'Your models');

  var ids = Object.keys(ASSETS);
  if (!ids.length) {
    addNote(b, 'Nothing here yet. Press <b>Add models</b> above to bring something in from Sketchfab.');
    return;
  }

  ids.sort(function (a, c) { return ASSETS[a].label.localeCompare(ASSETS[c].label); });

  ids.forEach(function (id) {
    var def = ASSETS[id];
    var row = el('div', 'lib');
    var cv = el('canvas');
    try { renderThumb(id, cv); } catch (e) {}
    row.appendChild(cv);
    var info = el('div', 'info');
    info.appendChild(el('b', null, def.label));
    info.appendChild(el('span', null, fmtInt(def.tris) + ' tris · ' + def.height.toFixed(1) + ' m tall'));
    row.appendChild(info);

    var del = el('button', 'ic');
    del.innerHTML = svgIcon(ICON.trash);
    del.setAttribute('data-tip', 'Throw this model away, along with every copy in the world');
    del.onclick = function () {
      confirmDialog('Throw away "' + def.label + '"?',
        'This takes the model out of your library and removes every copy of it in the world. The download stays in this browser, so bringing it back is instant.',
        'Throw it away', function () { removeImported(id); buildPanel(); toast('Removed ' + def.label); });
    };
    row.appendChild(del);
    b.appendChild(row);

    var cfg = el('div');
    b.appendChild(cfg);
    addSelect(cfg, {
      label: 'Shelf',
      get: function () { return def.kind; },
      set: function (v) {
        var objs = [];
        for (var i = 0; i < World.objs.length; i++) if (World.objs[i].kind === id) objs.push(World.objs[i]);
        def.kind = v;
        def.cat = 'imp_' + v;
        for (var k = 0; k < objs.length; k++) objs[k].cat = CAT_OF[v] || 'props';
        rebuildAssetCats();
        applyLayerVisibility();
        saveLibraryIndex();
        markSceneDirty();
      },
      tip: 'Which shelf you find this model on in the picker.',
      options: IMP_KINDS.map(function (k) { return { value: k.id, label: k.label }; })
    });
    addSlider(cfg, {
      label: 'True size', min: 0.05, max: 20, step: 0.01, dec: 2, def: 1, unit: '×',
      tip: 'Fixes a model that arrived at the wrong scale. Every copy already in the world changes with it.',
      get: function () { return def.scale; },
      set: function (v) { def.scale = v; saveLibraryIndex(); rescaleKind(id); markSceneDirty(); }
    });
    addSlider(cfg, {
      label: 'Sways in the wind', min: 0, max: 2, step: 0.01, dec: 2, def: 0,
      tip: 'How much this model bends in the same wind as the grass. Good for leaves, leave at 0 for solid things.',
      get: function () { return def.sway; },
      set: function (v) { def.sway = v; saveLibraryIndex(); reswayKind(id); markSceneDirty(); }
    });
  });

  var note = addNote(b, 'Models are kept in this browser, so reopening a world does not download them again.');
  sfCacheSize().then(function (n) {
    if (n > 0) note.textContent = 'Models are kept in this browser (' + (n / 1048576).toFixed(1) +
      ' MB), so reopening a world does not download them again.';
  });
}

function rescaleKind(id) {
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.kind !== id) continue;
    updateObject(o);
  }
}
function reswayKind(id) {
  var def = ASSETS[id];
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    if (o.kind !== id) continue;
    o.sway = def.sway;
    updateObject(o);
  }
}
/* ==========================================================================
   27. STARTER TEMPLATES + WORLD PERSISTENCE
   ========================================================================== */

function templateRoad(type, pts, deco) {
  state.road.type = type;
  applyRoadTypeDefaults();
  var rd = newRoad(type, pts);
  if (deco) { rd.deco.lights = !!deco.lights; rd.deco.trees = !!deco.trees; rd.deco.signs = !!deco.signs; }
  World.roads.push(rd);
  applyRoadToTerrain(rd);
  return rd;
}
function templateFinishRoads() {
  rebuildAllRoads();
  for (var i = 0; i < World.roads.length; i++) decorateRoad(World.roads[i]);
  rebuildAllRoads();
}
/* Place buildings along a road with a setback, alternating sides. */
function templateStreetBuildings(rd, kinds, spacing, sides, startAt) {
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
function templateScatter(kinds, count, cfg) {
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

function resetForTemplate(plate) {
  clearWorldObjects(null);
  World.roads.length = 0; World.paths.length = 0;
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
function finishTemplate(name) {
  syncGrassUniforms(); syncGroundUniforms(); syncEnvUniforms();
  applyLayerVisibility();
  // A brand-new world starts you at the first station, whatever you were
  // doing in the last one.
  clearSelection();
  state.world.mode = 'terrain';
  state.tool = 'sculpt';
  if (!modeHasTool('terrain', state.sculpt.mode)) state.sculpt.mode = 'raise';
  History.undo.length = 0; History.redo.length = 0; History.bytes = 0;
  refreshHistoryButtons();
  cam.frame(state.plate.width, state.plate.depth, Terrain.max);
  cam.tSph.ph = Math.PI * 0.36;
  cam.snap();
  buildRail(); buildPanel(); refreshUI(); refreshTopExtras(); updateBladeMeter();
  markSceneDirty();
  toast(name + ' is ready', 'ok', 3000);
}

var TEMPLATES = [
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
      var track = templateRoad('dirt', [{ x: -78, z: 20 }, { x: -20, z: 6 }, { x: 30, z: 16 }, { x: 78, z: 2 }], { trees: true });
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

function showTemplates() {
  openModal('Start a new world', function (body) {
    body.appendChild(el('p', null,
      'Each one builds a whole finished place — ground, lanes, buildings, planting and traffic — for you to change. ' +
      'It replaces whatever is in the world now, so save first if you want to keep it.'));
    var g = el('div', 'cards');
    TEMPLATES.forEach(function (t) {
      var c = el('button', 'card');
      c.appendChild(el('b', null, t.name));
      c.appendChild(el('span', null, t.desc));
      c.setAttribute('data-tip', 'Replace everything with ' + t.name);
      c.onclick = function () { closeModal(); setTimeout(function () { t.run(); }, 30); };
      g.appendChild(c);
    });
    body.appendChild(g);
  }, [{ label: 'Cancel' }]);
}

/* ==========================================================================
   WORLD PERSISTENCE — wraps the Phase 1 save/load so grass, terrain, roads
   and every placed object travel in one file.
   ========================================================================== */
var _serBase = serializeScene, _deserBase = deserializeScene;

serializeScene = function () {
  var o = _serBase();
  o.world = {
    nextId: World.nextId,
    roadId: Roads.nextId,
    pathId: Paths.nextId,
    layers: JSON.parse(JSON.stringify(LayerState)),
    roads: World.roads.map(serRoad),
    paths: World.paths.map(serPath),
    objs: World.objs.map(serObj),
    prefabs: World.prefabs
  };
  return o;
};

deserializeScene = function (obj) {
  // wipe the world first so the base loader's terrain rebuild has nothing
  // stale to re-project
  clearWorldObjects(null);
  clearAllLayers();
  World.roads.length = 0; World.paths.length = 0; World.prefabs.length = 0;
  World.objs.length = 0; World.byId = {}; OGrid.map = {};
  Sel.objs.length = 0; Sel.road = null;

  _deserBase(obj);

  var w = obj.world;
  if (w) {
    if (w.layers) for (var c in w.layers) if (LayerState[c]) {
      LayerState[c].vis = w.layers[c].vis !== false;
      LayerState[c].lock = !!w.layers[c].lock;
    }
    World.nextId = w.nextId || 1;
    Roads.nextId = w.roadId || 1;
    Paths.nextId = w.pathId || 1;
    if (w.roads) for (var r = 0; r < w.roads.length; r++) addRoadRecord(w.roads[r]);
    if (w.paths) for (var p = 0; p < w.paths.length; p++) addPathRecord(w.paths[p]);
    if (w.objs) for (var i = 0; i < w.objs.length; i++) deserObj(w.objs[i]);
    if (w.prefabs) World.prefabs = w.prefabs;
    // rewire decoration ownership so deleting a road still removes its lights
    for (var rr = 0; rr < World.roads.length; rr++) World.roads[rr].decoIds = [];
  }
  ogridRebuild();
  rebuildAllRoads();
  rebuildWater();
  applyLayerVisibility();
  syncEnvUniforms();
  state.world.mode = normalizeMode(state.world.mode);
  buildRail();
  buildPanel();
  refreshTopExtras();
  refreshUI();
  updateBladeMeter();
};
/* ==========================================================================
   14. INPUT
   ========================================================================== */
var Cursor = {
  sx: 0, sy: 0, over: false,
  world: new THREE.Vector3(), has: false,
  prev: new THREE.Vector3(), hasPrev: false,
  vx: 0, vz: 0
};
var Ptr = {
  ids: [],                 // active pointer ids, in order
  pos: {},                 // id -> {x, y}
  mode: null,              // 'stroke' | 'orbit' | 'pan' | 'pinch'
  lastX: 0, lastY: 0,
  pinchD: 0, pinchX: 0, pinchY: 0,
  strokeId: -1, primary: -1
};
var Keys = {
  space: false, alt: false, shift: false, ctrl: false, uiHidden: false,
  move: { f: false, b: false, l: false, r: false, u: false, d: false }
};
var _ballVel = { x: 0, z: 0 };

/* Which tool a stroke should use, taking modifier overrides into account. */
function effectiveTool() {
  if (Keys.alt) {
    if (state.tool === 'paint' || state.tool === 'smooth') return 'erase';
    if (state.tool === 'sculpt') return 'sculpt';   // handled via inverted mode
  }
  return state.tool;
}
function isPaintTool(t) {
  return t === 'paint' || t === 'erase' || t === 'smooth' || t === 'eyedropper' || t === 'sculpt';
}

function bindInput() {
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    Ptr.ids.push(e.pointerId);
    Ptr.pos[e.pointerId] = { x: e.clientX, y: e.clientY };
    Cursor.sx = e.offsetX; Cursor.sy = e.offsetY; Cursor.over = true;

    if (e.pointerType === 'touch' && Ptr.ids.length === 2) {
      endCurrentStroke();
      Ptr.mode = 'pinch';
      var a = Ptr.pos[Ptr.ids[0]], b = Ptr.pos[Ptr.ids[1]];
      Ptr.pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      Ptr.pinchX = (a.x + b.x) / 2; Ptr.pinchY = (a.y + b.y) / 2;
      return;
    }
    if (Ptr.ids.length > 1) return;

    Ptr.lastX = e.clientX; Ptr.lastY = e.clientY;

    var tool = effectiveTool();
    if (e.button === 1) { Ptr.mode = 'pan'; }
    else if (e.button === 2) { Ptr.mode = (state.tool === 'camera') ? 'pan' : 'orbit'; }
    else if (e.button === 0) {
      if (state.tool === 'camera' || Keys.space) { Ptr.mode = 'orbit'; canvas.classList.add('drag'); }
      else { Ptr.mode = 'stroke'; Ptr.strokeId = e.pointerId; startStroke(tool); }
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', function (e) {
    Cursor.sx = e.offsetX; Cursor.sy = e.offsetY; Cursor.over = true;
    if (Ptr.pos[e.pointerId]) { Ptr.pos[e.pointerId].x = e.clientX; Ptr.pos[e.pointerId].y = e.clientY; }

    if (Ptr.mode === 'pinch' && Ptr.ids.length >= 2) {
      var a = Ptr.pos[Ptr.ids[0]], b = Ptr.pos[Ptr.ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (Ptr.pinchD > 0) cam.dolly(clamp(Ptr.pinchD / Math.max(d, 1), 0.5, 2));
      cam.pan(mx - Ptr.pinchX, my - Ptr.pinchY);
      Ptr.pinchD = d; Ptr.pinchX = mx; Ptr.pinchY = my;
      return;
    }

    var dx = e.clientX - Ptr.lastX, dy = e.clientY - Ptr.lastY;
    Ptr.lastX = e.clientX; Ptr.lastY = e.clientY;

    if (Ptr.mode === 'orbit') { cam.orbit(dx, dy); return; }
    if (Ptr.mode === 'pan') { cam.pan(dx, dy); return; }
    if (Ptr.mode === 'stroke' && e.pointerId === Ptr.strokeId) {
      updateCursorWorld();
      if (Cursor.has) strokeTo(Cursor.world.x, Cursor.world.z);
    }
  });

  function up(e) {
    var i = Ptr.ids.indexOf(e.pointerId);
    if (i >= 0) Ptr.ids.splice(i, 1);
    delete Ptr.pos[e.pointerId];
    try { canvas.releasePointerCapture(e.pointerId); } catch (x) {}
    canvas.classList.remove('drag');
    if (Ptr.mode === 'stroke' && e.pointerId === Ptr.strokeId) endCurrentStroke();
    if (Ptr.ids.length === 0) Ptr.mode = null;
    else if (Ptr.mode === 'pinch' && Ptr.ids.length === 1) {
      Ptr.mode = null;
      var only = Ptr.pos[Ptr.ids[0]];
      if (only) { Ptr.lastX = only.x; Ptr.lastY = only.y; }
    }
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', function () { Cursor.over = false; });
  canvas.addEventListener('pointerenter', function () { Cursor.over = true; });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    cam.dolly(Math.exp(clamp(e.deltaY, -240, 240) * 0.0013));
  }, { passive: false });

  /* ---- file picker ---- */
  document.getElementById('filepick').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) loadSceneFile(e.target.files[0]);
    e.target.value = '';
  });

  /* ---- top bar buttons ---- */
  document.getElementById('b-undo').onclick = doUndo;
  document.getElementById('b-redo').onclick = doRedo;
  document.getElementById('b-save').onclick = saveScene;
  document.getElementById('b-load').onclick = function () { document.getElementById('filepick').click(); };
  document.getElementById('b-png').onclick = function () { exportPNG(1); };
  document.getElementById('b-keys').onclick = showShortcuts;
  document.getElementById('panel-toggle').onclick = togglePanel;
  document.getElementById('b-expand').onclick = function () {
    var any = false;
    for (var k in UI.sections) if (!UI.sections[k].classList.contains('open')) any = true;
    for (var k2 in UI.sections) {
      UI.sections[k2].classList.toggle('open', any);
      try { localStorage.setItem('grasspainter.sec.' + k2, any ? '1' : '0'); } catch (e) {}
    }
  };

  /* ---- keyboard ---- */
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') Keys.space = false;
    Keys.alt = e.altKey; Keys.shift = e.shiftKey;
  });
  window.addEventListener('blur', function () { Keys.space = Keys.alt = Keys.shift = false; });
}

function typingInField(e) {
  var t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
}

function onKeyDown(e) {
  Keys.alt = e.altKey; Keys.shift = e.shiftKey;
  if (e.code === 'Space') { Keys.space = true; if (!typingInField(e)) e.preventDefault(); }
  if (typingInField(e)) return;

  var mod = e.ctrlKey || e.metaKey;
  if (mod) {
    var k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (k === 'y') { e.preventDefault(); doRedo(); return; }
    if (k === 's') { e.preventDefault(); saveScene(); return; }
    if (k === 'o') { e.preventDefault(); document.getElementById('filepick').click(); return; }
    if (k === 'p') { e.preventDefault(); exportPNG(1); return; }
    if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); askClear(); return; }
    return;
  }

  switch (e.key) {
    case 'b': case 'B': setTool('paint'); return;
    case 'e': case 'E': setTool('erase'); return;
    case 's': case 'S': if (e.shiftKey) return; setTool('smooth'); return;
    case 'i': case 'I': setTool('eyedropper'); return;
    case 't': case 'T': setTool('sculpt'); return;
    case 'o': case 'O': setTool('ball'); return;
    case 'v': case 'V': setTool('camera'); return;
    case 'f': cam.frame(state.plate.width, state.plate.depth, Terrain.max); return;
    case 'F': fillPlate(); return;
    case 'g': case 'G':
      state.plate.grid = !state.plate.grid; syncGroundUniforms(); refreshUI(); markSceneDirty(); return;
    case '[': nudgeRadius(-1); return;
    case ']': nudgeRadius(1); return;
    case 'h': case 'H': toggleUI(); return;
    case 'Tab': e.preventDefault(); togglePanel(); return;
    case '?': showShortcuts(); return;
    case 'Escape': closeModal(); return;
  }
  if (e.key >= '1' && e.key <= '6') applyPreset(parseInt(e.key, 10) - 1);
}

function nudgeRadius(dir) {
  var r = state.brush.radius;
  var step = Math.max(0.1, r * 0.18);
  state.brush.radius = clamp(r + dir * step, 0.25, 24);
  refreshUI();
  markSceneDirty();
}
/* Below this width the panel is a drawer that slides over the world; above it
   the panel is part of the layout. The number has to be the one the stylesheet
   uses, so it is read from the same media query rather than written twice. */
var PANEL_DRAWER = window.matchMedia('(max-width:1120px)');
function togglePanel() {
  var p = document.getElementById('panel');
  if (PANEL_DRAWER.matches) {
    var open = p.classList.toggle('open');
    p.classList.remove('closed');
    if (!open) p.classList.add('closed');
  } else {
    p.classList.remove('open');
    p.classList.toggle('closed');
  }
}
function toggleUI() {
  Keys.uiHidden = !Keys.uiHidden;
  ['topbar', 'rail', 'panel', 'panel-toggle', 'hint'].forEach(function (id) {
    var e = document.getElementById(id);
    if (e) e.style.display = Keys.uiHidden ? 'none' : '';
  });
  resize();
}

/* ==========================================================================
   STROKES
   ========================================================================== */
var _strokeTool = 'paint', _lastStampTime = 0;

function startStroke(tool) {
  _strokeTool = tool;
  updateCursorWorld();
  if (!Cursor.has) { Ptr.mode = null; return; }
  Brush.hasLast = false;
  Brush.leftover = 0;
  Brush.start.copy(Cursor.world);
  Brush.axis = 0;
  _lastStampTime = nowMs();

  if (tool === 'eyedropper') { eyedrop(Cursor.world.x, Cursor.world.z); Ptr.mode = null; return; }
  if (state.tool === 'ball') {
    moveBall(Cursor.world.x, Cursor.world.z);
    return;
  }
  beginStroke(tool === 'erase' ? 'Erase' : tool === 'smooth' ? 'Smooth' :
              tool === 'sculpt' ? 'Sculpt' : 'Paint');
  strokeAt(Cursor.world.x, Cursor.world.z);
  Brush.last.copy(Cursor.world);
  Brush.hasLast = true;
}

function endCurrentStroke() {
  if (Ptr.mode !== 'stroke') return;
  if (_strokeTool !== 'eyedropper' && state.tool !== 'ball') endStroke();
  Brush.hasLast = false;
  Ptr.mode = null;
  Ptr.strokeId = -1;
  updateBladeMeter();
}

/* Interpolate along the stroke so a fast drag never leaves gaps. */
function strokeTo(x, z) {
  if (state.tool === 'ball') { moveBall(x, z); return; }
  if (_strokeTool === 'eyedropper') return;

  if (Keys.shift) {
    if (!Brush.axis) {
      var ax = Math.abs(x - Brush.start.x), az = Math.abs(z - Brush.start.z);
      if (Math.max(ax, az) > state.brush.radius * 0.4) Brush.axis = ax > az ? 1 : 2;
    }
    if (Brush.axis === 1) z = Brush.start.z;
    else if (Brush.axis === 2) x = Brush.start.x;
  } else Brush.axis = 0;

  var spacing = state.brush.radius * (_strokeTool === 'paint' ? 0.2 : 0.34);
  if (!Brush.hasLast) { strokeAt(x, z); Brush.last.set(x, 0, z); Brush.hasLast = true; return; }

  var dx = x - Brush.last.x, dz = z - Brush.last.z;
  var dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-6) return;
  var travel = dist + Brush.leftover;
  var steps = Math.floor(travel / spacing);
  if (steps > 400) steps = 400;                    // sanity cap on a huge jump
  var ux = dx / dist, uz = dz / dist;
  var walked = spacing - Brush.leftover;
  for (var s = 0; s < steps; s++) {
    strokeAt(Brush.last.x + ux * walked, Brush.last.z + uz * walked);
    walked += spacing;
  }
  Brush.leftover = travel - steps * spacing;
  Brush.last.set(x, 0, z);
}

function strokeAt(x, z) {
  var now = nowMs();
  var dt = clamp((now - _lastStampTime) / 1000, 0.001, 0.1);
  _lastStampTime = now;
  var t = _strokeTool;
  if (t === 'paint') paintStamp(x, z, 1);
  else if (t === 'erase') Brush.eraseQueue.push({ x: x, z: z, r: state.brush.radius, r2: state.brush.radius * state.brush.radius, p: state.brush.flow * 1.4 + 0.25 });
  else if (t === 'smooth') smoothStamp(x, z, dt);
  else if (t === 'sculpt') {
    var m = state.brush.sculpt, inv = Keys.alt;
    if (inv) state.brush.sculpt = (m === 'raise') ? 'lower' : (m === 'lower' ? 'raise' : m);
    sculptStamp(x, z, dt);
    state.brush.sculpt = m;
  }
}

function moveBall(x, z) {
  var r = state.interact.ballRadius;
  _ballVel.x = x - ball.position.x;
  _ballVel.z = z - ball.position.z;
  ball.position.set(x, heightAt(x, z) + r, z);
}

/* Re-project the last screen position onto the ground every frame, so the
   brush preview stays correct while the camera moves. */
function updateCursorWorld() {
  screenRay(Cursor.sx, Cursor.sy);
  Cursor.prev.copy(Cursor.world);
  var hit = raycastGround(_rayO, _rayD, Cursor.world);
  if (hit) {
    if (Cursor.has) { Cursor.vx = Cursor.world.x - Cursor.prev.x; Cursor.vz = Cursor.world.z - Cursor.prev.z; }
    Cursor.has = true;
  } else {
    Cursor.has = false; Cursor.vx = Cursor.vz = 0;
  }
  return Cursor.has;
}
/* ==========================================================================
   28. INPUT — one grammar, everywhere
   --------------------------------------------------------------------------
     click        place or pick
     drag         shape / plant / scatter
     Alt          the other way (dig instead of raise, rub out instead of add)
     [ ]          brush size
     R            turn what you are about to place
     Esc          cancel
   ========================================================================== */
var Pending = { ptDrag: null, marquee: null, gizmo: null, ramp: null, lastClick: 0 };
var Ghost = { meshes: [], kind: null, rot: 0, scale: 1 };
var Marquee = null;

function isSculptMode() { return state.world.mode === 'terrain'; }
function isBrushTool(t) {
  return t === 'paint' || t === 'erase' || t === 'smooth' || t === 'eyedropper' ||
         t === 'sculpt' || t === 'place_many' || t === 'place_erase';
}
function isPaintTool(t) { return isBrushTool(t); }
function isPlaceTool(t) { return t === 'place_one'; }
function effectiveTool() {
  var t = state.tool;
  if (Keys.alt) {
    if (t === 'paint' || t === 'smooth') return 'erase';
    if (t === 'place_many') return 'place_erase';
  }
  return t;
}
function ghostKind() {
  return state.world.mode === 'place' ? state.place.kind : null;
}
function placeKinds() {
  var out = [];
  for (var i = 0; i < state.place.kinds.length; i++)
    if (ASSETS[state.place.kinds[i]]) out.push(state.place.kinds[i]);
  if (!out.length && ASSETS[state.place.kind]) out.push(state.place.kind);
  return out;
}
function currentPrefab() {
  var k = state.place.kind;
  if (!k || k.indexOf('pf') !== 0) return null;
  for (var i = 0; i < World.prefabs.length; i++) if (World.prefabs[i].id === k) return World.prefabs[i];
  return null;
}

/* ---- ghost preview -------------------------------------------------------
   An imported model is several merged materials, so the ghost is one mesh per
   part sharing a single transform.
   -------------------------------------------------------------------------- */
function disposeGhost() {
  for (var i = 0; i < Ghost.meshes.length; i++) {
    scene.remove(Ghost.meshes[i]);
    Ghost.meshes[i].geometry.dispose();
    Ghost.meshes[i].material.dispose();
  }
  Ghost.meshes.length = 0;
  Ghost.kind = null;
}
function ensureGhost(kind) {
  if (Ghost.kind === kind && Ghost.meshes.length) return true;
  disposeGhost();
  var def = kind && ASSETS[kind];
  if (!def) return false;
  for (var p = 0; p < def.parts.length; p++) {
    var part = def.parts[p], base = part.geo;
    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('normal', base.attributes.normal);
    g.setAttribute('uv', base.attributes.uv);
    if (base.index) g.setIndex(base.index);
    var d = { iPosSeed: [0, 0, 0, 0.5], iQuat: [0, 0, 0, 1], iSclSway: [1, 1, 1, 0],
              iTint: [1, 1, 1], iAnim: [0, 0, 0, 0] };
    for (var n in d) g.setAttribute(n, new THREE.InstancedBufferAttribute(new Float32Array(d[n]), d[n].length));
    g.instanceCount = 1;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    var mesh = new THREE.Mesh(g, makeImpMaterial(def, part, p, true));
    mesh.frustumCulled = false;
    mesh.renderOrder = 60;
    scene.add(mesh);
    Ghost.meshes.push(mesh);
  }
  Ghost.kind = kind;
  return true;
}
var _ghostQ = new THREE.Quaternion();
function updateGhost() {
  var kind = ghostKind();
  var show = isPlaceTool(state.tool) && kind && ASSETS[kind] && Cursor.over && Cursor.has &&
             Ptr.mode !== 'orbit' && Ptr.mode !== 'pan' && Ptr.mode !== 'look';
  if (!show) {
    for (var h = 0; h < Ghost.meshes.length; h++) Ghost.meshes[h].visible = false;
    return;
  }
  if (!ensureGhost(kind)) return;
  var def = ASSETS[kind];
  var res = resolvePlacement(kind, Cursor.world.x, Cursor.world.z);
  var rot = (def.kind === 'building' && state.build.snap === 'road' && res.snapped)
    ? res.rotY : (Ghost.rot + state.build.rotation * DEG);
  var sc = Ghost.scale * (def.scale || 1) * state.place.size;
  _ghostQ.setFromAxisAngle(_upV, rot);
  var y = heightAt(res.x, res.z);
  for (var i = 0; i < Ghost.meshes.length; i++) {
    var a = Ghost.meshes[i].geometry.attributes;
    a.iPosSeed.array[0] = res.x; a.iPosSeed.array[1] = y; a.iPosSeed.array[2] = res.z;
    a.iQuat.array[0] = _ghostQ.x; a.iQuat.array[1] = _ghostQ.y;
    a.iQuat.array[2] = _ghostQ.z; a.iQuat.array[3] = _ghostQ.w;
    a.iSclSway.array[0] = a.iSclSway.array[1] = a.iSclSway.array[2] = sc;
    a.iPosSeed.needsUpdate = true; a.iQuat.needsUpdate = true; a.iSclSway.needsUpdate = true;
    Ghost.meshes[i].visible = true;
  }
}

function cancelPending() {
  Pending.ptDrag = null; Pending.ramp = null;
  if (Marquee) Marquee.style.display = 'none';
  Pending.marquee = null;
}

/* ==========================================================================
   POINTER
   ========================================================================== */
function bindInput() {
  Marquee = document.getElementById('marquee');
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('pointerdown', function (e) {
    // A lost pointerup (window blur, capture stolen, alert) used to strand
    // Ptr.mode and jam the camera in look mode. Starting a fresh gesture with
    // no buttons held resets the bookkeeping.
    if (e.buttons === 0 || Ptr.ids.length === 0) { Ptr.ids.length = 0; Ptr.pos = {}; Ptr.mode = null; Ptr.primary = -1; }
    canvas.setPointerCapture(e.pointerId);
    Ptr.ids.push(e.pointerId);
    if (Ptr.primary < 0) Ptr.primary = e.pointerId;
    Ptr.pos[e.pointerId] = { x: e.clientX, y: e.clientY };
    Cursor.sx = e.offsetX; Cursor.sy = e.offsetY; Cursor.over = true;

    if (e.pointerType === 'touch' && Ptr.ids.length === 2) {
      endCurrentStroke();
      Ptr.mode = 'pinch';
      var a = Ptr.pos[Ptr.ids[0]], b = Ptr.pos[Ptr.ids[1]];
      Ptr.pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      Ptr.pinchX = (a.x + b.x) / 2; Ptr.pinchY = (a.y + b.y) / 2;
      return;
    }
    if (Ptr.ids.length > 1) return;
    Ptr.lastX = e.clientX; Ptr.lastY = e.clientY;

    if (e.button === 1) { Ptr.mode = 'pan'; e.preventDefault(); return; }
    if (e.button === 2) { Ptr.mode = 'look'; canvas.classList.add('drag'); e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (Keys.space) { Ptr.mode = 'orbit'; canvas.classList.add('drag'); e.preventDefault(); return; }

    updateCursorWorld();
    var now = nowMs();
    var dbl = (now - Pending.lastClick) < 320;
    Pending.lastClick = now;
    Ptr.mode = 'tool';
    Ptr.strokeId = e.pointerId;
    onToolDown(e, dbl);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', function (e) {
    Cursor.sx = e.offsetX; Cursor.sy = e.offsetY; Cursor.over = true;
    if (Ptr.pos[e.pointerId]) { Ptr.pos[e.pointerId].x = e.clientX; Ptr.pos[e.pointerId].y = e.clientY; }

    if (Ptr.mode === 'pinch' && Ptr.ids.length >= 2) {
      var a = Ptr.pos[Ptr.ids[0]], b = Ptr.pos[Ptr.ids[1]];
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (Ptr.pinchD > 0) cam.dolly(clamp(Ptr.pinchD / Math.max(d, 1), 0.5, 2));
      cam.pan(mx - Ptr.pinchX, my - Ptr.pinchY);
      Ptr.pinchD = d; Ptr.pinchX = mx; Ptr.pinchY = my;
      return;
    }
    var dx = e.clientX - Ptr.lastX, dy = e.clientY - Ptr.lastY;
    Ptr.lastX = e.clientX; Ptr.lastY = e.clientY;
    if (Ptr.mode === 'look') { cam.look(dx, dy); return; }
    if (Ptr.mode === 'orbit') { cam.orbit(dx, dy); return; }
    if (Ptr.mode === 'pan') { cam.pan(dx, dy); return; }
    if (Ptr.mode === 'tool') { onToolMove(e, dx, dy); return; }
  });

  function up(e) {
    var i = Ptr.ids.indexOf(e.pointerId);
    if (i >= 0) Ptr.ids.splice(i, 1);
    delete Ptr.pos[e.pointerId];
    try { canvas.releasePointerCapture(e.pointerId); } catch (x) {}
    canvas.classList.remove('drag');
    if (Ptr.mode === 'tool') onToolUp(e);
    // the gesture ends when the pointer that started it is released
    if (Ptr.ids.length === 0 || e.pointerId === Ptr.primary) { Ptr.mode = null; Ptr.primary = Ptr.ids.length ? Ptr.ids[0] : -1; }
    else if (Ptr.mode === 'pinch' && Ptr.ids.length === 1) {
      Ptr.mode = null;
      var only = Ptr.pos[Ptr.ids[0]];
      if (only) { Ptr.lastX = only.x; Ptr.lastY = only.y; }
    }
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  window.addEventListener('pointerup', function (e) { if (Ptr.ids.indexOf(e.pointerId) >= 0) up(e); });
  window.addEventListener('blur', function () {
    if (Ptr.mode === 'tool') endCurrentStroke();
    Ptr.ids.length = 0; Ptr.pos = {}; Ptr.mode = null; Ptr.primary = -1;
    canvas.classList.remove('drag');
  });
  canvas.addEventListener('pointerleave', function () { Cursor.over = false; });
  canvas.addEventListener('pointerenter', function () { Cursor.over = true; });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    // while holding right-mouse to look around, the wheel trims fly speed
    if (Ptr.mode === 'look') {
      state.cam.flySpeed = clamp(state.cam.flySpeed * Math.exp(-e.deltaY * 0.0012), 1, 400);
      toast('Fly speed ' + state.cam.flySpeed.toFixed(0) + ' m/s', null, 900, 'flyspeed');
      refreshUI();
      return;
    }
    // The wheel always drives the camera — that is what makes flying around
    // feel effortless. Turning the ghost is on R and Alt+wheel instead.
    if (e.altKey && isPlaceTool(state.tool) && ghostKind()) {
      if (e.shiftKey) Ghost.scale = clamp(Ghost.scale * Math.exp(-e.deltaY * 0.0012), 0.15, 8);
      else Ghost.rot += (e.deltaY > 0 ? 1 : -1) * (Math.PI / 12);
      updateGhost();
      return;
    }
    cam.dolly(Math.exp(clamp(e.deltaY, -240, 240) * 0.0013));
  }, { passive: false });

  document.getElementById('filepick').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) loadSceneFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('b-undo').onclick = doUndo;
  document.getElementById('b-redo').onclick = doRedo;
  document.getElementById('b-save').onclick = saveScene;
  document.getElementById('b-load').onclick = function () { document.getElementById('filepick').click(); };
  document.getElementById('b-png').onclick = function () { exportPNG(1); };
  document.getElementById('panel-toggle').onclick = togglePanel;

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') Keys.space = false;
    Keys.alt = e.altKey; Keys.shift = e.shiftKey; Keys.ctrl = e.ctrlKey || e.metaKey;
    setMoveKey(e, false);
    refreshHint();
  });
  window.addEventListener('blur', function () {
    Keys.space = Keys.alt = Keys.shift = Keys.ctrl = false;
    Keys.move.f = Keys.move.b = Keys.move.l = Keys.move.r = Keys.move.u = Keys.move.d = false;
    refreshHint();
  });
}

/* ---- tool dispatch ------------------------------------------------------- */
function onToolDown(e, dbl) {
  var mode = state.world.mode, tool = effectiveTool();

  if (mode === 'select') {
    var hit = gizmoHit(Cursor.sx, Cursor.sy);
    if (hit) { Pending.gizmo = hit; Pending.gizmo.before = snapshotSelection(); return; }
    if (!Cursor.has) { clearSelection(); return; }
    var o = pickObject(Cursor.sx, Cursor.sy);
    if (o) { selectObjects([o], e.shiftKey); refreshSelectionUI(); return; }
    var rd = pickRoad(Cursor.world.x, Cursor.world.z);
    if (rd) { selectRoad(rd); refreshSelectionUI(); return; }
    Pending.marquee = { x0: Cursor.sx, y0: Cursor.sy, add: e.shiftKey };
    Marquee.style.display = 'block';
    if (!e.shiftKey) clearSelection();
    return;
  }

  if (!Cursor.has) return;

  if (mode === 'place' && state.tool === 'place_one') {
    var kind = state.place.kind;
    if (!kind) { toast('Pick a model first — or press Add models', null, 2600); return; }
    beginStroke('Place');
    var made = [];
    var pf = currentPrefab();
    if (pf) made = stampPrefab(pf, Cursor.world.x, Cursor.world.z, Ghost.rot);
    else {
      var o2 = placeObjectAt(kind, Cursor.world.x, Cursor.world.z, { rotY: undefined });
      if (o2) {
        var def = ASSETS[kind];
        if (!(def && def.kind === 'building' && state.build.snap === 'road')) {
          o2.rotY = Ghost.rot + state.build.rotation * DEG;
        }
        o2.scale = Ghost.scale * o2.scale;
        updateObject(o2);
        made = [o2];
      }
    }
    if (made.length) recordObjAdd(made);
    endStroke();
    markSceneDirty();
    return;
  }

  // brush-style tools
  if (isSculptMode() && state.sculpt.mode === 'ramp') {
    Pending.ramp = true;
    beginStroke('Ramp');
    Sculpt.snap = Terrain.sculpt.slice();
    beginSculptStroke(Cursor.world.x, Cursor.world.z);
    return;
  }
  startStroke(tool);
}

function onToolMove(e, dx, dy) {
  if (Pending.gizmo) { dragGizmo(e, dx, dy); return; }
  if (Pending.marquee) {
    var m = Marquee, q = Pending.marquee;
    var x0 = Math.min(q.x0, Cursor.sx), y0 = Math.min(q.y0, Cursor.sy);
    m.style.left = x0 + 'px'; m.style.top = y0 + 'px';
    m.style.width = Math.abs(Cursor.sx - q.x0) + 'px';
    m.style.height = Math.abs(Cursor.sy - q.y0) + 'px';
    return;
  }
  updateCursorWorld();
  if (Ptr.strokeId === e.pointerId && Cursor.has && Ptr.mode === 'tool' && !Pending.ramp)
    strokeTo(Cursor.world.x, Cursor.world.z);
}

function onToolUp(e) {
  if (Pending.gizmo) {
    commitSelectionChange(Pending.gizmo.before, 'Transform');
    Pending.gizmo = null;
    return;
  }
  if (Pending.marquee) {
    var q = Pending.marquee;
    Marquee.style.display = 'none';
    if (Math.abs(Cursor.sx - q.x0) > 4 && Math.abs(Cursor.sy - q.y0) > 4)
      boxSelect(q.x0, q.y0, Cursor.sx, Cursor.sy, q.add);
    Pending.marquee = null;
    refreshSelectionUI();
    return;
  }
  if (Pending.ramp) {
    Pending.ramp = null;
    if (Cursor.has) applyRamp(Cursor.world.x, Cursor.world.z);
    endSculptStroke();
    endStroke();
    markSceneDirty();
    return;
  }
  endCurrentStroke();
}

/* ---- gizmo dragging ------------------------------------------------------ */
var _gizPlane = new THREE.Vector3();
function dragGizmo(e, dx, dy) {
  var g = Pending.gizmo;
  if (g.mode === 'move') {
    if (g.axis === 'y') {
      moveSelection(0, -dy * gizmoScale(g.center) * 0.012, 0);
    } else {
      updateCursorWorld();
      if (!Cursor.has) return;
      var tx = Cursor.world.x - g.center.x, tz = Cursor.world.z - g.center.z;
      if (g.axis === 'x') tz = 0;
      else if (g.axis === 'z') tx = 0;
      moveSelection(tx, 0, tz);
      g.center = selectionCenter();
    }
  } else if (g.mode === 'rotate') {
    _projV.set(g.center.x, g.center.y, g.center.z).project(camera);
    var cx = (_projV.x * 0.5 + 0.5) * viewW, cy = (-_projV.y * 0.5 + 0.5) * viewH;
    var a = Math.atan2(Cursor.sy - cy, Cursor.sx - cx);
    var d = a - g.start;
    g.start = a;
    rotateSelection(-d);
  } else {
    scaleSelection(Math.exp(-dy * 0.006));
  }
}

/* ---- strokes ------------------------------------------------------------- */
var _strokeTool = 'paint', _lastStampTime = 0;
function startStroke(tool) {
  _strokeTool = tool;
  updateCursorWorld();
  if (!Cursor.has) { Ptr.mode = null; return; }
  Brush.hasLast = false;
  Brush.leftover = 0;
  Brush.start.copy(Cursor.world);
  Brush.axis = 0;
  _lastStampTime = nowMs();

  if (tool === 'eyedropper') { eyedrop(Cursor.world.x, Cursor.world.z); Ptr.mode = null; return; }
  if (tool === 'place_many' && !placeKinds().length) {
    toast('Pick a model first — or press Add models', null, 2600);
    Ptr.mode = null; return;
  }

  var label = 'Paint';
  if (tool === 'erase') label = 'Erase grass';
  else if (tool === 'smooth') label = 'Even out';
  else if (tool === 'sculpt') label = 'Shape the ground';
  else if (tool === 'place_many') label = 'Scatter';
  else if (tool === 'place_erase') label = 'Remove';
  beginStroke(label);
  if (tool === 'sculpt') { Sculpt.snap = Terrain.sculpt.slice(); beginSculptStroke(Cursor.world.x, Cursor.world.z); }
  strokeAt(Cursor.world.x, Cursor.world.z);
  Brush.last.copy(Cursor.world);
  Brush.hasLast = true;
}
function endCurrentStroke() {
  if (Ptr.mode !== 'tool') return;
  if (_strokeTool === 'sculpt') endSculptStroke();
  if (_strokeTool !== 'eyedropper') {
    if (_strokeAdded.length) { recordObjAdd(_strokeAdded); _strokeAdded.length = 0; }
    endStroke();
  }
  Brush.hasLast = false;
  Ptr.mode = null;
  Ptr.strokeId = -1;
  updateBladeMeter();
  refreshUI();
}
function strokeTo(x, z) {
  if (_strokeTool === 'eyedropper') return;
  if (Keys.shift) {
    if (!Brush.axis) {
      var ax = Math.abs(x - Brush.start.x), az = Math.abs(z - Brush.start.z);
      if (Math.max(ax, az) > state.brush.radius * 0.4) Brush.axis = ax > az ? 1 : 2;
    }
    if (Brush.axis === 1) z = Brush.start.z;
    else if (Brush.axis === 2) x = Brush.start.x;
  } else Brush.axis = 0;

  var spacing = state.brush.radius * (_strokeTool === 'paint' ? 0.2 : 0.34);
  if (!Brush.hasLast) { strokeAt(x, z); Brush.last.set(x, 0, z); Brush.hasLast = true; return; }
  var dx = x - Brush.last.x, dz = z - Brush.last.z;
  var dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1e-6) return;
  var travel = dist + Brush.leftover;
  var steps = Math.min(Math.floor(travel / spacing), 400);
  var ux = dx / dist, uz = dz / dist;
  var walked = spacing - Brush.leftover;
  for (var s = 0; s < steps; s++) {
    strokeAt(Brush.last.x + ux * walked, Brush.last.z + uz * walked);
    walked += spacing;
  }
  Brush.leftover = travel - steps * spacing;
  Brush.last.set(x, 0, z);
}

var _strokeAdded = [];
function strokeAt(x, z) {
  var now = nowMs();
  var dt = clamp((now - _lastStampTime) / 1000, 0.001, 0.1);
  _lastStampTime = now;
  var t = _strokeTool;

  if (t === 'paint') paintStamp(x, z, 1);
  else if (t === 'erase') Brush.eraseQueue.push({ x: x, z: z, r: state.brush.radius, r2: state.brush.radius * state.brush.radius, p: state.brush.flow * 1.4 + 0.25 });
  else if (t === 'smooth') smoothStamp(x, z, dt);
  else if (t === 'sculpt') sculptStamp(x, z, dt);
  else if (t === 'place_many') {
    var made = scatterStamp(x, z, state.nature, placeKinds());
    for (var i = 0; i < made.length; i++) _strokeAdded.push(made[i]);
  } else if (t === 'place_erase') {
    eraseWorldStamp(x, z, state.brush.radius, state.eraseMask);
    if (state.eraseMask.grass)
      Brush.eraseQueue.push({ x: x, z: z, r: state.brush.radius, r2: state.brush.radius * state.brush.radius, p: 1 });
  }
}

/* ==========================================================================
   KEYBOARD
   ========================================================================== */
/* WASD + QE are held-state, not one-shot, so they are tracked separately from
   the command shortcuts below and integrated every frame. */
var MOVE_CODES = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', KeyE: 'u', KeyQ: 'd' };
function setMoveKey(e, down) {
  var slot = MOVE_CODES[e.code];
  if (!slot) return false;
  if (down && (e.ctrlKey || e.metaKey || e.altKey)) return false;  // let Ctrl+S etc through
  Keys.move[slot] = down;
  return true;
}

function onKeyDown(e) {
  Keys.alt = e.altKey; Keys.shift = e.shiftKey; Keys.ctrl = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { Keys.space = true; if (!typingInField(e)) e.preventDefault(); }
  refreshHint();
  if (typingInField(e)) return;
  if (setMoveKey(e, true)) { e.preventDefault(); return; }

  var mod = e.ctrlKey || e.metaKey;
  if (mod) {
    var k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (k === 'y') { e.preventDefault(); doRedo(); return; }
    if (k === 's') { e.preventDefault(); saveScene(); return; }
    if (k === 'o') { e.preventDefault(); document.getElementById('filepick').click(); return; }
    if (k === 'p') { e.preventDefault(); exportPNG(1); return; }
    if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (k === 'a') {
      e.preventDefault();
      var all = World.objs.filter(function (o) { return !LayerState[o.cat].lock && LayerState[o.cat].vis; });
      setMode('select'); selectObjects(all, false); refreshSelectionUI();
      return;
    }
    if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); askClear(); return; }
    return;
  }

  if (e.key >= '1' && e.key <= '4' && !e.shiftKey) { setMode(MODES[parseInt(e.key, 10) - 1].id); return; }
  if (e.shiftKey && e.key >= '!' && e.key <= '^') {
    var map = { '!': 0, '@': 1, '#': 2, '$': 3, '%': 4, '^': 5 };
    if (map[e.key] !== undefined) { applyPreset(map[e.key]); return; }
  }

  switch (e.key) {
    case 'Escape':
      if (Tour.on) { endTour(); return; }
      if (_modal) { closeModal(); return; }
      cancelPending(); clearSelection(); refreshSelectionVisuals();
      return;
    case 'Delete': case 'Backspace': deleteSelection(); return;
    case 'x': case 'X': cycleTool(); return;
    case 'r': Ghost.rot += Math.PI / 12; updateGhost(); return;
    case 'R': Ghost.rot -= Math.PI / 12; updateGhost(); return;
    case 'f': focusSelection(); return;
    case 'F': fillPlate(); return;
    case 'p': case 'P': toggleSimulate(); return;
    case 'g': case 'G':
      state.plate.grid = !state.plate.grid; syncGroundUniforms(); refreshUI(); markSceneDirty(); return;
    case '[': nudgeRadius(-1); return;
    case ']': nudgeRadius(1); return;
    case 'h': case 'H': toggleUI(); return;
    case 'Tab': e.preventDefault(); togglePanel(); return;
    case '?': showShortcuts(); return;
    case 'ArrowLeft': nudgeSel(-1, 0); e.preventDefault(); return;
    case 'ArrowRight': nudgeSel(1, 0); e.preventDefault(); return;
    case 'ArrowUp': nudgeSel(0, -1); e.preventDefault(); return;
    case 'ArrowDown': nudgeSel(0, 1); e.preventDefault(); return;
  }
}
function cycleTool() {
  var list = allTools(state.world.mode);
  if (!list.length) return;
  var cur = currentTool();
  var i = 0;
  for (var k = 0; k < list.length; k++) if (list[k].id === cur) i = k;
  setTool(list[(i + 1) % list.length].id);
}
function nudgeSel(dx, dz) {
  if (!Sel.objs.length) return;
  var n = state.sel.nudge;
  var before = snapshotSelection();
  moveSelection(dx * n, 0, dz * n);
  commitSelectionChange(before, 'Nudge');
}
function nudgeRadius(dir) {
  var r = state.brush.radius;
  state.brush.radius = clamp(r + dir * Math.max(0.1, r * 0.18), 0.25, 40);
  refreshUI();
  markSceneDirty();
}

/* ---- shortcut list ------------------------------------------------------- */
SHORTCUTS = [
  ['Stations', [
    ['1', 'Terrain'], ['2', 'Grass'], ['3', 'Place'], ['4', 'Select'],
    ['X', 'Next brush in this station'], ['Tab', 'Hide or show the settings'], ['H', 'Hide everything']
  ]],
  ['Working', [
    ['Click', 'Place, or pick'], ['Drag', 'Shape, plant or scatter'],
    ['Alt', 'The other way — dig, or rub out'], ['[  ]', 'Brush size'],
    ['Shift Drag', 'Keep the stroke to one straight line'],
    ['R', 'Turn what you are about to place'],
    ['Alt Scroll', 'Turn it with the wheel'], ['Alt Shift Scroll', 'Resize it'],
    ['Esc', 'Cancel']
  ]],
  ['Flying', [
    ['W A S D', 'Forward, left, back, right'],
    ['E  Q', 'Up and down'],
    ['Shift', 'Faster'],
    ['Right-drag', 'Look around'],
    ['Right-drag Scroll', 'Change fly speed'],
    ['Middle-drag', 'Slide sideways'], ['Space drag', 'Orbit'],
    ['Scroll', 'Forward and back'],
    ['F', 'Fly to what is picked, or to the whole world'],
    ['Two fingers', 'Pinch to zoom, drag to slide']
  ]],
  ['Picking things', [
    ['Click', 'Pick'], ['Shift click', 'Add to what is picked'], ['Drag', 'Lasso'],
    ['Ctrl A', 'Pick everything'], ['Ctrl D', 'Duplicate'], ['Del', 'Delete'],
    ['Arrows', 'Shift it a little']
  ]],
  ['Your world', [
    ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo'], ['Ctrl S', 'Save a file'],
    ['Ctrl O', 'Open a file'], ['Ctrl P', 'Save a picture'], ['P', 'Freeze or unfreeze everything'],
    ['Shift F', 'Fill the world with grass'], ['Ctrl Shift Del', 'Clear the grass'],
    ['G', 'Measuring grid'], ['Shift 1-6', 'Grass looks'], ['?', 'This list']
  ]]
];
/* ==========================================================================
   15. MAIN LOOP
   ========================================================================== */
var _last = 0, _time = 0;
var _fpsAcc = 0, _fpsN = 0, _statT = 0;

function tick(dt) {
  // The Simulate toggle freezes wind, water, people and traffic together by
  // simply not advancing the shared clock.
  var sim = state.world.simulate ? dt : 0;
  _time += sim;
  Grass.mat.uniforms.uTime.value = _time;
  if (Water.mat) Water.mat.uniforms.uTime.value = _time;
  for (var m = 0; m < ROAD_MAT_LIST.length; m++) {
    var rm = Roads.meshes[ROAD_MAT_LIST[m]];
    if (rm) rm.material.uniforms.uTime.value = _time;
  }

  var it = state.interact;

  /* ---- cursor -> ground, and its influence on the push field ---- */
  if (Cursor.over) updateCursorWorld();
  var speedScale = 1 / Math.max(dt, 1e-3) * 0.02;
  if (Cursor.over && Cursor.has && Ptr.mode !== 'orbit' && Ptr.mode !== 'pan') {
    pushInfluence(
      Cursor.world.x, Cursor.world.z, it.radius, it.strength,
      clamp(Cursor.vx * speedScale, -3, 3), clamp(Cursor.vz * speedScale, -3, 3)
    );
  }

  /* ---- interactive ball ---- */
  ball.visible = it.ball;
  if (it.ball) {
    var r = it.ballRadius;
    ball.scale.setScalar(r);
    ball.position.y = heightAt(ball.position.x, ball.position.z) + r;
    pushInfluence(ball.position.x, ball.position.z, r * 1.75, it.strength * 1.6,
      clamp(_ballVel.x * speedScale, -3, 3), clamp(_ballVel.z * speedScale, -3, 3));
    _ballVel.x *= 0.55; _ballVel.z *= 0.55;
  }

  updateField(dt);

  /* ---- world systems ---- */
  updateActors(sim);
  waterTick(nowMs());
  updateGhost();

  /* ---- brush preview ring ---- */
  var t = effectiveTool();
  var showRing = Cursor.over && Cursor.has && isBrushTool(t) &&
                 Ptr.mode !== 'orbit' && Ptr.mode !== 'pan' && !Keys.uiHidden;
  updateRing(Cursor.world.x, Cursor.world.z, state.brush.radius, showRing);
  if (showRing) {
    var c = ring.material.uniforms.uColor.value;
    if (t === 'erase' || t === 'place_erase') c.set(0.95, 0.42, 0.34);
    else if (t === 'smooth') c.set(0.42, 0.68, 0.98);
    else if (t === 'sculpt') c.set(1.0, 0.70, 0.24);
    else if (t === 'eyedropper') c.set(0.78, 0.55, 0.98);
    else if (t === 'place_many') c.set(0.56, 0.75, 0.32);
    else c.set(0.49, 0.85, 0.34);
  }

  /* ---- buffer maintenance ---- */
  flushErase();
  flushGrass();
  flushLayers();
  uploadDensity();

  cam.flyStep(dt);
  cam.update(dt);
  // the gizmo is sized in screen space, so it has to track the camera
  if (Sel.objs.length && state.world.mode === 'select') refreshGizmo();
}

function renderFrame() {
  var su = sky.material.uniforms;
  su.uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
  renderer.render(scene, camera);
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!_last) _last = now;
  var dt = clamp((now - _last) / 1000, 0.0001, 0.1);
  _last = now;

  tick(dt);
  renderFrame();

  _fpsAcc += dt; _fpsN++;
  _statT += dt;
  if (_statT > 0.3) {
    // The frame counter is only worth showing to someone who went looking
    // for it, so it lives in the World sheet and is painted only when open.
    paintWorldReadout(_fpsN / Math.max(_fpsAcc, 1e-6));
    _fpsAcc = 0; _fpsN = 0; _statT = 0;
    updateBladeMeter();
  }

  autosaveTick(now);
}

/* ==========================================================================
   BOOT
   ========================================================================== */
function boot() {
  try {
    initRenderer();
    initField();
    createScene();
    createGrass();
    createRoads();
    createWater();
    createSelectionVisuals();
    initThumbs();

    buildTopExtras();
    initTooltips();
    bindInput();

    syncGrassUniforms();
    syncGroundUniforms();
    syncEnvUniforms();
    syncRoadUniforms();

    buildRail();
    buildPanel();

    /* Scripting handle — useful for automating scenes or debugging from the
       console. The UI never reads from it. */
    window.GP = {
      get state() { return state; },
      get bladeCount() { return Grass.count; },
      get objectCount() { return World.objs.length; },
      preset: applyPreset, presets: PRESETS,
      templates: TEMPLATES,
      template: function (which) {
        var t = (typeof which === 'number') ? TEMPLATES[which]
          : TEMPLATES.filter(function (x) { return x.id === which; })[0];
        if (t) t.run();
        return t ? t.name : null;
      },
      fill: fillPlate, clear: clearAll,
      undo: doUndo, redo: doRedo,
      mode: setMode, tool: setTool, quality: setQuality,
      paintAt: function (x, z) { beginStroke('Paint'); paintStamp(x, z, 1); endStroke(); },
      eraseAt: function (x, z, r) {
        beginStroke('Erase');
        Brush.eraseQueue.push({ x: x, z: z, r: r, r2: r * r, p: 1 });
        flushErase(); endStroke();
      },
      smoothAt: function (x, z, dt) { beginStroke('Smooth'); smoothStamp(x, z, dt || 0.05); endStroke(); },
      sculptAt: function (x, z, dt) { beginStroke('Sculpt'); Sculpt.snap = Terrain.sculpt.slice(); beginSculptStroke(x, z); sculptStamp(x, z, dt || 0.05); endSculptStroke(); endStroke(); },
      addObject: addObject, deleteObject: deleteObject, scatterStamp: scatterStamp,
      road: function (type, pts, deco) { var rd = templateRoad(type, pts, deco); templateFinishRoads(); return rd; },
      populate: populateWorld,
      select: selectObjects, selection: Sel,
      world: World, layers: Layers, assets: ASSETS,
      sketchfab: {
        browse: showSketchfabBrowser,
        search: sfSearch,
        setToken: sfSaveToken,
        import: importFromSketchfab,
        remove: removeImported,
        cacheSize: sfCacheSize,
        library: function () {
          var out = [];
          for (var id in ASSETS) out.push({ uid: id, label: ASSETS[id].label, kind: ASSETS[id].kind,
                                            tris: ASSETS[id].tris, parts: ASSETS[id].parts.length });
          return out;
        }
      },
      serialize: serializeScene, deserialize: deserializeScene,
      internals: { scene: scene, renderer: renderer, grass: Grass, terrain: Terrain,
                   field: Field, env: Env, roads: Roads, water: Water, camera: camera,
                   cam: cam, ptr: Ptr, cursor: Cursor, keys: Keys },
      sync: function () { syncGrassUniforms(); syncGroundUniforms(); syncEnvUniforms(); syncRoadUniforms(); refreshUI(); },
      rebuildPlate: rebuildPlate,
      frame: function () { cam.frame(state.plate.width, state.plate.depth, Terrain.max); cam.snap(); },
      camera: function (r, th, ph) {
        if (r !== undefined) cam.tSph.r = r;
        if (th !== undefined) cam.tSph.th = th;
        if (ph !== undefined) cam.tSph.ph = ph;
        cam.snap();
      }
    };

    // The model library has to come back before the scene does — a saved
    // object references a model UID, and an unknown UID is skipped.
    sfLoadToken();
    var bootMsg = document.getElementById('boot-msg');
    restoreLibrary(function (i, n, label) {
      if (bootMsg) bootMsg.textContent = 'Loading model ' + i + ' of ' + n + ' — ' + label;
    }).then(function (n) {
      if (bootMsg) bootMsg.textContent = 'Building scene';
      rebuildAssetCats();
      startScene(n);
    }, function () { rebuildAssetCats(); startScene(0); });

    function startScene(libCount) {
    restoreAutosave(function (restored) {
      if (!restored) {
        // First run: build a complete little world so the tool demonstrates
        // itself instead of opening on an empty plate.
        TEMPLATES[1].run();
        History.undo.length = 0; History.redo.length = 0; History.bytes = 0;
      }
      state.world.mode = normalizeMode(state.world.mode);
      applyLayerVisibility();
      buildRail();
      buildPanel();
      refreshHint();
      refreshUI();
      updateBladeMeter();
      refreshHistoryButtons();
      refreshTopExtras();

      var bootEl = document.getElementById('boot');
      bootEl.classList.add('out');
      setTimeout(function () { bootEl.style.display = 'none'; }, 320);

      requestAnimationFrame(loop);

      if (!state.world.seenIntro) setTimeout(function () { startTour(0); }, 700);
      else if (libCount === 0 && !Object.keys(ASSETS).length) {
        setTimeout(function () {
          toast('Nothing to place yet — open Place and press Add models', 'ok', 5000);
        }, 800);
      }
    });
    }
  } catch (err) {
    document.getElementById('boot').style.display = 'none';
    var n = document.getElementById('nogl');
    n.querySelector('h2').textContent = 'Something went wrong while starting up';
    n.querySelector('p').textContent = String(err && err.message ? err.message : err);
    n.style.display = 'flex';
    throw err;
  }
}

boot();

} /* ---- end of __GP_MAIN__ ---- */

window.__GP_START__();
