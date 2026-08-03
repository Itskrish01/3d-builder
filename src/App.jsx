import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EngineProvider, useEngine } from './ui/EngineProvider.jsx';
import { DialogHost, Marquee, Tooltip, useDialog, useToastQueue } from './ui/overlays.jsx';
import { TopBar, useSavedFlash } from './ui/TopBar.jsx';
import { Rail, Hint } from './ui/Rail.jsx';
import { Panel } from './ui/Panel.jsx';
import { WorldSheet } from './ui/WorldSheet.jsx';
import { RenderOverlay } from './ui/Render.jsx';
import { SketchfabBrowser } from './ui/SketchfabBrowser.jsx';
import { TemplatesDialog, HelpDialog, ShortcutsDialog } from './ui/dialogs.jsx';
import { Tour } from './ui/Tour.jsx';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';

/* ============================================================================
   The chrome. Everything here is React; everything inside the canvas is the
   engine. The two meet through the adapter built below, which is the whole of
   what the engine is allowed to ask a person for.
   ========================================================================== */

export default function App() {
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);

  const [toastNode, toast] = useToastQueue();
  const [marquee, setMarquee] = useState(null);
  // Owned here rather than in Chrome because it decides the shape of the grid
  // that Chrome is laid out inside.
  const [chromeHidden, setChromeHidden] = useState(false);

  // The engine calls these; they are held in refs inside the provider so the
  // engine is never rebuilt just because a callback identity changed.
  const hooks = useRef({});
  const adapter = useMemo(() => ({
    toast,
    marquee: setMarquee,
    askClearGrass: () => hooks.current.askClearGrass?.(),
    showShortcuts: () => hooks.current.showShortcuts?.(),
    escape: () => hooks.current.escape?.() ?? false,
    openFile: () => hooks.current.openFile?.(),
    togglePanel: () => hooks.current.togglePanel?.(),
    toggleUi: () => hooks.current.toggleUi?.()
  }), [toast]);

  return (
    <div className={'app' + (chromeHidden ? ' bare' : '')}>
      <div className="stage" ref={viewportRef}>
        <canvas className="view" ref={canvasRef} />
      </div>

      <EngineProvider canvasRef={canvasRef} viewportRef={viewportRef} adapter={adapter}>
        <ErrorBoundary>
          <DialogHost>
            <Chrome
              hooks={hooks}
              marquee={marquee}
              chromeHidden={chromeHidden}
              setChromeHidden={setChromeHidden}
            />
          </DialogHost>
        </ErrorBoundary>
      </EngineProvider>

      {toastNode}
      <Tooltip />
    </div>
  );
}

/**
 * Everything that needs the engine. Kept below the provider so it can use the
 * engine unconditionally, rather than guarding on null in twenty places.
 */
function Chrome({ hooks, marquee, chromeHidden, setChromeHidden }) {
  const engine = useEngine();
  const dialog = useDialog();
  const saved = useSavedFlash(engine);

  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia('(max-width:1120px)').matches);
  const [tour, setTour] = useState(false);
  /* Not a dialog: the traced image is drawn on the canvas underneath, so this
     one floats over the stage instead of covering it with a scrim. */
  const [renderOpen, setRenderOpen] = useState(false);
  const openFileRef = useRef(() => {});

  /* ---- the moving parts the engine reaches back for ---- */
  const openShortcuts = useCallback(() => {
    dialog.open((close) => <ShortcutsDialog onClose={close} />);
  }, [dialog]);

  const openTemplates = useCallback(() => {
    dialog.open((close) => <TemplatesDialog onClose={close} />);
  }, [dialog]);

  const openWorld = useCallback(() => {
    dialog.open((close) => <WorldSheet onClose={close} />);
  }, [dialog]);

  const openImport = useCallback(() => {
    dialog.open((close) => <SketchfabBrowser onClose={close} />);
  }, [dialog]);

  const openHelp = useCallback(() => {
    dialog.open((close) => (
      <HelpDialog onClose={close} onTour={() => setTour(true)} onShortcuts={openShortcuts} />
    ));
  }, [dialog, openShortcuts]);

  const askClearGrass = useCallback(async () => {
    const ok = await dialog.confirm({
      title: 'Clear all the grass?',
      message: `This removes all ${engine.fmtInt(engine.bladeCount)} blades. Ctrl+Z brings them back.`,
      okLabel: 'Clear the grass'
    });
    if (ok) engine.clearAll();
  }, [dialog, engine]);

  const togglePanel = useCallback(() => setPanelOpen((v) => !v), []);
  const toggleUi = useCallback(() => {
    setChromeHidden((v) => {
      engine.setUiHidden(!v);
      return !v;
    });
  }, [engine, setChromeHidden]);

  // Escape belongs to the UI first: it closes a tour or a dialog before the
  // engine gets to cancel a drag or drop a selection.
  const escape = useCallback(() => {
    if (tour) { setTour(false); return true; }
    if (dialog.anyOpen()) { dialog.close(); return true; }
    return false;
  }, [tour, dialog]);

  // Refreshed after every render so the engine always calls the current
  // closures — `tour` and `dialog` state change what Escape should do.
  useEffect(() => {
    hooks.current = {
      askClearGrass,
      showShortcuts: openShortcuts,
      escape,
      togglePanel,
      toggleUi,
      openFile: () => openFileRef.current()
    };
  });

  /* ---- first run opens the tour ---- */
  useEffect(() => {
    if (engine.state.world.seenIntro) return undefined;
    const id = setTimeout(() => setTour(true), 700);
    return () => clearTimeout(id);
  }, [engine]);

  /* ---- the canvas has to follow the panel when it is part of the layout ---- */
  useEffect(() => {
    const id = setTimeout(() => engine.resize(), 300);
    return () => clearTimeout(id);
  }, [engine, panelOpen, chromeHidden]);

  function finishTour() {
    setTour(false);
    engine.state.world.seenIntro = true;
    engine.markSceneDirty();
  }

  return (
    <>
      {!chromeHidden && (
        <>
          <TopBar
            saved={saved}
            onOpenWorld={openWorld}
            onOpenTemplates={openTemplates}
            onOpenHelp={openHelp}
            onOpenFile={(fn) => { openFileRef.current = fn; }}
            onOpenRender={() => setRenderOpen((v) => !v)}
          />
          <Rail />
          <Panel open={panelOpen} onImport={openImport} />
          <button
            type="button"
            className={'panel-toggle' + (panelOpen ? '' : ' flipped')}
            data-tip="Hide or show the settings"
            data-key="Tab"
            aria-label="Hide or show the settings"
            aria-expanded={panelOpen}
            onClick={togglePanel}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
          <Hint />
        </>
      )}

      <Marquee rect={marquee} />
      {!chromeHidden && <RenderOverlay open={renderOpen} onClose={() => setRenderOpen(false)} />}
      {tour && <Tour onFinish={finishTour} />}
    </>
  );
}
