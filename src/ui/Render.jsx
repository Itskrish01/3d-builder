import { useEffect, useRef, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Icon, ICON } from './icons.jsx';

/* ============================================================================
   RENDER — the ray-traced photograph.

   Deliberately a still and not a mode you build in: a path tracer needs
   hundreds of samples a pixel before the noise clears, which is seconds to
   minutes. So this is a camera, not a viewport. Point the view, press the
   button, watch it clean up, save the picture.
   ========================================================================== */

const QUALITY = [
  { key: 'quick',  label: 'Quick',   target: 64,   bounces: 3, scale: 0.7, blurb: 'A look in a few seconds' },
  { key: 'good',   label: 'Good',    target: 400,  bounces: 5, scale: 1,   blurb: 'Clean enough to keep' },
  { key: 'best',   label: 'Patient', target: 2000, bounces: 8, scale: 1,   blurb: 'Leave it running' }
];

export function RenderButton({ onOpen }) {
  const engine = useEngine();
  useEngineTopic('pathtrace');
  const busy = engine.PT.active || engine.PT.building;
  return (
    <button
      type="button"
      className={'render-btn' + (busy ? ' on' : '')}
      data-tip="Trace the current view with real light — bounced light, true shadows, real reflections"
      onClick={onOpen}
    >
      <Icon path={ICON.camera} />
      <span>Render</span>
    </button>
  );
}

export function RenderOverlay({ open, onClose }) {
  const engine = useEngine();
  useEngineTopic('pathtrace');
  const [quality, setQuality] = useState('good');
  const PT = engine.PT;

  /* Leaving the panel must not leave a trace running behind it — but *only* on
     the way out. Written as a dependency list this fired on every render, and
     this panel re-renders on every accumulated sample, so it spent the whole
     render repeatedly stopping the thing it had just started. A transition is
     what is actually meant here, so a transition is what is tested. */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) engine.stopRender();
    wasOpen.current = open;
  });

  if (!open) return null;

  const supported = engine.canPathTrace();
  const q = QUALITY.find((x) => x.key === quality);
  const done = PT.target > 0 && PT.samples >= PT.target;
  const pct = PT.target ? Math.min(100, Math.round((PT.samples / PT.target) * 100)) : 0;

  function start() {
    engine.startRender({ target: q.target, bounces: q.bounces, scale: q.scale });
  }

  return (
    <div className="render-panel" role="dialog" aria-label="Render">
      <div className="render-head">
        <span className="panel-title wide">Render</span>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon path={ICON.close} />
        </button>
      </div>

      {!supported && (
        <p className="render-note err">
          Ray tracing needs WebGL2, and this browser is not offering it. Everything else still works.
        </p>
      )}

      {supported && !PT.active && !PT.building && (
        <>
          <p className="render-note">
            Traces the view you are looking at with real light — light bounces off surfaces and picks
            up their colour, shadows are cast by the thing that blocks them, and glass and metal
            behave like glass and metal. It builds up over a few seconds; the longer you leave it,
            the cleaner it gets.
          </p>
          <div className="render-quality" role="radiogroup" aria-label="Quality">
            {QUALITY.map((x) => (
              <button
                key={x.key}
                type="button"
                role="radio"
                aria-checked={quality === x.key}
                className={'chip' + (quality === x.key ? ' on' : '')}
                onClick={() => setQuality(x.key)}
              >
                <b>{x.label}</b>
                <span>{x.blurb}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn primary wide" onClick={start}>
            <Icon path={ICON.camera} />
            <span>Render this view</span>
          </button>
          <p className="render-note dim">
            Grass is not traced — the blades exist only on the graphics card, and there are far too
            many of them to hand a ray tracer. The ground keeps its colour. Everything you placed,
            the landscape and the water are all traced.
          </p>
        </>
      )}

      {PT.building && (
        <p className="render-note">
          <span className="spinner" /> Preparing the scene…
        </p>
      )}

      {PT.active && (
        <>
          <div className="render-progress">
            <div className="bar"><i style={{ width: (PT.target ? pct : 100) + '%' }} /></div>
            <div className="render-stats num">
              <span>{PT.samples}{PT.target ? ' / ' + PT.target : ''} samples</span>
              <span>{engine.fmtInt(Math.round(PT.tris))} triangles</span>
            </div>
          </div>
          <p className="render-note">
            {PT.compiling
              ? <><span className="spinner" />Compiling the tracer. This happens once and takes a few seconds.</>
              : done
                ? 'Finished. Move the camera or click the world to go back to building.'
                : 'Building up. You can save it at any point — it only gets cleaner.'}
          </p>
          <div className="render-actions">
            <button type="button" className="btn primary" onClick={() => engine.saveRender('grass-painter')}>
              <Icon path={ICON.save} /><span>Save picture</span>
            </button>
            <button type="button" className="btn" onClick={() => engine.stopRender()}>
              <span>Back to building</span>
            </button>
          </div>
        </>
      )}

      {!!PT.error && <p className="render-note err">{PT.error}</p>}
    </div>
  );
}
