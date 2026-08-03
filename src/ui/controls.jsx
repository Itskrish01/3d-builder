import { useCallback, useEffect, useRef, useState } from 'react';
import { useEngine } from './EngineProvider.jsx';
import { Icon, ICON } from './icons.jsx';

/* ============================================================================
   ONE CONTROL VOCABULARY

   Every control binds either to a path into engine state (`path="grass.height"`)
   or to an explicit get/set pair, so the same slider serves a world setting and
   a per-model setting with no second implementation.

   `apply` lists the work a change needs — see engine/apply.js.
   ========================================================================== */

/* A control may have no binding at all — a row of chips that are actions
   rather than a choice. That is a supported shape, so reading and writing both
   have to cope with there being nothing to read or write. */
function useBinding({ path, get, set, apply, onChange }) {
  const engine = useEngine();
  const value = get ? get() : (path ? engine.get(path) : undefined);

  const commit = useCallback((next) => {
    if (set) set(next);
    else if (path) engine.set(path, next);
    engine.apply(apply);
    onChange?.(next);
  }, [engine, path, set, apply, onChange]);

  return [value, commit, engine];
}

/* ---------------------------------------------------------------------------
   Layout
   -------------------------------------------------------------------------- */
export function Group({ title, children }) {
  return (
    <div className="group">
      {title && <div className="group-title wide">{title}</div>}
      <div>{children}</div>
    </div>
  );
}

export function Note({ children }) {
  return <div className="note">{children}</div>;
}

/* ---------------------------------------------------------------------------
   Slider — drag anywhere on the track, Shift-drag for fine control,
   double-click to reset, and typed numbers in the value box.
   -------------------------------------------------------------------------- */
export function Slider({
  label, path, get, set, apply, onChange,
  min, max, step = 0.01, dec = 2, unit = '', format, def, tip, kbd
}) {
  const [value, commit, engine] = useBinding({ path, get, set, apply, onChange });
  const [live, setLive] = useState(null);   // non-null only while dragging
  const [text, setText] = useState(null);   // non-null only while typing
  const trackRef = useRef(null);
  const dragRef = useRef({ on: false, lastX: 0, fine: false });

  const shown = live ?? value;
  const reset = def !== undefined ? def : (path ? getDefault(engine, path) : shown);
  const fraction = clamp01((shown - min) / (max - min));
  const display = format ? format(shown) : shown.toFixed(dec) + unit;

  const quantise = useCallback((raw) => {
    let v = Math.min(max, Math.max(min, raw));
    if (step) v = Math.round(v / step) * step;
    return Math.min(max, Math.max(min, v));
  }, [min, max, step]);

  const push = useCallback((raw) => {
    const v = quantise(raw);
    setLive(v);
    commit(v);
  }, [quantise, commit]);

  const fromX = useCallback((clientX) => {
    const r = trackRef.current.getBoundingClientRect();
    push(min + clamp01((clientX - r.left) / r.width) * (max - min));
  }, [push, min, max]);

  function onPointerDown(e) {
    dragRef.current = { on: true, lastX: e.clientX, fine: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!e.shiftKey) fromX(e.clientX);
    e.preventDefault();
    e.stopPropagation();
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d.on) return;
    if (e.shiftKey) {
      d.fine = true;
      const w = trackRef.current.getBoundingClientRect().width || 1;
      push((live ?? value) + ((e.clientX - d.lastX) / w) * (max - min) * 0.16);
    } else {
      d.fine = false;
      fromX(e.clientX);
    }
    d.lastX = e.clientX;
  }
  function endDrag(e) {
    if (!dragRef.current.on) return;
    dragRef.current = { on: false, lastX: 0, fine: false };
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    setLive(null);
  }

  return (
    <div className="ctrl" data-tip={tip || label} data-key={kbd}>
      <div className="ctrl-top">
        <div className="ctrl-label">{label}</div>
        <input
          className="ctrl-val"
          type="text"
          spellCheck={false}
          value={text ?? display}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => { setText(display); e.target.select(); }}
          onBlur={() => {
            const n = parseFloat(String(text).replace(/[^0-9.+\-eE]/g, ''));
            if (Number.isFinite(n)) push(n);
            setText(null);
            setLive(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') { setText(null); e.currentTarget.blur(); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              const s = (step || (max - min) / 100) * (e.shiftKey ? 10 : 1);
              push(value + (e.key === 'ArrowUp' ? s : -s));
              setText(null);
              e.preventDefault();
            }
          }}
        />
      </div>
      <div
        ref={trackRef}
        className={'slider' + (dragRef.current.on ? ' act' : '') + (dragRef.current.fine ? ' fine' : '')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => push(reset ?? shown)}
      >
        <div className="trk" />
        <div className="fill" style={{ width: `${fraction * 100}%` }} />
        <div className="knob" style={{ left: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

function getDefault(engine, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), engine.defaults);
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* ---------------------------------------------------------------------------
   Segmented, chips, toggle, colour, select
   -------------------------------------------------------------------------- */
export function Segment({ label, path, get, set, apply, onChange, options, tip }) {
  const [value, commit] = useBinding({ path, get, set, apply, onChange });
  return (
    <div className="ctrl" data-tip={tip}>
      {label && <div className="ctrl-top"><div className="ctrl-label">{label}</div></div>}
      <div className="seg">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={String(value) === String(o.value)}
            data-tip={o.tip || o.label}
            onClick={() => commit(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A wrapping row of named choices. Used where the options have real names worth
 * reading — landforms, grass looks — rather than numbers to dial in. With no
 * binding it is a row of actions instead, and nothing shows as chosen.
 */
export function Chips({ label, path, get, set, apply, onChange, options, tip }) {
  const [value, commit] = useBinding({ path, get, set, apply, onChange });
  const selectable = !!(path || get);
  return (
    <div className="ctrl" data-tip={tip}>
      {label && <div className="ctrl-top"><div className="ctrl-label">{label}</div></div>}
      <div className="chips">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="chip"
            aria-pressed={selectable ? String(value) === String(o.value) : undefined}
            data-tip={o.tip || o.label}
            onClick={() => (selectable ? commit(o.value) : onChange?.(o.value))}
          >
            {o.swatch && <i style={{ background: o.swatch }} />}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, path, get, set, apply, onChange, tip, kbd }) {
  const [value, commit] = useBinding({ path, get, set, apply, onChange });
  return (
    <div className="ctrl row" data-tip={tip || label} data-key={kbd}>
      <div className="ctrl-label">{label}</div>
      <button type="button" className="tgl" aria-pressed={!!value} aria-label={label} onClick={() => commit(!value)} />
    </div>
  );
}

export function ColorField({ label, path, get, set, apply, onChange, tip }) {
  const [value, commit] = useBinding({ path, get, set, apply, onChange });
  const [text, setText] = useState(null);

  function commitHex(raw) {
    let v = String(raw).trim();
    if (!/^#?[0-9a-f]{6}$/i.test(v) && !/^#?[0-9a-f]{3}$/i.test(v)) { setText(null); return; }
    if (v[0] !== '#') v = '#' + v;
    if (v.length === 4) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    commit(v.toLowerCase());
    setText(null);
  }

  return (
    <div className="ctrl" data-tip={tip || label}>
      <div className="ctrl-top"><div className="ctrl-label">{label}</div></div>
      <div className="col">
        <div className="sw" style={{ background: value }}>
          <input type="color" value={value} aria-label={label} onChange={(e) => commit(e.target.value)} />
        </div>
        <input
          className="hex"
          type="text"
          spellCheck={false}
          value={text ?? value.toUpperCase()}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </div>
    </div>
  );
}

export function Select({ label, path, get, set, apply, onChange, options, tip }) {
  const [value, commit] = useBinding({ path, get, set, apply, onChange });
  return (
    <div className="ctrl" data-tip={tip || label}>
      {label && <div className="ctrl-top"><div className="ctrl-label">{label}</div></div>}
      <div className="sel">
        <select value={String(value)} onChange={(e) => commit(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Icon path={ICON.chevron} w={2} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Wind dial — the one control that is worth being a picture
   -------------------------------------------------------------------------- */
export function Dial({ label, path, apply, tip, children }) {
  const [value, commit] = useBinding({ path, apply });
  const svgRef = useRef(null);
  const dragging = useRef(false);

  const rad = (value * Math.PI) / 180;
  const sx = Math.sin(rad);
  const sy = -Math.cos(rad);
  const tip1 = [50 + sx * 30, 50 + sy * 30];
  const base = [50 - sx * 12, 50 - sy * 12];
  const off = [-sy * 8, sx * 8];
  const points = [
    tip1,
    [base[0] + off[0], base[1] + off[1]],
    [base[0] - off[0], base[1] - off[1]]
  ].map((p) => p.join(',')).join(' ');

  function fromEvent(e) {
    const r = svgRef.current.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    commit(Math.round(deg) % 360);
  }

  return (
    <div className="dial">
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        data-tip={tip}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); fromEvent(e); e.preventDefault(); }}
        onPointerMove={(e) => dragging.current && fromEvent(e)}
        onPointerUp={(e) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ } }}
      >
        <circle className="dial-rim" cx="50" cy="50" r="46" />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          const r0 = i % 3 === 0 ? 32 : 38;
          return (
            <line
              key={i}
              className="dial-tick"
              x1={50 + Math.sin(a) * r0} y1={50 - Math.cos(a) * r0}
              x2={50 + Math.sin(a) * 42} y2={50 - Math.cos(a) * 42}
            />
          );
        })}
        <polygon className="dial-arrow" points={points} />
        <circle className="dial-hub" cx="50" cy="50" r="6" />
      </svg>
      <div className="dial-info">
        <Slider label={label} path={path} apply={apply} min={0} max={360} step={1} dec={0} unit="°" tip={tip} />
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Buttons
   -------------------------------------------------------------------------- */
export function Btn({ icon, label, kind, tip, kbd, onClick, disabled, className = '' }) {
  return (
    <button
      type="button"
      className={`btn ${kind || ''} ${label ? '' : 'icon'} ${className}`.trim()}
      data-tip={tip || label}
      data-key={kbd}
      aria-label={label || tip}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <Icon path={icon} />}
      {label}
    </button>
  );
}

export function ButtonRow({ children }) {
  return <div className="btn-row">{children}</div>;
}

/* ---------------------------------------------------------------------------
   Tool row — the two-to-four verbs inside a station
   -------------------------------------------------------------------------- */
export function ToolRow({ tools, current, onPick }) {
  if (!tools.length) return null;
  return (
    <div className="tools" style={{ gridTemplateColumns: `repeat(${tools.length}, minmax(0, 1fr))` }}>
      {tools.map((t) => (
        <button
          key={t.id}
          type="button"
          className="tbtn"
          aria-pressed={current === t.id}
          data-tip={t.tip}
          onClick={() => onPick(t.id)}
        >
          <Icon path={t.icon} />
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Blade meter — the one live readout worth keeping in a panel
   -------------------------------------------------------------------------- */
export function BladeMeter() {
  const engine = useEngine();
  const [count, setCount] = useState(engine.bladeCount);
  useEffect(() => {
    const id = setInterval(() => setCount(engine.bladeCount), 400);
    return () => clearInterval(id);
  }, [engine]);
  const fraction = count / engine.MAX_BLADES;
  return (
    <>
      <div className={'meter' + (fraction > 0.9 ? ' warn' : '')}>
        <i style={{ width: `${Math.min(1, fraction) * 100}%` }} />
      </div>
      <div className="note" style={{ marginTop: 8 }}>
        {engine.fmtInt(count)} blades — room for {engine.fmtInt(engine.MAX_BLADES)}
      </div>
    </>
  );
}
