import { ICON } from './icons.jsx';

/* ============================================================================
   EVERY WORD THE INTERFACE SAYS, IN ONE PLACE

   The engine knows a station is called `place`; what it is called to a person,
   and how that is explained, lives here. Keeping it together is what stops the
   vocabulary drifting — a control named one thing in a panel and another in a
   tooltip is how an interface stops being learnable.
   ========================================================================== */

export const STATIONS = {
  terrain: {
    label: 'Terrain',
    lede: <>Drag on the ground to push it up. Hold <b>Alt</b> to dig down.</>,
    tip: 'Shape the ground — hills, valleys, cliffs and flat building plots.'
  },
  place: {
    label: 'Place',
    lede: <>Pick a model, then click on the ground to put one down.</>,
    tip: 'Put anything into the world — houses, trees, people, cars.'
  },
  select: {
    label: 'Select',
    lede: <>Click something to pick it up. Drag on empty ground to lasso several.</>,
    tip: 'Pick things you already placed, then move, turn, resize or delete them.'
  }
};

export const TOOLS = {
  raise: { label: 'Raise', icon: ICON.raise, tip: 'Pull the ground up. Hold it still to grow a peak; Alt digs down.' },
  lower: { label: 'Lower', icon: ICON.lower, tip: 'Push the ground down for valleys and lake beds.' },
  smooth: { label: 'Smooth', icon: ICON.smooth, tip: 'Soften whatever is under the brush.' },
  flatten: { label: 'Flat', icon: ICON.flatten, tip: 'Level the ground to the height where you started the drag — good for building plots.' },
  ramp: { label: 'Ramp', icon: ICON.ramp, tip: 'Drag from A to B for a clean, even slope between the two heights.' },
  noise: { label: 'Roughen', icon: ICON.noise, tip: 'Add rocky bumpiness.' },
  erode: { label: 'Erode', icon: ICON.erode, tip: 'Let material slide downhill and settle, the way weather does it.' },


  place_one: { label: 'One', icon: ICON.place, tip: 'Click to put down a single model. Press R to turn it.' },
  place_many: { label: 'Scatter', icon: ICON.scatter, tip: 'Drag to sprinkle lots of them. Alt removes instead.' },
  place_erase: { label: 'Remove', icon: ICON.eraser, tip: 'Drag to take away whatever is under the brush.' },

  select: { label: 'Select', icon: ICON.arrow, tip: 'Click to pick, Shift-click to add, drag on empty ground to lasso.' }
};

/* `smooth` is shared between two stations and means something different in
   each, so the grass one is relabelled where it is used rather than renamed. */
export const TOOL_OVERRIDES = {
};

export function toolCopy(station, id) {
  return { ...TOOLS[id], ...(TOOL_OVERRIDES[station]?.[id] || {}) };
}

export const HINTS = {
  terrain: [['Drag'], 'shape it', ['Alt'], 'the other way', ['[', ']'], 'brush size'],
  grass: [['Drag'], 'plant', ['Alt'], 'rub out', ['[', ']'], 'brush size'],
  place: [['Click'], 'place', ['Drag'], 'scatter', ['R'], 'turn it'],
  select: [['Click'], 'pick', ['Shift'], 'add', ['Drag'], 'lasso', ['Del'], 'remove']
};

export const FLY_HINT = [['WASD'], 'fly', ['Right-drag'], 'look'];

export const SHORTCUTS = [
  ['Stations', [
    ['1', 'Terrain'], ['2', 'Grass'], ['3', 'Place'], ['4', 'Select'],
    ['X', 'Next brush in this station'], ['Tab', 'Hide or show the settings'], ['H', 'Hide everything']
  ]],
  ['Working', [
    ['Click', 'Place, or pick'], ['Drag', 'Shape, plant or scatter'],
    ['Esc', 'Put the chosen model down, or drop the selection'],
    ['Alt', 'The other way — dig, or rub out'], ['[  ]', 'Brush size'],
    ['Shift Drag', 'Keep the stroke to one straight line'],
    ['R', 'Turn what you are about to place'],
    ['Alt Scroll', 'Turn it with the wheel'], ['Alt Shift Scroll', 'Resize it']
  ]],
  ['Flying', [
    ['W A S D', 'Forward, left, back, right'], ['E  Q', 'Up and down'], ['Shift', 'Faster'],
    ['Right-drag', 'Look around'], ['Right-drag Scroll', 'Change fly speed'],
    ['Middle-drag', 'Slide sideways'], ['Space drag', 'Orbit'], ['Scroll', 'Forward and back'],
    ['F', 'Fly to what is picked, or to the whole world'],
    ['Two fingers', 'Pinch to zoom, drag to slide']
  ]],
  ['Picking things', [
    ['Click', 'Pick'], ['Shift click', 'Add to what is picked'], ['Drag', 'Lasso'],
    ['Ctrl A', 'Pick everything'], ['Ctrl D', 'Duplicate'], ['Del', 'Delete'],
    ['Arrows', 'Shift it a little']
  ]],
  ['Your world', [
    ['Ctrl Z', 'Undo'], ['Ctrl Shift Z', 'Redo'], ['Ctrl S', 'Save a file'],
    ['Ctrl O', 'Open a file'], ['Ctrl P', 'Save a picture'], ['P', 'Freeze or unfreeze everything'],
    ['G', 'Measuring grid'], ['Shift 1-6', 'Grass looks'], ['?', 'This list']
  ]]
];

export const LANDFORMS = [
  { value: 'flat', label: 'Flat' },
  { value: 'rolling', label: 'Hills' },
  { value: 'mountains', label: 'Mountains' },
  { value: 'valley', label: 'Valley' },
  { value: 'island', label: 'Island' },
  { value: 'plateau', label: 'Plateau' },
  { value: 'canyon', label: 'Canyon' }
];

export const PLACE_SHELVES = [
  { id: 'all', label: 'All' },
  { id: 'building', label: 'Buildings' },
  { id: 'nature', label: 'Trees & plants' },
  { id: 'prop', label: 'Props' },
  { id: 'person', label: 'People' },
  { id: 'vehicle', label: 'Vehicles' }
];
