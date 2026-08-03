/* ============================================================================
   ICONS

   One stroke weight, one 24x24 frame, drawn rather than imported so the whole
   set stays consistent and costs nothing to ship.
   ========================================================================== */

export function Icon({ path, w = 1.9, className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

export const ICON = {
  raise: '<path d="M12 20V6"/><path d="m5 12 7-7 7 7"/><path d="M3 22h18"/>',
  lower: '<path d="M12 4v14"/><path d="m5 12 7 7 7-7"/><path d="M3 22h18"/>',
  smooth: '<path d="M3 14c3 0 3-6 6-6s3 6 6 6 3-6 6-6"/><path d="M3 20h18"/>',
  flatten: '<path d="M3 10h18"/><path d="M6 16h12"/><path d="M3 20h18"/>',
  ramp: '<path d="M3 20h18"/><path d="M4 18 18 6"/><path d="M18 6v12"/>',
  noise: '<path d="m3 17 3-6 3 4 3-8 3 10 3-5 3 5"/>',
  erode: '<path d="M4 5v6c0 5 3 8 8 8s8-3 8-8V5"/><path d="M8 5v5M16 5v5"/>',
  place: '<path d="M12 21s7-5.5 7-11a7 7 0 0 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  brush: '<path d="M9.5 14.5 3 21"/><path d="m6 18 1.6-4.2a3 3 0 0 1 .7-1.1l7-7a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3l-7 7a3 3 0 0 1-1.1.7Z"/>',
  scatter: '<circle cx="6" cy="7" r="2"/><circle cx="17" cy="5.5" r="1.6"/><circle cx="12" cy="13" r="2.2"/><circle cx="19" cy="16" r="1.8"/><circle cx="6.5" cy="18" r="1.7"/>',
  eraser: '<path d="m5.5 14.5 4 4h9"/><path d="M13.4 3.6 3.6 13.4a2 2 0 0 0 0 2.8l4.2 4.2a2 2 0 0 0 2.8 0l9.8-9.8a2 2 0 0 0 0-2.8l-4.2-4.2a2 2 0 0 0-2.8 0Z"/>',
  dropper: '<path d="m11 9 4 4"/><path d="M17.5 2.5a2.1 2.1 0 0 1 3 3l-1.9 1.9 1 1a1.5 1.5 0 0 1 0 2.1l-.7.7-5.1-5.1.7-.7a1.5 1.5 0 0 1 2.1 0l1-1Z"/><path d="m13.8 8.2-8 8a2 2 0 0 0-.5.9L4.5 20l3-.8a2 2 0 0 0 .9-.5l8-8"/>',
  arrow: '<path d="m4 4 7 16 2.2-6.8L20 11Z"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M4 4 20 20"/><path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4"/><path d="M6.3 8A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.9 9.9 0 0 0 3.5-.6"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10" width="15" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7.5-1.9"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  wand: '<path d="m5 19 9-9"/><path d="m15 5 1.2 2.8L19 9l-2.8 1.2L15 13l-1.2-2.8L11 9l2.8-1.2Z"/><path d="M4 5h2M5 4v2M18 17h2M19 16v2"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  frame: '<path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4"/>',
  people: '<circle cx="9" cy="6" r="3"/><path d="M3 21v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2"/><path d="M17 8.5a2.5 2.5 0 1 0 0-5"/><path d="M17 13a4 4 0 0 1 4 4v4"/>',
  fill: '<path d="M4 20h16"/><path d="M7 20V9M12 20V5M17 20v-8"/>',
  undo: '<path d="M3 10h11a5 5 0 0 1 0 10h-3"/><path d="M7 6 3 10l4 4"/>',
  redo: '<path d="M21 10H10a5 5 0 0 0 0 10h3"/><path d="m17 6 4 4-4 4"/>',
  save: '<path d="M12 3v11M8 10l4 4 4-4"/><path d="M4 19h16"/>',
  open: '<path d="M12 16V5M8 9l4-4 4 4"/><path d="M4 19h16"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.4-2h7.2L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2A2.5 2.5 0 0 1 14.5 10c0 1.7-2.5 2-2.5 3.6"/><path d="M12 17.2h.01"/>',
  newWorld: '<path d="M3 20h18"/><path d="m3 20 5-8 4 4.5L16 8l5 12"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3v5h-5"/>',
  scale: '<path d="M4 15v5h5"/><path d="m4 20 7-7"/><path d="M20 9V4h-5"/><path d="m20 4-7 7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/>',
  world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>',
  wordmark: '<path d="M2 20h20"/><path d="M6 20c0-4 1-7 3-9"/><path d="M12 20c0-6.5 1.8-11 4.5-14"/><path d="M18 20c0-3.5-.8-6-2-8"/>'
};

/* ---------------------------------------------------------------------------
   STATION GLYPHS — the signature.

   Every one is drawn in the same 44x26 frame with the same ground line at
   y = 21, so the four stations stack into strata of one continuous ground:
   whichever one you are at, you are working on the same piece of earth.
   -------------------------------------------------------------------------- */
const STATION_FORM = {
  /* a hill rising off the ground */
  terrain: <path d="M6 21 15 9l6 7 6-10 10 15" />,
  /* blades standing on it */
  grass: (
    <>
      <path d="M11 21c0-4 .8-7 2.6-9.5" />
      <path d="M18 21c0-6 1.2-10.5 3.4-13.5" />
      <path d="M25 21c0-5 .9-8.5 2.4-10.8" />
      <path d="M32 21c0-6.5 1.2-10.5 3-13" />
    </>
  ),
  /* something set down on it */
  place: (
    <>
      <path d="M15 21v-8l7-4 7 4v8" />
      <path d="M20 21v-5h4v5" />
    </>
  ),
  /* something on it, picked out */
  select: (
    <>
      <path d="M18 21v-5l4-2.4 4 2.4v5" />
      <path d="M9 11V6h5" />
      <path d="M30 6h5v5" />
      <path d="M9 16v5h5" />
      <path d="M35 16v5h-5" />
    </>
  )
};

export function StationGlyph({ station }) {
  return (
    <svg viewBox="0 0 44 26" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="ground" d="M2 21h40" />
      <g className="form">{STATION_FORM[station]}</g>
    </svg>
  );
}
