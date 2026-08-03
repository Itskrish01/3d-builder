import { useEffect, useRef, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Slider, Toggle, Note } from './controls.jsx';
import { Icon, ICON } from './icons.jsx';

/* ============================================================================
   RENDER — the ray-traced photograph, and its own settings.

   Deliberately a still and not a mode you build in: a path tracer needs
   hundreds of samples a pixel before the noise clears, which is seconds to
   minutes. So this is a camera, not a viewport. Point the view, choose the
   light, press the button, watch it clean up, save the picture.

   Its light is its own. Everything under Light here belongs to the render, not
   to the world, so a village built at noon can be photographed at midnight
   without touching the light you are building under.
   ========================================================================== */

const QUALITY = [
  /* Quick is a live view, not a photograph: it follows the camera and starts
     the image again every time you move, which is why its sample count is
     small and its bounce count low. The other two are stills — they freeze the
     view so the picture can actually converge. */
  { key: 'quick',   label: 'Quick',   target: 64,   bounces: 3, scale: 0.7,
    live: true,  blurb: 'Live — fly around in it' },
  { key: 'good',    label: 'Good',    target: 400,  bounces: 5, scale: 1,
    live: false, blurb: 'One still, clean' },
  { key: 'patient', label: 'Patient', target: 2000, bounces: 8, scale: 1,
    live: false, blurb: 'One still, slow' }
];

/* Named hours, because "18.6" is not a thing anyone pictures. */
const LIGHT_PRESETS = [
  { key: 'noon',   label: 'Midday',  hour: 12.5 },
  { key: 'golden', label: 'Golden',  hour: 17.9 },
  { key: 'dusk',   label: 'Dusk',    hour: 19.1 },
  { key: 'night',  label: 'Night',   hour: 1.0 }
];

export function RenderButton({ onOpen }) {
  const engine = useEngine();
  useEngineTopic('pathtrace');
  const busy = engine.PT.active || engine.PT.building;
  return (
    <button
      type="button"
      className={'render-btn' + (busy ? ' on' : '')}
      data-tip="Trace this view with real light — bounced light, true shadows, real reflections. Its own settings live here."
      onClick={onOpen}
    >
      <Icon path={ICON.camera} />
      <span>Render</span>
    </button>
  );
}

export function RenderOverlay({ open, onClose }) {
  const engine = useEngine();
  /* 'scene' as well: engine.touch() announces on that topic, and that is what
     setR uses — without it, picking a quality changed the state and nothing
     on screen moved, so the button still started the previous setting. */
  useEngineTopic('pathtrace', 'state', 'scene');
  const [tab, setTab] = useState('render');
  const PT = engine.PT;
  const R = engine.state.render;

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
  const q = QUALITY.find((x) => x.key === R.quality) || QUALITY[1];
  const done = PT.target > 0 && PT.samples >= PT.target;
  const pct = PT.target ? Math.min(100, Math.round((PT.samples / PT.target) * 100)) : 0;
  const running = PT.active || PT.building;

  function setR(key, value) {
    engine.state.render[key] = value;
    engine.touch();
  }

  function start() {
    engine.startRender({ target: q.target, bounces: q.bounces, scale: q.scale, live: q.live });
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

      {supported && !running && (
        <>
          <div className="panel-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'render'}
              onClick={() => setTab('render')}>Picture</button>
            <button type="button" role="tab" aria-selected={tab === 'light'}
              onClick={() => setTab('light')}>Light</button>
          </div>

          {tab === 'render' && (
            <>
              <p className="render-note">
                Traces the view you are looking at with real light — it bounces off surfaces and
                picks up their colour, shadows are cast by whatever blocks them, and glass and metal
                behave like glass and metal. The longer you leave it, the cleaner it gets.
              </p>
              <div className="render-quality" role="radiogroup" aria-label="Quality">
                {QUALITY.map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    role="radio"
                    aria-checked={R.quality === x.key}
                    className={'qopt' + (R.quality === x.key ? ' on' : '')}
                    onClick={() => setR('quality', x.key)}
                  >
                    <b>{x.label}</b>
                    <span>{x.blurb}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="btn primary wide" onClick={start}>
                <Icon path={q.live ? ICON.eye : ICON.camera} />
                <span>{q.live ? 'Start live view' : 'Render this view'}</span>
              </button>
            </>
          )}

          {tab === 'light' && (
            <div className="render-light">
              <Toggle label="Use the world's light" path="render.matchWorld"
                tip="On, the picture is lit exactly as you see it. Off, the render gets its own time of day and the world keeps yours." />

              {!R.matchWorld && (
                <>
                  <div className="render-quality" role="group" aria-label="Time of day">
                    {LIGHT_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={'qopt' + (Math.abs(R.timeOfDay - p.hour) < 0.05 ? ' on' : '')}
                        onClick={() => setR('timeOfDay', p.hour)}
                      >
                        <b>{p.label}</b>
                        <span>{engine.clockLabel(p.hour)}</span>
                      </button>
                    ))}
                  </div>
                  <Slider label="Time of day" path="render.timeOfDay" min={0} max={24} step={0.05}
                    format={(v) => engine.clockLabel(v)}
                    tip="The hour this picture is taken at. The world stays where you left it." />
                </>
              )}

              <Slider label="Brightness" path="render.exposure" min={0.2} max={3} step={0.01}
                tip="Exposure of the picture." />
              <Slider label="Sun" path="render.sunStrength" min={0} max={4} step={0.01}
                tip="How hard the sun is. Zero gives a soft overcast with no direct shadows." />
              <Slider label="Sky" path="render.skyStrength" min={0} max={3} step={0.01}
                tip="How much light comes from the sky itself. This is what fills the shadows." />
              <Toggle label="Show the sky behind" path="render.showSky"
                tip="Off leaves the background empty while the sky still lights the scene." />
              <Note>These belong to the render only. Nothing here changes the world you are building.</Note>
            </div>
          )}
        </>
      )}

      {PT.building && (
        <>
          <div className="render-progress">
            <div className="bar"><i style={{ width: PT.progress + '%' }} /></div>
          </div>
          <p className="render-note">
            <span className="spinner" />
            Preparing the scene — {PT.progress}%.
          </p>
        </>
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
              : PT.live
                ? 'Live. Fly around and it keeps tracing — the image restarts each time you move, and settles when you stop.'
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
