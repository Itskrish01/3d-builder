import { useEffect, useRef, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Group, Note, Chips, Select, Slider, Toggle, Btn } from './controls.jsx';
import { Icon, ICON } from './icons.jsx';
import { PLACE_SHELVES } from './copy.jsx';
import { useDialog } from './overlays.jsx';

/* ============================================================================
   THE MODEL PICKER

   Lives inside the Place panel rather than in a separate shelf along the
   bottom — one screen region fewer to notice, learn and explain.
   ========================================================================== */

/** The renderer draws the model with the real object shader, so the card shows
    exactly what will be placed. Cached, because that costs a render target. */
function Thumb({ kind, kindOrGroup }) {
  const engine = useEngine();
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const key = `${kindOrGroup}|${kind}`;
    const cached = engine.thumbCache.get(key);
    if (cached) {
      canvas.width = cached.width;
      canvas.height = cached.height;
      canvas.getContext('2d').drawImage(cached, 0, 0);
      return;
    }
    try {
      if (kindOrGroup === 'asset') engine.renderThumb(kind, canvas);
      else engine.drawGroupSwatch(canvas);
    } catch {
      return;   // a model that failed to build simply shows an empty tile
    }
    const store = document.createElement('canvas');
    store.width = canvas.width || 128;
    store.height = canvas.height || 128;
    store.getContext('2d').drawImage(canvas, 0, 0);
    engine.thumbCache.set(key, store);
  }, [engine, kind, kindOrGroup]);

  return <canvas ref={ref} />;
}

function ModelCard({ label, kind, type, selected, onPick }) {
  return (
    <button
      type="button"
      className="mcard"
      aria-pressed={selected}
      data-tip={label}
      onClick={onPick}
    >
      <Thumb kind={kind} kindOrGroup={type} />
      <b>{label}</b>
      {selected && <span className="tick"><Icon path={ICON.check} w={3} /></span>}
    </button>
  );
}

export function ModelPicker({ onImport }) {
  const engine = useEngine();
  useEngineTopic('library', 'state');
  const [shelf, setShelf] = useState('all');

  const ids = Object.keys(engine.ASSETS);
  const counts = {};
  for (const id of ids) counts[engine.ASSETS[id].kind] = (counts[engine.ASSETS[id].kind] || 0) + 1;

  const shelves = PLACE_SHELVES.filter((s) => s.id === 'all' || counts[s.id]);
  const current = shelves.some((s) => s.id === shelf) ? shelf : 'all';

  const shown = ids
    .filter((id) => current === 'all' || engine.ASSETS[id].kind === current)
    .sort((a, b) => engine.ASSETS[a].label.localeCompare(engine.ASSETS[b].label));

  const chosen = engine.state.place.kinds;

  function pick(id, additive) {
    const at = chosen.indexOf(id);
    if (additive) {
      // Shift builds a mix, and can empty it — putting the brush down is
      // always available, however you got here.
      if (at >= 0) chosen.splice(at, 1);
      else chosen.push(id);
    } else if (at >= 0 && chosen.length === 1) {
      // Clicking the one you already chose is how you stop placing. Without
      // this every click on the ground drops another copy and there is no way
      // out except switching station.
      chosen.length = 0;
    } else {
      engine.state.place.kinds = [id];
    }
    engine.state.place.kind = engine.state.place.kinds[engine.state.place.kinds.length - 1] || '';
    engine.markSceneDirty();
    engine.touch();
  }

  function clearChoice() {
    engine.state.place.kinds = [];
    engine.state.place.kind = '';
    engine.markSceneDirty();
    engine.touch();
  }

  return (
    <Group title="Models">
      {shelves.length > 2 && (
        <Chips
          get={() => current}
          set={setShelf}
          options={shelves.map((s) => ({ value: s.id, label: s.label }))}
        />
      )}

      <div className="mgrid">
        <button
          type="button"
          className="mcard add"
          data-tip="Search Sketchfab and bring a model into your library"
          onClick={onImport}
        >
          <div className="ph"><Icon path={ICON.plus} w={2.4} /></div>
          <b>Add models</b>
        </button>

        {!ids.length && (
          <div className="empty">
            Nothing to place yet. Everything in this world comes from Sketchfab — press Add models to bring one in.
          </div>
        )}

        {shown.map((id) => (
          <ModelCard
            key={id}
            label={engine.ASSETS[id].label}
            kind={id}
            type="asset"
            selected={chosen.includes(id)}
            onPick={(e) => pick(id, e.shiftKey)}
          />
        ))}

        {current === 'all' && engine.World.prefabs.map((pf) => (
          <ModelCard
            key={pf.id}
            label={pf.name}
            kind={pf.id}
            type="group"
            selected={chosen.includes(pf.id)}
            onPick={(e) => pick(pf.id, e.shiftKey)}
          />
        ))}
      </div>

      {!!ids.length && (chosen.length
        ? (
          <div className="chosen-row">
            <Note>
              Placing <b>{chosen.length === 1 ? (engine.ASSETS[chosen[0]]?.label || 'a group') : `${chosen.length} models`}</b>.
              Click it again, or press <kbd>Esc</kbd>, to stop.
            </Note>
            <Btn label="Stop placing" tip="Put the brush down. Clicking the ground will not add anything." onClick={clearChoice} />
          </div>
        )
        : <Note>Click a model to choose it. <b>Shift-click</b> to mix several together when you scatter.</Note>
      )}
    </Group>
  );
}

/* ============================================================================
   LIBRARY LIST — what each model costs, which shelf it is on, how big it is
   and how much it moves. Everything a model needs, next to the model.
   ========================================================================== */
export function LibraryList() {
  const engine = useEngine();
  useEngineTopic('library');
  const dialog = useDialog();
  const [cacheMB, setCacheMB] = useState(null);

  useEffect(() => {
    engine.sfCacheSize().then((n) => n > 0 && setCacheMB((n / 1048576).toFixed(1)));
  }, [engine]);

  const ids = Object.keys(engine.ASSETS).sort(
    (a, b) => engine.ASSETS[a].label.localeCompare(engine.ASSETS[b].label)
  );

  if (!ids.length) {
    return (
      <Group title="Your models">
        <Note>Nothing here yet. Press <b>Add models</b> above to bring something in from Sketchfab.</Note>
      </Group>
    );
  }

  return (
    <Group title="Your models">
      {ids.map((id) => {
        const def = engine.ASSETS[id];
        return (
          <div key={id}>
            <div className="lib">
              <Thumb kind={id} kindOrGroup="asset" />
              <div className="info">
                <b>{def.label}</b>
                <span>{engine.fmtInt(def.tris)} tris · {def.height.toFixed(1)} m tall</span>
              </div>
              <button
                type="button"
                className="ic"
                data-tip="Throw this model away, along with every copy in the world"
                aria-label={`Remove ${def.label}`}
                onClick={async () => {
                  const ok = await dialog.confirm({
                    title: `Throw away "${def.label}"?`,
                    message: 'This takes the model out of your library and removes every copy of it in the world. The download stays in this browser, so bringing it back is instant.',
                    okLabel: 'Throw it away'
                  });
                  if (ok) engine.removeFromLibrary(id);
                }}
              >
                <Icon path={ICON.trash} />
              </button>
            </div>

            <Select
              label="Shelf"
              tip="Which shelf you find this model on in the picker."
              get={() => def.kind}
              set={(v) => {
                for (const o of engine.World.objs) if (o.kind === id) o.cat = SHELF_CAT[v] || 'props';
                def.kind = v;
                def.cat = 'imp_' + v;
                engine.rebuildAssetCats();
                engine.applyLayerVisibility();
                engine.saveLibraryIndex();
                engine.markSceneDirty();
              }}
              options={engine.IMP_KINDS.map((k) => ({ value: k.id, label: k.label }))}
            />
            <Slider
              label="True size" min={0.05} max={20} step={0.01} def={1} unit="×"
              tip="Fixes a model that arrived at the wrong scale. Every copy already in the world changes with it."
              get={() => def.scale}
              set={(v) => { def.scale = v; engine.saveLibraryIndex(); engine.rescaleKind(id); engine.markSceneDirty(); }}
            />
            <Slider
              label="Sways in the wind" min={0} max={2} step={0.01} def={0}
              tip="How much this model bends in the same wind as the grass. Good for leaves, leave at 0 for solid things."
              get={() => def.sway}
              set={(v) => { def.sway = v; engine.saveLibraryIndex(); engine.reswayKind(id); engine.markSceneDirty(); }}
            />
            <Animation id={id} def={def} />
          </div>
        );
      })}
      <Note>
        Models are kept in this browser{cacheMB ? ` (${cacheMB} MB)` : ''}, so reopening a world does not download them again.
      </Note>
    </Group>
  );
}


/* ============================================================================
   ANIMATION

   Only shows up for models that came with clips. Playback is a property of the
   model rather than of each copy, so every copy of a walking character walks —
   at its own random phase, so a crowd is not in lockstep.
   ========================================================================== */
function Animation({ id, def }) {
  const engine = useEngine();
  const [, force] = useState(0);

  if (!def.clipCount) return null;

  if (!def.anim) {
    return (
      <Note>
        This model came with {def.clipCount === 1 ? 'an animation' : `${def.clipCount} animations`}, but it has
        too many points to animate smoothly at this size, so it stands still.
      </Note>
    );
  }

  const clips = def.anim.clips;
  const push = () => {
    engine.applyAnimSettings(id);
    engine.saveLibraryIndex();
    engine.markSceneDirty();
    force((n) => n + 1);
  };

  return (
    <>
      <Toggle
        label="Play its animation"
        tip="Every copy of this model plays the clip, each starting at a different point."
        get={() => !!def.animPlay}
        set={(v) => { def.animPlay = v; }}
        onChange={push}
      />
      {clips.length > 1 && (
        <Select
          label="Which one"
          tip="The clips that came with the model."
          get={() => String(def.animClip || 0)}
          set={(v) => { def.animClip = parseInt(v, 10) || 0; }}
          onChange={push}
          options={clips.map((c, i) => ({ value: String(i), label: c.name }))}
        />
      )}
      <Slider
        label="Speed" min={0.1} max={3} step={0.05} def={1} unit="×"
        tip="1 plays it at the speed it was made at."
        get={() => def.animSpeed ?? 1}
        set={(v) => { def.animSpeed = v; }}
        onChange={push}
      />
      {def.anim.dropped > 0 && (
        <Note>{def.anim.dropped === 1 ? 'One more clip' : `${def.anim.dropped} more clips`} came with this model but did not fit in memory.</Note>
      )}
    </>
  );
}

const SHELF_CAT = { building: 'buildings', nature: 'nature', prop: 'props', person: 'people', vehicle: 'vehicles' };
