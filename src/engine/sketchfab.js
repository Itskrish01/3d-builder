/* ============================================================================
   SKETCHFAB CLIENT

   Search, authenticated download, and an IndexedDB cache of the GLB bytes.
   The cache is what makes a saved world reopenable: the file stores model
   uids, and reopening re-hydrates from cache instead of pulling megabytes
   off the network again.

   WHERE THE TOKEN COMES FROM

   The environment, and nowhere else. Credentials are the job of whoever set
   the app up, so nothing in the interface asks for one:

     VITE_SKETCHFAB_TOKEN   read straight by the browser. Vite inlines every
                            VITE_* variable into the JavaScript it ships, so
                            this token IS readable by anyone who opens a
                            deployed build. Right for your own machine or a
                            deploy only you can reach; not a secret.

     SKETCHFAB_TOKEN        held by the serverless function in api/, with
     + VITE_SKETCHFAB_PROXY=1   the client routing through /api/sketchfab. The
                            token never reaches the browser. Right for a
                            public deploy.

   Search works with no token at all; only downloading needs one.
   ========================================================================== */

const ENV_TOKEN = (import.meta.env.VITE_SKETCHFAB_TOKEN || '').trim();
const USE_PROXY = String(import.meta.env.VITE_SKETCHFAB_PROXY || '') === '1';

export var SF = {
  DIRECT: 'https://api.sketchfab.com/v3',
  PROXY: '/api/sketchfab',
  token: ENV_TOKEN,
  db: null,
  cacheIndex: {}
};

/** True when requests can be authenticated at all — directly or by the proxy. */
export function sfCanDownload() {
  return !!SF.token || USE_PROXY;
}

/** Which of the two arrangements is in play, so the UI can say so if neither is. */
export function sfTokenSource() {
  if (SF.token) return 'env';
  if (USE_PROXY) return 'proxy';
  return 'none';
}

/* The proxy adds the Authorization header itself; sending one from the browser
   as well would only leak the token the proxy exists to hide. */
function apiBase() { return USE_PROXY && !SF.token ? SF.PROXY : SF.DIRECT; }
export function sfHeaders() {
  if (apiBase() === SF.PROXY) return {};
  return SF.token ? { Authorization: 'Token ' + SF.token } : {};
}

/* ---- search --------------------------------------------------------------
   Face count is capped by default: this is a world builder that instances
   models hundreds of times, and a 500k-triangle "house" makes that
   impossible. The cap is exposed in the UI. */
export function sfSearch(opts) {
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
  return fetch(apiBase() + '/search?' + q.join('&'), { headers: sfHeaders() })
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
export function sfDownloadGLB(uid, onProgress) {
  if (!sfCanDownload()) return Promise.reject(new Error('No Sketchfab token — set VITE_SKETCHFAB_TOKEN in .env'));
  return fetch(apiBase() + '/models/' + uid + '/download', { headers: sfHeaders() })
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
export function fetchWithProgress(url, onProgress) {
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
export var SFDB_NAME = 'grasspainter-models', SFDB_STORE = 'glb';
export function sfDB() {
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
export function sfCachePut(uid, meta, buffer) {
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
export function sfCacheGet(uid) {
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
export function sfCacheList() {
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
export function sfCacheDelete(uid) {
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
export function sfCacheSize() {
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

