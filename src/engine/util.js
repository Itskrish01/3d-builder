import * as THREE from 'three';

/* ==========================================================================
   2. MATH
   ========================================================================== */

export var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
export var lerp  = function (a, b, t) { return a + (b - a) * t; };
export var smoothstep = function (e0, e1, x) {
  var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t);
};
export var TAU = Math.PI * 2;
export var DEG = Math.PI / 180;

/* Deterministic 32-bit PRNG (mulberry32) — used so a "fill" is reproducible
   within a session and so noise seeds stay stable. */
export function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export var rnd = Math.random;

/* ---- 2D simplex noise (CPU side, drives the terrain heightfield) --------- */
export var SN = (function () {
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
export function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgb2hex(r, g, b) {
  var f = function (v) { var s = Math.round(clamp(v, 0, 1) * 255).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + f(r) + f(g) + f(b);
}
export function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
/* sRGB hex -> linear vec3, because every shader works in linear light. */
export function hexLin(h, out) {
  var c = hex2rgb(h);
  out = out || new THREE.Vector3();
  return out.set(s2l(c[0]), s2l(c[1]), s2l(c[2]));
}
export function mixArr(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/* ---- misc ---------------------------------------------------------------- */
export function fmtInt(n) { return n.toLocaleString('en-US'); }
export function nowMs() { return (performance && performance.now) ? performance.now() : Date.now(); }
