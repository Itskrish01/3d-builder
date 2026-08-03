import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEngine } from './EngineProvider.jsx';
import { Btn } from './controls.jsx';

/* ============================================================================
   THE GUIDED TOUR

   A spotlight and a card. The scrim is the spotlight's own box-shadow and
   nothing in the overlay takes pointer events except the card, so every step
   can be tried for real while it is still on screen. Steps that can be tried
   watch for it happening and move on by themselves.
   ========================================================================== */

const STEPS = [
  {
    title: 'Let’s build a world',
    body: (
      <>Four stations run down the left edge. You shape the <b>ground</b>, plant <b>grass</b> on it,
        <b> place</b> things on top, and <b>select</b> anything you want to move. That is the whole tool.</>
    ),
    target: null
  },
  {
    title: 'Fly around first',
    body: (
      <>Hold the <b>right mouse button</b> and move the mouse to look around. <b>W A S D</b> flies,
        <b> E</b> goes up, <b>Q</b> goes down. Roll the wheel while looking to fly faster or slower.</>
    ),
    target: () => document.querySelector('.stage'),
    hint: 'Try it — hold right-click and look around',
    done: (engine, memo) => {
      const k = engine.Keys;
      if (engine.Ptr.mode === 'look' || k.move.f || k.move.b || k.move.l || k.move.r) memo.flew = true;
      return !!memo.flew;
    }
  },
  {
    title: 'Shape the ground',
    body: (
      <>Pick <b>Raise</b> and drag on the ground to push a hill up. Hold <b>Alt</b> while you drag to dig
        down instead. <b>Smooth</b> and <b>Flatten</b> settle it back again.</>
    ),
    mode: 'terrain',
    target: () => document.querySelector('.rail .station'),
    hint: 'Try it — drag on the ground',
    done: (engine, memo) => engine.history.undo > memo.mark
  },
  {
    title: 'The settings follow the station',
    body: (
      <>Each station puts only its own controls here — the handful you actually reach for.
        <b> All settings</b> at the bottom opens everything else when you want it.</>
    ),
    target: () => document.querySelector('.panel')
  },
  {
    title: 'Paint the grass',
    body: (
      <>Drag to plant grass, hold <b>Alt</b> to rub it out. The row of names under <b>Look</b> swaps the
        whole field between a lawn, a meadow, wheat and more.</>
    ),
    mode: 'grass',
    target: () => document.querySelectorAll('.rail .station')[1],
    hint: 'Try it — drag on the ground',
    done: (engine, memo) => engine.history.undo > memo.mark
  },
  {
    title: 'Put things in it',
    body: (
      <>Everything you can place — houses, trees, people, cars — comes from Sketchfab. Press
        <b> Add models</b>, search, pick one, then click on the ground. Put something in the wrong spot?
        The <b>Select</b> station moves and deletes it.</>
    ),
    mode: 'place',
    target: () => document.querySelectorAll('.rail .station')[2]
  },
  {
    title: 'The world itself',
    body: (
      <>Time of day, water, ground colour, quality and layers belong to the whole world, so they live
        here rather than in any one station.</>
    ),
    target: () => document.querySelector('.sun-btn')
  },
  {
    title: 'That’s everything',
    body: (
      <>Your world saves itself into this browser as you go. <b>Save</b> writes a file you can keep or
        send to someone. <b>New world</b> starts you off from a finished scene. Press <b>?</b> any time
        for the key list.</>
    ),
    target: () => document.querySelector('[data-tip^="Download this world"]')
  }
];

export function Tour({ from = 0, onFinish }) {
  const engine = useEngine();
  const [index, setIndex] = useState(from);
  const [box, setBox] = useState({ hole: null, card: { left: 12, top: 12 } });
  const cardRef = useRef(null);
  const memo = useRef({ mark: 0, flew: false });
  const step = STEPS[index];

  // The index is read from a ref rather than closed over, so `go` stays stable
  // and the side effects (changing station, resetting the baseline) happen
  // here rather than inside a state updater, where React may run them twice.
  const indexRef = useRef(from);

  const go = useCallback((delta) => {
    const next = indexRef.current + delta;
    if (next >= STEPS.length || next < 0) { onFinish(); return; }
    const s = STEPS[next];
    if (s.mode && engine.state.world.mode !== s.mode) engine.setMode(s.mode);
    memo.current.mark = engine.history.undo;
    // Move the ref now, not at the next render: two clicks inside one frame
    // would otherwise both read the old step and land on the same one.
    indexRef.current = next;
    setIndex(next);
  }, [engine, onFinish]);

  // The step the tour opens on still needs its baseline and its station.
  useEffect(() => {
    const s = STEPS[from];
    if (s.mode && engine.state.world.mode !== s.mode) engine.setMode(s.mode);
    memo.current = { mark: engine.history.undo, flew: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure the target and place the card beside it. Runs on a timer as well
  // as on layout, because the thing being pointed at can move under us.
  const place = useCallback(() => {
    const el = step.target?.();
    const r = el?.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const valid = r && r.width > 2 && r.height > 2;
    const pad = 6;
    const hole = valid
      ? { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
      : null;

    const cw = cardRef.current?.offsetWidth || 330;
    const ch = cardRef.current?.offsetHeight || 220;
    const gap = 18;
    let left;
    let top;
    if (!valid) {
      left = (vw - cw) / 2;
      top = (vh - ch) / 2;
    } else if (r.right + gap + cw < vw - 12) {
      left = r.right + gap; top = r.top;
    } else if (r.left - gap - cw > 12) {
      left = r.left - gap - cw; top = r.top;
    } else if (r.bottom + gap + ch < vh - 12) {
      left = r.left + r.width / 2 - cw / 2; top = r.bottom + gap;
    } else {
      left = r.left + r.width / 2 - cw / 2; top = r.top - gap - ch;
    }
    setBox({
      hole,
      card: {
        left: Math.round(Math.min(Math.max(12, left), Math.max(12, vw - cw - 12))),
        top: Math.round(Math.min(Math.max(12, top), Math.max(12, vh - ch - 12)))
      }
    });
  }, [step]);

  useLayoutEffect(place, [place, index]);

  useEffect(() => {
    const id = setInterval(() => {
      if (step.done?.(engine, memo.current)) { go(1); return; }
      place();
    }, 350);
    window.addEventListener('resize', place);
    return () => { clearInterval(id); window.removeEventListener('resize', place); };
  }, [engine, step, go, place]);

  return (
    <div className="tour" aria-live="polite">
      <div
        className={'tour-hole' + (box.hole ? '' : ' hidden') + (step.done ? ' pulse' : '')}
        style={box.hole || { left: '50%', top: '50%', width: 0, height: 0 }}
      />
      <div className="tour-card" ref={cardRef} style={box.card} role="dialog" aria-label={step.title}>
        <div className="step-no num">{index + 1} of {STEPS.length}</div>
        <h3 className="wide">{step.title}</h3>
        {step.hint && <div className="live">{step.hint}</div>}
        <p>{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((_, i) => <i key={i} className={i === index ? 'on' : undefined} />)}
          </div>
          <div className="grow" />
          {index > 0 && <Btn label="Back" kind="ghost" onClick={() => go(-1)} />}
          <Btn label="Skip" kind="ghost" tip="Close the tour. The ? button brings it back." onClick={onFinish} />
          <Btn label={index === STEPS.length - 1 ? 'Start building' : 'Next'} kind="pri" onClick={() => go(1)} />
        </div>
      </div>
    </div>
  );
}
