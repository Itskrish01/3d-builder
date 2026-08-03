import { useEffect, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Group, Note, Slider, Btn, ButtonRow } from './controls.jsx';
import { Icon, ICON } from './icons.jsx';
import { useDialog } from './overlays.jsx';

/* ============================================================================
   EXPLORER

   The other view of the same scene: a tree of named folders over the objects
   that are already there. Clicking a row selects in the world, and selecting
   in the world highlights the row — one selection, two ways to reach it.

   Folders are organisational only. Nothing in the renderer knows they exist,
   so no arrangement here can break a scene.
   ========================================================================== */

const DEG = Math.PI / 180;

/* The rows are declared out here on purpose. Defined inside Explorer they
   would be a new component type on every render, so React would throw the
   whole tree away and rebuild it each time — losing the caret out of a rename
   box mid-word, and doing far more DOM work than a tree ever should. */
function FolderRow({ ctx, f, depth }) {
  const { engine, open, toggle, renaming, setRenaming, pick, removeFolder } = ctx;
  const kids = engine.childFolders(f.id);
  const mine = engine.objectsIn(f.id, false);
  const deep = engine.objectsIn(f.id, true);
  const expanded = open.has(f.id);

  return (
    <>
      <div className="node" style={{ paddingLeft: depth * 14 + 4 }}>
        <button
          type="button"
          className={'twist' + (expanded ? ' open' : '')}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => toggle(f.id)}
          disabled={!kids.length && !mine.length}
        >
          <Icon path={ICON.chevron} w={2.4} />
        </button>
        <Icon path={ICON.folder} className="node-ic" />
        {renaming === f.id ? (
          <input
            className="rename"
            autoFocus
            defaultValue={f.name}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(0);
            }}
            onBlur={(e) => { engine.renameFolder(f.id, e.target.value); setRenaming(0); }}
          />
        ) : (
          <button
            type="button"
            className="node-name"
            onDoubleClick={() => setRenaming(f.id)}
            onClick={() => pick(deep, false)}
            data-tip="Click to select everything inside. Double-click to rename."
          >
            {f.name}
          </button>
        )}
        <span className="node-count num">{deep.length || ''}</span>
        <button type="button" className="node-btn" data-tip="Delete this folder"
          aria-label={`Delete ${f.name}`} onClick={() => removeFolder(f)}>
          <Icon path={ICON.trash} />
        </button>
      </div>
      {expanded && (
        <>
          {kids.map((k) => <FolderRow key={k.id} ctx={ctx} f={k} depth={depth + 1} />)}
          {mine.map((o) => <ObjectRow key={o.id} ctx={ctx} o={o} depth={depth + 1} />)}
        </>
      )}
    </>
  );
}

function ObjectRow({ ctx, o, depth }) {
  const { engine, picked, pick } = ctx;
  const label = o.name || engine.ASSETS[o.kind]?.label || 'Object';
  return (
    <div className={'node' + (picked.has(o.id) ? ' on' : '')} style={{ paddingLeft: depth * 14 + 4 }}>
      <span className="twist" />
      <span className="node-dot" style={{ background: engine.CAT_COLOR[o.cat] }} />
      <button
        type="button"
        className="node-name"
        onClick={(e) => pick([o], e.shiftKey)}
        data-tip="Select it. Shift-click to add to the selection."
      >
        {label}
      </button>
    </div>
  );
}

export function Explorer() {
  const engine = useEngine();
  useEngineTopic('scene', 'selection', 'state');
  const dialog = useDialog();
  const [open, setOpen] = useState(() => new Set());
  const [renaming, setRenaming] = useState(0);

  const picked = new Set(engine.Sel.objs.map((o) => o.id));

  /* Picking something in the world reveals it here. A highlighted row inside a
     folder you cannot see is the same as no highlight at all. */
  const selKey = engine.Sel.objs.map((o) => o.id).join(',');
  useEffect(() => {
    const need = new Set();
    for (const o of engine.Sel.objs) {
      let f = engine.folderById(o.folder);
      while (f) { need.add(f.id); f = engine.folderById(f.parent); }
    }
    if (!need.size) return;
    setOpen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of need) if (!next.has(id)) { next.add(id); changed = true; }
      return changed ? next : prev;
    });
     
  }, [selKey, engine]);

  function toggle(id) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /* Selecting from the tree is selecting in the world — there is only one
     selection, and picking a row moves you to the station that can act on it. */
  function pick(objs, additive) {
    if (engine.state.world.mode !== 'select') engine.setMode('select');
    engine.selectObjects(objs, additive);
    engine.touch();
  }

  async function removeFolder(f) {
    const inside = engine.objectsIn(f.id, true);
    if (!inside.length) { engine.deleteFolder(f.id, false); return; }
    const ok = await dialog.confirm({
      title: `Delete "${f.name}" and everything in it?`,
      message: `${inside.length} ${inside.length === 1 ? 'thing is' : 'things are'} in this folder. Cancel keeps them and removes only the folder.`,
      okLabel: `Delete all ${inside.length}`
    });
    engine.deleteFolder(f.id, ok);
  }

  const ctx = { engine, open, toggle, renaming, setRenaming, picked, pick, removeFolder };
  const roots = engine.childFolders(engine.ROOT_FOLDER);
  const loose = engine.objectsIn(engine.ROOT_FOLDER, false);
  const sel = engine.Sel.objs;

  return (
    <>
      <Group title="Explorer">
        <ButtonRow>
          <Btn icon={ICON.folderPlus} label="New folder"
            tip="Add an empty folder at the top level."
            onClick={() => {
              const id = engine.createFolder('Folder', engine.ROOT_FOLDER);
              setOpen((p) => new Set(p).add(id));
              setRenaming(id);
            }} />
          <Btn icon={ICON.folder} label="Group" disabled={!sel.length}
            tip="Put everything selected into a new folder."
            onClick={() => {
              const id = engine.groupIntoFolder(sel, 'Group');
              setOpen((p) => new Set(p).add(id));
              setRenaming(id);
            }} />
        </ButtonRow>

        <div className="tree">
          <div className="node root">
            <span className="twist" />
            <Icon path={ICON.world} className="node-ic" />
            <span className="node-name as-label">Scene</span>
            <span className="node-count num">{engine.objectCount}</span>
          </div>
          {roots.map((f) => <FolderRow key={f.id} ctx={ctx} f={f} depth={1} />)}
          {loose.map((o) => <ObjectRow key={o.id} ctx={ctx} o={o} depth={1} />)}
          {!roots.length && !loose.length && (
            <div className="tree-empty">Nothing placed yet. Anything you put down turns up here.</div>
          )}
        </div>

        {!!sel.length && !!roots.length && (
          <MoveInto onMove={(id) => engine.moveToFolder(sel, id)} />
        )}
      </Group>

      <Properties />
    </>
  );
}

function MoveInto({ onMove }) {
  const engine = useEngine();
  function flatten(parent, depth, out) {
    for (const f of engine.childFolders(parent)) {
      out.push({ id: f.id, label: '— '.repeat(depth) + f.name });
      flatten(f.id, depth + 1, out);
    }
    return out;
  }
  const list = flatten(engine.ROOT_FOLDER, 0, []);
  return (
    <div className="ctrl">
      <div className="ctrl-top"><div className="ctrl-label">Move the selection into</div></div>
      <div className="sel">
        <select
          value=""
          onChange={(e) => { if (e.target.value) onMove(parseInt(e.target.value, 10)); }}
        >
          <option value="">Choose a folder…</option>
          <option value={String(engine.ROOT_FOLDER)}>Scene (top level)</option>
          {list.map((f) => <option key={f.id} value={String(f.id)}>{f.label}</option>)}
        </select>
        <Icon path={ICON.chevron} w={2} />
      </div>
    </div>
  );
}

/* ============================================================================
   PROPERTIES — what the thing you picked actually is, and every number that
   describes it, editable.
   ========================================================================== */
export function Properties() {
  const engine = useEngine();
  useEngineTopic('selection', 'scene', 'state');
  const sel = engine.Sel.objs;

  if (engine.Sel.road && !sel.length) {
    return (
      <Group title="Properties">
        <Note>A road is selected — {engine.Sel.road.pts.length} points, {engine.Sel.road.width.toFixed(1)} m wide.</Note>
      </Group>
    );
  }
  if (!sel.length) {
    return (
      <Group title="Properties">
        <Note>Nothing selected. Click something in the world, or a row above.</Note>
      </Group>
    );
  }

  const one = sel.length === 1 ? sel[0] : null;
  const def = one ? engine.ASSETS[one.kind] : null;

  /* Editing a number moves the whole selection by the difference, so the same
     fields work for one object and for fifty. */
  function nudge(axis, value) {
    const c = engine.selectionCenter();
    const before = engine.snapshotSelection();
    const d = [0, 0, 0];
    d[axis] = value - [c.x, c.y, c.z][axis];
    engine.moveSelection(d[0], d[1], d[2]);
    engine.commitSelectionChange(before, 'Move');
    engine.touch();
  }

  const centre = engine.selectionCenter();

  return (
    <Group title="Properties">
      <Note>
        {one
          ? <>{one.name || def?.label || 'Object'} — <b>{def ? engine.fmtInt(def.tris) : '?'}</b> triangles, on the <b>{one.cat}</b> layer.</>
          : <><b>{sel.length}</b> things selected. Numbers below move or resize all of them together.</>}
      </Note>

      <Slider label="Left / right" get={() => centre.x} set={(v) => nudge(0, v)}
        min={-500} max={500} step={0.05} unit=" m" tip="Position across the world." />
      <Slider label="Up / down" get={() => centre.y} set={(v) => nudge(1, v)}
        min={-200} max={200} step={0.05} unit=" m" tip="Height. Placing already sits things on the ground." />
      <Slider label="Forward / back" get={() => centre.z} set={(v) => nudge(2, v)}
        min={-500} max={500} step={0.05} unit=" m" tip="Position along the world." />

      {/* One row per axis. Yaw still swings the selection about its middle,
          which is what turning a row of houses should do; pitch and roll turn
          each thing where it stands. */}
      {[
        { axis: 'y', label: 'Turn (up axis)', get: (o) => o.rotY },
        { axis: 'x', label: 'Tip forward / back', get: (o) => o.rotX || 0 },
        { axis: 'z', label: 'Roll left / right', get: (o) => o.rotZ || 0 }
      ].map((r) => (
        <Slider key={r.axis} label={r.label} min={-180} max={180} step={1} dec={0} unit="°"
          tip="Rotation about this axis."
          get={() => {
            const v = (r.get(sel[0]) / DEG) % 360;
            return v > 180 ? v - 360 : v < -180 ? v + 360 : v;
          }}
          set={(v) => {
            const before = engine.snapshotSelection();
            engine.rotateSelection(v * DEG - r.get(sel[0]), r.axis);
            engine.commitSelectionChange(before, 'Turn');
            engine.touch();
          }} />
      ))}

      <Slider label="Size" min={0.05} max={20} step={0.01} unit="×"
        tip="Scale. Everything selected scales about the middle of the selection."
        get={() => sel[0].scale}
        set={(v) => {
          const before = engine.snapshotSelection();
          engine.scaleSelection(v / Math.max(sel[0].scale, 1e-4));
          engine.commitSelectionChange(before, 'Resize');
          engine.touch();
        }} />

      <Slider label="Lean with the ground" min={0} max={1} step={0.01}
        tip="0 stands straight up; 1 tips fully with the slope underneath."
        get={() => sel[0].align}
        set={(v) => {
          for (const o of sel) { o.align = v; engine.updateObject(o); }
          engine.markSceneDirty();
          engine.touch();
        }} />

      <ButtonRow>
        <Btn icon={ICON.copy} label="Duplicate" kbd="Ctrl D" onClick={engine.duplicateSelection} />
        <Btn icon={ICON.trash} label="Delete" kind="dgr" kbd="Del" onClick={engine.deleteSelection} />
      </ButtonRow>
    </Group>
  );
}
