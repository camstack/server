/**
 * OccupancyWatcher unit tests — the PURE debounced edge state machine.
 *
 * Contract (design §2.3, brief A2):
 *  - `occupied ⇔ count ≥ threshold` (maxObjects/capacity parity).
 *  - A raw change that flips the occupied predicate opens a PENDING edge; the
 *    edge commits only after it holds continuously for `sustainSeconds`. A
 *    flip-back before commit cancels the pending edge (no emit).
 *  - `became-free` is symmetric.
 *  - `hydrate` reseeds confirmed edge-state so a restart mid-occupancy does not
 *    re-fire an edge for a level that was already confirmed before the crash.
 *  - Frame-total key (no `zoneId`) counts `snapshot.frame.totalObjects`; a
 *    per-zone key reads `snapshot.zones[].byClass[className]`.
 *  - Fail-closed: a `zoneId` absent from the snapshot's `zones[]` tracks no key
 *    (no emit).
 *
 * The clock is injected as the `now` argument to `observe` — the module owns no
 * timers and does no I/O, so every window is exercised deterministically.
 *
 * SEEDING (2026-08-12): the FIRST observation of a key writes the observed
 * level and fires nothing — an edge requires a transition between two observed
 * snapshots (`occupancy-cold-seed.spec.ts`). Every test below that is about a
 * TRANSITION therefore establishes the "before" side with an explicit seed
 * observation at the same `now`, which leaves the original timelines and every
 * timestamp assertion untouched.
 */

import type { CameraOccupancySnapshot } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { occupancyKey, OccupancyWatcher, type OccupancyStateRow } from '../occupancy-watcher.js'

const DEVICE = 42
const SEC = 1_000

/** Build a snapshot with a frame total + optional zones. Times are irrelevant
 *  to the watcher (the clock is the `now` arg), so `ts` is fixed. */
function snapshot(opts: {
  readonly frameTotal?: number
  readonly frameByClass?: Readonly<Record<string, number>>
  readonly zones?: readonly {
    readonly zoneId: string
    readonly zoneName: string
    readonly total: number
    readonly byClass?: Readonly<Record<string, number>>
  }[]
}): CameraOccupancySnapshot {
  return {
    ts: 0,
    frameWidth: 1920,
    frameHeight: 1080,
    frame: {
      totalObjects: opts.frameTotal ?? 0,
      byClass: { ...opts.frameByClass },
    },
    zones: (opts.zones ?? []).map((z) => ({
      zoneId: z.zoneId,
      zoneName: z.zoneName,
      totalObjects: z.total,
      byClass: { ...z.byClass },
      trackIds: [],
    })),
    unzoned: { totalObjects: 0, byClass: {} },
  }
}

describe('occupancyKey', () => {
  it('encodes device, frame/zone, all/class scopes and the threshold marker', () => {
    expect(occupancyKey(DEVICE, undefined, undefined, 1)).toBe('42|@frame|@all|t1')
    expect(occupancyKey(DEVICE, 'zoneA', undefined, 2)).toBe('42|zoneA|@all|t2')
    expect(occupancyKey(DEVICE, undefined, 'person', 3)).toBe('42|@frame|person|t3')
    expect(occupancyKey(DEVICE, 'zoneA', 'car', 5)).toBe('42|zoneA|car|t5')
  })
})

describe('OccupancyWatcher — debounce / sustain (became-occupied)', () => {
  it('(a) does NOT emit before sustainSeconds elapse, then emits once it holds', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 15 }]) // frame-total, any class

    // Seed the "before" side: an empty frame. Fires nothing by construction.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0)).toEqual([])
    // t=0: count 0 -> 5 (occupied). Pending opens, no commit yet.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 5 }), 0)).toEqual([])
    // t=10s: still occupied, sustain not elapsed.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 5 }), 10 * SEC)).toEqual([])
    // t=15s: held continuously -> commit exactly one became-occupied edge.
    const edges = w.observe(DEVICE, snapshot({ frameTotal: 5 }), 15 * SEC)
    expect(edges).toEqual([
      {
        deviceId: DEVICE,
        count: 5,
        previousCount: 0,
        occupied: true,
        threshold: 1,
        timestamp: 15 * SEC,
      },
    ])
    // t=20s: no NEW edge (occupied unchanged).
    expect(w.observe(DEVICE, snapshot({ frameTotal: 6 }), 20 * SEC)).toEqual([])
  })

  it('(b) a flip-back before sustainSeconds cancels the pending edge', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 15 }])

    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0)).toEqual([]) // seed: empty
    expect(w.observe(DEVICE, snapshot({ frameTotal: 5 }), 0)).toEqual([]) // pending true
    // t=5s: back to empty BEFORE the window -> pending cancelled, no emit.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 5 * SEC)).toEqual([])
    // t=25s: still empty -> nothing ever committed.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 25 * SEC)).toEqual([])
    // A fresh occupancy must still be able to fire (state not wedged).
    expect(w.observe(DEVICE, snapshot({ frameTotal: 3 }), 30 * SEC)).toEqual([])
    const edges = w.observe(DEVICE, snapshot({ frameTotal: 3 }), 45 * SEC)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.occupied).toBe(true)
    expect(edges[0]?.count).toBe(3)
  })

  it('sustainSeconds:0 fires on the first matching edge', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 0 }])
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0)).toEqual([]) // seed: empty
    const edges = w.observe(DEVICE, snapshot({ frameTotal: 2 }), 0)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.occupied).toBe(true)
    expect(edges[0]?.count).toBe(2)
  })

  it('max-count semantics: occupied ⇔ count ≥ threshold (boundary inclusive)', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 3, sustainSeconds: 0 }])
    // count 2 (< 3) -> not occupied, no edge.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 2 }), 0)).toEqual([])
    // count 3 (== threshold) -> occupied, edge.
    const edges = w.observe(DEVICE, snapshot({ frameTotal: 3 }), SEC)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.count).toBe(3)
  })
})

describe('OccupancyWatcher — became-free (symmetric)', () => {
  it('(c) commits a became-free edge once the empty state holds', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 10 }])

    // Confirm occupied first — from a seeded EMPTY baseline, so the rise is a
    // real transition rather than the seed itself.
    w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0)
    w.observe(DEVICE, snapshot({ frameTotal: 4 }), 0)
    const occ = w.observe(DEVICE, snapshot({ frameTotal: 4 }), 10 * SEC)
    expect(occ[0]?.occupied).toBe(true)

    // Now drop to 0 and hold for the window.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 12 * SEC)).toEqual([]) // pending free
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 18 * SEC)).toEqual([]) // < 10s held
    const freed = w.observe(DEVICE, snapshot({ frameTotal: 0 }), 22 * SEC)
    expect(freed).toEqual([
      {
        deviceId: DEVICE,
        count: 0,
        previousCount: 4,
        occupied: false,
        threshold: 1,
        timestamp: 22 * SEC,
      },
    ])
  })

  it('a re-occupancy before the became-free window cancels the free edge', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 10 }])
    w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0) // seed: empty
    w.observe(DEVICE, snapshot({ frameTotal: 4 }), 0)
    w.observe(DEVICE, snapshot({ frameTotal: 4 }), 10 * SEC) // confirmed occupied
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 12 * SEC)).toEqual([]) // pending free
    // Re-occupied before the free window -> pending cancelled, still occupied.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 5 }), 15 * SEC)).toEqual([])
    // Holding occupied does not emit a second became-occupied.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 5 }), 40 * SEC)).toEqual([])
  })
})

describe('OccupancyWatcher — hydrate / restart reseed (constraint 4)', () => {
  it('(d) hydrate then observe with the SAME confirmed level emits nothing', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 15 }])
    const rows: OccupancyStateRow[] = [
      {
        key: occupancyKey(DEVICE, undefined, undefined, 1),
        deviceId: DEVICE,
        threshold: 1,
        confirmedCount: 4,
        occupied: true,
        lastChangeAt: 0,
        updatedAt: 0,
      },
    ]
    w.hydrate(rows)
    // Post-restart the zone is STILL occupied -> no re-fire.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 4 }), 100 * SEC)).toEqual([])
    expect(w.observe(DEVICE, snapshot({ frameTotal: 6 }), 200 * SEC)).toEqual([])
  })

  it('(d) a genuine post-hydrate edge (level flips) still fires', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 15 }])
    w.hydrate([
      {
        key: occupancyKey(DEVICE, undefined, undefined, 1),
        deviceId: DEVICE,
        threshold: 1,
        confirmedCount: 4,
        occupied: true,
        lastChangeAt: 0,
        updatedAt: 0,
      },
    ])
    // The camera empties AFTER restart -> became-free must fire.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 100 * SEC)).toEqual([]) // pending
    const freed = w.observe(DEVICE, snapshot({ frameTotal: 0 }), 120 * SEC)
    expect(freed).toHaveLength(1)
    expect(freed[0]?.occupied).toBe(false)
    expect(freed[0]?.previousCount).toBe(4)
  })

  it('snapshotState round-trips through hydrate', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: 'gate', threshold: 2, sustainSeconds: 0 }])
    w.observe(DEVICE, snapshot({ zones: [{ zoneId: 'gate', zoneName: 'Gate', total: 3 }] }), 0)
    const state = w.snapshotState()
    expect(state).toHaveLength(1)
    expect(state[0]).toMatchObject({
      key: occupancyKey(DEVICE, 'gate', undefined, 2),
      deviceId: DEVICE,
      zoneId: 'gate',
      threshold: 2,
      confirmedCount: 3,
      occupied: true,
    })

    const w2 = new OccupancyWatcher()
    w2.setWatchedKeys([{ zoneId: 'gate', threshold: 2, sustainSeconds: 0 }])
    w2.hydrate(state)
    // Same level -> no re-fire after reseed.
    expect(
      w2.observe(
        DEVICE,
        snapshot({ zones: [{ zoneId: 'gate', zoneName: 'Gate', total: 3 }] }),
        50 * SEC,
      ),
    ).toEqual([])
  })
})

describe('OccupancyWatcher — key scoping (frame vs zone vs class)', () => {
  it('(e) a frame-total key counts snapshot.frame.totalObjects', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 2, sustainSeconds: 0 }])
    w.observe(
      DEVICE,
      snapshot({ frameTotal: 0, zones: [{ zoneId: 'z', zoneName: 'Z', total: 0 }] }),
      0,
    )
    const edges = w.observe(
      DEVICE,
      snapshot({ frameTotal: 2, zones: [{ zoneId: 'z', zoneName: 'Z', total: 0 }] }),
      0,
    )
    expect(edges).toHaveLength(1)
    expect(edges[0]?.count).toBe(2)
    expect(edges[0]?.zoneId).toBeUndefined()
  })

  it('(e) a per-zone class key reads zones[].byClass[className] + carries zoneName', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: 'drive', className: 'car', threshold: 1, sustainSeconds: 0 }])
    const snap = snapshot({
      frameTotal: 9,
      frameByClass: { car: 9 },
      zones: [{ zoneId: 'drive', zoneName: 'Driveway', total: 3, byClass: { car: 2, person: 1 } }],
    })
    // Seed with the zone PRESENT but empty of cars — a zone absent from the
    // snapshot is fail-closed and would create no key at all.
    w.observe(
      DEVICE,
      snapshot({ zones: [{ zoneId: 'drive', zoneName: 'Driveway', total: 0, byClass: {} }] }),
      0,
    )
    const edges = w.observe(DEVICE, snap, 0)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      deviceId: DEVICE,
      zoneId: 'drive',
      zoneName: 'Driveway',
      className: 'car',
      count: 2, // zone car count, NOT frame total (9) nor zone total (3)
      occupied: true,
    })
  })

  it('a frame class key reads snapshot.frame.byClass[className]', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ className: 'person', threshold: 1, sustainSeconds: 0 }])
    w.observe(DEVICE, snapshot({ frameTotal: 3, frameByClass: { car: 3 } }), 0) // seed: no person
    const edges = w.observe(
      DEVICE,
      snapshot({ frameTotal: 5, frameByClass: { person: 2, car: 3 } }),
      0,
    )
    expect(edges).toHaveLength(1)
    expect(edges[0]?.count).toBe(2)
    expect(edges[0]?.className).toBe('person')
  })

  it('a class absent from byClass counts as zero (no emit)', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ className: 'bicycle', threshold: 1, sustainSeconds: 0 }])
    expect(w.observe(DEVICE, snapshot({ frameTotal: 5, frameByClass: { person: 5 } }), 0)).toEqual(
      [],
    )
  })
})

describe('OccupancyWatcher — fail-closed on missing substrate (constraint 3)', () => {
  it('(f) a zoneId absent from the snapshot tracks no key (no emit)', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: 'ghost', threshold: 1, sustainSeconds: 0 }])
    // Snapshot has a different zone only.
    expect(
      w.observe(
        DEVICE,
        snapshot({ frameTotal: 8, zones: [{ zoneId: 'real', zoneName: 'Real', total: 8 }] }),
        0,
      ),
    ).toEqual([])
    // ...and never emits, even sustained.
    expect(
      w.observe(
        DEVICE,
        snapshot({ frameTotal: 8, zones: [{ zoneId: 'real', zoneName: 'Real', total: 8 }] }),
        60 * SEC,
      ),
    ).toEqual([])
    // Fail-closed also means it holds no state for the ghost zone.
    expect(w.snapshotState()).toEqual([])
  })

  it('a re-appearing zone SEEDS from what it re-appears holding, and does not fire', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ zoneId: 'gate', threshold: 1, sustainSeconds: 0 }])
    // Zone missing -> no key, no state (fail-closed).
    expect(w.observe(DEVICE, snapshot({}), 0)).toEqual([])
    expect(w.snapshotState()).toEqual([])
    // The zone re-appears already occupied. Nothing OBSERVED it become
    // occupied — the watcher was blind to that zone — so this is a first
    // observation and it seeds. Announcing an arrival here would be inventing
    // a transition out of a gap in the substrate.
    expect(
      w.observe(DEVICE, snapshot({ zones: [{ zoneId: 'gate', zoneName: 'Gate', total: 2 }] }), SEC),
    ).toEqual([])
    expect(w.snapshotState()[0]).toMatchObject({ confirmedCount: 2, occupied: true })

    // A real transition from that seeded level still fires.
    const freed = w.observe(
      DEVICE,
      snapshot({ zones: [{ zoneId: 'gate', zoneName: 'Gate', total: 0 }] }),
      2 * SEC,
    )
    expect(freed).toHaveLength(1)
    expect(freed[0]).toMatchObject({ occupied: false, count: 0, previousCount: 2 })
  })
})

describe('OccupancyWatcher — per-threshold keying + multi-device', () => {
  it('two rules (≥1 and ≥3) on one key BOTH fire at their own crossings on a gradual accumulation (no lossy rebound)', () => {
    const w = new OccupancyWatcher()
    // Two rules on the same frame/class key with DIFFERENT thresholds. Under the
    // old min-threshold merge the key collapsed to ≥1 and the ≥3 rule NEVER got
    // an edge when the count rose within the already-occupied band (0→1→3). With
    // per-threshold keying each threshold owns its own false→true edge.
    w.setWatchedKeys([
      { threshold: 1, sustainSeconds: 0 },
      { threshold: 3, sustainSeconds: 0 },
    ])
    // Seed both keys from an empty frame.
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0)).toEqual([])
    // 0 → 1: only the ≥1 key crosses.
    const at1 = w.observe(DEVICE, snapshot({ frameTotal: 1 }), 0)
    expect(at1).toHaveLength(1)
    expect(at1[0]).toMatchObject({ threshold: 1, count: 1, previousCount: 0, occupied: true })
    // 1 → 3: the ≥1 key is already occupied (edge-only, no re-fire); the ≥3 key
    // now crosses from its OWN cold baseline.
    const at3 = w.observe(DEVICE, snapshot({ frameTotal: 3 }), SEC)
    expect(at3).toHaveLength(1)
    expect(at3[0]).toMatchObject({ threshold: 3, count: 3, previousCount: 0, occupied: true })
  })

  it('merges specs that share the SAME (zone, class, threshold) to the max sustain', () => {
    const w = new OccupancyWatcher()
    // Two rules, same threshold (2), different sustain (5 & 20) -> ONE key, MAX
    // sustain (20s).
    w.setWatchedKeys([
      { threshold: 2, sustainSeconds: 5 },
      { threshold: 2, sustainSeconds: 20 },
    ])
    expect(w.observe(DEVICE, snapshot({ frameTotal: 0 }), 0)).toEqual([]) // seed: empty
    expect(w.observe(DEVICE, snapshot({ frameTotal: 2 }), 0)).toEqual([])
    expect(w.observe(DEVICE, snapshot({ frameTotal: 2 }), 10 * SEC)).toEqual([]) // < 20s
    const edges = w.observe(DEVICE, snapshot({ frameTotal: 2 }), 20 * SEC)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ threshold: 2, count: 2 })
    // Exactly one confirmed state entry for the shared key.
    expect(w.snapshotState()).toHaveLength(1)
  })

  it('drops confirmed state for a key that is no longer watched (bounded RAM + prunable durable set)', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 0 }])
    w.observe(DEVICE, snapshot({ frameTotal: 2 }), 0)
    expect(w.snapshotState()).toHaveLength(1)
    // Re-watch a DIFFERENT threshold: the old t1 state is stale and dropped.
    w.setWatchedKeys([{ threshold: 5, sustainSeconds: 0 }])
    expect(w.snapshotState()).toEqual([])
  })

  it('keeps per-device state independent for the same key spec', () => {
    const w = new OccupancyWatcher()
    w.setWatchedKeys([{ threshold: 1, sustainSeconds: 0 }])
    w.observe(1, snapshot({ frameTotal: 0 }), 0) // seed device 1
    w.observe(2, snapshot({ frameTotal: 0 }), 0) // seed device 2
    const a = w.observe(1, snapshot({ frameTotal: 1 }), 0)
    const b = w.observe(2, snapshot({ frameTotal: 1 }), 0)
    expect(a).toHaveLength(1)
    expect(a[0]?.deviceId).toBe(1)
    expect(b).toHaveLength(1)
    expect(b[0]?.deviceId).toBe(2)
    expect(w.snapshotState()).toHaveLength(2)
  })
})
