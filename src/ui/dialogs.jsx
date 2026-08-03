import { Dialog } from './overlays.jsx';
import { Btn } from './controls.jsx';
import { ICON } from './icons.jsx';
import { SHORTCUTS } from './copy.jsx';

export function HelpDialog({ onClose, onTour, onShortcuts }) {
  return (
    <Dialog title="Help" onClose={onClose}>
      <p>Grass Painter has four stations down the left. Pick one, then work directly on the ground.</p>
      <div className="btn-row">
        <Btn icon={ICON.place} label="Take the tour" kind="pri"
          tip="Walk through the whole tool, one station at a time."
          onClick={() => { onClose(); onTour(); }} />
        <Btn icon={ICON.keyboard} label="Keyboard shortcuts"
          tip="Every key the tool listens for."
          onClick={() => { onClose(); onShortcuts(); }} />
      </div>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }) {
  return (
    <Dialog title="Keyboard shortcuts" wide onClose={onClose}>
      <p>
        Sliders take a drag anywhere along the track, Shift-drag for fine control, a double-click to
        reset, and typed numbers.
      </p>
      <div className="keys">
        {SHORTCUTS.map(([group, rows]) => (
          <div key={group}>
            <h4>{group}</h4>
            <dl>
              {rows.map(([keys, what]) => (
                <div key={keys} style={{ display: 'contents' }}>
                  <dt>{keys.split(/\s+/).map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
