import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon, ICON } from './icons.jsx';
import { Btn } from './controls.jsx';

/* ============================================================================
   TOOLTIP

   One listener for the whole app rather than a wrapper round every control:
   anything with a `data-tip` gets one, including elements rendered by code
   that has never heard of this component.
   ========================================================================== */
export function Tooltip() {
  const [tip, setTip] = useState(null);
  const timer = useRef(0);
  const box = useRef(null);

  useEffect(() => {
    function over(e) {
      const el = e.target.closest?.('[data-tip]');
      if (!el) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setTip({
          text: el.getAttribute('data-tip'),
          key: el.getAttribute('data-key'),
          rect: el.getBoundingClientRect()
        });
      }, 420);
    }
    function out(e) {
      if (!e.target.closest?.('[data-tip]')) return;
      clearTimeout(timer.current);
      setTip(null);
    }
    function down() { clearTimeout(timer.current); setTip(null); }

    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    window.addEventListener('pointerdown', down, true);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      window.removeEventListener('pointerdown', down, true);
    };
  }, []);

  // Placed after layout so the measured width is the real one.
  useEffect(() => {
    if (!tip || !box.current) return;
    const el = box.current;
    const own = el.getBoundingClientRect();
    const { rect } = tip;
    const x = Math.min(Math.max(8, rect.left + rect.width / 2 - own.width / 2), window.innerWidth - own.width - 8);
    let y = rect.top - own.height - 10;
    if (y < 6) y = rect.bottom + 10;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div className="tip" ref={box} role="tooltip">
      {tip.text}
      {tip.key && <span className="k">{tip.key}</span>}
    </div>
  );
}

/* ============================================================================
   TOASTS
   ========================================================================== */
export function useToastQueue() {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  /** Pass an id to replace an existing message rather than stack a new one —
      used by readouts that fire repeatedly, like fly speed while scrolling. */
  const toast = useCallback((message, kind, ms = 2400, id) => {
    const key = id || `t${++seq.current}`;
    setToasts((list) => {
      const next = list.filter((t) => t.key !== key);
      return [...next, { key, message, kind }];
    });
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.key !== key)), ms);
  }, []);

  const node = (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.key} className={`toast ${t.kind || ''}`.trim()}>{t.message}</div>
      ))}
    </div>
  );
  return [node, toast];
}

/* ============================================================================
   DIALOGS

   One stack, one place that knows about Escape and the backdrop. Anything that
   needs to ask something renders through here rather than growing its own.
   ========================================================================== */
const DialogContext = createContext(null);
export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog outside <DialogHost>');
  return ctx;
}

export function DialogHost({ children }) {
  const [stack, setStack] = useState([]);
  const seq = useRef(0);

  const close = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const closeAll = useCallback(() => setStack([]), []);

  /** @param {(close: () => void) => React.ReactNode} render */
  const open = useCallback((render) => {
    const key = ++seq.current;
    setStack((s) => [...s, { key, render }]);
    return key;
  }, []);

  /** Yes/no, resolved as a promise so callers read top to bottom. */
  const confirm = useCallback(({ title, message, okLabel = 'Yes', danger = true }) => (
    new Promise((resolve) => {
      open((dismiss) => (
        <Dialog
          title={title}
          onClose={() => { dismiss(); resolve(false); }}
          actions={
            <>
              <Btn label="Cancel" onClick={() => { dismiss(); resolve(false); }} />
              <Btn label={okLabel} kind={danger ? 'dgr' : 'pri'} onClick={() => { dismiss(); resolve(true); }} />
            </>
          }
        >
          <p>{message}</p>
        </Dialog>
      ));
    })
  ), [open]);

  const api = { open, close, closeAll, confirm, get isOpen() { return stack.length > 0; } };
  const openRef = useRef(false);
  openRef.current = stack.length > 0;
  api.anyOpen = () => openRef.current;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {stack.map((entry, i) => (
        <div key={entry.key} style={{ zIndex: 150 + i, position: 'relative' }}>
          {entry.render(close)}
        </div>
      ))}
    </DialogContext.Provider>
  );
}

export function Dialog({ title, children, actions, onClose, wide }) {
  const dialog = useDialog();
  const dismiss = onClose || dialog.close;

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); dismiss(); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismiss]);

  return (
    <div
      className="scrim"
      onPointerDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`.trim()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <b className="wide">{title}</b>
          <Btn icon={ICON.close} kind="ghost" tip="Close" onClick={dismiss} />
        </div>
        <div className="modal-body">
          {children}
          {actions && <div className="btn-row">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   BOX-SELECT MARQUEE — the engine reports the rectangle, this draws it
   ========================================================================== */
export function Marquee({ rect }) {
  if (!rect) return null;
  return (
    <div
      className="marquee"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    />
  );
}

export function CheckIcon() {
  return <Icon path={ICON.check} w={2.6} />;
}
