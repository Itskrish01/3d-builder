import { useEffect, useState } from 'react';
import { useEngine, useEngineTopic } from './EngineProvider.jsx';
import { Dialog, useDialog } from './overlays.jsx';
import { Group, Note, Slider, Toggle, Segment, Select, ColorField, Btn, ButtonRow } from './controls.jsx';
import { Icon, ICON } from './icons.jsx';

/* ============================================================================
   THE WORLD SHEET

   Everything that belongs to the world rather than to a station: light, ground,
   water, quality, the camera, layers, housekeeping. One deliberate trip here
   instead of twenty-five controls sitting under every station forever.
   ========================================================================== */
export function WorldSheet({ onClose }) {
  useEngineTopic('env', 'state', 'scene');

  return (
    <Dialog title="World" wide onClose={onClose}>
      <div className="sheet">
        <div>
          <Light />
          <Ground />
          <Water />
        </div>
        <div>
          <Quality />
          <Camera />
          <Layers />
          <Housekeeping />
        </div>
      </div>
    </Dialog>
  );
}

function Light() {
  const engine = useEngine();
  return (
    <Group title="Light">
      <Slider label="Time of day" path="env.timeOfDay" min={0} max={24} step={0.05} apply={['env']}
        format={(v) => engine.clockLabel(v)}
        tip="Moves the sun. Everything else — sky, shadows, the glow through the blades — follows it." />
      <Slider label="Brightness" path="env.exposure" min={0.2} max={3} step={0.01} apply={['env']}
        tip="Overall exposure of the picture." />
      <Slider label="Light on models" path="env.modelFill" min={0} max={1} step={0.01} apply={['env']}
        tip="How evenly imported models are lit. High shows them close to the colours they had where you found them; low lets the scene's own sun and shadow fall across them." />
      <Toggle label="Draw the sky" path="env.sky" apply={['env']}
        tip="Off gives a flat background in the haze colour." />
      <Slider label="Haze" path="env.fogDensity" min={0} max={0.06} step={0.0002} dec={4} apply={['env']}
        tip="Distance fog. Small numbers already reach a long way across a big world." />
      <Toggle label="Haze matches the sky" path="env.fogAuto" apply={['env']}
        tip="Take the haze colour from the sky instead of choosing it yourself." />
      <ColorField label="Haze colour" path="env.fogColor" apply={['env']}
        tip="Used when the haze does not follow the sky." />
      <Toggle label="Shadows under the grass" path="env.shadows" apply={['env']}
        tip="Darken the ground beneath thick grass." />
      <Slider label="Shadow strength" path="env.shadowStrength" min={0} max={1} step={0.01} apply={['env']}
        tip="How dark those shadows get." />
    </Group>
  );
}

function Ground() {
  return (
    <Group title="Ground">
      <Toggle label="Colour it by steepness" path="plate.autoTex" apply={['ground']}
        tip="Blend grass, dirt, rock and snow automatically by how steep and how high the ground is." />
      <ColorField label="Flat ground" path="plate.grassColor" apply={['ground']} tip="Colour where the ground is level." />
      <ColorField label="Gentle slopes" path="plate.dirtColor" apply={['ground']} tip="Colour on mild slopes." />
      <ColorField label="Cliffs" path="plate.rockColor" apply={['ground']} tip="Colour on steep faces." />
      <Slider label="How steep counts as cliff" path="plate.rockSlope" min={0.2} max={0.99} step={0.01} apply={['ground']}
        tip="Lower means only the very steepest faces turn to rock." />
      <Slider label="Cliff blend" path="plate.rockBlend" min={0.01} max={0.5} step={0.01} apply={['ground']}
        tip="How softly grass fades into rock." />
      <Toggle label="Snow on the tops" path="plate.snowOn" apply={['ground']} tip="Cap high ground with snow." />
      <ColorField label="Snow colour" path="plate.snowColor" apply={['ground']} tip="Colour of the snow." />
      <Slider label="Snow line" path="plate.snowline" min={-10} max={60} step={0.1} dec={1} unit=" m" apply={['ground']}
        tip="The height snow starts settling at." />
      <Slider label="Snow blend" path="plate.snowBlend" min={0.1} max={12} step={0.1} dec={1} apply={['ground']}
        tip="How gradually the snow line fades in." />
      <Select label="Plain pattern instead" path="plate.pattern" apply={['ground']}
        tip="Used when colouring by steepness is off."
        options={[
          { value: 'solid', label: 'Plain' },
          { value: 'checker', label: 'Checker' },
          { value: 'radial', label: 'Fading circle' },
          { value: 'noise', label: 'Patchy dirt' }
        ]} />
      <ColorField label="Pattern colour" path="plate.baseColor" apply={['ground']} tip="Main colour of that pattern." />
      <ColorField label="Second colour" path="plate.secColor" apply={['ground']} tip="The other colour in that pattern." />
      <Toggle label="Measuring grid" path="plate.grid" apply={['ground']} kbd="G"
        tip="Lines on the ground so you can judge distance." />
      <Slider label="Grid spacing" path="plate.gridSpacing" min={0.25} max={20} step={0.05} unit=" m" apply={['ground']}
        tip="Distance between grid lines." />
    </Group>
  );
}

function Water() {
  const engine = useEngine();
  return (
    <Group title="Water">
      <Toggle label="Flood the low ground" path="plate.water" onChange={engine.rebuildWater}
        tip="Fill everything below the water line." />
      <Slider label="Water level" path="plate.waterLevel" min={-30} max={30} step={0.05} unit=" m"
        onChange={engine.rebuildWater} tip="How high the water sits." />
      <ColorField label="Near the shore" path="plate.waterColor" onChange={engine.syncWaterUniforms} tip="Colour in the shallows." />
      <ColorField label="Out deep" path="plate.waterDeep" onChange={engine.syncWaterUniforms} tip="Colour where it is deep." />
      <Slider label="See-through" path="plate.waterOpacity" min={0.1} max={1} step={0.01}
        onChange={engine.syncWaterUniforms} tip="How much of the lake bed shows through." />
      <Slider label="Ripple size" path="plate.waveScale" min={0.05} max={3} step={0.01}
        onChange={engine.syncWaterUniforms} tip="Size of the ripples on the surface." />
      <Slider label="Ripple speed" path="plate.waveSpeed" min={0} max={3} step={0.01}
        onChange={engine.syncWaterUniforms} tip="How fast the ripples travel." />
      <Slider label="Foam at the edge" path="plate.foam" min={0} max={2} step={0.01}
        onChange={engine.syncWaterUniforms} tip="The white band where water meets land." />
    </Group>
  );
}

function Quality() {
  const engine = useEngine();
  const [stats, setStats] = useState(() => ({ ...engine.stats }));

  useEffect(() => {
    const id = setInterval(() => setStats({ ...engine.stats }), 300);
    return () => clearInterval(id);
  }, [engine]);

  return (
    <Group title="Quality">
      <Segment
        path="world.quality"
        tip="Moves draw distance, grass density and the animation budget together."
        options={Object.keys(engine.QUALITY).map((k) => ({
          value: k, label: engine.QUALITY[k].label, tip: `${engine.QUALITY[k].label} detail`
        }))}
        set={(v) => engine.setQuality(v)}
      />
      <Toggle label="Keep everything moving" path="world.simulate" kbd="P" apply={['env']}
        tip="Turn off to freeze the wind, water, people and traffic for a clean screenshot." />
      <div className="readout">
        <div className={stats.fps && stats.fps < 40 ? 'warn' : ''}>
          <i>Frames</i><b>{stats.fps ? stats.fps.toFixed(0) : '—'}</b>
        </div>
        <div><i>Blades</i><b>{engine.fmtInt(stats.blades)}</b></div>
        <div><i>Objects</i><b>{engine.fmtInt(stats.objects)}</b></div>
        <div><i>Triangles</i><b>{engine.fmtInt(stats.triangles)}</b></div>
      </div>
    </Group>
  );
}

function Camera() {
  return (
    <Group title="Camera">
      <Note>
        Fly with <b>W A S D</b>, <b>E</b> up and <b>Q</b> down. Hold the right mouse button to look around,
        and roll the wheel while looking to change speed. <b>F</b> frames whatever is picked.
      </Note>
      <Slider label="Field of view" path="cam.fov" min={20} max={110} step={1} dec={0} unit="°" apply={['camera']}
        tip="How wide a view the camera takes in. Low is a telephoto look that flattens distance; high is a wide angle that exaggerates it." />
      <Slider label="Fly speed" path="cam.flySpeed" min={1} max={400} step={0.5} dec={0} unit=" m/s"
        tip="How fast W A S D moves you." />
      <Slider label="Shift speeds it up by" path="cam.boost" min={1} max={12} step={0.1} dec={1} unit="×"
        tip="Speed multiplier while Shift is held." />
      <Slider label="Mouse sensitivity" path="cam.lookSens" min={0.2} max={3} step={0.01}
        tip="How far the view turns per pixel of mouse movement." />
      <Toggle label="Invert up and down" path="cam.invertY" tip="Flip the vertical direction of looking around." />
    </Group>
  );
}

function Layers() {
  const engine = useEngine();
  const [, force] = useState(0);
  const counts = engine.objectCounts();

  return (
    <Group title="Layers">
      <Note>Hide a layer to get it out of the way, or lock it so brushes and clicks pass straight through.</Note>
      {engine.CATS.map((cat) => {
        const st = engine.LayerState[cat];
        const n = cat === 'grass' ? engine.bladeCount
          : cat === 'roads' ? engine.World.roads.length
            : counts[cat];
        return (
          <div key={cat} className={'layer' + (st.vis ? '' : ' off')}>
            <div className="sw" style={{ background: engine.CAT_COLOR[cat] }} />
            <div className="nm">{cat[0].toUpperCase() + cat.slice(1)}</div>
            <div className="ct">{n === undefined ? '' : engine.fmtInt(n)}</div>
            <button type="button" className="ic"
              data-tip={st.vis ? 'Hide this layer' : 'Show this layer'}
              aria-label={st.vis ? `Hide ${cat}` : `Show ${cat}`}
              onClick={() => { st.vis = !st.vis; engine.applyLayerVisibility(); engine.markSceneDirty(); force((n2) => n2 + 1); }}>
              <Icon path={st.vis ? ICON.eye : ICON.eyeOff} />
            </button>
            <button type="button" className="ic" aria-pressed={st.lock}
              data-tip={st.lock ? 'Unlock — brushes and clicks can touch it again' : 'Lock — brushes and clicks pass straight through'}
              aria-label={st.lock ? `Unlock ${cat}` : `Lock ${cat}`}
              onClick={() => { st.lock = !st.lock; engine.markSceneDirty(); force((n2) => n2 + 1); }}>
              <Icon path={st.lock ? ICON.lock : ICON.unlock} />
            </button>
          </div>
        );
      })}
    </Group>
  );
}

function Housekeeping() {
  const engine = useEngine();
  const dialog = useDialog();

  async function removeEverything() {
    const ok = await dialog.confirm({
      title: 'Remove everything you placed?',
      message: 'This takes out every building, tree, prop, person and vehicle. The ground, the grass and the roads stay. Ctrl+Z brings it back.',
      okLabel: 'Remove them'
    });
    if (!ok) return;
    const list = engine.World.objs.slice();
    if (!list.length) return;
    engine.beginStroke('Clear objects');
    engine.recordObjDel(list);
    for (const o of list) engine.deleteObject(o);
    engine.endStroke();
    engine.disposeEmptyLayers();
    engine.touch();
  }

  return (
    <Group title="This world">
      <Toggle label="Keep a copy in this browser" path="scene.autosave"
        tip="Your world comes back automatically when you reload the page." />
      <ButtonRow>
        <Btn icon={ICON.people} label="Add people and traffic"
          tip="Fill every road that a template built with a sensible mix of walkers and vehicles."
          onClick={() => engine.populateWorld(1)} />
      </ButtonRow>
      <ButtonRow>
        <Btn icon={ICON.trash} label="Remove everything placed" kind="dgr"
          tip="Take out every model you or a template put down. Ground, grass and roads stay."
          onClick={removeEverything} />
      </ButtonRow>
    </Group>
  );
}
