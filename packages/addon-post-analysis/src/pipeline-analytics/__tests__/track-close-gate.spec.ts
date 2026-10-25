/**
 * Spec §6.4: a row closes only when the tracker says its chain is not live
 * and its tail is final — asked through the ONE production gate,
 * `TrackerSweep.canClose`, in the processor's frame clock (review C2, M2).
 *
 * Disarms (each alone, restored):
 *  - ignore `canClose` in `expireStale`: the first two tests and the 38 s
 *    scene all fail (the scene fails on its first post-TTL `expireStale`
 *    check, long before the fusion commits);
 *  - in `index.ts`'s closer wiring, pass `() => true`: not unit-visible — the
 *    "a silent camera's row…" test is the executable form of that wiring
 *    (same call, same args). `track-close-canclose-wiring-e2e.spec.ts` pins
 *    the ACTUAL `index.ts` wiring through the booted addon.
 *  - drop the `heldRowForceCloseMs` bound (or widen it past the scene's own
 *    numbers): "force-closes a row the bound has outrun" fails.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../pipeline/frame-processor.js'
import { sequentialTrackIdMinter } from '../pipeline/track-id.js'
import { TrackerSweep } from '../pipeline/tracker-sweep.js'
import { makeSilentLogger } from './test-helpers.js'
import { buildTrackStoreForTest, sighting } from './track-store-test-helpers.js'

describe('expireStale canClose', () => {
  it('keeps a row the gate holds, closes it once released', async () => {
    const store = buildTrackStoreForTest()
    store.upsert(sighting('P', 1000, 500))
    let live = true
    // Past TTL (30 s) but well under the M2 force-close bound (TTL +
    // LINK_WINDOW_MS + 2 sweeps, 100 s default) — this pins the GATE, not
    // the bound; `force-closes a row the bound has outrun` pins that.
    expect(await store.expireStale(40_000, { canClose: () => !live })).toEqual([])
    live = false
    expect(
      (await store.expireStale(40_000, { canClose: () => !live })).map((t) => t.trackId),
    ).toEqual(['P'])
  })

  it('force-closes a row the bound has outrun, with the tracker still holding it', async () => {
    const store = buildTrackStoreForTest()
    store.upsert(sighting('P', 1000, 500))
    // ttlMs (30 s, default) + LINK_WINDOW_MS (60 s) + 2×TTL_SWEEP_INTERVAL_MS
    // (10 s) = 100 s past lastSeen. One ms over that bound, canClose saying
    // "no" forever must no longer matter (review M2).
    const closed = await store.expireStale(1000 + 100_001, { canClose: () => false })
    expect(closed.map((t) => t.trackId)).toEqual(['P'])
  })

  it("a silent camera's row outlives its TTL until the sweep has made its tail final", async () => {
    const wall = { now: 0 }
    const p = new FrameProcessor(7, {}, {}, {}, 'pipeline', {
      mintTrackId: sequentialTrackIdMinter(),
      wallClock: () => wall.now,
    })
    const sweep = new TrackerSweep({
      processors: () => [['7:pipeline', p]],
      processorsOf: (d) => (d === 7 ? [p] : []),
      applyFusions: async () => {},
      logger: makeSilentLogger(),
    })
    const store = buildTrackStoreForTest({ ttlMs: 2000 })
    const det = (x: number): ObjectDetection => ({
      id: `d${x}`,
      kind: 'first-level',
      macroClass: 'person',
      score: 0.9,
      labels: [],
      bbox: { x, y: 100, width: 100, height: 200 },
    })
    for (let i = 0; i < 5; i++) {
      const t = i * 130
      wall.now = t
      const frame: FrameResult = {
        kind: 'frame',
        frameId: `f${t}`,
        deviceId: 7,
        timestamp: t,
        width: 1920,
        height: 1080,
        detections: [det(100 + i * 5)],
      }
      for (const tr of p.process({ timestamp: t, frame }).tracked) {
        store.upsert(sighting(tr.trackId, t, 100 + i * 5, { deviceId: 7 }))
      }
    }
    const gate = {
      canClose: (t: { deviceId: number; trackId: string }) => sweep.canClose(t, wall.now),
    }
    wall.now = 3000
    await sweep.run(wall.now)
    // TTL (2 s) has passed, but the tracklet still coasts and L2 may still extend it.
    expect(await store.expireStale(wall.now, gate)).toEqual([])
    for (let w = 5000; w <= 20_000; w += 5000) {
      wall.now = w
      await sweep.run(w)
    }
    expect((await store.expireStale(wall.now, gate)).map((t) => t.trackId)).toEqual(['t1'])
  })

  it("a fusion committed 38 s after the survivor's last sighting never reopens it (review H1)", async () => {
    // Task 11 H4's exact shape, through the REAL tracker: A is face-bearing
    // and walks 0→260 (minHits=3 confirms it). 8 s of silence — under
    // `LINK_MAX_GAP_MS` (10 s), so A's tail stays "pending successor" —
    // then B starts at the SAME spot, faceless at first (so A's face-bearing
    // chain refuses to absorb it live — `facelessLive`), then B itself grows
    // a face at 18270. Two unnamed face-bearing chains wait from the LATER
    // first-face for `FACE_SETTLE_HOLD_MS` (20 s) before the arc is even
    // `ready` (`faceHoldUntil`, linker.ts) — so the commit lands at
    // 18270 + 20_000 = 38270, the next real frame after it (38290): 38.03 s
    // after A's own last sighting (260).
    const wall = { now: 0 }
    const p = new FrameProcessor(7, {}, {}, {}, 'pipeline', {
      mintTrackId: sequentialTrackIdMinter(),
      wallClock: () => wall.now,
    })
    const sweep = new TrackerSweep({
      processors: () => [['7:pipeline', p]],
      processorsOf: (d) => (d === 7 ? [p] : []),
      applyFusions: async () => {},
      logger: makeSilentLogger(),
    })
    const store = buildTrackStoreForTest()
    const gate = {
      canClose: (t: { deviceId: number; trackId: string }) => sweep.canClose(t, wall.now),
    }
    const person = (id: string): ObjectDetection => ({
      id,
      kind: 'first-level',
      macroClass: 'person',
      score: 0.9,
      labels: [],
      bbox: { x: 500, y: 100, width: 100, height: 200 },
    })
    const face = (id: string, parentId: string): ObjectDetection => ({
      id,
      kind: 'detail',
      macroClass: 'face',
      score: 0.9,
      labels: [],
      bbox: { x: 510, y: 110, width: 20, height: 20 },
      parentId,
    })
    function driveFrame(t: number, dets: readonly ObjectDetection[]): readonly string[] {
      wall.now = t
      const frame: FrameResult = {
        kind: 'frame',
        frameId: `f${t}`,
        deviceId: 7,
        timestamp: t,
        width: 1920,
        height: 1080,
        detections: [...dets],
      }
      const tracked = p.process({ timestamp: t, frame }).tracked
      for (const tr of tracked) store.upsert(sighting(tr.trackId, t, 500, { deviceId: 7 }))
      return tracked.map((tr) => tr.trackId)
    }

    for (const t of [0, 130, 260]) driveFrame(t, [person('pA'), face('fA', 'pA')])
    const aId = driveFrame(260, [person('pA'), face('fA', 'pA')])[0]
    if (aId === undefined) throw new Error('A was never confirmed')
    const a = aId

    const bStart = 260 + 8_000
    let firstBId: string | undefined
    let committedAt: number | undefined
    for (let t = bStart; t <= 39_000; t += 130) {
      const withFace = t >= 18_270
      const ids = driveFrame(t, withFace ? [person('pB'), face('fB', 'pB')] : [person('pB')])
      const id = ids[0]
      if (firstBId === undefined) firstBId = id
      if (committedAt === undefined && id !== undefined && id === a && id !== firstBId) {
        committedAt = t
      }
      // The survivor's row must never close before the commit, however long
      // the sweep cadence runs in the meantime (review C2/M2's whole point).
      if (t - 260 >= 30_000) {
        expect(
          (await store.expireStale(t, gate)).map((tr) => tr.trackId),
          `expireStale at t=${t}`,
        ).toEqual([])
      }
    }

    expect(firstBId, 'B was confirmed under its own id').toBeDefined()
    expect(firstBId).not.toBe(a)
    if (committedAt === undefined) throw new Error('the fusion never committed')
    expect(committedAt - 260).toBeGreaterThanOrEqual(38_000)
    // Nothing reopened A's row: it is still the one continuous active entry,
    // never closed-then-recreated by the late commit.
    expect(store.getActiveByTrack(a)).not.toBeNull()
  })
})
