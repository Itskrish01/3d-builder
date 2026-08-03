import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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
export var IMPORT_TEX_MAX = 1024;

/* Two submeshes merge only if they would shade identically. Everything the
   fragment shader reads has to be in this key — a matte wall and a polished
   floor sharing one texture are not the same material, and merging them means
   one of the two renders as the other. */
export function materialKey(m) {
  if (!m) return 'none';
  var t = m.map && m.map.image ? (m.map.uuid) : '';
  var c = m.color ? m.color.getHexString() : 'ffffff';
  var a = (m.transparent ? 1 : 0) + '|' + (m.alphaTest || 0);
  var mr = (m.metalness === undefined ? 'x' : m.metalness.toFixed(3)) + ',' +
           (m.roughness === undefined ? 'x' : m.roughness.toFixed(3)) + ',' +
           (m.metalnessMap ? m.metalnessMap.uuid : '') + ',' +
           (m.roughnessMap ? m.roughnessMap.uuid : '');
  var em = (m.emissive ? m.emissive.getHexString() : '000000') + ',' +
           (m.emissiveIntensity === undefined ? 1 : m.emissiveIntensity).toFixed(3) + ',' +
           (m.emissiveMap ? m.emissiveMap.uuid : '');
  var lit = m.isMeshBasicMaterial ? 'unlit' : 'lit';
  var vc = m.vertexColors ? 'vc' : '';
  return [t, c, a, (m.side === undefined ? 2 : m.side), mr, em, lit, vc].join('|');
}

/* Re-encode a texture at or below the size cap. glTF textures are flipY:false,
   and a canvas copy has to preserve that or every model renders upside down. */
export function downscaleTexture(tex, max) {
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
export var _impM = new THREE.Matrix4(), _impN = new THREE.Matrix3(), _impV = new THREE.Vector3();
export function mergeGroup(items) {
  var vTotal = 0, iTotal = 0, i, g;
  var anyColor = false;
  for (i = 0; i < items.length; i++) {
    g = items[i].geometry;
    if (!g.attributes.position) continue;
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    if (g.attributes.color) anyColor = true;
  }
  if (!vTotal) return null;
  var pos = new Float32Array(vTotal * 3);
  var nrm = new Float32Array(vTotal * 3);
  var uv = new Float32Array(vTotal * 2);
  /* Painted-on vertex colour is the whole appearance of a lot of low-poly
     models — drop it and they arrive white. Filled with 1 where a submesh in
     the group has none, so a partial group still merges. */
  var vcol = anyColor ? new Float32Array(vTotal * 3).fill(1) : null;
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
    var cAttr = vcol ? g.attributes.color : null;
    var count = p.count;
    for (var v = 0; v < count; v++) {
      _impV.set(p.getX(v), p.getY(v), p.getZ(v)).applyMatrix4(_impM);
      pos[(vo + v) * 3] = _impV.x; pos[(vo + v) * 3 + 1] = _impV.y; pos[(vo + v) * 3 + 2] = _impV.z;
      if (n) {
        _impV.set(n.getX(v), n.getY(v), n.getZ(v)).applyMatrix3(_impN).normalize();
        nrm[(vo + v) * 3] = _impV.x; nrm[(vo + v) * 3 + 1] = _impV.y; nrm[(vo + v) * 3 + 2] = _impV.z;
      } else { nrm[(vo + v) * 3 + 1] = 1; }
      if (t) { uv[(vo + v) * 2] = t.getX(v); uv[(vo + v) * 2 + 1] = t.getY(v); }
      if (cAttr) {
        vcol[(vo + v) * 3] = cAttr.getX(v);
        vcol[(vo + v) * 3 + 1] = cAttr.getY(v);
        vcol[(vo + v) * 3 + 2] = cAttr.getZ(v);
      }
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
  if (vcol) out.setAttribute('aVCol', new THREE.BufferAttribute(vcol, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* Recentre on XZ and sit the model on y = 0, so placement, snapping and the
   flatten-under-footprint logic all behave the same as they did for the
   procedural assets. */
export function normalizeParts(parts) {
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
    autoScaled: scale !== 1,
    // Baked animation frames have to land in the same space as the rest pose,
    // so the transform applied above travels with the result.
    xform: { cx: cx, cy: base, cz: cz, scale: scale }
  };
}


/* ============================================================================
   BAKED ANIMATION

   Models are drawn instanced — one draw call for every copy of a house — which
   rules out giving each copy its own skeleton. So every clip is sampled on the
   CPU at import and the resulting vertex positions are written into a texture,
   one run of texels per frame, read back in the vertex shader. A crowd of
   fifty walking people is still one draw call, and each can be given a
   different phase so they are not in lockstep.

   The cost is memory, so it is budgeted. Past the cap the model simply stays
   still and the library says why, rather than quietly eating VRAM.
   ========================================================================== */
var VAT_FPS = 15;               // sample rate; the shader interpolates between
var VAT_MIN_FRAMES = 6;
var VAT_MAX_FRAMES = 24;        // per clip
var VAT_MAX_CLIPS = 4;
var VAT_MAX_TEXELS = 800000;    // about 6.4 MB at RGBA16F
var VAT_WIDTH = 1024;

var _bakeV = new THREE.Vector3();

/* three renamed this in r151; accept both so the pin can move later. */
function skinVertex(mesh, index, target) {
  if (mesh.applyBoneTransform) return mesh.applyBoneTransform(index, target);
  return mesh.boneTransform(index, target);
}

/* Writes one frame of one merged part, in exactly the vertex order mergeGroup
   produced — same items, same traversal, same offsets. */
function sampleGroup(items, out, base, xf) {
  var vo = 0;
  for (var i = 0; i < items.length; i++) {
    var mesh = items[i], g = mesh.geometry;
    if (!g.attributes.position) continue;
    var pos = g.attributes.position, n = pos.count;
    var skinned = !!mesh.isSkinnedMesh;
    for (var v = 0; v < n; v++) {
      if (skinned) skinVertex(mesh, v, _bakeV);
      else _bakeV.set(pos.getX(v), pos.getY(v), pos.getZ(v));
      _bakeV.applyMatrix4(mesh.matrixWorld);
      var o = base + (vo + v) * 3;
      out[o] = (_bakeV.x - xf.cx) * xf.scale;
      out[o + 1] = (_bakeV.y - xf.cy) * xf.scale;
      out[o + 2] = (_bakeV.z - xf.cz) * xf.scale;
    }
    vo += n;
  }
}

function toHalfArray(src) {
  var out = new Uint16Array(src.length);
  for (var i = 0; i < src.length; i++) out[i] = THREE.DataUtils.toHalfFloat(src[i]);
  return out;
}

function updateSkeletons(root) {
  root.traverse(function (o) { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
}

/**
 * @returns {{clips: {name: string, start: number, count: number, duration: number}[],
 *            frames: number, verts: number, dropped: number} | null}
 */
function bakeAnimation(root, partItems, parts, animations, xf) {
  var usable = [], a;
  for (a = 0; a < animations.length && usable.length < VAT_MAX_CLIPS; a++) {
    if (animations[a].duration > 0.01) usable.push(animations[a]);
  }
  if (!usable.length) return null;

  var verts = 0, i;
  for (i = 0; i < parts.length; i++) verts += parts[i].geo.attributes.position.count;
  if (!verts) return null;

  var plan = [], total = 0;
  for (i = 0; i < usable.length; i++) {
    var f = Math.round(usable[i].duration * VAT_FPS);
    f = Math.max(VAT_MIN_FRAMES, Math.min(VAT_MAX_FRAMES, f));
    plan.push({ clip: usable[i], frames: f });
    total += f;
  }
  // Drop clips from the end until the set fits the budget. If even one clip at
  // the lowest rate will not fit, the model stays still.
  var dropped = 0;
  while (plan.length && verts * total > VAT_MAX_TEXELS) {
    total -= plan.pop().frames;
    dropped++;
  }
  if (!plan.length) return null;

  var mixer = new THREE.AnimationMixer(root);
  var bufs = [];
  for (i = 0; i < parts.length; i++) {
    bufs.push(new Float32Array(parts[i].geo.attributes.position.count * total * 3));
  }

  var clips = [], frame = 0;
  for (var c = 0; c < plan.length; c++) {
    var entry = plan[c];
    mixer.stopAllAction();
    mixer.clipAction(entry.clip).reset().play();
    clips.push({
      name: entry.clip.name || ('Clip ' + (c + 1)),
      start: frame, count: entry.frames, duration: entry.clip.duration
    });
    for (var k = 0; k < entry.frames; k++, frame++) {
      // Deliberately short of the clip end: in a loop the last pose and the
      // first are the same, and sampling both stalls the cycle for a frame.
      mixer.setTime((k / entry.frames) * entry.clip.duration);
      root.updateMatrixWorld(true);
      updateSkeletons(root);
      for (var q = 0; q < parts.length; q++) {
        var count = parts[q].geo.attributes.position.count;
        sampleGroup(partItems[q], bufs[q], frame * count * 3, xf);
      }
    }
  }
  mixer.stopAllAction();

  for (i = 0; i < parts.length; i++) {
    var part = parts[i];
    var n = part.geo.attributes.position.count;
    var texels = n * total;
    var w = Math.min(VAT_WIDTH, texels);
    var h = Math.ceil(texels / w);
    var rgba = new Float32Array(w * h * 4);
    for (var t = 0; t < texels; t++) {
      rgba[t * 4] = bufs[i][t * 3];
      rgba[t * 4 + 1] = bufs[i][t * 3 + 1];
      rgba[t * 4 + 2] = bufs[i][t * 3 + 2];
      rgba[t * 4 + 3] = 1;
    }
    var tex = new THREE.DataTexture(toHalfArray(rgba), w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    part.vat = { tex: tex, w: w, h: h, verts: n };

    // The shader fetches one texel per vertex, so each vertex carries its index.
    var vid = new Float32Array(n);
    for (var vi = 0; vi < n; vi++) vid[vi] = vi;
    part.geo.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
  }

  return { clips: clips, frames: total, verts: verts, dropped: dropped };
}

/* GLB bytes -> renderable parts. */
export function importGLB(buffer, name) {
  return Promise.resolve().then(function () {
    return new Promise(function (resolve, reject) {
      new GLTFLoader().parse(buffer, '', resolve, reject);
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

    var parts = [], partItems = [], tris = 0, submeshes = 0;
    for (var i = 0; i < order.length; i++) {
      var grp = groups[order[i]];
      submeshes += grp.items.length;
      var geo = mergeGroup(grp.items);
      if (!geo) continue;
      partItems.push(grp.items);
      var m2 = grp.mat || {};
      var col = m2.color ? [m2.color.r, m2.color.g, m2.color.b] : [1, 1, 1];
      var tex = m2.map ? downscaleTexture(m2.map, IMPORT_TEX_MAX) : null;
      var cut = 0;
      if (m2.alphaTest) cut = m2.alphaTest;
      else if (m2.transparent && tex) cut = 0.35;      // typical foliage cutout
      tris += geo.index.count / 3;

      /* glTF packs roughness in green and metalness in blue of one texture, and
         three points both slots at it. Without sampling it, a model that varies
         across its surface is shaded with whatever single factor came with the
         map — which the spec defaults to 1.0, i.e. fully metal, i.e. black. */
      var mrSrc = m2.metalnessMap || m2.roughnessMap || null;
      var mrTex = mrSrc ? downscaleTexture(mrSrc, IMPORT_TEX_MAX) : null;

      var em = m2.emissive ? [m2.emissive.r, m2.emissive.g, m2.emissive.b] : [0, 0, 0];
      var emK = m2.emissiveIntensity === undefined ? 1 : m2.emissiveIntensity;
      var emTex = m2.emissiveMap ? downscaleTexture(m2.emissiveMap, IMPORT_TEX_MAX) : null;

      parts.push({
        geo: geo, tex: tex, color: col, alphaTest: cut,
        // Sketchfab shows these models with full PBR; carry what decides the
        // shading rather than re-inventing it. See IMP_FS.
        metalness: m2.metalness === undefined ? 0 : m2.metalness,
        roughness: m2.roughness === undefined ? 0.75 : m2.roughness,
        mrTex: mrTex,
        emissive: [em[0] * emK, em[1] * emK, em[2] * emK],
        emissiveTex: emTex,
        vcol: !!geo.attributes.aVCol,
        /* KHR_materials_unlit, which three gives us as a basic material. Its
           lighting is already painted into the texture, so lighting it again
           is what makes those models arrive muddy. */
        unlit: !!m2.isMeshBasicMaterial
      });
    }
    var info = normalizeParts(parts);
    var anim = null;
    if (gltf.animations && gltf.animations.length) {
      // A model that refuses to bake is simply a still one; it is never worth
      // failing the whole import over.
      try { anim = bakeAnimation(root, partItems, parts, gltf.animations, info.xform); }
      catch (e) { anim = null; }
    }
    return {
      name: name || 'Model',
      parts: parts,
      tris: Math.round(tris),
      submeshes: submeshes,
      height: info.height,
      radius: info.radius,
      size: info.size,
      autoScaled: info.autoScaled,
      anim: anim,
      clipCount: (gltf.animations && gltf.animations.length) || 0
    };
  });
}

/* Free everything a model owns. Called when a model is removed from the
   library so repeated import/remove cycles do not leak GPU memory. */
export function disposeModel(model) {
  if (!model || !model.parts) return;
  for (var i = 0; i < model.parts.length; i++) {
    var p = model.parts[i];
    if (p.geo) p.geo.dispose();
    if (p.tex && p.tex.dispose) p.tex.dispose();
    if (p.vat && p.vat.tex) p.vat.tex.dispose();
  }
  model.parts.length = 0;
}

