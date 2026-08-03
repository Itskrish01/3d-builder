import { useEffect, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { StationGlyph, ICON } from './icons.jsx';
import { STATIONS, HINTS, FLY_HINT } from './copy.jsx';
import { Btn } from './controls.jsx';

export function Rail() {
  const engine = useEngine();
  useEngineTopic('mode', 'scene');
  const [intro, setIntro] = useState(true);

  // The strata draw themselves in once, on the first rail of the session.
  useEffect(() => {
    const id = setTimeout(() => setIntro(false), 1000);
    return () => clearTimeout(id);
  }, []);

  const active = engine.state.world.mode;

  return (
    <nav className={'rail' + (intro ? ' intro' : '')} role="toolbar" aria-label="Stations">
      {engine.MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="station"
          aria-pressed={active === m.id}
          data-tip={STATIONS[m.id].tip}
          data-key={m.key}
          onClick={() => engine.setMode(m.id)}
        >
          <StationGlyph station={m.id} />
          <span>{STATIONS[m.id].label}</span>
        </button>
      ))}
      <div className="rail-foot">
        <Btn
          icon={ICON.frame}
          kind="ghost"
          tip="Pull back until the whole world fits on screen"
          kbd="F"
          onClick={engine.frameWorld}
        />
      </div>
    </nav>
  );
}

/** The line along the bottom of the viewport that says what a drag will do. */
export function Hint() {
  const engine = useEngine();
  useEngineTopic('mode');
  const [modifier, setModifier] = useState(null);

  useEffect(() => {
    const read = (e) => setModifier(
      e.altKey ? 'Alt: the other way'
        : e.shiftKey ? 'Shift: straight line / add'
          : e.code === 'Space' && e.type === 'keydown' ? 'Space: orbit'
            : null
    );
    window.addEventListener('keydown', read);
    window.addEventListener('keyup', read);
    window.addEventListener('blur', () => setModifier(null));
    return () => {
      window.removeEventListener('keydown', read);
      window.removeEventListener('keyup', read);
    };
  }, []);

  const parts = [...(HINTS[engine.state.world.mode] || []), ...FLY_HINT];

  return (
    <div className="hint">
      {parts.map((part, i) => (
        Array.isArray(part)
          ? <span key={i}>{part.map((k) => <kbd key={k}>{k}</kbd>)}</span>
          : <span key={i}>{part}{i < parts.length - 1 ? ' ·' : ''}</span>
      ))}
      {modifier && <em>{modifier}</em>}
    </div>
  );
}
