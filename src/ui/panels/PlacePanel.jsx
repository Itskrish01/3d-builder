import { Group, Slider, Segment, Toggle } from '../controls.jsx';
import { ModelPicker, LibraryList } from '../ModelPicker.jsx';

/* One station places everything. The per-kind knobs underneath are still the
   two sets the engine reads — buildings take `build`, everything else takes
   `nature` — this panel just drives both from one set of plain words. */
export function PlacePanel({ more, onImport }) {
  if (more) {
    return (
      <>
        <Group title="Variety">
          <Slider label="Smallest" path="nature.scaleMin" min={0.1} max={2} step={0.01}
            tip="Bottom of the random size range." />
          <Slider label="Largest" path="nature.scaleMax" min={0.1} max={4} step={0.01}
            tip="Top of the random size range." />
          <Slider label="Turn each one" path="nature.rotJitter" min={0} max={180} step={1} dec={0} unit="°"
            tip="Random spin so a group does not look stamped." />
          <Slider label="Lean with the slope" path="nature.alignNormal" min={0} max={1} step={0.01}
            tip="How much each model tips over with the ground it stands on." />
          <Slider label="Smallest gap" path="nature.spacing" min={0.2} max={20} step={0.1} unit=" m"
            tip="Models never land closer together than this." />
        </Group>

        <Group title="Buildings">
          <Toggle label="Flatten the ground under it" path="build.flatten"
            tip="Level the terrain under a building so it does not float or sink." />
          <Toggle label="Always stand upright" path="build.upright"
            tip="Keep buildings vertical instead of tipping with the ground." />
          <Slider label="Grid spacing" path="build.gridSize" min={0.25} max={20} step={0.25} unit=" m"
            tip="How far apart the grid lines are when snapping to a grid." />
          <Slider label="Distance from the road" path="build.setback" min={0} max={30} step={0.25} unit=" m"
            tip="How far back from the kerb a road-facing building sits." />
          <Slider label="Facing" path="build.rotation" min={0} max={360} step={1} dec={0} unit="°"
            tip="Which way a building faces when it is not snapped to a road." />
          <Slider label="Random facing" path="build.rotJitter" min={0} max={45} step={0.5} dec={1} unit="°"
            tip="Small random turn so a row of houses is not perfectly aligned." />
        </Group>

        <Group title="Where things are allowed">
          <Slider label="Flattest ground needed" path="nature.minNormalY" min={0} max={1} step={0.01}
            tip="Refuse steeper ground than this — 1 means flat ground only." />
          <Slider label="Not below" path="nature.minAlt" min={-60} max={60} step={0.5} dec={1} unit=" m"
            tip="Only place above this height — pines above the treeline." />
          <Slider label="Not above" path="nature.maxAlt" min={-60} max={60} step={0.5} dec={1} unit=" m"
            tip="Only place below this height — palms near the water." />
        </Group>

        <Group title="What Remove takes">
          <Toggle label="Trees and plants" path="eraseMask.nature" tip="Include trees, rocks and plants." />
          <Toggle label="Props" path="eraseMask.props" tip="Include street furniture and yard props." />
          <Toggle label="Buildings" path="eraseMask.buildings" tip="Include buildings." />
          <Toggle label="People" path="eraseMask.people" tip="Include people." />
          <Toggle label="Vehicles" path="eraseMask.vehicles" tip="Include cars and trucks." />
          <Toggle label="Grass too" path="eraseMask.grass" tip="Also rub out grass blades under the brush." />
        </Group>

        <LibraryList />
      </>
    );
  }

  return (
    <>
      <ModelPicker onImport={onImport} />

      <Group title="How it goes down">
        <Segment
          path="build.snap"
          tip="Where a click actually puts the model."
          options={[
            { value: 'free', label: 'Anywhere', tip: 'Exactly where you click' },
            { value: 'grid', label: 'On a grid', tip: 'Snapped to a regular grid' },
            { value: 'road', label: 'Facing a road', tip: 'Set back from the nearest road and turned to face it' }
          ]}
        />
        <Slider label="Size" path="place.size" min={0.1} max={6} step={0.01} unit="×"
          tip="How big each copy is placed. 1 is the model at its own size." />
        <Slider label="Brush size" path="brush.radius" min={1} max={40} step={0.25} dec={1} unit=" m" kbd="[  ]"
          tip="How wide the Scatter and Remove brushes reach." />
        <Slider label="How many scattered" path="nature.density" min={0.02} max={3} step={0.01}
          tip="How thickly the Scatter brush drops models as you drag." />
      </Group>
    </>
  );
}
