/**
 * A TTL retirement needs the detector to have PROVED ITSELF.
 *
 * Being overdue is a clock, not evidence. `lastFrameAtByDevice` advances on
 * every processed frame, so an entry aged out on frames-flowing time alone —
 * and six minutes in which the detector produced no vehicle at all counted
 * exactly like six minutes in which it produced plenty and none of them was
 * this car. The first says nothing about the object; the second says it left.
 *
 * Measured on device 102: a motorcycle parked for 29 HOURS was retired by TTL
 * after 6.2 minutes of observed time without a confirmation, while it was
 * still physically there — a debug-flagged track two hours later sat on its
 * exact spot with a median centroid displacement of 0.0 px. Losing the entry
 * loses the suppression, so the object became new again, span a 35-second
 * track with 295 observations and its events, then died before the 120 s the
 * evidence ledger needs to re-promote it. Six retirements in two hours on that
 * one camera, each one a fresh flood of events.
 */
import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { watchFrames } from './watch-frames.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import type { StationaryEntry } from '../stationary-types.js'

const DEV = 102
const T0 = 1_789_000_000_000
const TTL = 300_000

function entry(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: over.id ?? 'bike',
    deviceId: DEV,
    className: 'vehicle',
    bbox: { x: 3048, y: 356, w: 452, h: 420 },
    frameWidth: 3840,
    frameHeight: 2160,
    firstSeenAt: T0,
    becameStationaryAt: T0,
    lastConfirmedAt: over.lastConfirmedAt ?? T0,
  }
}

/** One frame carrying a same-class detection somewhere ELSE in the view — the
 *  detector visibly working, and this object not there. */
function frameWithAPassingVehicle(reg: StationaryObjectRegistry, at: number): void {
  reg.filter({
    deviceId: DEV,
    detections: [{ bbox: { x: 10, y: 10, w: 100, h: 100 }, className: 'vehicle' }],
    frameWidth: 3840,
    frameHeight: 2160,
    timestamp: at,
  })
}

describe('a TTL retirement needs evidence, not just a clock', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    reg = new StationaryObjectRegistry({
      records: world.records,
      logger: createNoopLogger(),
      entryTtlMs: TTL,
    })
  })

  // The 102 case.
  it('HOLDS an overdue entry while the detector has produced nothing of its class', async () => {
    await reg.promote(entry())
    // Frames flowed for well past the TTL — but the detector produced nothing.
    reg.noteFrame(DEV, T0 + TTL * 2)
    await reg.sweep(T0 + TTL * 2)
    expect(reg.count(DEV)).toBe(1)
  })

  it('RETIRES it once the detector visibly works and the object is still not there', async () => {
    await reg.promote(entry())
    // A different vehicle crosses the view: the detector is provably fine.
    frameWithAPassingVehicle(reg, T0 + TTL + 1_000)
    watchFrames(reg, DEV, T0, T0 + TTL * 2)
    await reg.sweep(T0 + TTL * 2)
    expect(reg.count(DEV)).toBe(0)
  })

  // Without a backstop an object that vanished while its whole class stopped
  // being detected would be immortal: the strike path needs a departing READ to
  // arm, which never comes if nothing is detected at all.
  it('retires anyway at the backstop, so a held entry cannot become immortal', async () => {
    await reg.promote(entry())
    watchFrames(reg, DEV, T0, T0 + TTL * 13, 5_000)
    await reg.sweep(T0 + TTL * 13)
    expect(reg.count(DEV)).toBe(0)
  })

  it('a detection of ANOTHER class is not evidence about this one', async () => {
    await reg.promote(entry())
    reg.filter({
      deviceId: DEV,
      detections: [{ bbox: { x: 10, y: 10, w: 80, h: 200 }, className: 'person' }],
      frameWidth: 3840,
      frameHeight: 2160,
      timestamp: T0 + TTL + 1_000,
    })
    reg.noteFrame(DEV, T0 + TTL * 2)
    await reg.sweep(T0 + TTL * 2)
    expect(reg.count(DEV)).toBe(1)
  })

  // Evidence older than the last confirmation says nothing: the object was
  // still being confirmed after it.
  it('ignores class sightings that predate the entry’s last confirmation', async () => {
    await reg.promote(entry({ lastConfirmedAt: T0 + 100_000 }))
    frameWithAPassingVehicle(reg, T0 + 50_000)
    reg.noteFrame(DEV, T0 + 100_000 + TTL * 2)
    await reg.sweep(T0 + 100_000 + TTL * 2)
    expect(reg.count(DEV)).toBe(1)
  })
})
