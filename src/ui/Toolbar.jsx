import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Icon, ICON } from './icons.jsx';

/* ============================================================================
   THE TOOLBAR

   The tools sit on the viewport, at the top left, the way they do in every
   other 3D application — not three clicks deep inside a settings panel. What
   you are doing to a thing belongs next to the thing, and the panel on the
   right is then free to be what it should always have been: the numbers.

   Add / Move / Rotate / Scale, and a delete that only appears when there is
   something to delete.
   ========================================================================== */

const TOOLS = [
  {
    key: 'add', icon: ICON.plus, label: 'Add', kbd: 'A',
    tip: 'Put something into the world'
  },
  {
    key: 'move', icon: ICON.move, label: 'Move', kbd: 'G',
    tip: 'Drag the arrows to move. G, as in grab.'
  },
  {
    key: 'rotate', icon: ICON.rotate, label: 'Rotate', kbd: 'R',
    tip: 'Turn it. Drag the ring, or set any axis by hand on the right.'
  },
  {
    key: 'scale', icon: ICON.scale, label: 'Scale', kbd: 'T',
    tip: 'Make it bigger or smaller'
  }
];

export function Toolbar({ onAdd }) {
  const engine = useEngine();
  useEngineTopic('mode', 'state', 'selection', 'scene');

  const mode = engine.state.world.mode;
  const gizmo = engine.state.sel.gizmo;
  const picked = engine.Sel.objs.length;

  /* One question decides which tool is lit: are we placing, or are we handling
     something already placed? */
  const active = mode === 'place' ? 'add' : gizmo;

  function choose(key) {
    if (key === 'add') { engine.setMode('place'); onAdd?.(); return; }
    engine.setMode('select');
    engine.state.sel.gizmo = key;
    engine.markSceneDirty();
    engine.touch();
  }

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={'tool' + (active === t.key ? ' on' : '')}
          aria-pressed={active === t.key}
          data-tip={t.tip}
          data-key={t.kbd}
          onClick={() => choose(t.key)}
        >
          <Icon path={t.icon} />
          <span className="tool-name">{t.label}</span>
        </button>
      ))}

      <div className="tool-sep" />

      <button
        type="button"
        className="tool"
        disabled={!picked}
        data-tip="Copy what is selected"
        data-key="Ctrl D"
        onClick={engine.duplicateSelection}
      >
        <Icon path={ICON.copy} />
        <span className="tool-name">Copy</span>
      </button>
      <button
        type="button"
        className="tool danger"
        disabled={!picked}
        data-tip="Delete what is selected"
        data-key="Del"
        onClick={engine.deleteSelection}
      >
        <Icon path={ICON.trash} />
        <span className="tool-name">Delete</span>
      </button>
    </div>
  );
}
