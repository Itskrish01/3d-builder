import { useEngine } from '../EngineProvider.jsx';
import { useDialog } from '../overlays.jsx';
import { Group, Note, Slider, Chips, ColorField, Toggle, Dial, Btn, ButtonRow, BladeMeter } from '../controls.jsx';
import { ICON } from '../icons.jsx';
import { ExtraTools } from './shared.jsx';

export function GrassPanel({ more }) {
  const engine = useEngine();
  const dialog = useDialog();

  async function clearGrass() {
    const ok = await dialog.confirm({
      title: 'Clear all the grass?',
      message: `This removes all ${engine.fmtInt(engine.bladeCount)} blades. Ctrl+Z brings them back.`,
      okLabel: 'Clear the grass'
    });
    if (ok) engine.clearAll();
  }

  if (more) {
    return (
      <>
        <Group title="Brush">
          <ExtraTools station="grass" />
          <Slider label="How much per stroke" path="brush.flow" min={0.02} max={1} step={0.01}
            tip="How many blades each stamp tries to plant. Higher fills an area faster." />
          <Slider label="Edge softness" path="brush.falloff" min={0} max={1} step={0.01}
            tip="0 fades out gradually from the middle, 1 is a crisp circular cut." />
          <Slider label="Scatter" path="brush.scatter" min={0} max={1} step={0.01}
            tip="0 snaps blades to a tidy lattice, 1 is fully natural scatter." />
          <Slider label="Crowding limit" path="brush.maxDensity" min={5} max={400} step={1} dec={0} unit="/m²" apply={['dens']}
            tip="A stroke stops adding blades to a spot once it reaches this many per square metre." />
          <Slider label="Random lean" path="brush.tilt" min={0} max={0.8} step={0.01}
            tip="How far each blade may lean away from straight up when it is planted." />
          <Slider label="Steepest ground grass grows on" path="plate.maxGrassSlope" min={0} max={0.98} step={0.01}
            tip="Blades refuse to grow where the ground tips past this — it keeps grass off cliff faces." />
        </Group>

        <Group title="Blade shape">
          <Slider label="Height variation" path="grass.heightVar" min={0} max={1} step={0.01}
            tip="How much taller or shorter than average each new blade can be." />
          <Slider label="Width" path="grass.width" min={0.005} max={0.4} step={0.001} dec={3} unit=" m" apply={['grass']}
            tip="Blade width at the root." />
          <Slider label="Width variation" path="grass.widthVar" min={0} max={1} step={0.01}
            tip="Random spread of blade width at paint time." />
          <Slider label="Taper" path="grass.taper" min={0.2} max={3} step={0.01} apply={['grass']}
            tip="How quickly the blade narrows to the tip. Low stays broad, high goes needle-like." />
          <Slider label="Droop" path="grass.curve" min={0} max={2} step={0.01} apply={['grass']}
            tip="How far the blade curls over with no wind." />
          <Slider label="Droop variation" path="grass.curveVar" min={0} max={1} step={0.01}
            tip="Random spread of resting droop at paint time." />
          <Slider label="Smoothness" path="grass.segments" min={3} max={7} step={1} dec={0} apply={['template']}
            tip="Points along each blade. Higher looks smoother and costs more." />
          <Slider label="Cross-blade curl" path="grass.bladeCurl" min={0} max={1.4} step={0.01} apply={['grass']}
            tip="Curvature across the width of the blade — this is what makes the highlight run down the middle." />
        </Group>

        <Group title="Colour">
          <Slider label="Where root meets tip" path="grass.gradPow" min={0.3} max={4} step={0.01} apply={['grass']}
            tip="High values keep the root colour for longer up the blade." />
          <Slider label="Hue variation" path="grass.hueVar" min={0} max={0.5} step={0.005} dec={3} apply={['grass']}
            tip="Per-blade random hue shift." />
          <Slider label="Saturation variation" path="grass.satVar" min={0} max={1} step={0.01} apply={['grass']}
            tip="Per-blade random saturation shift." />
          <Slider label="Brightness variation" path="grass.valVar" min={0} max={1} step={0.01} apply={['grass']}
            tip="Per-blade random brightness shift." />
          <Slider label="Shade at the base" path="grass.ao" min={0} max={1} step={0.01} apply={['grass']}
            tip="Darkening toward the bottom of each blade. It is what grounds the field." />
          <Slider label="Backlight glow" path="grass.translucency" min={0} max={3} step={0.01} apply={['grass']}
            tip="How much light passes through a blade when the sun is behind it." />
          <Slider label="Sheen" path="grass.specular" min={0} max={1.5} step={0.01} apply={['grass']}
            tip="Strength of the highlight." />
          <Slider label="Sheen spread" path="grass.roughness" min={0.02} max={1} step={0.01} apply={['grass']}
            tip="Low is glossy, high is matte." />
        </Group>

        <Group title="Field">
          <Slider label="How thick it looks" path="grass.density" min={0.02} max={1} step={0.01} apply={['grass']}
            tip="Draws only a fraction of the blades you painted. Thins the field without deleting anything." />
          <Slider label="Softest blades" path="grass.stiffMin" min={0.15} max={3} step={0.01}
            tip="Soft blades bend much further in the same wind." />
          <Slider label="Stiffest blades" path="grass.stiffMax" min={0.15} max={3} step={0.01}
            tip="A wide soft-to-stiff range is what stops the field moving as one mass." />
        </Group>

        <Group title="Wind detail">
          <Slider label="Speed" path="wind.speed" min={0} max={2} step={0.01} apply={['grass']}
            tip="How fast the wind pattern scrolls across the world." />
          <Slider label="Turbulence" path="wind.turbulence" min={0} max={2} step={0.01} apply={['grass']}
            tip="Chaos: jitters the local direction and flutters the tips." />
          <Slider label="Wave size" path="wind.waveScale" min={0.005} max={0.4} step={0.001} dec={3} apply={['grass']}
            tip="Low values make long, broad swells." />
          <Slider label="Gusts across the field" path="wind.gustFreq" min={0.01} max={0.7} step={0.005} dec={3} apply={['grass']}
            tip="Low values give one big sweeping wave." />
          <Slider label="Gust strength" path="wind.gustStrength" min={0} max={3} step={0.01} apply={['grass']}
            tip="How hard the gust front bends the grass as it passes." />
          <Slider label="Gust speed" path="wind.gustSpeed" min={0} max={6} step={0.01} apply={['grass']}
            tip="How quickly the gust front travels." />
        </Group>

        <Group title="Grass that reacts to you">
          <Note>The blades part around your cursor. These decide how that feels.</Note>
          <Slider label="How far it parts" path="interact.radius" min={0.3} max={12} step={0.05} unit=" m"
            tip="How far from the cursor the grass is pushed aside." />
          <Slider label="How hard" path="interact.strength" min={0} max={4} step={0.01}
            tip="How far the grass is bent away from the cursor." />
          <Slider label="Spring back" path="interact.recovery" min={0.5} max={20} step={0.1} dec={1}
            tip="Higher springs back faster." />
          <Slider label="Wobble" path="interact.damping" min={0.08} max={1.6} step={0.01}
            tip="Below 1 the grass overshoots and wobbles on the way back; at 1 it settles without bouncing." />
          <Slider label="Drag behind" path="interact.wake" min={0} max={2} step={0.01}
            tip="How much the grass is pulled along the way the cursor is travelling." />
          <Toggle label="Show the ball" path="interact.ball" tip="A ball you can drag through the grass." />
          <Slider label="Ball size" path="interact.ballRadius" min={0.2} max={6} step={0.05} unit=" m"
            tip="How big the ball is." />
        </Group>
      </>
    );
  }

  return (
    <>
      <Group title="Brush">
        <Slider label="Brush size" path="brush.radius" min={0.25} max={40} step={0.05} dec={1} unit=" m"
          kbd="[  ]" tip="How wide a patch each drag covers." />
      </Group>

      <Group title="Look">
        <Chips
          options={engine.PRESETS.map((p, i) => ({
            value: i,
            label: p.name,
            swatch: p.swatch,
            tip: `Change the grass, wind and light to the ${p.name} look. Grass you have already painted stays put.`
          }))}
          onChange={(i) => engine.applyPreset(i)}
        />
        <Slider label="Blade height" path="grass.height" min={0.05} max={5} step={0.01} unit=" m" apply={['grass']}
          tip="How tall new and existing blades stand." />
        <ColorField label="Tip colour" path="grass.tipColor" apply={['grass']} tip="The colour at the top of every blade." />
        <ColorField label="Root colour" path="grass.baseColor" apply={['grass']} tip="The colour down at the soil." />
      </Group>

      <Group title="Wind">
        <Dial label="Direction" path="wind.direction" apply={['grass']}
          tip="Drag the dial to point the wind somewhere else. Hold Shift to snap to 15° steps.">
          <Slider label="Strength" path="wind.strength" min={0} max={2.5} step={0.01} apply={['grass']}
            tip="How far the blades lean downwind." />
        </Dial>
      </Group>

      <Group title="The whole field">
        <ButtonRow>
          <Btn icon={ICON.fill} label="Fill everywhere" kind="pri" kbd="Shift F"
            tip="Cover the whole world with grass, skipping water, roads and cliffs."
            onClick={engine.fillPlate} />
          <Btn icon={ICON.trash} label="Clear" kind="dgr" kbd="Ctrl Shift Del"
            tip="Remove every blade. You will be asked first, and Ctrl+Z brings it back."
            onClick={clearGrass} />
        </ButtonRow>
        <BladeMeter />
      </Group>
    </>
  );
}
