/**
 * Entry expiry counts WATCHED time, not the span between frame timestamps.
 *
 * A session-dispatch (on-motion) camera produces no frames between motion
 * sessions. The sweep used to compare the latest frame timestamp with the last
 * confirmation, so a silent gap was counted in full the moment the next
 * session's first frame arrived: a car parked 3.3 h, last confirmed at the end
 * of a session, was retired seconds into the next one (`unconfirmedForMs`
 * 316 052 against a 300 000 TTL) because a passing vehicle elsewhere let the
 * detector prove itself. The suppression was lost and the car became new again.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { createNoopLogger } from '../../../../embedding-encoder/shared/noop-logger.js'
import { StationaryObjectRegistry } from '../stationary-registry.js'
import { WATCHED_GAP_CAP_MS, type StationaryEntry } from '../stationary-types.js'
import { watchFrames } from './watch-frames.js'

const DEV = 101
const T0 = 1_789_000_000_000
const TTL = 300_000
const SILENCE = 5 * 60_000 + 20_000

function parked(over: Partial<StationaryEntry> = {}): StationaryEntry {
  return {
    id: 'car',
    deviceId: DEV,
    className: 'vehicle',
    bbox: { x: 3048, y: 356, w: 452, h: 420 },
    frameWidth: 3840,
    frameHeight: 2160,
    firstSeenAt: T0 - 3 * 3_600_000,
    becameStationaryAt: T0 - 3 * 3_600_000,
    lastConfirmedAt: over.lastConfirmedAt ?? T0,
  }
}

function passingVehicle(reg: StationaryObjectRegistry, at: number): void {
  reg.filter({
    deviceId: DEV,
    detections: [{ bbox: { x: 10, y: 10, w: 100, h: 100 }, className: 'vehicle' }],
    frameWidth: 3840,
    frameHeight: 2160,
    timestamp: at,
  })
}

describe('entry expiry counts watched time', () => {
  let world: FakeRecords
  let reg: StationaryObjectRegistry
  let reasons: string[]

  const build = (records = world.records): StationaryObjectRegistry =>
    new StationaryObjectRegistry({
      records,
      logger: {
        ...createNoopLogger(),
        info: (msg, extras) => {
          if (msg === 'stationary entry retired') reasons.push(String(extras?.meta?.['reason']))
        },
      },
      entryTtlMs: TTL,
    })

  beforeEach(() => {
    world = makeAnalyticsRecordsNow()
    reasons = []
    reg = build()
  })

  it('does NOT retire after a silent gap between sessions, then retires after ttl of watching', async () => {
    await reg.promote(parked())
    watchFrames(reg, DEV, T0 - 20_000, T0, 1_000) // session 1 ends
    const s2 = T0 + SILENCE
    passingVehicle(reg, s2 + 2_000)
    watchFrames(reg, DEV, s2, s2 + 5_000, 1_000) // session 2 opens, other vehicle
    await reg.sweep(s2 + 5_000)
    expect(reg.count(DEV)).toBe(1)

    // Continuous watching without a match: only now does it age out.
    watchFrames(reg, DEV, s2 + 5_000, s2 + TTL + 6_000, 1_000)
    await reg.sweep(s2 + TTL + 6_000)
    expect(reg.count(DEV)).toBe(0)
    expect(reasons).toEqual(['ttl'])
  })

  it('an always-on camera still retires after ttl of continuous frames', async () => {
    await reg.promote(parked())
    passingVehicle(reg, T0 + 1_000)
    watchFrames(reg, DEV, T0, T0 + TTL - 1_000, 2_000)
    await reg.sweep(T0 + TTL)
    expect(reg.count(DEV)).toBe(1)
    watchFrames(reg, DEV, T0 + TTL - 1_000, T0 + TTL + 2_000, 1_000)
    await reg.sweep(T0 + TTL + 2_000)
    expect(reg.count(DEV)).toBe(0)
  })

  it('a slow cadence (1 frame per 5 s) accumulates in full', async () => {
    await reg.promote(parked())
    passingVehicle(reg, T0 + 1_000)
    watchFrames(reg, DEV, T0, T0 + TTL - 5_000, 5_000)
    await reg.sweep(T0 + TTL)
    expect(reg.count(DEV)).toBe(1)
    watchFrames(reg, DEV, T0 + TTL - 5_000, T0 + TTL + 5_000, 5_000)
    await reg.sweep(T0 + TTL + 5_000)
    expect(reg.count(DEV)).toBe(0)
  })

  it('a gap longer than the cap counts as the cap, not its length', async () => {
    await reg.promote(parked())
    passingVehicle(reg, T0 + 1_000)
    reg.noteFrame(DEV, T0)
    reg.noteFrame(DEV, T0 + TTL * 2) // one frame after a huge silence
    await reg.sweep(T0 + TTL * 2)
    expect(reg.count(DEV)).toBe(1)
    expect(WATCHED_GAP_CAP_MS).toBeLessThan(TTL)
  })

  it('a hydrated entry starts at zero watched time, whatever its wall timestamps', async () => {
    await reg.promote(parked())
    const reg2 = build()
    await reg2.load()
    expect(reg2.count(DEV)).toBe(1)
    const later = T0 + 3 * 3_600_000 // restarted hours after the last confirmation
    passingVehicle(reg2, later + 2_000)
    watchFrames(reg2, DEV, later, later + 10_000, 1_000)
    await reg2.sweep(later + 10_000)
    expect(reg2.count(DEV)).toBe(1)
    watchFrames(reg2, DEV, later + 10_000, later + TTL + 12_000, 1_000)
    await reg2.sweep(later + TTL + 12_000)
    expect(reg2.count(DEV)).toBe(0)
  })
})
