import { useCallback, useEffect, useRef, useState } from 'react';
import { useEngine } from './EngineProvider.jsx';
import { Dialog } from './overlays.jsx';
import { Btn } from './controls.jsx';
import { Icon, ICON } from './icons.jsx';
import { sfCanDownload, sfTokenSource } from '../engine/sketchfab.js';

const FACE_CAPS = [
  { value: '8000', label: '≤ 8k faces' },
  { value: '25000', label: '≤ 25k faces' },
  { value: '60000', label: '≤ 60k faces' },
  { value: '150000', label: '≤ 150k faces' },
  { value: '0', label: 'Any size' }
];

/* ============================================================================
   IMPORT FROM SKETCHFAB

   The token comes from the environment — VITE_SKETCHFAB_TOKEN in .env, or a
   server-side proxy holding SKETCHFAB_TOKEN. This dialog never asks for one:
   configuring credentials is a job for whoever set the app up, not for the
   person trying to place a tree. If nothing is configured it says so, once,
   instead of failing later with an unexplained 401.
   ========================================================================== */
export function SketchfabBrowser({ onClose }) {
  const engine = useEngine();
  const browser = engine.Browser;

  const [query, setQuery] = useState(browser.q);
  const [kind, setKind] = useState(browser.kind);
  const [maxFaces, setMaxFaces] = useState(String(browser.maxFaces));
  const [results, setResults] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [message, setMessage] = useState('Search Sketchfab for a model to import.');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({});
  const [status, setStatus] = useState({});
  const searchBox = useRef(null);

  const run = useCallback(async (append) => {
    browser.q = query.trim();
    browser.kind = kind;
    browser.maxFaces = parseInt(maxFaces, 10) || 0;
    setBusy(true);
    setError(false);
    setMessage('Searching…');
    try {
      const res = await engine.sfSearch({
        q: browser.q, maxFaces: browser.maxFaces, count: 24, sort: browser.sort,
        cursor: append ? cursor : null
      });
      setCursor(res.next);
      setResults((prev) => (append ? [...prev, ...res.results] : res.results));
      setMessage(res.results.length || append ? '' : 'No downloadable models matched. Try a broader search, or raise the face limit.');
    } catch (e) {
      setError(true);
      setMessage(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [engine, browser, query, kind, maxFaces, cursor]);

  useEffect(() => { if (browser.q) run(false); /* resume the last search */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importOne(model) {
    if (engine.ASSETS[model.uid]) return;
    if (!sfCanDownload()) {
      setStatus((s) => ({ ...s, [model.uid]: { bad: true, text: 'No token configured' } }));
      return;
    }
    setStatus((s) => ({ ...s, [model.uid]: { busy: true, text: 'Downloading…' } }));
    try {
      const def = await engine.importFromSketchfab(model, kind, (p) => {
        setProgress((prev) => ({ ...prev, [model.uid]: p }));
      });
      setStatus((s) => ({
        ...s,
        [model.uid]: { done: true, text: `${engine.fmtInt(def.tris)} tris · ${def.parts.length} material${def.parts.length === 1 ? '' : 's'}` }
      }));
    } catch (e) {
      setStatus((s) => ({ ...s, [model.uid]: { bad: true, text: e.message || 'Import failed' } }));
    }
  }

  return (
    <Dialog title="Add models from Sketchfab" wide onClose={onClose}>
      <TokenNotice />

      <div className="sfbar">
        <input
          ref={searchBox}
          type="text"
          value={query}
          placeholder='Search models — try "low poly house", "pine tree", "car"'
          data-tip="Only downloadable models are listed."
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); run(false); } }}
        />
        <div className="sel">
          <select value={kind} onChange={(e) => setKind(e.target.value)}
            data-tip="Which shelf the model is filed on. It only decides where you find it again.">
            {engine.IMP_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <Icon path={ICON.chevron} w={2} />
        </div>
        <div className="sel">
          <select value={maxFaces} onChange={(e) => setMaxFaces(e.target.value)}
            data-tip="This is a world builder — a 500k-face model cannot be placed hundreds of times and still run.">
            {FACE_CAPS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <Icon path={ICON.chevron} w={2} />
        </div>
        <Btn label="Search" kind="pri" disabled={busy} onClick={() => run(false)} />
      </div>

      {message && <div className={'sfmsg' + (error ? ' err' : '')}>{message}</div>}

      <div className="sfgrid">
        {results.map((m) => {
          const already = !!engine.ASSETS[m.uid];
          const st = status[m.uid] || (already ? { done: true, text: 'Already in your library' } : null);
          return (
            <button
              key={m.uid}
              type="button"
              className={'sfcard' + (st?.busy ? ' busy' : '') + (st?.done ? ' done' : '')}
              data-tip={`Import "${m.name}"`}
              onClick={() => importOne(m)}
            >
              {m.thumb && <img src={m.thumb} alt="" loading="lazy" />}
              <div className="sfprog"><i style={{ width: `${(progress[m.uid] || 0) * 100}%` }} /></div>
              <div className="meta">
                <b>{m.name}</b>
                <span>by {m.author}</span>
                <span className={'fc' + (st?.bad ? ' bad' : '')}>
                  {st ? st.text : `${engine.fmtInt(m.faces)} faces · ${m.license || 'see licence'}`}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {cursor && (
        <div className="btn-row">
          <Btn label="Load more" disabled={busy} onClick={() => run(true)} />
        </div>
      )}
    </Dialog>
  );
}

/* Silent when a token is configured — which is the normal case. */
function TokenNotice() {
  if (sfCanDownload()) return null;
  const proxy = sfTokenSource() === 'proxy';
  return (
    <div className="sfmsg err" style={{ textAlign: 'left' }}>
      Searching works, but downloading needs a Sketchfab token and none is set up.
      {proxy
        ? ' This deployment routes downloads through its own server — set SKETCHFAB_TOKEN there.'
        : ' Put one in VITE_SKETCHFAB_TOKEN in the .env file and restart the dev server.'}
    </div>
  );
}
