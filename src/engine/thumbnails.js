import * as THREE from 'three';
import { ASSETS, IMP_VS, IMP_FS } from './assets.js';
import { renderer } from './renderer.js';
/* ==========================================================================
   THUMBNAILS — models are rendered with the real object shader into a small
   render target, so the picker shows exactly what will be placed.
   ========================================================================== */
export var Thumbs = { rt: null, scene: null, cam: null, cache: {}, size: 128 };

export function initThumbs() {
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
    // A card wants the rest pose, so the animation branch stays switched off.
    uVatTex: { value: null }, uVatSize: { value: new THREE.Vector2(1, 1) },
    uVat: { value: 0 }, uVatPlay: { value: 0 }, uVatVerts: { value: 1 },
    uVatStart: { value: 0 }, uVatCount: { value: 1 }, uVatRate: { value: 0 },
    uModelH: { value: Math.max(def.height, 0.001) },
    uMap: { value: part.tex || null },
    uHasMap: { value: part.tex ? 1 : 0 },
    uAlphaTest: { value: part.alphaTest || 0 },
    uColor: { value: new THREE.Vector3(part.color[0], part.color[1], part.color[2]) },
    uMetal: { value: part.metalness === undefined ? 0 : part.metalness },
    uRough: { value: part.roughness === undefined ? 0.75 : part.roughness }
  };
  return new THREE.ShaderMaterial({
    vertexShader: IMP_VS, fragmentShader: IMP_FS, uniforms: u,
    side: THREE.DoubleSide, transparent: true
  });
}

/* Renders the model exactly as it will appear when placed — one draw per
   merged material, same shader as the world. */
export function renderThumb(kind, canvas) {
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
export function drawGroupSwatch(canvas) {
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
