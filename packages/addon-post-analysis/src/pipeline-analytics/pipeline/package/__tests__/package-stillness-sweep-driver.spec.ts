/**
 * The frame-free sweep driver (F4): every device holding a candidate is
 * swept on the analytics' existing 5 s TTL tick — no timer per frame, no
 * timer per device — with THAT device's activity gate, and each outcome is
 * bridged exactly as a frame's would be.
 */
import { describe, expect, it } from 'vitest'
import { PACKAGE_STILLNESS_TTL_MS, PackageStillnessTracker } from '../package-stillness-tracker.js'
import { sweepPackageStillness } from '../package-stillness-sweep.js'

const DOORMAT = { x: 104.5, y: 164.4, w: 271, h: 78 }
const START = 10_000_000

function delivered(tracker: PackageStillnessTracker, deviceId: number, lookedAfter: boolean): void {
  const base = {
    deviceId,
    frameWidth: 640,
    frameHeight: 360,
    minDwellMs: 0,
    activityWindowMs: 300_000,
    lastActivityAt: START,
    rawPackageBoxes: [],
  }
  const parcel = [{ className: 'package', bbox: DOORMAT }]
  tracker.observe({ ...base, sightings: parcel, timestamp: START, looked: true })
  tracker.observe({ ...base, sightings: parcel, timestamp: START + 400, looked: true })
  tracker.observe({ ...base, sightings: parcel, timestamp: START + 800, looked: true })
  if (lookedAfter) {
    for (const at of [START + 15_000, START + 20_000]) {
      tracker.observe({
        ...base,
        sightings: [],
        timestamp: at,
        looked: true,
        lastActivityAt: START + 13_000,
      })
    }
  }
}

describe('sweepPackageStillness', () => {
  it('bridges an attested pick-up without a frame, per device, with that device gate', () => {
    let n = 0
    const tracker = new PackageStillnessTracker({ newId: () => `c-${(n += 1)}` })
    delivered(tracker, 101, true)
    delivered(tracker, 102, false)
    const bridged: Array<{ deviceId: number; departed: number; at: number }> = []
    const now = START + 800 + PACKAGE_STILLNESS_TTL_MS + 1
    sweepPackageStillness({
      tracker,
      now,
      activityWindowMsFor: () => 300_000,
      lastActivityAtFor: (deviceId) => (deviceId === 101 ? START + 13_000 : START),
      onOutcome: (deviceId, outcome, at) => {
        bridged.push({ deviceId, departed: outcome.departed.length, at })
      },
      onDeviceError: () => {},
    })
    // 101 was looked for and not found: concluded. 102 was never looked for
    // since its last sighting: nothing to bridge, left for its next frame.
    expect(bridged).toEqual([{ deviceId: 101, departed: 1, at: now }])
    expect(tracker.debugCandidateCount(102)).toBe(1)
  })

  it('visits nothing and bridges nothing when no device holds a candidate', () => {
    const tracker = new PackageStillnessTracker({ newId: () => 'x' })
    let calls = 0
    sweepPackageStillness({
      tracker,
      now: START,
      activityWindowMsFor: () => {
        calls += 1
        return 0
      },
      lastActivityAtFor: () => undefined,
      onOutcome: () => {
        calls += 1
      },
      onDeviceError: () => {
        calls += 1
      },
    })
    expect(calls).toBe(0)
  })

  it('a device whose sweep throws is reported, and the next device still runs (M3)', () => {
    let n = 0
    const tracker = new PackageStillnessTracker({ newId: () => `c-${(n += 1)}` })
    delivered(tracker, 101, true)
    delivered(tracker, 102, true)
    const errors: number[] = []
    const bridged: number[] = []
    sweepPackageStillness({
      tracker,
      now: START + 800 + PACKAGE_STILLNESS_TTL_MS + 1,
      activityWindowMsFor: (deviceId) => {
        if (deviceId === 101) throw new Error('settings exploded')
        return 300_000
      },
      lastActivityAtFor: () => START + 13_000,
      onOutcome: (deviceId) => {
        bridged.push(deviceId)
      },
      onDeviceError: (deviceId) => {
        errors.push(deviceId)
      },
    })
    expect(errors).toEqual([101])
    expect(bridged).toEqual([102])
  })
})
