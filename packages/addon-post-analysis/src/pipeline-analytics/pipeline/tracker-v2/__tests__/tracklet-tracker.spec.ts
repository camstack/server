/**
 * The L1 frame step (§3). Each `it` is one rule of the spec. (Round 4: no
 * presence — a still subject is an ordinary tracklet until the registry
 * promotes it, spec §5.)
 *
 * Disarms (each alone, restored; each named test must turn RED):
 *  - skip the ambiguous groups (treat them as pairs): "a crossing in doubt ends both tracklets";
 *  - remove the `doubtExpired` clause from `confirmIfDue`: "contested pieces are emitted after CONTESTED_MAX_MS";
 *  - set `contestedHits` AFTER `confirmIfDue` in `spawn`: "confirmBypass never confirms a piece born in doubt";
 *  - in `followWithLowScore` also set `lastSeenAt`: "sub-floor boxes … do not extend the coast";
 *  - drop the `LINGERING_CLASSES` check: "a vehicle sub-floor box never carries a moving vehicle";
 *  - make `expire` a no-op: "silence ends a coasting tracklet through expire";
 *  - remove the `expire(t)` at the top of `step` (review 2 NC1): "a frame after the coast budget never binds the stale tracklet" fails;
 *  - (Task 4's) drop `inCohortDoubt` from the competitor loop: "merged boxes every 4th frame do not restart the doubt clock" fails;
 *  - end a tracklet whose recent boxes are still (a stillness cap of any kind):
 *    "a still subject stays one tracklet while it is seen" fails;
 *  - make `drop(id, t, 'stationary')` end the tracklet `dropped`: "a registry
 *    promotion ends the tracklet `stationary`" fails.
 *
 * Fix round 1 (task-6 review), each RED on 3b154e1fb before the fix:
 *  - drop `demoteSilent(t)` from `step`: "a newcomer on the prediction after a
 *    silence inside the budget is a new tracklet" fails (H1);
 *  - give a coasting owner `RIVAL_MARGIN` again in `auditCompetitors`: "a double
 *    crossing with a turn-back never swaps two confirmed ids" fails (H2);
 *  - refuse the group's continuation-only box without `against`, or without
 *    `refused` on the split facts: "a continuation-only box in a doubt group…" fails (M1);
 *  - follow a sub-floor box on the LAST box instead of the prediction: "sub-floor
 *    boxes …" fails on `assocAt` — `heldByLowScore` alone is sticky and stays green (M2);
 *  - drop the `stationary` exemption from `unconfirmed-spawn-lost`: "a registry
 *    promotion of an unconfirmed tracklet…" fails (L1);
 *  - refuse a double fire against `liveList[fire.tracklet]`: "a double fire inside a
 *    split is refused against the piece…" fails (L2).
 *
 * Re-review (Variant A), RED on b9755ea4d before the fix:
 *  - give a coasting owner `RIVAL_MARGIN` again in `auditRivalBoxes`: "a newcomer on a
 *    coasting tracklet's stale box never takes its id by margin" fails.
 */
import type { BoundingBox, SpatialDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sequentialTrackIdMinter } from '../../track-id.js'
import type { SpawnRefusalFacts } from '../../tracker/spawn-refusal.js'
import { CONTESTED_MAX_MS } from '../constants.js'
import { TrackletTracker } from '../tracklet-tracker.js'
import {
  DEFAULT_TRACKER_V2_CONFIG,
  type TrackerV2Config,
  type TrackerV2FrameContext,
  type TrackletSplitFacts,
} from '../types.js'

const CTX: TrackerV2FrameContext = { frameWidth: 3840, frameHeight: 2160 }
const box = (x: number, y = 100, w = 100, h = 200): BoundingBox => ({ x, y, w, h })
const det = (b: BoundingBox, cls = 'person', score = 0.9): SpatialDetection => ({
  class: cls,
  originalClass: cls,
  score,
  bbox: b,
})
const SEAT = box(416, 1112, 1014, 565)
/** 103's four recorded seat variants (IoU 0.93–0.96 with one another). */
const SEATS: readonly BoundingBox[] = [
  box(416, 1112, 1014, 565),
  box(416, 1097, 1014, 596),
  box(418, 1115, 1012, 558),
  box(418, 1099, 1012, 589),
]

function tracker(
  refusals: SpawnRefusalFacts[] = [],
  config: Partial<TrackerV2Config> = {},
): TrackletTracker {
  return new TrackletTracker(
    { ...DEFAULT_TRACKER_V2_CONFIG, ...config },
    sequentialTrackIdMinter(),
    { refusal: (f) => refusals.push(f) },
  )
}

function confirmWalker(tr: TrackletTracker, x0: number): number {
  let t = 0
  for (let i = 0; i < 3; i++) {
    tr.step([det(box(x0 + i * 10))], t, CTX)
    t += 130
  }
  return t
}

/** Two confirmed people side by side, then the 101-door overlap: returns the split time. */
function split(tr: TrackletTracker): number {
  let t = 0
  for (let i = 0; i < 3; i++) {
    tr.step([det(box(100)), det(box(140))], t, CTX)
    t += 130
  }
  tr.step([det(box(120)), det(box(125))], t, CTX)
  return t
}

describe('TrackletTracker', () => {
  it('emits a tracklet only once it is confirmed at minHits', () => {
    const tr = tracker()
    expect(tr.step([det(box(100))], 0, CTX).emissions).toEqual([])
    expect(tr.step([det(box(110))], 130, CTX).emissions).toEqual([])
    const third = tr.step([det(box(120))], 260, CTX).emissions
    expect(third.map((e) => [e.tracklet.id, e.matched])).toEqual([['t1', true]])
  })

  it('coasts on misses and ends `missed` at maxMissedMs from the last confident box', () => {
    const tr = tracker()
    const t = confirmWalker(tr, 100)
    const coast = tr.step([], t, CTX).emissions
    expect([coast[0]?.matched, coast[0]?.tracklet.mode]).toEqual([false, 'coasting'])
    tr.step([], 260 + 4001, CTX)
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason, x.endedAt])).toEqual([
      ['t1', 'missed', 260],
    ])
  })

  it('silence ends a coasting tracklet through expire, with no frame', () => {
    const tr = tracker()
    confirmWalker(tr, 100)
    tr.expire(4000)
    expect(tr.liveTracklets()).toHaveLength(1)
    tr.expire(260 + 4001)
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason, x.endedAt])).toEqual([
      ['t1', 'missed', 260],
    ])
  })

  it('an unconfirmed tracklet that ends reports unconfirmed-spawn-lost', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    tr.step([det(box(100))], 0, CTX)
    tr.step([], 4200, CTX)
    expect(refusals.map((r) => r.reason)).toEqual(['unconfirmed-spawn-lost'])
  })

  it('a crossing in doubt ends both tracklets and spawns split pieces, once', () => {
    const tr = tracker()
    const t = split(tr)
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason])).toEqual([
      ['t1', 'ambiguous'],
      ['t2', 'ambiguous'],
    ])
    const pieces = tr.liveTracklets()
    expect(pieces.map((p) => p.lineage)).toEqual([
      { kind: 'split', from: ['t1', 't2'] },
      { kind: 'split', from: ['t1', 't2'] },
    ])
    expect(pieces.every((p) => !p.confirmed && p.cohort === pieces[0]?.cohort)).toBe(true)
    const next = tr.step([det(box(121)), det(box(126))], t + 130, CTX)
    expect(tr.liveTracklets().map((p) => p.id)).toEqual(pieces.map((p) => p.id))
    expect(next.emissions).toEqual([])
    let u = t + 260
    for (const [l, r] of [
      [110, 135],
      [100, 150],
      [90, 165],
      [80, 180],
    ] as const) {
      tr.step([det(box(l)), det(box(r))], u, CTX)
      u += 130
    }
    expect(tr.liveTracklets().every((p) => p.confirmed)).toBe(true)
  })

  it('contested pieces are emitted after CONTESTED_MAX_MS even if their subjects never part (review H9)', () => {
    const tr = tracker()
    const t0 = split(tr)
    let firstEmission: number | null = null
    for (let u = t0 + 130; u <= t0 + 20_000; u += 130) {
      const jitter = (u / 130) % 2 === 0 ? 1 : 0
      const out = tr.step([det(box(121 + jitter)), det(box(126 - jitter))], u, CTX)
      if (firstEmission === null && out.emissions.length > 0) firstEmission = u
    }
    expect(firstEmission).not.toBeNull()
    expect((firstEmission ?? 0) - t0).toBeGreaterThanOrEqual(CONTESTED_MAX_MS)
    expect((firstEmission ?? 0) - t0).toBeLessThan(CONTESTED_MAX_MS + 300)
    // Still the same two pieces after 20 s of overlap: no id per frame, no id per 3 s.
    expect(tr.liveTracklets()).toHaveLength(2)
  })

  it('confirmBypass never confirms a piece born in doubt (review M14)', () => {
    const tr = tracker([], { confirmBypassEnabled: true, confirmBypassScore: 0.8 })
    const t = split(tr)
    expect(
      tr
        .liveTracklets()
        .filter((p) => p.startedAt === t)
        .every((p) => !p.confirmed),
    ).toBe(true)
  })

  it('a double fire beside a confirmed track is refused, not split (review M1)', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    const t = confirmWalker(tr, 100)
    tr.step([det(box(125)), det(box(127))], t, CTX)
    expect(refusals.map((r) => r.reason)).toEqual(['dedup-iou'])
    expect(tr.endedTracklets()).toEqual([])
  })

  it('refuses a box overlapping a tracklet bound this frame at ≥ dedupSpawnIou', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    const t = confirmWalker(tr, 100)
    tr.step([det(box(125)), det(box(140, 120))], t, CTX)
    expect(refusals.map((r) => r.reason)).toContain('dedup-iou')
    expect(tr.liveTracklets()).toHaveLength(1)
  })

  it('a continuation-only box nobody claims is refused as stationary-hold', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    tr.step([det(box(900), 'vehicle')], 0, { ...CTX, continuationOnly: new Set([0]) })
    expect(refusals.map((r) => r.reason)).toEqual(['stationary-hold'])
    expect(tr.liveTracklets()).toEqual([])
  })

  it('sub-floor boxes follow a moving person without emitting their box, and do not extend the coast', () => {
    const tr = tracker()
    const t = confirmWalker(tr, 100)
    const out = tr.step([], t, { ...CTX, lowScore: [det(box(135), 'person', 0.4)] }).emissions
    expect(out[0]?.tracklet.heldByLowScore).toBe(true)
    expect(out[0]?.tracklet.lastBox.x).toBe(120)
    // Inside the budget, on the prediction (135 + 10/130 px/ms × the 1 s cap ≈ 212): followed…
    const late = tr.step([], 4000, { ...CTX, lowScore: [det(box(212), 'person', 0.4)] }).emissions
    expect([late[0]?.tracklet.id, late[0]?.tracklet.heldByLowScore, late[0]?.matched]).toEqual([
      't1',
      true,
      false,
    ])
    // `heldByLowScore` alone is sticky from the follow at 390 (review M2): the
    // association state is what proves THIS box was followed.
    expect(tr.get('t1')?.assocAt).toBe(4000)
    // …yet the coast still ends at the last CONFIDENT box.
    tr.expire(260 + 4001)
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason, x.endedAt])).toEqual([
      ['t1', 'missed', 260],
    ])
  })

  it('a vehicle sub-floor box never carries a moving vehicle', () => {
    const tr = tracker()
    let t = 0
    for (let i = 0; i < 3; i++) {
      tr.step([det(box(1000 + i * 40, 300, 400, 300), 'vehicle')], t, CTX)
      t += 130
    }
    const out = tr.step([], t, {
      ...CTX,
      lowScore: [det(box(1120, 300, 400, 300), 'vehicle', 0.4)],
    }).emissions
    expect(out[0]?.tracklet.heldByLowScore).toBe(false)
  })

  it('a still subject stays one tracklet while it is seen — no stillness state, no cap (round 4)', () => {
    // 103 seated, recorded jitter, 600 ms cadence, one minute: L1 has no
    // opinion about stillness; the registry decides it (spec §5).
    const tr = tracker()
    let t = 0
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++, t += 600) {
      for (const e of tr.step([det(SEATS[i % 4] ?? SEAT, 'person', 0.68)], t, CTX).emissions) {
        ids.add(e.tracklet.id)
        expect([e.tracklet.mode, e.matched]).toEqual(['active', true])
      }
    }
    expect([...ids]).toEqual(['t1'])
    expect(tr.endedTracklets()).toEqual([])
  })

  it('a registry promotion ends the tracklet `stationary`, at its last sighting (round 4)', () => {
    const tr = tracker()
    let t = 0
    for (let i = 0; i < 12; i++, t += 600)
      tr.step([det(SEATS[i % 4] ?? SEAT, 'person', 0.68)], t, CTX)
    tr.drop('t1', t, 'stationary')
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason, x.endedAt])).toEqual([
      ['t1', 'stationary', t - 600],
    ])
    // Its boxes now go to the registry (the gate suppresses them before L1).
    expect(tr.liveTracklets()).toEqual([])
  })

  it('a frame after the coast budget never binds the stale tracklet (review 2 NC1)', () => {
    const tr = tracker()
    confirmWalker(tr, 100) // last sighting at 260, on box(120)
    // No frame and no `advance` for 5 s, then a box exactly on the last box.
    tr.step([det(box(120))], 5260, CTX)
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason, x.endedAt])).toEqual([
      ['t1', 'missed', 260],
    ])
    expect(tr.liveTracklets().map((x) => x.id)).toEqual(['t2'])
  })

  it('merged boxes every 4th frame do not restart the doubt clock (review 2 M1)', () => {
    const tr = tracker()
    const t0 = split(tr)
    const ids = new Set(tr.liveTracklets().map((x) => x.id))
    const emittedAt = new Map<string, number>()
    for (let u = t0 + 130, k = 0; u <= t0 + 20_000; u += 130, k++) {
      const dets = k % 4 === 3 ? [det(box(123))] : [det(box(121)), det(box(126))]
      for (const e of tr.step(dets, u, CTX).emissions)
        if (!emittedAt.has(e.tracklet.id)) emittedAt.set(e.tracklet.id, u)
    }
    // No piece minted after the split, and both pieces emitted within the bound.
    expect(new Set(tr.liveTracklets().map((x) => x.id))).toEqual(ids)
    for (const id of ids)
      expect((emittedAt.get(id) ?? Number.POSITIVE_INFINITY) - t0).toBeLessThan(
        CONTESTED_MAX_MS + 600,
      )
  })

  // ── Fix round 1 (task-6 review) ──────────────────────────────────────────

  it('a newcomer on the prediction after a silence inside the budget is a new tracklet (review H1)', () => {
    const tr = tracker()
    confirmWalker(tr, 100) // last sighting at 260 on box(120), moving +10 px per 130 ms
    // No frame for 3.4 s (the motion gate stopped them, D438), then a newcomer on
    // the capped prediction (120 + 10/130 px/ms × 1 000 ms ≈ 197), IoU 0.13 with the last box.
    const out = tr.step([det(box(197))], 3660, CTX).emissions
    expect(out.map((e) => [e.tracklet.id, e.matched, e.tracklet.mode])).toEqual([
      ['t1', false, 'coasting'],
    ])
    expect(tr.liveTracklets().map((x) => [x.id, x.lastBox.x])).toEqual([
      ['t1', 120],
      ['t2', 197],
    ])
  })

  it('a double crossing with a turn-back never swaps two confirmed ids (review H2)', () => {
    // A from 200 → right, B from 500 → left, 45 px per 130 ms (0.45 box widths
    // per frame: an ordinary walk at 7.7 fps). Closer than 80 px the detector
    // returns only A's box; once A has passed B by 80 px both turn back.
    const tr = tracker()
    const carried = new Map<string, Set<string>>()
    let [xa, xb, v] = [200, 500, 45]
    for (let k = 0; k < 30; k++) {
      const merged = Math.abs(xa - xb) < 80
      const dets = merged ? [det(box(xa))] : [det(box(xa)), det(box(xb))]
      const who = merged ? ['A'] : ['A', 'B']
      for (const e of tr.step(dets, k * 130, CTX).emissions) {
        if (e.detection === undefined) continue
        const subject = who[dets.indexOf(e.detection)] ?? '?'
        carried.set(e.tracklet.id, (carried.get(e.tracklet.id) ?? new Set()).add(subject))
      }
      xa += v
      xb -= v
      if (v > 0 && xa - xb >= 80) v = -v
    }
    // On HEAD at 3b154e1fb: t1 carried A then B and t2 B then A (a full swap).
    const mixed = [...carried].filter(([, subjects]) => subjects.size > 1).map(([id]) => id)
    expect(mixed).toEqual([])
  })

  it('a continuation-only box in a doubt group is refused against the group, not as unclaimed (review M1)', () => {
    const refusals: SpawnRefusalFacts[] = []
    const splits: TrackletSplitFacts[] = []
    const tr = new TrackletTracker(DEFAULT_TRACKER_V2_CONFIG, sequentialTrackIdMinter(), {
      refusal: (f) => refusals.push(f),
      split: (f) => splits.push(f),
    })
    for (let t = 0; t < 390; t += 130) tr.step([det(box(100)), det(box(130))], t, CTX)
    tr.step([det(box(115))], 390, { ...CTX, continuationOnly: new Set([0]) })
    // Extra ids over a mix-up (Q3): both parents still end `ambiguous`…
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason])).toEqual([
      ['t1', 'ambiguous'],
      ['t2', 'ambiguous'],
    ])
    // …and the box they fought over is recorded as the group's, not as "nobody claimed it" (D391).
    expect(splits.map((f) => [f.ended, f.born, f.refused])).toEqual([
      [['t1', 't2'], [], [box(115)]],
    ])
    expect(refusals.map((r) => [r.reason, r.againstTrackId])).toEqual([['stationary-hold', 't1']])
  })

  it('a registry promotion of an unconfirmed tracklet reports no unconfirmed-spawn-lost (review L1)', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    tr.step([det(box(100))], 0, CTX)
    tr.drop('t1', 130, 'stationary')
    expect(tr.endedTracklets().map((x) => [x.id, x.endReason])).toEqual([['t1', 'stationary']])
    expect(refusals).toEqual([])
  })

  it('a double fire inside a split is refused against the piece that took the box (review L2)', () => {
    const refusals: SpawnRefusalFacts[] = []
    const tr = tracker(refusals)
    let t = 0
    for (let i = 0; i < 3; i++, t += 130) tr.step([det(box(100)), det(box(140))], t, CTX)
    // The 101-door overlap, with a second read of the box at 120 (IoU 0.98).
    tr.step([det(box(120)), det(box(125)), det(box(121))], t, CTX)
    const pieces = tr.liveTracklets().map((x) => x.id)
    const fire = refusals.filter((r) => r.reason === 'dedup-iou')
    expect(fire).toHaveLength(1)
    expect(pieces).toContain(fire[0]?.againstTrackId)
  })

  it("a newcomer on a coasting tracklet's stale box never takes its id by margin (re-review, Variant A)", () => {
    // A walks 10 px per frame (100 px box) to its last sighting on 140 at 520,
    // misses two frames, and is back at 170 at 910 — just as a newcomer B stands
    // exactly on the stale box. B costs t1 0, A costs it 0.46: past RIVAL_MARGIN.
    const tr = tracker()
    const carried = new Map<string, Set<string>>()
    const note = (dets: readonly SpatialDetection[], who: readonly string[], t: number): void => {
      for (const e of tr.step(dets, t, CTX).emissions) {
        if (e.detection === undefined) continue
        const subject = who[dets.indexOf(e.detection)] ?? '?'
        carried.set(e.tracklet.id, (carried.get(e.tracklet.id) ?? new Set()).add(subject))
      }
    }
    for (let k = 0; k < 5; k++) note([det(box(100 + k * 10))], ['A'], k * 130)
    for (let k = 5; k < 7; k++) note([], [], k * 130)
    for (let k = 7; k < 17; k++) note([det(box(100 + k * 10)), det(box(140))], ['A', 'B'], k * 130)
    // Neither margin protects a coasting owner: doubt, split — extra ids, never a mix (Q3).
    expect([...carried].filter(([, subjects]) => subjects.size > 1)).toEqual([])
    expect(tr.get('t1')?.endReason).toBe('ambiguous')
  })
})
