import { useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Icon, ICON } from './icons.jsx';
import { STATIONS } from './copy.jsx';
import { StationTools } from './panels/shared.jsx';
import { TerrainPanel } from './panels/TerrainPanel.jsx';
import { GrassPanel } from './panels/GrassPanel.jsx';
import { PlacePanel } from './panels/PlacePanel.jsx';
import { SelectPanel } from './panels/SelectPanel.jsx';
import { Explorer } from './Explorer.jsx';

const PANELS = {
  terrain: TerrainPanel,
  grass: GrassPanel,
  place: PlacePanel,
  select: SelectPanel
};

/* ============================================================================
   THE SETTINGS PANEL

   One station's controls, in flat titled groups. Everything else this station
   can do sits behind one "All settings" line — which replaced eight collapsible
   sections and a Simple/Advanced switch.
   ========================================================================== */
export function Panel({ open, onImport }) {
  const engine = useEngine();
  useEngineTopic('mode', 'scene', 'state', 'library');
  const [tab, setTab] = useState('settings');

  const mode = engine.state.world.mode;
  const Body = PANELS[mode] || TerrainPanel;
  const station = STATIONS[mode];
  const moreOpen = !!engine.state.ui.moreOpen;

  function toggleMore() {
    engine.state.ui.moreOpen = !moreOpen;
    engine.markSceneDirty();
    engine.touch();
  }

  return (
    <aside className={'panel' + (open ? ' open' : ' closed')} aria-label={`${station.label} settings`}>
      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'settings'}
          data-tip="The controls for the station you are in"
          onClick={() => setTab('settings')}>Settings</button>
        <button type="button" role="tab" aria-selected={tab === 'explorer'}
          data-tip="Everything in the world, in folders you arrange — and what each thing is"
          onClick={() => setTab('explorer')}>Explorer</button>
      </div>

      {tab === 'settings' && (
        <>
          <div className="panel-head">
            <span className="panel-title wide">{station.label}</span>
            <span className="panel-lede">{station.lede}</span>
          </div>

          <div className="panel-body">
            <StationTools station={mode} />
            <Body more={false} onImport={onImport} />

            <div className={'more' + (moreOpen ? ' open' : '')}>
              <button
                type="button"
                className="more-btn"
                aria-expanded={moreOpen}
                data-tip="Everything else this station can do"
                onClick={toggleMore}
              >
                <Icon path={ICON.chevron} w={2.2} />
                <span>All settings</span>
              </button>
              {moreOpen && (
                <div className="more-body">
                  <Body more onImport={onImport} />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'explorer' && (
        <div className="panel-body">
          <Explorer />
        </div>
      )}
    </aside>
  );
}
