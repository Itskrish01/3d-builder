import { createContext, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { createEngine } from '../engine/index.js';

/* ============================================================================
   The engine is a long-lived imperative object, not React state. It is created
   once, handed down through context, and read directly by the panels; when
   something inside it changes it says so on a topic and the components that
   care re-render.

   The alternative — mirroring 200 engine settings into React state — would
   mean two copies of the truth and a sync bug for every one of them.
   ========================================================================== */

const EngineContext = createContext(null);

export function useEngine() {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('useEngine outside <EngineProvider>');
  return engine;
}

/**
 * Re-render when the engine announces any of these topics. Several announcements
 * in one frame collapse into one render, so a paint stroke emitting on every
 * stamp costs one render per frame rather than sixty.
 *
 * @param {...('scene'|'state'|'selection'|'mode'|'history'|'stats'|'env'|'library'|'saved')} topics
 */
export function useEngineTopic(...topics) {
  const engine = useEngine();
  const [, bump] = useReducer((n) => n + 1, 0);
  const key = topics.join('|');

  useEffect(() => {
    let queued = false;
    const onChange = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; bump(); });
    };
    const offs = key.split('|').map((topic) => engine.on(topic, onChange));
    return () => offs.forEach((off) => off());
  }, [engine, key]);
}

/**
 * Boots WebGL against a canvas and provides the engine to everything below.
 * Children do not mount until the world is on screen, so no panel ever has to
 * cope with a half-built engine.
 */
export function EngineProvider({ canvasRef, viewportRef, adapter, children, onReady }) {
  const [engine, setEngine] = useState(null);
  const [status, setStatus] = useState('Starting up');
  const [error, setError] = useState(null);
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  useEffect(() => {
    let cancelled = false;
    let created = null;

    if (!hasWebGL()) {
      setError({
        title: "This browser can't draw 3D",
        detail: 'Grass Painter needs WebGL. Try a recent Chrome, Edge, Firefox or Safari, turn hardware acceleration on in the browser settings, and make sure your graphics driver is up to date.'
      });
      return undefined;
    }

    // Each entry is read through a ref at call time, so a re-rendered callback
    // never forces the engine to be torn down and rebuilt. It has to be a plain
    // object with real own properties: the engine merges it with Object.assign,
    // which sees nothing at all through a bare Proxy.
    const stableAdapter = {};
    for (const key of Object.keys(adapterRef.current || {})) {
      stableAdapter[key] = (...args) => adapterRef.current?.[key]?.(...args);
    }

    createEngine(canvasRef.current, viewportRef.current, stableAdapter, setStatus)
      .then((e) => {
        if (cancelled) { e.dispose(); return; }
        created = e;
        setEngine(e);
        onReady?.(e);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) {
          setError({ title: 'Something went wrong while starting up', detail: String(e?.message || e) });
        }
      });

    return () => { cancelled = true; created?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="fatal">
        <div className="in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <h2>{error.title}</h2>
          <p>{error.detail}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {!engine && (
        <div className="boot">
          <div className="in">
            <div className="bar"><i /></div>
            <small>{status}</small>
          </div>
        </div>
      )}
      {engine && <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>}
    </>
  );
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
