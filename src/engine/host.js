/* ============================================================================
   THE HOST BRIDGE

   The engine is imperative and owns a WebGL canvas; React owns everything
   made of DOM. They meet here, and only here.

   Two directions:

     emit(topic)   the engine saying "this changed". React subscribes and
                   re-reads engine state; the engine never knows who listens
                   or what a component is.

     ui.*          the handful of things the engine genuinely needs a person
                   for — a message, a confirmation, a file picker. Every one
                   has a no-op default so the engine can run headless (tests,
                   the scripting handle) with no UI attached at all.
   ========================================================================== */

/** @typedef {'scene'|'state'|'selection'|'mode'|'history'|'stats'|'env'|'library'|'saved'} Topic */

const listeners = new Map();

/**
 * Subscribe to one topic. Returns the unsubscribe function, which is the shape
 * React's useEffect and useSyncExternalStore both want.
 * @param {Topic} topic
 * @param {() => void} fn
 */
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

/**
 * Announce a change. Cheap enough to call from a stroke: subscribers are
 * expected to coalesce (see useEngineTopic).
 * @param {Topic} topic
 */
export function emit(topic) {
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of set) fn();
}

const noop = () => {};

export const ui = {
  /** @type {(message: string, kind?: 'ok'|'err'|null, ms?: number, id?: string) => void} */
  toast: noop,
  /** Ask before clearing every blade. The engine does not own dialogs. */
  askClearGrass: noop,
  showShortcuts: noop,
  /** Let the UI eat Escape first — a tour or a dialog outranks cancelling a drag. */
  escape: () => false,
  /** Box-select rectangle in canvas pixels, or null to hide it. */
  marquee: noop,
  openFile: noop,
  togglePanel: noop,
  toggleUi: noop
};

/** Wire the real implementations in once, from the React root. */
export function setUiAdapter(adapter) {
  Object.assign(ui, adapter);
}
