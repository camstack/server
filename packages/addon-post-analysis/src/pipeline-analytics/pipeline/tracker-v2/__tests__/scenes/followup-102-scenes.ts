/**
 * Synthetic scenes for the 102 follow-up (parking camera, tracks breaking near
 * parked cars). The real 102 windows could not be fetched for this work, so
 * each scene is built from the shapes the investigation measured — a ~550 px
 * jump with area ×2.2 between two frames of a car turning in, ~1 % of frames
 * out of capture order (up to 1.2 s back), a 1–2-hit detector flicker beside a
 * car — on a 7.7 fps (130 ms) cadence. Truth is exact by construction.
 */
import type { SceneBox, SceneDetection, SceneFrame } from './run-scene.js'

const FRAME_MS = 130

function vehicle(truth: string, box: SceneBox, score = 0.8): SceneDetection {
  return { truth, cls: 'vehicle', score, box }
}

/** A box of `w × h` centred on (`cx`, `cy`), rounded to whole pixels. */
function centred(cx: number, cy: number, w: number, h: number): SceneBox {
  return [Math.round(cx - w / 2), Math.round(cy - h / 2), Math.round(w), Math.round(h)]
}

/**
 * (A) A car turning in toward the camera. Ten frames as a 480×300 box
 * drifting right (25 px a frame); then, between two frames, its box jumps
 * 550 px down-right (440, 330) and grows ×2.2 in area — L1 cannot bind it
 * (IoU 0.02), so L2 must link the two pieces. Then 15 frames of the near car.
 *
 * `outOfOrder`: one frame stamped 1 040 ms before the far piece's last
 * sighting arrives after the near piece was born, carrying the far car's box
 * from then (200 px back). Before F1 the coasting far piece bound it and a
 * rewound tracker measured the link from that box (~720 px against a 630 px
 * reach). Since F1 fix round 1 the frame is DROPPED WHOLE at the facade
 * (1 040 ms back, inside the `maxMissedMs` bound): it binds nothing.
 *
 * Fix round 1: F2 (the reach on the larger box) is WITHDRAWN, so this car is
 * TWO ids — refused by reach (0.75 × the far box's diagonal, 424 px < 550),
 * which item 5 logs unsampled. Up to the jump, a DIFFERENT car appearing ahead
 * of a vanished one within half a second is this scene frame for frame
 * ({@link twoCarsInSequence617} `follower`); every narrowing of F2 that keeps
 * this one track fuses that one too (item-3 report). The extra id is the
 * operator's preferred failure.
 */
export function turningCar102(opts: { readonly outOfOrder?: boolean } = {}): SceneFrame[] {
  const frames: SceneFrame[] = []
  const far = (i: number): SceneBox => centred(1240 + i * 25, 650, 480, 300)
  for (let i = 0; i < 10; i++) frames.push({ t: i * FRAME_MS, dets: [vehicle('car', far(i))] })
  const lastFarCx = 1240 + 9 * 25
  const nearW = 480 * Math.sqrt(2.2)
  const nearH = 300 * Math.sqrt(2.2)
  for (let k = 0; k < 15; k++) {
    const t = (10 + k) * FRAME_MS
    frames.push({
      t,
      dets: [vehicle('car', centred(lastFarCx + 440 + k * 10, 650 + 330 + k * 6, nearW, nearH))],
    })
    // Arrives after the near piece's second frame, stamped 1 040 ms before the
    // far piece's last sighting (t = 1 170), with the far box of that moment.
    if (opts.outOfOrder === true && k === 1) frames.push({ t: 130, dets: [vehicle('car', far(1))] })
  }
  return frames
}

/**
 * (B) A person walking along a parked car — a CLASS-GATING guard, not a guard
 * of F1–F3 (fix round 1, review M1). The car sits still with the detector's
 * jitter (±4 px, ±3 px in size); the person walks past it at 18 px a frame,
 * their box overlapping the car's for most of the walk. A person and a vehicle
 * never gate each other (`classRelation` → `none`, a forbidden cost), so no
 * association, doubt or link between them is ever weighed: one id each, never
 * mixed. It goes red only if class gating breaks. The same-class mix-up guards
 * are (M1)–(M3).
 */
export function personBesideParkedCar102(): SceneFrame[] {
  const frames: SceneFrame[] = []
  for (let i = 0; i < 80; i++) {
    const j = (i % 3) - 1
    const parked: SceneBox = [1500 + 4 * j, 800 - 2 * j, 600 + 3 * j, 350 - 3 * j]
    const walker: SceneBox = [1200 + i * 18, 640 + (i % 2) * 4, 140, 360]
    frames.push({
      t: i * FRAME_MS,
      dets: [
        vehicle('parked', parked, 0.7),
        { truth: 'walker', cls: 'person', score: 0.8, box: walker },
      ],
    })
  }
  return frames
}

/**
 * (C) A confirmed car, then a 1–2-hit flicker beside it. The car (400×250)
 * creeps right 4 px a frame. On frame 12 (and, with `stubHits: 2`, frame 13)
 * the detector also fires a second box 120 px to its right — IoU 0.54 with the
 * car's own box, under the 0.6 double-fire bar, so it spawns an unconfirmed
 * stub. The next frame the detector sees ONE box, 55 px right of the car:
 * it costs the car about 0.23 and the stub 0.28, inside `RIVAL_MARGIN`. The
 * competitor test ends the confirmed car `ambiguous` and its continuation is a
 * contested piece L2 never links on geometry: two ids, never a mix.
 *
 * Fix round 1: that extra id STAYS. Up to the frame of the doubt this scene is
 * frame for frame (M2) and (M3), where the second box is a real car; (M3) is
 * this scene with the first car's continuation hidden. An exemption for the
 * stub in L1, or a "dissolved doubt" link in L2, made this one track and mixed
 * the two cars of (M2)/(M3) (see the follow-up 102 item-4 report).
 */
export function confirmedCarThenStub617(opts: { readonly stubHits?: 1 | 2 } = {}): SceneFrame[] {
  const stubHits = opts.stubHits ?? 1
  const frames: SceneFrame[] = []
  const carAt = (i: number): number => 1000 + i * 4
  const box = (x: number): SceneBox => [x, 500, 400, 250]
  const flickerUntil = 12 + stubHits
  for (let i = 0; i < 40; i++) {
    const t = i * FRAME_MS
    if (i >= 12 && i < flickerUntil) {
      frames.push({
        t,
        dets: [vehicle('car', box(carAt(i))), vehicle('car', box(carAt(i) + 120), 0.5)],
      })
    } else if (i === flickerUntil) {
      frames.push({ t, dets: [vehicle('car', box(carAt(i - 1) + 55))] })
    } else {
      frames.push({ t, dets: [vehicle('car', box(carAt(i)))] })
    }
  }
  return frames
}

/**
 * (M2) Scene C's exact geometry, but the second box is a REAL second car
 * (fix round 1, review of F3 C1): on frame 12 (and 13 for `stubHits: 2`) it is
 * born 120 px right of the confirmed car, the next frame the detector sees only
 * IT — 55 px right of the car, the car itself missed — and then both are seen,
 * the first car creeping on, the second driving right 15 px a frame. On the
 * frame of the doubt this is indistinguishable from scene C's flicker; what
 * follows is not. The contract: no id ever covers both cars.
 */
export function confirmedCarThenSecondCar102(
  opts: { readonly stubHits?: 1 | 2 } = {},
): SceneFrame[] {
  const stubHits = opts.stubHits ?? 1
  const frames: SceneFrame[] = []
  const carAt = (i: number): number => 1000 + i * 4
  const box = (x: number): SceneBox => [x, 500, 400, 250]
  const flickerUntil = 12 + stubHits
  const otherFrom = carAt(flickerUntil - 1) + 55
  for (let i = 0; i < 40; i++) {
    const t = i * FRAME_MS
    if (i < 12) frames.push({ t, dets: [vehicle('car', box(carAt(i)))] })
    else if (i < flickerUntil)
      frames.push({
        t,
        dets: [vehicle('car', box(carAt(i))), vehicle('other', box(carAt(i) + 120), 0.5)],
      })
    else if (i === flickerUntil) frames.push({ t, dets: [vehicle('other', box(otherFrom))] })
    else
      frames.push({
        t,
        dets: [
          vehicle('car', box(carAt(i))),
          vehicle('other', box(otherFrom + 15 * (i - flickerUntil))),
        ],
      })
  }
  return frames
}

/**
 * (M1) A passing car occludes a parked, confirmed car (fix round 1, review of
 * F3 C1). The passer is born 300 px left of the parked car and seen for
 * `passerHits` frames moving 60 px a frame; then the parked car is missed for
 * six frames while the passer drives across it (its first occluded box at
 * `x1`); then both are seen, the passer driving on. No id may cover both.
 */
export function passerOccludesParkedCar102(
  opts: { readonly passerHits?: 1 | 2; readonly x1?: number } = {},
): SceneFrame[] {
  const passerHits = opts.passerHits ?? 1
  const x1 = opts.x1 ?? 860
  const frames: SceneFrame[] = []
  const box = (x: number): SceneBox => [x, 500, 400, 250]
  const parked = (i: number): SceneBox => box(1000 + ((i % 3) - 1) * 2)
  let i = 0
  for (; i < 12; i++) frames.push({ t: i * FRAME_MS, dets: [vehicle('parked', parked(i))] })
  for (let k = 0; k < passerHits; k++, i++)
    frames.push({
      t: i * FRAME_MS,
      dets: [vehicle('parked', parked(i)), vehicle('passer', box(700 + 60 * k))],
    })
  for (let k = 0; k < 6; k++, i++)
    frames.push({ t: i * FRAME_MS, dets: [vehicle('passer', box(x1 + 60 * k))] })
  for (let k = 0; k < 12; k++, i++)
    frames.push({
      t: i * FRAME_MS,
      dets: [vehicle('parked', parked(i)), vehicle('passer', box(x1 + 60 * (6 + k)))],
    })
  return frames
}

/**
 * (M3) Scene C's geometry, but the second box is a REAL car that stops in
 * front of the first one and hides it (fix round 1): from the frame of the
 * doubt on, only the newcomer is seen, standing at the box that ended the
 * doubt. Up to that frame it is scene C frame for frame, and afterwards it is
 * scene C with the first car's continuation hidden: no rule that makes scene C
 * one track can tell the two apart without appearance, so here an extra id is
 * the only safe answer. The contract: no id ever covers both cars.
 */
export function secondCarHidesFirst102(opts: { readonly stubHits?: 1 | 2 } = {}): SceneFrame[] {
  const stubHits = opts.stubHits ?? 1
  const frames: SceneFrame[] = []
  const carAt = (i: number): number => 1000 + i * 4
  const box = (x: number): SceneBox => [x, 500, 400, 250]
  const flickerUntil = 12 + stubHits
  const stopAt = carAt(flickerUntil - 1) + 55
  for (let i = 0; i < 120; i++) {
    const t = i * FRAME_MS
    if (i < 12) frames.push({ t, dets: [vehicle('car', box(carAt(i)))] })
    else if (i < flickerUntil)
      frames.push({
        t,
        dets: [vehicle('car', box(carAt(i))), vehicle('other', box(carAt(i) + 120), 0.5)],
      })
    else frames.push({ t, dets: [vehicle('other', box(stopAt))] })
  }
  return frames
}

/**
 * How the two cars of {@link twoCarsInSequence617} move. A's per-frame step,
 * which side of A's last centre B appears on (x sign; B is always nearer the
 * camera, below), and B's per-frame step:
 *  - `opposite`: A drives left, B appears on A's right (behind it) and drives right;
 *  - `oncoming`: A drives left, B appears on A's left (ahead of it) and drives right;
 *  - `behind`: A drives right, B appears on A's left (behind it) and drives right;
 *  - `parked`: A stands (3 px of drift over 10 frames), B appears on its right and drives right;
 *  - `follower`: A drives right, B appears on A's right (ahead of it) and drives right —
 *    the shape of scene (A) itself.
 */
export type SequenceHeading = 'opposite' | 'oncoming' | 'behind' | 'parked' | 'follower'

interface SequenceMotion {
  readonly aStep: number
  readonly side: 1 | -1
  readonly bStep: number
}

const SEQUENCE_MOTION: Readonly<Record<SequenceHeading, SequenceMotion>> = {
  opposite: { aStep: -25, side: 1, bStep: 20 },
  oncoming: { aStep: -25, side: -1, bStep: 20 },
  behind: { aStep: 25, side: -1, bStep: 20 },
  parked: { aStep: 0.3, side: 1, bStep: 20 },
  follower: { aStep: 25, side: 1, bStep: 20 },
}

/**
 * (S) Two DIFFERENT cars in sequence (fix round 1, review of F2 H2). Car A
 * (480×300) is seen for 10 frames and leaves; `gapMs` after its last sighting
 * car B — area ×2.2, nearer the camera — appears `distance` px from A's last
 * centre (0.8 across, 0.6 down) and is seen for 15 frames. `heading` says how
 * each moves (see {@link SequenceHeading}).
 *
 * With the reach on the larger box for EVERY vehicle arc (F2), B inherited A's
 * id at 450–600 px (the predecessor rule already fuses at ≤ 400 px). Narrowed
 * to a vehicle approaching along its own motion within half a second, it still
 * fused `follower` — scene (A) frame for frame. Contract: no id covers both
 * cars, so F2 is withdrawn (fix round 1).
 */
export function twoCarsInSequence617(
  opts: {
    readonly distance?: number
    readonly gapMs?: number
    readonly heading?: SequenceHeading
  } = {},
): SceneFrame[] {
  const distance = opts.distance ?? 550
  const gapMs = opts.gapMs ?? 1300
  const m = SEQUENCE_MOTION[opts.heading ?? 'opposite']
  const frames: SceneFrame[] = []
  const a = (i: number): SceneBox => centred(1800 + i * m.aStep, 650, 480, 300)
  for (let i = 0; i < 10; i++) frames.push({ t: i * FRAME_MS, dets: [vehicle('car-a', a(i))] })
  const lastA = 1800 + 9 * m.aStep
  const bx = lastA + m.side * 0.8 * distance
  const by = 650 + 0.6 * distance
  const t0 = 9 * FRAME_MS + gapMs
  const bw = 480 * Math.sqrt(2.2)
  const bh = 300 * Math.sqrt(2.2)
  for (let k = 0; k < 15; k++)
    frames.push({
      t: t0 + k * FRAME_MS,
      dets: [vehicle('car-b', centred(bx + k * m.bStep, by, bw, bh))],
    })
  return frames
}
