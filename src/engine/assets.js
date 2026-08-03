import * as THREE from 'three';
import { disposeModel, importGLB } from './gltf.js';
import { Grass } from './grass.js';
import { Layers } from './layers.js';
import { Env } from './renderer.js';
import { GLSL_COLOR, GLSL_FOG, GLSL_NOISE } from './shaders.js';
import { sfCacheGet, sfCachePut, sfDownloadGLB } from './sketchfab.js';
import { Q, state } from './state.js';
import { World, deleteObject } from './world.js';

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
export var IMP_VS = GLSL_NOISE + `
attribute vec4 iPosSeed;
attribute vec4 iQuat;
attribute vec4 iSclSway;
attribute vec3 iTint;
attribute vec4 iAnim;
attribute float aVid;
attribute vec3 aVCol;
uniform float uHasVCol;

uniform sampler2D uVatTex;
uniform vec2  uVatSize;
uniform float uVat, uVatPlay, uVatVerts, uVatStart, uVatCount, uVatRate;
uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindStrength, uWindSpeed, uTurbulence, uWaveScale;
uniform float uGustScale, uGustSpeed, uGustStrength;
uniform float uDrawDist, uFadeK, uAnimDist, uSimulate, uGhost, uModelH;

varying vec3 vN, vW, vTint, vVCol;
varying vec2 vUv;
varying float vSel, vFade;

vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

/* One texel per vertex per frame, addressed as a flat run so a model with more
   vertices than a texture is wide still fits. */
vec3 vatAt(float frame){
  float i = frame * uVatVerts + aVid;
  vec2 uv = (vec2(mod(i, uVatSize.x), floor(i / uVatSize.x)) + 0.5) / uVatSize;
  return texture2D(uVatTex, uv).xyz;
}

void main(){
  vec3 root = iPosSeed.xyz;
  float seed = iPosSeed.w;

  float dist = distance(root, cameraPosition);
  if (dist > uDrawDist){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vFade = 1.0 - smoothstep(uDrawDist * uFadeK, uDrawDist, dist);

  vec3 p = position;

  if (uVat > 0.5 && uVatPlay > 0.5 && dist < uAnimDist){
    // iAnim.x is a per-copy random phase, so a crowd does not march in step.
    float ph = fract(iAnim.x * 0.15915494 + uTime * uVatRate * uSimulate);
    float f = ph * uVatCount;
    float f0 = floor(f);
    float f1 = mod(f0 + 1.0, uVatCount);
    p = mix(vatAt(uVatStart + f0), vatAt(uVatStart + f1), f - f0);
  } else if (iAnim.y > 0.0 && dist < uAnimDist){
    // Gentle idle motion for anything given a non-zero rate; no skeleton is
    // involved, so this is deliberately subtle.
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
  // An absent attribute reads as zero, which would render the model black, so
  // the flag decides rather than the attribute.
  vVCol = mix(vec3(1.0), aVCol, uHasVCol);
  vSel = iAnim.w;
  vUv = uv;
  vN = n;
  vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export var IMP_FS = GLSL_COLOR + GLSL_FOG + `
uniform sampler2D uMap, uMRMap, uEmisMap;
uniform float uHasMap, uHasMR, uHasEmis, uAlphaTest, uGhost, uExposure, uAmbient;
uniform float uMetal, uRough, uUnlit, uFill;
uniform vec3 uColor, uEmissive, uSunDir, uSunColor, uSkyColor, uGroundColor;
varying vec3 vN, vW, vTint, vVCol;
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
  base.rgb *= vTint * vVCol;   // COLOR_0 is authored linear, so no decode

  vec3 emis = uEmissive;
  if (uHasEmis > 0.5) emis *= pow(texture2D(uEmisMap, vUv).rgb, vec3(2.2));

  /* An unlit material carries its lighting already painted into the texture.
     Lighting it a second time is what makes those models turn up muddy, so the
     only thing left to do is fog and tone map it. */
  if (uUnlit > 0.5){
    vec3 flat_ = gp_fog(base.rgb + emis, length(cameraPosition - vW));
    vec4 fo = gp_out(flat_, uExposure);
    fo.a = uGhost > 0.5 ? 0.55 : vFade;
    gl_FragColor = fo;
    return;
  }

  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);

  /* Close to how the model was authored: metal/rough response, a GGX
     highlight, Fresnel, and the sky/ground gradient standing in for an
     environment probe. Not a full IBL — there is no HDR map to sample — but it
     is the difference between "plastic" and something that reads as the
     material it was made as. */
  // glTF packs roughness in green and metalness in blue, each multiplying its
  // factor. Without the map, a model whose factors defaulted to 1 shades as
  // solid metal — no diffuse at all, just a dark tint of its own albedo.
  float rough = uRough, metal = uMetal;
  if (uHasMR > 0.5){
    vec3 mr = texture2D(uMRMap, vUv).rgb;
    rough *= mr.g;
    metal *= mr.b;
  }
  rough = clamp(rough, 0.045, 1.0);
  metal = clamp(metal, 0.0, 1.0);
  float a2 = rough * rough;

  vec3 albedo = base.rgb;
  vec3 diffCol = albedo * (1.0 - metal);
  vec3 specCol = mix(vec3(0.04), albedo, metal);

  // Sun. A little wrap keeps the terminator from going black, but far less
  // than before, which is where the flat look came from.
  float ndl = max(0.0, dot(N, uSunDir));
  float wrap = 0.12;
  float diffuseTerm = (ndl + wrap) / (1.0 + wrap);

  vec3 Hv = normalize(uSunDir + V);
  float ndh = max(0.0, dot(N, Hv));
  float ndv = max(1e-3, dot(N, V));
  float vdh = max(1e-3, dot(V, Hv));

  // GGX normal distribution, with Schlick-Smith visibility folded in.
  float dDenom = ndh * ndh * (a2 * a2 - 1.0) + 1.0;
  float D = (a2 * a2) / max(3.14159 * dDenom * dDenom, 1e-5);
  float k = a2 * 0.5;
  float vis = 0.5 / max(mix(2.0 * ndl * ndv, ndl + ndv, k), 1e-4);
  vec3 F = specCol + (1.0 - specCol) * pow(1.0 - vdh, 5.0);
  vec3 sunSpec = F * D * vis * ndl;

  // Environment: the same gradient the sky is drawn from, sampled along the
  // normal for diffuse and along the reflection for specular, blurred toward
  // the average as roughness rises.
  vec3 R = reflect(-V, N);
  float up = N.y * 0.5 + 0.5;
  vec3 envDiff = mix(uGroundColor, uSkyColor, up) * uAmbient;

  /* Studio fill. An outdoor sky lights the side facing away from the sun at
     about a third of the sunlit side — physically right, and nothing like the
     even light a model was shown under wherever it came from, which is why an
     imported tree lands in the scene reading as a darker, more saturated green
     than the one you picked. This adds back a near-uniform environment, so
     what you get is the colour the model was authored with. */
  vec3 fillCol = mix(uGroundColor, uSkyColor, 0.5) + vec3(0.25);
  envDiff += fillCol * uFill * (0.55 + 0.45 * up);

  vec3 envSpecDir = mix(uGroundColor, uSkyColor, R.y * 0.5 + 0.5);
  vec3 envAvg = mix(uGroundColor, uSkyColor, 0.5);
  vec3 envSpec = mix(envSpecDir, envAvg, rough) * uAmbient;
  float fresnelEnv = pow(1.0 - ndv, 5.0);
  vec3 envF = specCol + (max(vec3(1.0 - rough), specCol) - specCol) * fresnelEnv;

  vec3 lit = diffCol * (uSunColor * diffuseTerm + envDiff)
           + uSunColor * sunSpec
           + envSpec * envF
           + emis;

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
export var ASSETS = {};
export var ASSET_CATS = [];
export var LIB_KEY = 'grasspainter.library.v1';

export var IMP_KINDS = [
  { id: 'building', label: 'Buildings', cat: 'buildings' },
  { id: 'nature',   label: 'Nature',    cat: 'nature' },
  { id: 'prop',     label: 'Props',     cat: 'props' },
  { id: 'person',   label: 'People',    cat: 'people' },
  { id: 'vehicle',  label: 'Vehicles',  cat: 'vehicles' }
];

export function rebuildAssetCats() {
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
export function defImported(uid, model, opt) {
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
    imported: true,
    anim: model.anim || null,
    clipCount: model.clipCount || 0,
    animPlay: opt.animPlay !== undefined ? !!opt.animPlay : !!model.anim,
    animClip: opt.animClip || 0,
    animSpeed: opt.animSpeed === undefined ? 1 : opt.animSpeed
  };
  ASSETS[uid] = def;
  rebuildAssetCats();
  return def;
}

export function removeImported(uid) {
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
export function assetKey() { return ''; }
export function assetGeometry(kind, partIndex) {
  var d = ASSETS[kind];
  if (!d || !d.parts || !d.parts[partIndex || 0]) return null;
  return d.parts[partIndex || 0].geo;
}
export function assetPartCount(kind) {
  var d = ASSETS[kind];
  return d && d.parts ? d.parts.length : 0;
}
export function assetPalette() { return [[1, 1, 1], [1, 1, 1], [1, 1, 1]]; }

/* ==========================================================================
   MATERIALS — one per (model, part) so each can carry its own texture and,
   for small detail parts, its own shorter draw distance.
   ========================================================================== */
export var ImpMat = { shared: null, list: [] };

export function impSharedUniforms() {
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
    uFill: { value: 0.5 },
    uExposure: { value: 1.05 },
    uFogColor: { value: new THREE.Vector3() },
    uFogDensity: { value: 0.0075 },
    uAnimDist: { value: 90 },
    uSimulate: { value: 1 }
  };
  return ImpMat.shared;
}

/* The animation half of a material's uniforms. A model with no baked clips
   still declares them — uVat 0 means the branch is never taken. */
export function vatUniforms(def, part) {
  var vat = part && part.vat;
  var clip = vat && def && def.anim ? def.anim.clips[Math.min(def.animClip || 0, def.anim.clips.length - 1)] : null;
  return {
    uVatTex: { value: vat ? vat.tex : null },
    uVatSize: { value: new THREE.Vector2(vat ? vat.w : 1, vat ? vat.h : 1) },
    uVat: { value: vat ? 1 : 0 },
    uVatPlay: { value: (vat && def && def.animPlay) ? 1 : 0 },
    uVatVerts: { value: vat ? vat.verts : 1 },
    uVatStart: { value: clip ? clip.start : 0 },
    uVatCount: { value: clip ? clip.count : 1 },
    uVatRate: { value: clip ? ((def.animSpeed || 1) / Math.max(clip.duration, 0.05)) : 0 }
  };
}



/* Push the model's current playback choice into every material drawing it. */
export function applyAnimSettings(kind) {
  var def = ASSETS[kind];
  if (!def) return;
  for (var i = 0; i < Layers.list.length; i++) {
    var L = Layers.list[i];
    if (L.kind !== kind) continue;
    var u = L.mesh.material.uniforms;
    if (!u || !u.uVat) continue;
    var next = vatUniforms(def, def.parts[L.partIndex]);
    u.uVatPlay.value = next.uVatPlay.value;
    u.uVatStart.value = next.uVatStart.value;
    u.uVatCount.value = next.uVatCount.value;
    u.uVatRate.value = next.uVatRate.value;
  }
}

export function makeImpMaterial(def, part, partIndex, ghost) {
  var shared = impSharedUniforms(), u = {};
  for (var k in shared) u[k] = shared[k];
  u.uMap = { value: part.tex || null };
  u.uHasMap = { value: part.tex ? 1 : 0 };
  u.uAlphaTest = { value: part.alphaTest || 0 };
  u.uColor = { value: new THREE.Vector3(part.color[0], part.color[1], part.color[2]) };
  u.uMetal = { value: part.metalness === undefined ? 0 : part.metalness };
  u.uRough = { value: part.roughness === undefined ? 0.75 : part.roughness };
  u.uMRMap = { value: part.mrTex || null };
  u.uHasMR = { value: part.mrTex ? 1 : 0 };
  var em = part.emissive || [0, 0, 0];
  u.uEmissive = { value: new THREE.Vector3(em[0], em[1], em[2]) };
  u.uEmisMap = { value: part.emissiveTex || null };
  u.uHasEmis = { value: part.emissiveTex ? 1 : 0 };
  u.uHasVCol = { value: part.vcol ? 1 : 0 };
  u.uUnlit = { value: part.unlit ? 1 : 0 };
  u.uModelH = { value: Math.max(def.height, 0.001) };
  u.uGhost = { value: ghost ? 1 : 0 };
  // Detail LOD: parts that carry a small share of the model's triangles fade
  // out much closer to the camera than the silhouette-defining ones.
  u.uDrawDist = { value: 260 };
  u.uFadeK = { value: 0.85 };
  var vu = vatUniforms(def, part);
  for (var vk in vu) u[vk] = vu[vk];
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

export function syncObjectEnv() {
  var u = impSharedUniforms(), e = state.env, q = Q();
  u.uSunDir.value.copy(Env.sunDir);
  u.uSunColor.value.copy(Env.sun);
  u.uSkyColor.value.copy(Env.amb);
  u.uGroundColor.value.copy(Env.gnd);
  u.uAmbient.value = Env.ambient;
  u.uFill.value = e.modelFill === undefined ? 0.5 : e.modelFill;
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
export function saveLibraryIndex() {
  var out = [];
  for (var id in ASSETS) {
    var d = ASSETS[id];
    out.push({ uid: d.uid, label: d.label, kind: d.kind, sway: d.sway, scale: d.scale,
               author: d.author, license: d.license,
               animPlay: d.animPlay, animClip: d.animClip, animSpeed: d.animSpeed });
  }
  try { localStorage.setItem(LIB_KEY, JSON.stringify(out)); } catch (e) {}
}
export function loadLibraryIndex() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch (e) { return []; }
}

/* Rebuild the whole library from cache on startup. Runs in sequence so a big
   library reports progress instead of stalling silently. */
export function restoreLibrary(onStep) {
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
export function acquireModel(uid, meta, onProgress) {
  return sfCacheGet(uid).then(function (hit) {
    if (hit && hit.glb) return hit.glb;
    return sfDownloadGLB(uid, onProgress).then(function (buf) {
      return sfCachePut(uid, meta || {}, buf).then(function () { return buf; });
    });
  });
}

