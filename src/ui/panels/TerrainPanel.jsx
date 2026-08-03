import { useEngine } from '../EngineProvider.jsx';
import { Group, Slider, Chips, Select, Btn, ButtonRow } from '../controls.jsx';
import { LANDFORMS } from '../copy.jsx';
import { ICON } from '../icons.jsx';
import { ExtraTools } from './shared.jsx';

/* Four visible controls. The other fourteen are one click away, and the water
   and ground colours are not here at all — they belong to the world, so they
   live in the World sheet. */
export function TerrainPanel({ more }) {
  const engine = useEngine();

  if (more) {
    return (
      <>
        <Group title="More brushes">
          <ExtraTools station="terrain" />
          <Slider label="Edge softness" path="brush.falloff" min={0} max={1} step={0.01}
            tip="0 fades out gradually, 1 is a crisp circular edge." />
          <Slider label="Roughen size" path="sculpt.noiseScale" min={0.05} max={4} step={0.01} unit=" m"
            tip="How big the bumps the Roughen brush makes are." />
          <Slider label="Slide angle" path="sculpt.talus" min={0.1} max={2} step={0.01}
            tip="How steep a slope Erode leaves standing before material slides off it." />
          <Slider label="Erode passes" path="sculpt.erodeIters" min={1} max={6} step={1} dec={0}
            tip="More passes cut deeper gullies." />
        </Group>

        <Group title="The landform">
          <Slider label="Seed" path="plate.seed" min={1} max={999999} step={1} dec={0} apply={['plate']}
            tip="Changes the shape without changing its character." />
          <Slider label="Bumpiness" path="plate.amplitude" min={0} max={24} step={0.05} unit=" m" apply={['plate']}
            tip='How far the land rises and falls before "How tall" scales it.' />
          <Slider label="Feature size" path="plate.frequency" min={0.004} max={0.3} step={0.001} dec={3} apply={['plate']}
            tip="Low values give broad landforms, high values lots of small ones." />
          <Slider label="Layers of detail" path="plate.octaves" min={1} max={6} step={1} dec={0} apply={['plate']}
            tip="More layers add finer detail on top of the big shapes." />
          <Select label="Ground detail" path="plate.resolution"
            tip="A finer grid sculpts smaller detail and costs more to draw."
            options={[
              { value: '64', label: 'Coarse — fastest' },
              { value: '128', label: 'Medium' },
              { value: '256', label: 'Fine' },
              { value: '512', label: 'Very fine — heavy' }
            ]}
            set={(v) => engine.set('plate.resolution', parseInt(v, 10))}
            onChange={() => { engine.rebuildPlate(); engine.rebuildWater(); }} />
          <Slider label="World width" path="plate.width" min={20} max={400} step={1} dec={0} unit=" m" apply={['plate']}
            tip="How far the ground stretches east to west." />
          <Slider label="World depth" path="plate.depth" min={20} max={400} step={1} dec={0} unit=" m" apply={['plate']}
            tip="How far the ground stretches north to south." />
        </Group>
      </>
    );
  }

  return (
    <>
      <Group title="Brush">
        <Slider label="Brush size" path="brush.radius" min={0.25} max={40} step={0.05} dec={1} unit=" m"
          kbd="[  ]" tip="How wide a patch each drag affects." />
        <Slider label="Strength" path="sculpt.strength" min={0.02} max={2} step={0.01}
          tip="How fast the ground moves. Holding still in one spot keeps building." />
      </Group>

      <Group title="Shape of the land">
        <Chips path="plate.landform" apply={['plate']} options={LANDFORMS} />
        <Slider label="How tall" path="plate.heightScale" min={0} max={4} step={0.01} apply={['plate']}
          tip="Stretches the whole landform up, or squashes it flat." />
        <ButtonRow>
          <Btn
            icon={ICON.wand}
            label="Roll a new one"
            tip="Same kind of landscape, different shape. Anything you sculpted by hand is cleared."
            onClick={() => engine.regenerateTerrain(Math.floor(Math.random() * 999999) + 1)}
          />
        </ButtonRow>
      </Group>
    </>
  );
}
