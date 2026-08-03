import { useEngine, useEngineTopic } from '../EngineProvider.jsx';
import { Group, Note, Slider, Segment, Btn, ButtonRow } from '../controls.jsx';
import { ICON } from '../icons.jsx';

const DEG = Math.PI / 180;

export function SelectPanel({ more }) {
  const engine = useEngine();
  useEngineTopic('selection', 'scene');

  const picked = engine.Sel.objs;
  const road = engine.Sel.road;

  if (more) {
    return (
      <>
        <Group title="Selection">
          <Slider label="Arrow-key step" path="sel.nudge" min={0.05} max={5} step={0.05} unit=" m"
            tip="How far the arrow keys shift what is picked." />
          <ButtonRow>
            <Btn icon={ICON.copy} label="Save as a group"
              tip="Turn what is picked into one stamp you can place again from the Place station."
              onClick={() => { if (engine.groupSelectionToPrefab()) engine.touch(); }} />
          </ButtonRow>
        </Group>

        {!!engine.World.prefabs.length && (
          <Group title="Your groups">
            {engine.World.prefabs.map((pf) => (
              <ButtonRow key={pf.id}>
                <Btn
                  icon={ICON.place}
                  label={`${pf.name} — ${pf.items.length} pieces`}
                  tip="Switch to Place with this group ready to stamp."
                  onClick={() => {
                    engine.state.place.kind = pf.id;
                    engine.state.place.kinds = [pf.id];
                    engine.setMode('place');
                  }}
                />
              </ButtonRow>
            ))}
          </Group>
        )}
      </>
    );
  }

  return (
    <Group title="Selection">
      <Note>{describe(engine, picked, road)}</Note>

      <Segment
        path="sel.gizmo"
        tip="What the handles on screen do."
        onChange={engine.refreshSelectionVisuals}
        options={[
          { value: 'move', label: 'Move' },
          { value: 'rotate', label: 'Turn' },
          { value: 'scale', label: 'Resize' }
        ]}
      />

      {road && !picked.length && (
        <ButtonRow>
          <Btn icon={ICON.trash} label="Delete this road" kind="dgr"
            tip="Remove the road and anything placed along it."
            onClick={() => { engine.deleteRoad(road); engine.clearSelection(); engine.touch(); }} />
        </ButtonRow>
      )}

      {!!picked.length && <Transforms />}

      <ButtonRow>
        <Btn icon={ICON.copy} label="Duplicate" kbd="Ctrl D" tip="Make a copy, just to one side."
          disabled={!picked.length} onClick={engine.duplicateSelection} />
        <Btn icon={ICON.trash} label="Delete" kind="dgr" kbd="Del" tip="Remove what is picked."
          disabled={!picked.length} onClick={engine.deleteSelection} />
      </ButtonRow>
    </Group>
  );
}

function describe(engine, picked, road) {
  if (road) return `A road is picked — ${road.pts.length} points`;
  if (!picked.length) return 'Nothing picked yet';
  if (picked.length === 1) return `${engine.ASSETS[picked[0].kind]?.label || 'One thing'} is picked`;
  return `${picked.length} things are picked`;
}

/** Position, turn and size as numbers, for when dragging a handle will not do. */
function Transforms() {
  const engine = useEngine();
  const centre = engine.selectionCenter();
  const first = engine.Sel.objs[0];

  const rows = [
    { key: 'P', label: 'Position', values: [centre.x, centre.y, centre.z], apply: (i, v) => {
      const d = [0, 0, 0];
      d[i] = v - [centre.x, centre.y, centre.z][i];
      engine.moveSelection(d[0], d[1], d[2]);
    } },
    { key: 'T', label: 'Turn, in degrees (up-down axis only)', values: [0, first.rotY / DEG, 0], apply: (i, v) => {
      if (i === 1) engine.rotateSelection(v * DEG - first.rotY);
    } },
    { key: 'S', label: 'Size', values: [first.scale, first.scale, first.scale], apply: (_i, v) => {
      engine.scaleSelection(v / Math.max(first.scale, 1e-4));
    } }
  ];

  return rows.map((row) => (
    <div className="xform" key={row.key}>
      <i>{row.key}</i>
      {row.values.map((v, i) => (
        <input
          key={i}
          type="text"
          defaultValue={v.toFixed(2)}
          data-tip={row.label}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
          onBlur={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isFinite(n)) return;
            const before = engine.snapshotSelection();
            row.apply(i, n);
            engine.commitSelectionChange(before, 'Transform');
          }}
        />
      ))}
    </div>
  ));
}
