import { updateActors } from './actors.js';
import { pushInfluence, updateField, updateRing } from './field.js';
import { Grass, ball, flushGrass, ring, sky, uploadDensity } from './grass.js';
import { flushErase } from './history.js';
import { Cursor, Keys, Ptr, _ballVel, effectiveTool, isBrushTool, updateCursorWorld, updateGhost } from './input.js';
import { flushLayers } from './layers.js';
import { cam, camera, renderer, scene } from './renderer.js';
import { ROAD_MAT_LIST, Roads } from './roads.js';
import { Sel, refreshGizmo } from './selection.js';
import { state } from './state.js';
import { heightAt } from './terrain.js';
import { clamp, nowMs } from './util.js';
import { Water, waterTick } from './water.js';

/* ==========================================================================
   15. MAIN LOOP
   ========================================================================== */
export var _last = 0, _time = 0;
export var _fpsAcc = 0, _fpsN = 0, _statT = 0;

export function tick(dt) {
  // The Simulate toggle freezes wind, water, people and traffic together by
  // simply not advancing the shared clock.
  var sim = state.world.simulate ? dt : 0;
  _time += sim;
  Grass.mat.uniforms.uTime.value = _time;
  if (Water.mat) Water.mat.uniforms.uTime.value = _time;
  for (var m = 0; m < ROAD_MAT_LIST.length; m++) {
    var rm = Roads.meshes[ROAD_MAT_LIST[m]];
    if (rm) rm.material.uniforms.uTime.value = _time;
  }

  var it = state.interact;

  /* ---- cursor -> ground, and its influence on the push field ---- */
  if (Cursor.over) updateCursorWorld();
  var speedScale = 1 / Math.max(dt, 1e-3) * 0.02;
  if (Cursor.over && Cursor.has && Ptr.mode !== 'orbit' && Ptr.mode !== 'pan') {
    pushInfluence(
      Cursor.world.x, Cursor.world.z, it.radius, it.strength,
      clamp(Cursor.vx * speedScale, -3, 3), clamp(Cursor.vz * speedScale, -3, 3)
    );
  }

  /* ---- interactive ball ---- */
  ball.visible = it.ball;
  if (it.ball) {
    var r = it.ballRadius;
    ball.scale.setScalar(r);
    ball.position.y = heightAt(ball.position.x, ball.position.z) + r;
    pushInfluence(ball.position.x, ball.position.z, r * 1.75, it.strength * 1.6,
      clamp(_ballVel.x * speedScale, -3, 3), clamp(_ballVel.z * speedScale, -3, 3));
    _ballVel.x *= 0.55; _ballVel.z *= 0.55;
  }

  updateField(dt);

  /* ---- world systems ---- */
  updateActors(sim);
  waterTick(nowMs());
  updateGhost();

  /* ---- brush preview ring ---- */
  var t = effectiveTool();
  var showRing = Cursor.over && Cursor.has && isBrushTool(t) &&
                 Ptr.mode !== 'orbit' && Ptr.mode !== 'pan' && !Keys.uiHidden;
  updateRing(Cursor.world.x, Cursor.world.z, state.brush.radius, showRing);
  if (showRing) {
    var c = ring.material.uniforms.uColor.value;
    if (t === 'erase' || t === 'place_erase') c.set(0.95, 0.42, 0.34);
    else if (t === 'smooth') c.set(0.42, 0.68, 0.98);
    else if (t === 'sculpt') c.set(1.0, 0.70, 0.24);
    else if (t === 'eyedropper') c.set(0.78, 0.55, 0.98);
    else if (t === 'place_many') c.set(0.56, 0.75, 0.32);
    else c.set(0.49, 0.85, 0.34);
  }

  /* ---- buffer maintenance ---- */
  flushErase();
  flushGrass();
  flushLayers();
  uploadDensity();

  cam.flyStep(dt);
  cam.update(dt);
  /* The gizmo is sized in screen space, so it has to track the camera — and it
     has to be told to go away, which the old `if there is a selection` guard
     could never do: the frame the selection emptied was the frame that stopped
     asking. Derive both from the state every frame instead. */
  if (Sel.objs.length && state.world.mode === 'select') refreshGizmo();
  else Sel.gizmo.visible = false;
}

export function renderFrame() {
  var su = sky.material.uniforms;
  su.uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
  renderer.render(scene, camera);
}



/* ==========================================================================
   BOOT
   ========================================================================== */



