import { useEffect, useRef, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Icon, ICON } from './icons.jsx';
import { Btn } from './controls.jsx';
import { RenderButton } from './Render.jsx';

/* The clock dot is the sky at that hour, so the button reads at a glance. */
const SKY_STOPS = [
  [0, [0.10, 0.13, 0.22]], [5, [0.16, 0.18, 0.30]], [6.5, [0.86, 0.47, 0.28]],
  [9, [0.55, 0.74, 0.93]], [13, [0.47, 0.70, 0.95]], [17, [0.62, 0.72, 0.90]],
  [18.6, [0.93, 0.48, 0.24]], [20, [0.28, 0.22, 0.34]], [24, [0.10, 0.13, 0.22]]
];

function skyColour(hour) {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const [h0, c0] = SKY_STOPS[i];
    const [h1, c1] = SKY_STOPS[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      const mix = c0.map((v, k) => Math.round((v + (c1[k] - v) * t) * 255));
      return `rgb(${mix.join(',')})`;
    }
  }
  return '#8fc8f0';
}

export function TopBar({ onOpenWorld, onOpenTemplates, onOpenHelp, onOpenFile, onOpenRender, saved }) {
  const engine = useEngine();
  useEngineTopic('env', 'history', 'state');
  const fileInput = useRef(null);

  const { undo, redo } = engine.history;
  const hour = engine.state.env.timeOfDay;

  // The one hidden DOM node React still needs: a file input the top bar and
  // Ctrl+O both reach for.
  useEffect(() => { onOpenFile(() => fileInput.current?.click()); }, [onOpenFile]);

  return (
    <header className="topbar">
      <div className="brand">
        <Icon path={ICON.wordmark} w={2} />
        <b>Grass Painter</b>
      </div>
      <div className="sep" />
      <Btn icon={ICON.undo} kind="ghost" tip="Undo the last thing you did" kbd="Ctrl Z" disabled={!undo} onClick={engine.undo} />
      <Btn icon={ICON.redo} kind="ghost" tip="Redo what you just undid" kbd="Ctrl Shift Z" disabled={!redo} onClick={engine.redo} />

      <div className="grow" />

      <div className={'saved' + (saved ? ' on' : '')}>
        <Icon path={ICON.check} w={2.6} />
        <span>Saved</span>
      </div>

      <button
        type="button"
        className="sun-btn"
        data-tip="Time of day, water, ground colour, quality and layers — everything that belongs to the whole world"
        onClick={onOpenWorld}
      >
        <span className="dot" style={{ background: skyColour(hour) }} />
        <b>{engine.clockLabel(hour)}</b>
      </button>

      <RenderButton onOpen={onOpenRender} />
      <Btn icon={ICON.newWorld} label="New world" className="has-label" tip="Start again from a ready-made world" onClick={onOpenTemplates} />
      <Btn icon={ICON.save} label="Save" className="has-label" tip="Download this world as a file you can open again later" kbd="Ctrl S" onClick={engine.save} />
      <Btn icon={ICON.open} kind="ghost" tip="Open a world you saved earlier" kbd="Ctrl O" onClick={() => fileInput.current?.click()} />
      <Btn icon={ICON.camera} kind="ghost" tip="Save a picture of what you can see" kbd="Ctrl P" onClick={() => engine.exportPNG(1)} />
      <Btn icon={ICON.help} kind="ghost" tip="Take the tour again, or see every keyboard shortcut" kbd="?" onClick={onOpenHelp} />

      <input
        ref={fileInput}
        type="file"
        accept=".json,.grass,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) engine.load(file);
          e.target.value = '';
        }}
      />
    </header>
  );
}

/** Wraps a label so the 820px breakpoint can hide it and leave the icon. */
export function useSavedFlash(engine) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let timer = 0;
    const off = engine.on('saved', () => {
      setSaved(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setSaved(false), 1800);
    });
    return () => { off(); clearTimeout(timer); };
  }, [engine]);
  return saved;
}
