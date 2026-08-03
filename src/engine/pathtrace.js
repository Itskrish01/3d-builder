import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';
import { ASSETS } from './assets.js';
import { emit, ui } from './host.js';
import { renderFrame } from './loop.js';
import { Env, camera, renderer, updateEnv } from './renderer.js';
import { state } from './state.js';
import { Terrain } from './terrain.js';
import { Water } from './water.js';
import { World } from './world.js';

/* ==========================================================================
   30. PATH TRACING
   --------------------------------------------------------------------------
   A real ray tracer, by way of three-gpu-pathtracer: rays are traced against a
   BVH in a fragment shader, one sample per frame, accumulating until the noise
   settles. Light bounces, so shadows are cast by everything, surfaces pick up
   colour from what is next to them, and glass and metal behave like glass and
   metal.

   It is a *still* render rather than a mode you build in, and that is not a
   shortcut — a path tracer needs hundreds of samples per pixel to converge,
   which is seconds to minutes, so nothing you could paint in. You build in the
   fast view and then take a photograph of it.

   THE PART THAT MATTERS: nothing in this engine is a THREE.Mesh. Every blade,
   every house, every metre of ground is drawn by a custom shader that computes
   its vertices on the GPU from instance attributes, a heightfield texture and
   noise. A BVH is built on the CPU from real triangles, so a path tracer
   handed this scene would see one model at the origin and an empty plane. So
   the scene is *baked* here: every placed object becomes a real Mesh at its
   real transform with a real material, and the terrain hands over the vertex
   buffer it already keeps on the CPU. That bake is this file.
   ========================================================================== */

export var PT = {
  active: false,        // a render is running or finished on screen
  building: false,      // baking the scene / building the BVH
  compiling: false,     // the tracer's own shader, which is not quick
  samples: 0,
  target: 0,            // samples to stop at; 0 means keep going
  tris: 0,
  meshes: 0,
  skipped: 0,           // things that could not be traced, for honesty
  error: '',
  startedAt: 0
};

var tracer = null;
var ptScene = null;
var ptCamera = null;
var built = [];         // everything to dispose when we stop
var savedOutput = null;

/* Every shader in this engine tone maps and gamma-encodes itself, so the
   renderer is left in linear with no tone mapping. The tracer's final blit
   does the opposite — it hands three a linear HDR buffer and expects the
   renderer's own output stage to finish it. Left alone, a trace comes out
   near-black. So the renderer is switched over for the duration and put back
   afterwards; our own materials are ShaderMaterials, which three does not
   touch with either setting, so the fast view is unaffected either way. */
function takeOutputStage() {
  if (savedOutput) return;
  savedOutput = {
    encoding: renderer.outputEncoding,
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure
  };
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = state.env.exposure;
}
function releaseOutputStage() {
  if (!savedOutput) return;
  renderer.outputEncoding = savedOutput.encoding;
  renderer.toneMapping = savedOutput.toneMapping;
  renderer.toneMappingExposure = savedOutput.exposure;
  savedOutput = null;
}

/* WebGL2 is not optional here: the tracer stores the BVH in integer textures
   and reads them with texelFetch. */
export function canPathTrace() {
  return !!(renderer && renderer.capabilities && renderer.capabilities.isWebGL2);
}

/* The tracer is built against a newer three than the one this engine is
   pinned to, and wants exactly four things that arrived after it:

     Scene.backgroundRotation / environmentRotation / environmentIntensity  (r163)
     WebGLRenderer.compileAsync                                             (r152)

   It reads the scene fields from its own constructor, on a scene of its own,
   so there is no object of ours to put them on. Every other renderer method it
   touches — twenty-three of them — already exists here. Four small definitions
   are a far better trade than dragging the whole app across thirty versions of
   three, which would flip colour management on and silently double-decode
   every imported texture. */
var shimmed = false;
function shimForTracer() {
  if (shimmed) return;
  shimmed = true;

  if (typeof renderer.compileAsync !== 'function') {
    // r152's version compiles, then polls KHR_parallel_shader_compile. Without
    // that extension both are synchronous anyway, so the promise is honest.
    renderer.compileAsync = function (scene, camera, target) {
      this.compile(scene, camera, target);
      return Promise.resolve(scene);
    };
  }

  var proto = THREE.Scene.prototype;
  function lazy(name, make) {
    if (name in proto) return;
    var key = '_gp_' + name;
    Object.defineProperty(proto, name, {
      configurable: true,
      get: function () {
        if (this[key] === undefined) this[key] = make();
        return this[key];
      },
      set: function (v) { this[key] = v; }
    });
  }
  lazy('backgroundRotation', function () { return new THREE.Euler(); });
  lazy('environmentRotation', function () { return new THREE.Euler(); });
  lazy('environmentIntensity', function () { return 1; });
}

/* ---- the bake ------------------------------------------------------------ */

/* The raster path decodes base-colour maps itself, in the shader, so the
   textures are handed to WebGL as plain linear data. The tracer expects three
   to do that decode, which means the same texture has to be uploaded a second
   time under sRGB. Cloning shares the decoded image and costs only the upload.
*/
var texClones = new Map();
function sRGBClone(tex) {
  if (!tex) return null;
  if (texClones.has(tex)) return texClones.get(tex);
  var c = tex.clone();
  c.encoding = THREE.sRGBEncoding;
  c.needsUpdate = true;
  texClones.set(tex, c);
  return c;
}

function partMaterial(part) {
  var col = part.color || [1, 1, 1];
  var map = sRGBClone(part.tex);

  /* An unlit material's lighting is already painted into its texture. There is
     no such thing in a physical renderer, so it becomes a surface that emits
     exactly what it would have shown — which is what it looked like. */
  if (part.unlit) {
    return new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: new THREE.Color(col[0], col[1], col[2]),
      emissiveMap: map,
      emissiveIntensity: 1,
      map: map,
      transparent: !!part.alphaTest,
      alphaTest: part.alphaTest || 0,
      side: THREE.DoubleSide,
      vertexColors: !!part.vcol
    });
  }

  var em = part.emissive || [0, 0, 0];
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(col[0], col[1], col[2]),
    map: map,
    metalness: part.metalness === undefined ? 0 : part.metalness,
    roughness: part.roughness === undefined ? 0.75 : part.roughness,
    // A metallic-roughness map is measurements, not colour — it stays linear.
    metalnessMap: part.mrTex || null,
    roughnessMap: part.mrTex || null,
    emissive: new THREE.Color(em[0], em[1], em[2]),
    emissiveMap: sRGBClone(part.emissiveTex),
    transparent: !!part.alphaTest,
    alphaTest: part.alphaTest || 0,
    side: THREE.DoubleSide,
    vertexColors: !!part.vcol
  });
}

/* The ground the tracer sees is the same vertex buffer the rasteriser draws —
   terrain height lives in a CPU array here, not in a displacement map, which
   is the one piece of luck in this whole exercise. */
function bakeTerrain(scene) {
  if (!Terrain.geo || !Terrain.geo.attributes.position) return;
  var p = state.plate;
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Terrain.geo.attributes.position.array.slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(Terrain.geo.attributes.normal.array.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(Terrain.geo.index.array.slice(), 1));

  /* Slope and altitude decide the ground colour in the terrain shader. Baking
     the same rules to vertex colours keeps rock on the cliffs and snow on the
     tops instead of flooding the whole plate with one green. */
  var mat = new THREE.MeshStandardMaterial({ roughness: Math.max(0.35, p.roughness), metalness: 0 });
  if (p.autoTex && p.mode === 'terrain') {
    var pos = g.attributes.position.array, nrm = g.attributes.normal.array;
    var n = pos.length / 3;
    var cols = new Float32Array(n * 3);
    var grass = new THREE.Color(p.grassColor), rock = new THREE.Color(p.rockColor);
    var snow = new THREE.Color(p.snowColor), c = new THREE.Color();
    var hi = -1e9, lo = 1e9;
    for (var i = 0; i < n; i++) { var y = pos[i * 3 + 1]; if (y > hi) hi = y; if (y < lo) lo = y; }
    var span = Math.max(hi - lo, 1e-3);
    for (var v = 0; v < n; v++) {
      var slope = 1 - Math.min(1, Math.max(0, nrm[v * 3 + 1]));
      var alt = (pos[v * 3 + 1] - lo) / span;
      c.copy(grass);
      c.lerp(rock, Math.min(1, Math.max(0, (slope - p.rockSlope) / Math.max(p.rockBlend, 0.01))));
      if (p.snowOn) c.lerp(snow, Math.min(1, Math.max(0, (alt - p.snowline) / Math.max(p.snowBlend, 0.05))));
      cols[v * 3] = c.r; cols[v * 3 + 1] = c.g; cols[v * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    mat.vertexColors = true;
  } else {
    mat.color = new THREE.Color(p.baseColor);
  }

  var mesh = new THREE.Mesh(g, mat);
  scene.add(mesh);
  built.push(g, mat);
  PT.tris += g.index.count / 3;
  PT.meshes++;
}

/* Every placed object, at its own transform. The object already carries the
   quaternion and scale the instance buffer uses, so the bake cannot drift out
   of step with what you were just looking at. */
var _m4 = new THREE.Matrix4(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _s3 = new THREE.Vector3();
function bakeObjects(scene) {
  var matCache = new Map();
  for (var i = 0; i < World.objs.length; i++) {
    var o = World.objs[i];
    var def = ASSETS[o.kind];
    if (!def || !def.parts || !def.parts.length) { PT.skipped++; continue; }

    _v3.set(o.x, o.y, o.z);
    _q.set(o.qx, o.qy, o.qz, o.qw);
    _s3.set(o.sx, o.sy, o.sz);
    _m4.compose(_v3, _q, _s3);

    for (var k = 0; k < def.parts.length; k++) {
      var part = def.parts[k];
      if (!part.geo || !part.geo.attributes.position) continue;
      var key = o.kind + ':' + k;
      var mat = matCache.get(key);
      if (!mat) { mat = partMaterial(part); matCache.set(key, mat); built.push(mat); }

      var mesh = new THREE.Mesh(part.geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(_m4);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.updateMatrixWorld(true);
      scene.add(mesh);
      PT.meshes++;
      if (part.geo.index) PT.tris += part.geo.index.count / 3;
    }
  }
}

function bakeWater(scene) {
  if (!state.water || !state.water.on || !Water.geo || !Water.geo.attributes.position) return;
  var g = Water.geo.clone();
  /* Water is the one surface a path tracer really pays off on — it is doing
     the refraction and the reflection for real rather than approximating both.
   */
  var mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(state.water.color || '#2d6f8f'),
    roughness: 0.06, metalness: 0, transmission: 0.92, thickness: 1.4, ior: 1.333
  });
  var mesh = new THREE.Mesh(g, mat);
  scene.add(mesh);
  built.push(g, mat);
  PT.meshes++;
}

/* The sky is the light. Handing the tracer the same gradient the sky shader
   draws means the render is lit by the time of day you set, not by a studio
   preset that would look nothing like the view you took it from. */
function bakeEnvironment(scene) {
  updateEnv();
  var grad = new GradientEquirectTexture(1024);
  grad.topColor.setRGB(Env.zenith.x, Env.zenith.y, Env.zenith.z);
  grad.bottomColor.setRGB(Env.horizon.x, Env.horizon.y, Env.horizon.z);
  grad.exponent = 1.6;
  grad.update();
  scene.environment = grad;
  scene.background = state.env.sky ? grad : null;
  built.push(grad);

  var sun = new THREE.DirectionalLight();
  sun.color.setRGB(Env.sun.x, Env.sun.y, Env.sun.z);
  sun.intensity = 1;
  sun.position.copy(Env.sunDir).multiplyScalar(500);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);
  built.push(sun);
}

/* ---- driving it ---------------------------------------------------------- */

export function startRender(opt) {
  opt = opt || {};
  if (PT.building) return;
  stopRender();

  if (!canPathTrace()) {
    PT.error = 'Ray tracing needs WebGL2, which this browser is not giving us.';
    emit('pathtrace');
    return;
  }

  PT.building = true;
  PT.error = '';
  PT.samples = 0; PT.tris = 0; PT.meshes = 0; PT.skipped = 0;
  PT.target = opt.target || 0;
  PT.startedAt = Date.now();
  emit('pathtrace');

  /* Building the BVH blocks, and a frozen tab with no explanation is worse
     than a slow one, so let the "building" state paint first. */
  setTimeout(function () {
    try {
      ptScene = new THREE.Scene();
      built = [];
      bakeEnvironment(ptScene);
      bakeTerrain(ptScene);
      bakeObjects(ptScene);
      bakeWater(ptScene);

      if (PT.meshes === 0) {
        PT.error = 'There is nothing in the world to trace yet.';
        PT.building = false; PT.active = false;
        emit('pathtrace');
        return;
      }

      ptCamera = camera.clone();
      ptCamera.matrixAutoUpdate = true;
      ptCamera.position.copy(camera.position);
      ptCamera.quaternion.copy(camera.quaternion);
      ptCamera.fov = camera.fov;
      ptCamera.aspect = camera.aspect;
      ptCamera.updateProjectionMatrix();
      ptCamera.updateMatrixWorld(true);

      takeOutputStage();
      shimForTracer();
      tracer = new WebGLPathTracer(renderer);
      tracer.renderScale = opt.scale === undefined ? 1 : opt.scale;
      tracer.bounces = opt.bounces === undefined ? 5 : opt.bounces;
      tracer.filterGlossyFactor = 0.5;
      tracer.multipleImportanceSampling = true;
      tracer.renderToCanvas = true;
      /* Until enough samples land, the tracer shows a fallback — by default it
         rasterises its own baked scene, which means three compiling a standard
         material for geometry that has no second UV set, which does not
         compile. Show our own view instead: the warm-up looks like the thing
         you were just looking at, and three never sees those materials. */
      tracer.rasterizeSceneCallback = function () { renderFrame(); };
      tracer.setScene(ptScene, ptCamera);

      PT.building = false;
      PT.active = true;
      emit('pathtrace');
    } catch (e) {
      // The message alone is never enough to act on a bake failure.
      console.error('[pathtrace] scene build failed', e);
      PT.error = (e && e.message) || 'The scene could not be prepared for tracing.';
      PT.building = false;
      PT.active = false;
      releaseOutputStage();
      disposeBuilt();
      emit('pathtrace');
    }
  }, 30);
}

/* One sample. The loop calls this instead of the raster render while a render
   is up, so the canvas shows the accumulating image rather than flickering
   between two pictures of the same thing. */
export function renderStep() {
  if (!tracer || !PT.active) return false;
  try {
    /* Reaching the target stops the *accumulating*, not the drawing. Returning
       early instead left the finished picture undrawn and the canvas black —
       the one moment the whole feature exists for. */
    tracer.pausePathTracing = !!(PT.target && PT.samples >= PT.target);
    tracer.renderSample();
    /* The path tracing shader is thousands of lines and compiles on first use,
       which is seconds of nothing happening. Saying so beats a frozen zero. */
    var c = !!tracer.isCompiling;
    if (c !== PT.compiling) { PT.compiling = c; emit('pathtrace'); }
    var s = Math.floor(tracer.samples);
    if (s !== PT.samples) {
      PT.samples = s;
      emit('pathtrace');
    }
  } catch (e) {
    PT.error = (e && e.message) || 'The trace failed part way through.';
    PT.active = false;
    emit('pathtrace');
  }
  return true;
}

function disposeBuilt() {
  for (var i = 0; i < built.length; i++) {
    var b = built[i];
    if (b && typeof b.dispose === 'function') b.dispose();
  }
  built = [];
  texClones.forEach(function (t) { t.dispose(); });
  texClones.clear();
  if (ptScene) ptScene.clear();
  ptScene = null;
  ptCamera = null;
}

export function stopRender() {
  if (tracer) { try { tracer.dispose(); } catch (e) { /* already gone */ } tracer = null; }
  releaseOutputStage();
  disposeBuilt();
  var was = PT.active || PT.building;
  PT.active = false;
  PT.building = false;
  PT.samples = 0;
  if (was) emit('pathtrace');
}

/* The render only exists in the drawing buffer, so it has to be read back in
   the same frame it was drawn. */
export function saveRender(name) {
  if (!PT.active || !tracer) { ui.toast('Nothing rendered yet', 'err'); return; }
  requestAnimationFrame(function () {
    tracer.renderSample();
    var url;
    try { url = renderer.domElement.toDataURL('image/png'); }
    catch (e) { ui.toast('The image could not be read back', 'err'); return; }
    var a = document.createElement('a');
    a.href = url;
    a.download = (name || 'render') + '-' + PT.samples + 'spp.png';
    a.click();
    ui.toast('Saved ' + a.download);
  });
}
