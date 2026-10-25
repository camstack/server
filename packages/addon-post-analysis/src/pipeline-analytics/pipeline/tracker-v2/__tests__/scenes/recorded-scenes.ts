/**
 * Reconstructed real scenes (spec §10.A). Where a scene says so, boxes and
 * times are the stored positions of the named windows (`pipelineAnalytics.listTracks`
 * full projection, read 2026-09-29), time rebased to the window start; truth is
 * the analyses' manual reading. Not every frame is stored: the parked cars'
 * jitter is a pattern inside their stored RANGES, 104 and the crossings are
 * synthetic, and the 101 scenes are synthetic between four stored endpoint
 * boxes plus a hypothetical newcomer (see that section).
 */
import { APPEARANCE_BIN_COUNT, type AppearanceDescriptor } from '@camstack/types'
import type { SceneBox, SceneDetection, SceneFrame } from './run-scene.js'

type Timed = readonly [number, number, number, number, number] // t, x, y, w, h

interface TimedTrack {
  readonly truth: string
  readonly cls: string
  readonly score: number
  readonly points: readonly Timed[]
}

function mergeTimed(tracks: readonly TimedTrack[]): SceneFrame[] {
  const byT = new Map<number, SceneDetection[]>()
  for (const tr of tracks) {
    for (const [t, x, y, w, h] of tr.points) {
      const list = byT.get(t) ?? []
      list.push({ truth: tr.truth, cls: tr.cls, score: tr.score, box: [x, y, w, h] })
      byT.set(t, list)
    }
  }
  return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, dets]) => ({ t, dets }))
}

/**
 * 102, 28/09 13:52:51–13:54:51Z: two parked cars stacked, one car passing.
 *
 * Hand-traced after Task 4 fix round 1 (M1, no rescue overlap): the passing
 * car's last two boxes (4568 ms, 4918 ms) come 720 ms after 3848 ms and
 * overlap its last box at IoU 0.282 < 0.3, so the coasting tracklet no longer
 * re-binds them; they form a 2-hit piece that never confirms (minHits 3) and
 * is never emitted or linked. `passing` still has exactly one final id, but
 * its track ends at 3848 ms, not 4918 ms. No passing box overlaps a parked box
 * at ≥ 0.3 (at most 0.10 with parked-1, 0.16 with parked-2).
 *
 * `passing: false` leaves out the passing car (round 4: what the parked pair
 * does on its own, before the registry promotes it).
 */
export function parkedPair102(opts: { readonly passing?: boolean } = {}): SceneFrame[] {
  const passing: readonly Timed[] = [
    [0, 2112, 7, 508, 242],
    [464, 2070, 0, 598, 300],
    [639, 2101, 4, 614, 312],
    [847, 2118, 0, 616, 334],
    [962, 2128, 0, 624, 362],
    [1311, 2248, 0, 616, 377],
    [1405, 2065, 0, 846, 475],
    [1621, 2060, 0, 871, 499],
    [1712, 2152, 0, 785, 523],
    [1924, 2210, 0, 763, 547],
    [2074, 2387, 40, 730, 576],
    [2259, 2411, 55, 730, 594],
    [2537, 2498, 70, 667, 620],
    [2920, 2557, 101, 774, 686],
    [3092, 2666, 245, 763, 678],
    [3249, 2668, 250, 809, 845],
    [3374, 2748, 298, 785, 924],
    [3555, 2796, 319, 833, 994],
    [3680, 2830, 361, 845, 1070],
    [3848, 2892, 367, 896, 1186],
    [4568, 3269, 823, 566, 1169],
    [4918, 3456, 1172, 376, 952],
  ]
  const passingAt = new Map(passing.map((p) => [p[0], p]))
  const times = new Set<number>(passing.map((p) => p[0]))
  for (let t = 0; t <= 120_000; t += 130) times.add(t)
  return [...times]
    .sort((a, b) => a - b)
    .map((t, i) => {
      const dets: SceneDetection[] = []
      // Parked car 1 (the one at y≈30), stored boxes ≈[3090–3134, 20–58, 384–452, 331–384], 0.50–0.56.
      if (i % 9 !== 4) {
        dets.push({
          truth: 'parked-1',
          cls: 'vehicle',
          score: 0.5 + (i % 5) * 0.01,
          box: [3110 + ((i * 7) % 17) - 8, 30 + ((i * 5) % 13) - 6, 415 + ((i * 3) % 11) - 5, 350],
        })
      }
      // Parked car 2 (y≈320), stored ≈[3073–3088, 304–330, 290–346, 240–299]; the 6.7 s gap is recorded (53:46.1→53:52.8Z).
      const inGap = t >= 55_000 && t < 61_700
      if (i % 3 !== 0 && !inGap) {
        dets.push({
          truth: 'parked-2',
          cls: 'vehicle',
          score: 0.52 + (i % 4) * 0.01,
          box: [3080 + ((i * 3) % 9) - 4, 320 + ((i * 7) % 11) - 5, 315, 262],
        })
      }
      const p = passingAt.get(t)
      if (p !== undefined && opts.passing !== false)
        dets.push({ truth: 'passing', cls: 'vehicle', score: 0.62, box: [p[1], p[2], p[3], p[4]] })
      return { t, dets }
    })
}

const SEAT: readonly SceneBox[] = [
  [416, 1112, 1014, 565],
  [416, 1097, 1014, 596],
  [418, 1115, 1012, 558],
  [418, 1099, 1012, 589],
]
const SEAT_FALLBACK: SceneBox = [416, 1112, 1014, 565]

/** 103's four recorded seat variants, in turn. */
function seat(k: number): SceneBox {
  return SEAT[k % SEAT.length] ?? SEAT_FALLBACK
}

/** 103, 28/09 09:04:07–09:11:18Z: the seven seat tracks' spans, rebased. */
const SEAT_SESSIONS: readonly (readonly [number, number])[] = [
  [0, 15_993],
  [34_156, 50_507],
  [78_912, 128_959],
  [167_373, 167_683],
  [205_187, 262_010],
  [316_767, 316_767],
  [384_529, 430_937],
]

export type SeatGap = 'sub-floor' | 'silence'

/** The operator at the desk: seven sitting sessions, the gaps filled with sub-floor 0.42 boxes or with silence. */
export function seated584(gap: SeatGap): SceneFrame[] {
  const frames: SceneFrame[] = []
  let prevEnd: number | null = null
  let k = 0
  for (const [from, to] of SEAT_SESSIONS) {
    if (prevEnd !== null && gap === 'sub-floor') {
      for (let t = prevEnd + 1000; t < from; t += 1000) {
        frames.push({
          t,
          dets: [],
          low: [{ truth: 'operator', cls: 'person', score: 0.42, box: seat(k++) }],
        })
      }
    }
    for (let t = from; t <= to; t += 400) {
      frames.push({
        t,
        dets: [{ truth: 'operator', cls: 'person', score: 0.66 + (k % 6) * 0.01, box: seat(k++) }],
      })
    }
    prevEnd = to
  }
  return frames
}

/**
 * 102, 28/09 14:00:56.090–14:01:02.805Z: two people walking together
 * (`z9fx…`, `tg9f…`). z9 is last detected at +4.205 s (it walked out of the top
 * edge); from +6.2 s tg walks onto z9's last box (IoU 0.20 → 0.48 at +6.7 s)
 * while z9 is still coasting — the "trample" the old tracker then merged.
 */
export function walkingPair102(): SceneFrame[] {
  const z9: readonly Timed[] = [
    [217, 2579, 314, 299, 654],
    [451, 2566, 296, 294, 103],
    [573, 2558, 280, 264, 616],
    [766, 2536, 277, 282, 622],
    [785, 2521, 253, 260, 623],
    [1023, 2500, 232, 262, 602],
    [1125, 2485, 218, 265, 556],
    [1308, 2467, 209, 269, 562],
    [1356, 2454, 205, 253, 554],
    [1540, 2449, 187, 234, 553],
    [1653, 2438, 175, 238, 527],
    [1752, 2411, 162, 247, 500],
    [1868, 2408, 157, 235, 498],
    [2051, 2410, 151, 214, 515],
    [2153, 2393, 143, 208, 517],
    [2336, 2374, 110, 205, 493],
    [2463, 2348, 104, 215, 462],
    [3078, 2336, 73, 196, 445],
    [3186, 2341, 68, 184, 445],
    [3306, 2344, 70, 162, 424],
    [3683, 2307, 48, 156, 319],
    [4205, 2285, 32, 151, 326],
  ]
  const tg: readonly Timed[] = [
    [0, 3006, 619, 337, 780],
    [217, 2930, 596, 374, 654],
    [451, 2869, 568, 395, 678],
    [573, 2854, 526, 349, 712],
    [766, 2851, 508, 338, 680],
    [785, 2830, 442, 338, 664],
    [1023, 2848, 440, 316, 649],
    [1125, 2836, 432, 317, 658],
    [1308, 2822, 426, 302, 648],
    [1356, 2802, 432, 295, 571],
    [1540, 2720, 368, 336, 595],
    [1653, 2711, 373, 325, 586],
    [1752, 2713, 346, 292, 619],
    [1868, 2708, 317, 283, 592],
    [2051, 2707, 296, 271, 560],
    [2153, 2675, 295, 299, 552],
    [2336, 2688, 283, 253, 542],
    [2463, 2671, 277, 257, 487],
    [2602, 2656, 274, 262, 486],
    [2707, 2623, 260, 266, 509],
    [2831, 2611, 247, 257, 524],
    [3078, 2606, 212, 228, 475],
    [3186, 2600, 203, 234, 468],
    [3306, 2591, 199, 235, 462],
    [3432, 2576, 197, 236, 455],
    [3683, 2560, 171, 212, 436],
    [3805, 2549, 174, 216, 432],
    [3951, 2494, 167, 238, 430],
    [4065, 2490, 143, 223, 455],
    [4205, 2490, 130, 211, 432],
    [4363, 2494, 120, 200, 408],
    [4546, 2478, 122, 209, 389],
    [4650, 2476, 121, 202, 386],
    [4776, 2466, 109, 199, 378],
    [5032, 2438, 97, 197, 374],
    [5134, 2441, 90, 180, 378],
    [5268, 2446, 79, 158, 377],
    [5383, 2428, 62, 169, 379],
    [5508, 2420, 53, 170, 372],
    [5617, 2420, 54, 170, 360],
    [5744, 2407, 62, 176, 346],
    [6234, 2382, 49, 160, 329],
    [6344, 2368, 46, 163, 331],
    [6467, 2353, 32, 158, 342],
    [6605, 2334, 20, 167, 348],
    [6715, 2327, 8, 168, 342],
  ]
  return mergeTimed([
    { truth: 'z9fx', cls: 'person', score: 0.82, points: z9 },
    { truth: 'tg9f', cls: 'person', score: 0.79, points: tg },
  ])
}

/** Two descriptors with no bin in common: "a red coat" and "a blue coat". */
export function coat(which: 'red' | 'blue', gray = false): AppearanceDescriptor {
  return {
    version: 1,
    bins: Array.from({ length: APPEARANCE_BIN_COUNT }, (_, i) =>
      (i % 2 === 0) === (which === 'red') ? 9 : 1,
    ),
    gray,
  }
}

/** Two people crossing at a door (the 101 shape): boxes overlap fully mid-crossing. */
export function crossingPair(appearance: 'distinct' | 'none'): SceneFrame[] {
  const frames: SceneFrame[] = []
  for (let i = 0; i <= 30; i++) {
    const t = i * 150
    const a: SceneDetection = {
      truth: 'left-to-right',
      cls: 'person',
      score: 0.85,
      box: [1200 + i * 30, 300, 400, 560],
      ...(appearance === 'distinct' ? { appearance: coat('red') } : {}),
    }
    const b: SceneDetection = {
      truth: 'right-to-left',
      cls: 'person',
      score: 0.85,
      box: [2100 - i * 30, 320, 400, 560],
      ...(appearance === 'distinct' ? { appearance: coat('blue') } : {}),
    }
    frames.push({ t, dets: [a, b] })
  }
  return frames
}

/** 104 "near, IoU < 0.3, short gap": a child crouches out of the box for 1.9 s. */
export function poseChange590(): SceneFrame[] {
  const frames: SceneFrame[] = []
  for (let i = 0; i < 10; i++)
    frames.push({
      t: i * 140,
      dets: [{ truth: 'child', cls: 'person', score: 0.8, box: [1000, 400, 200, 450] }],
    })
  for (let i = 0; i < 10; i++) {
    frames.push({
      t: 1260 + 1900 + i * 140,
      dets: [{ truth: 'child', cls: 'person', score: 0.8, box: [1200, 600, 260, 260] }],
    })
  }
  return frames
}

// ── 101, 24/09 11:10:20–11:10:28Z: Bob and Alice — SYNTHETIC frames ─
// Only the four ENDPOINT boxes below are stored (3840×2160, spec §10.A). Every
// frame between them is a 150 ms linear interpolation, and everything after
// +5.25 s (Alice lingering, the newcomer, the return) is spec §10's
// HYPOTHETICAL scenario (review H8), not recorded — the recorded case was
// Bob merged into Alice by the old tracker's duplicate-merge pass at
// 11:10:28Z (spec §1).
// A newcomer's truth is DEFINED by the verdict the scene injects: geometry
// alone cannot tell who stands on Bob's last box. The processor-level twin
// (runner-shaped frames, real face details) is Task 11's
// `frame-processor-identity.spec.ts`; here the face is the facade's own input
// (`faceBearing`) and the names are `noteIdentity` verdicts.
const BOB_FROM: SceneBox = [1891, 670, 1417, 958]
const BOB_LAST: SceneBox = [2039, 1592, 1490, 527]
const ALICE_FROM: SceneBox = [1417, 200, 1340, 966]
/** Alice's last stored box, on Bob's (IoU 0.60 with hers). */
const ALICE_ON_HER: SceneBox = [1769, 1410, 1804, 721]
/** SYNTHETIC (fix round 1, M2): Alice leaving up and left, away from Bob's last box. */
const ALICE_AWAY: SceneBox = [1100, 150, 1340, 966]

function lerp(a: SceneBox, b: SceneBox, f: number): SceneBox {
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
  ]
}

function person(truth: string, box: SceneBox): SceneDetection {
  return { truth, cls: 'person', score: 0.86, box, face: true }
}

/** Both walk for 5.25 s from their stored first boxes to `aliceTo`/Bob's last, named at +3 s. */
function walkTogether(aliceTo: SceneBox): SceneFrame[] {
  const frames: SceneFrame[] = []
  for (let t = 0; t <= 5250; t += 150) {
    const f = t / 5250
    frames.push({
      t,
      dets: [
        person('bob', lerp(BOB_FROM, BOB_LAST, f)),
        person('alice', lerp(ALICE_FROM, aliceTo, f)),
      ],
      ...(t === 3000
        ? {
            names: [
              { truth: 'bob', identity: 'bob' },
              { truth: 'alice', identity: 'alice' },
            ],
          }
        : {}),
    })
  }
  return frames
}

/** HYPOTHETICAL: from +11.2 s someone stands on Bob's last box; named Alice at +14.05 s. */
function newcomerOnBobLast(): SceneFrame[] {
  const frames: SceneFrame[] = []
  for (let t = 11_200; t <= 30_000; t += 150) {
    frames.push({
      t,
      dets: [person('alice', BOB_LAST)],
      ...(t === 14_050 ? { names: [{ truth: 'alice', identity: 'alice' }] } : {}),
    })
  }
  return frames
}

/**
 * SYNTHETIC between stored endpoints, then HYPOTHETICAL: both walk down side by
 * side (+0–5.25 s) and are named at +3 s; Bob leaves, Alice stays on her
 * last box until +6.95 s, then leaves. From +11.2 s (both coast budgets spent,
 * no frame in between) someone stands on BOB's last box and is named
 * Alice at +14.05 s — truth by the verdict. Both arcs into him sit within
 * the ambiguity margin, so without the identity rule he is REFUSED (an extra
 * id), not fused into Bob: `bobAliceApart101` is the variant that
 * proves "never Bob".
 */
export function bobAlice101(): SceneFrame[] {
  const frames = walkTogether(ALICE_ON_HER)
  for (let t = 5400; t <= 6950; t += 150) frames.push({ t, dets: [person('alice', ALICE_ON_HER)] })
  return [...frames, ...newcomerOnBobLast()]
}

/**
 * SYNTHETIC (review M2): the same two people, but Alice leaves up and left
 * at +5.25 s and never stands on her box. The newcomer on Bob's last box
 * is named Alice at +14.05 s. By geometry Bob's arc is clearly the
 * better one (cost 0.458 against Alice's, beyond the 0.15 ambiguity
 * margin), so only the identity cannot-link keeps him out of Bob's id.
 */
export function bobAliceApart101(): SceneFrame[] {
  return [...walkTogether(ALICE_AWAY), ...newcomerOnBobLast()]
}

/**
 * SYNTHETIC (interpolated from stored endpoints) then HYPOTHETICAL: Alice
 * walks onto the spot (last seen +3 s, named at +1.5 s) and returns
 * to it 5 s after his last sighting, face showing; the recognizer names him
 * at +16.1 s. Every other rule is ready at +13 s (last sighting + 10 s).
 */
export function faceReturn101(): SceneFrame[] {
  const frames: SceneFrame[] = []
  for (let t = 0; t <= 3000; t += 150) {
    frames.push({
      t,
      dets: [person('alice', lerp(ALICE_FROM, ALICE_ON_HER, t / 3000))],
      ...(t === 1500 ? { names: [{ truth: 'alice', identity: 'alice' }] } : {}),
    })
  }
  for (let t = 8000; t <= 30_000; t += 150) {
    frames.push({
      t,
      dets: [person('alice', ALICE_ON_HER)],
      ...(t === 16_100 ? { names: [{ truth: 'alice', identity: 'alice' }] } : {}),
    })
  }
  return frames
}
