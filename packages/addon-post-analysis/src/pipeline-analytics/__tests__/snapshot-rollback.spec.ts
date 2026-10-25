/**
 * The periodic snapshot gets its interval back when the capture does not land.
 *
 * Before 2026-08-07 `markSnapshotPending` advanced the gate unconditionally and
 * its own docblock admitted the consequence — "if the write later fails the slot
 * is simply lost". A failed capture spent an interval it never used, and
 * `snapshot` was the only media kind with no retry of any shape. 197 snapshots
 * per 3 h died there on the live hub.
 *
 * The cases below drive the TrackStore directly (the gate reference and its
 * budget live with `lastSnapshotAt`, not in a side map) and then the real
 * `evaluatePeriodicSnapshot`, so a rollback that restored the clock but not the
 * movement bbox — or vice versa — still fails.
 */
import { describe, it, expect } from 'vitest'
import { TrackStore } from '../store/track-store.js'
import { evaluatePeriodicSnapshot } from '../snapshot-movement-gate.js'
import { SNAPSHOT_MAX_ROLLBACKS } from '../pipeline/snapshot-retry.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

const DEVICE_ID = 101
const INTERVAL_MS = 5_000

function store(): TrackStore {
  const fake = makeFakeSettingsStore()
  return new TrackStore({
    store: fake.client,
    logger: makeSilentLogger(),
    config: { maxPositionHistory: 300 },
  })
}

function seedTrack(s: TrackStore, at: number): void {
  s.upsert({
    trackId: 't1',
    deviceId: DEVICE_ID,
    className: 'person',
    timestamp: at,
    position: { x: 10, y: 10, timestamp: at, bbox: { x: 0, y: 0, w: 20, h: 40 } },
    zones: [],
    state: 'moving',
  })
}

/** The real gate, asked whether a snapshot is due right now. */
function dueNow(
  s: TrackStore,
  now: number,
  bbox: { x: number; y: number; w: number; h: number },
): boolean {
  return evaluatePeriodicSnapshot({
    lastSnapshotAt: s.lastSnapshotAt('t1'),
    lastSnapshotBbox: s.lastSnapshotBbox('t1'),
    currentBbox: bbox,
    now,
    frameWidth: 640,
    frameHeight: 360,
    intervalMs: INTERVAL_MS,
    movementThreshold: 0.03,
    maxIdleMs: 30_000,
  }).capture
}

describe('snapshot gate rollback', () => {
  it('gives the interval back when the capture never landed — the next frame is due again', () => {
    const s = store()
    seedTrack(s, 1_000)
    s.seedSnapshotClock('t1', 1_000, { x: 0, y: 0, w: 20, h: 40 })

    const movedBox = { x: 300, y: 200, w: 20, h: 40 }
    expect(dueNow(s, 6_100, movedBox)).toBe(true)

    // The capture is DECIDED: the gate advances so the next few frames of the
    // same instant cannot fire a burst.
    s.markSnapshotPending('t1', 6_100, movedBox)
    expect(dueNow(s, 6_200, movedBox)).toBe(false)

    // ...and the write never lands.
    expect(s.rollbackSnapshotPending('t1', 6_100)).toBe(true)
    expect(dueNow(s, 6_200, movedBox)).toBe(true)
    // Both halves of the reference are restored — clock AND movement bbox.
    expect(s.lastSnapshotAt('t1')).toBe(1_000)
    expect(s.lastSnapshotBbox('t1')).toEqual({ x: 0, y: 0, w: 20, h: 40 })
  })

  it('refuses to roll back once a snapshot has actually landed on the slot', () => {
    const s = store()
    seedTrack(s, 1_000)
    s.markSnapshotPending('t1', 6_100, { x: 300, y: 200, w: 20, h: 40 })
    s.addSnapshot('t1', {
      timestamp: 6_100,
      position: { x: 310, y: 220, timestamp: 6_100, bbox: { x: 300, y: 200, w: 20, h: 40 } },
      mediaId: 5001,
    })

    expect(s.rollbackSnapshotPending('t1', 6_100)).toBe(false)
    expect(s.lastSnapshotAt('t1')).toBe(6_100)
  })

  it('refuses to roll back an attempt a NEWER pending mark has already superseded', () => {
    const s = store()
    seedTrack(s, 1_000)
    s.markSnapshotPending('t1', 6_100, { x: 300, y: 200, w: 20, h: 40 })
    s.markSnapshotPending('t1', 8_000, { x: 400, y: 200, w: 20, h: 40 })

    // A late settle for the FIRST attempt must not re-open a window the second
    // attempt legitimately closed.
    expect(s.rollbackSnapshotPending('t1', 6_100)).toBe(false)
    expect(s.lastSnapshotAt('t1')).toBe(8_000)
  })

  it('concedes the slot after a bounded run of non-landings — never an unbounded per-frame retry', () => {
    const s = store()
    seedTrack(s, 1_000)
    s.seedSnapshotClock('t1', 1_000, { x: 0, y: 0, w: 20, h: 40 })

    let at = 6_100
    for (let i = 0; i < SNAPSHOT_MAX_ROLLBACKS; i += 1) {
      s.markSnapshotPending('t1', at, { x: 300, y: 200, w: 20, h: 40 })
      expect(s.rollbackSnapshotPending('t1', at)).toBe(true)
      at += 100
    }
    s.markSnapshotPending('t1', at, { x: 300, y: 200, w: 20, h: 40 })
    expect(s.rollbackSnapshotPending('t1', at)).toBe(false)
    expect(s.lastSnapshotAt('t1')).toBe(at)
  })

  it('a landed snapshot resets the budget — the bound is on a RUN of failures, not on the track', () => {
    const s = store()
    seedTrack(s, 1_000)

    let at = 6_100
    for (let i = 0; i < SNAPSHOT_MAX_ROLLBACKS; i += 1) {
      s.markSnapshotPending('t1', at, { x: 300, y: 200, w: 20, h: 40 })
      s.rollbackSnapshotPending('t1', at)
      at += 100
    }
    s.markSnapshotPending('t1', at, { x: 300, y: 200, w: 20, h: 40 })
    s.addSnapshot('t1', {
      timestamp: at,
      position: { x: 310, y: 220, timestamp: at, bbox: { x: 300, y: 200, w: 20, h: 40 } },
      mediaId: 5001,
    })

    const next = at + 6_000
    s.markSnapshotPending('t1', next, { x: 320, y: 200, w: 20, h: 40 })
    expect(s.rollbackSnapshotPending('t1', next)).toBe(true)
  })

  it('is a no-op for an unknown / expired track', () => {
    const s = store()
    expect(s.rollbackSnapshotPending('ghost', 1)).toBe(false)
  })
})
