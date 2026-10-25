/**
 * **The test that matters for D62: an operator-visible retention value has
 * exactly ONE consumer, and changing it changes WHAT IS DELETED.**
 *
 * It asserts on the sweep, not on the stored value. A settings test that reads
 * back what it wrote is exactly the shape of assurance that let
 * `retentionObjectDays` sit in the form for weeks deciding nothing: the value
 * round-tripped perfectly, and the sweep had stopped reading it.
 *
 * So this drives the SHIPPED chain — `resolveRetentionSettings` →
 * `resolveRetentionCutoffs` → `sweepTrackRetention` / `sweepTracklessRoots` —
 * over a recording fake, changes ONE operator value at a time, and asserts the
 * set of deleted rows moves. Both surviving keys get that treatment, and both
 * halves of the sweep (the cascading track root and the three terminal roots)
 * are asserted to move TOGETHER — that is what "one window" means.
 */
import { describe, expect, it } from 'vitest'
import {
  type DeviceRetentionCutoffs,
  resolveRetentionCutoffs,
  resolveRetentionSettings,
} from '../../retention-policy.js'
import { sweepTrackRetention } from '../../track-retention-sweep.js'
import { sweepTracklessRoots } from '../trackless-root-sweep.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 400 * DAY
const DEVICE = 101

/** Ages, in days, of the rows every fixture starts with. */
const AGES_DAYS = [1, 5, 20, 40] as const

interface SweepOutcome {
  readonly tracks: readonly number[]
  readonly motion: readonly number[]
  readonly audio: readonly number[]
  readonly sensor: readonly number[]
  readonly disabled: readonly number[]
}

/**
 * Run BOTH halves of the retention pass for one device against a raw settings
 * blob, and report which ages were deleted. `earliestFootageMs` mirrors what
 * the recorder would answer.
 */
async function runSweep(
  raw: Record<string, unknown>,
  earliestFootageMs: number | null,
): Promise<SweepOutcome> {
  const settings = resolveRetentionSettings(raw)
  const resolve = async (_deviceId: number, nowMs: number): Promise<DeviceRetentionCutoffs> =>
    resolveRetentionCutoffs(settings, nowMs, earliestFootageMs)

  const olderThan = (cutoffMs: number): number[] =>
    AGES_DAYS.filter((d) => NOW - d * DAY < cutoffMs).map((d) => d)

  const tracks: number[] = []
  const motion: number[] = []
  const audio: number[] = []
  const sensor: number[] = []
  const disabled: number[] = []

  await sweepTrackRetention({
    listDeviceIds: async () => [DEVICE],
    resolveCutoffMs: async (deviceId, nowMs) => (await resolve(deviceId, nowMs)).cutoffMs,
    pruneTracksBefore: async (_deviceId, cutoffMs) => {
      tracks.push(...olderThan(cutoffMs))
      return { tracks: tracks.length, events: 0, media: 0, faces: 0, plates: 0, embeddings: 0 }
    },
    now: () => NOW,
  })

  await sweepTracklessRoots({
    deviceIds: [DEVICE],
    nowMs: NOW,
    resolveCutoffs: resolve,
    evictTracklessEvents: async ({ cutoffMs }) => {
      const ids = olderThan(cutoffMs).map(String)
      motion.push(...olderThan(cutoffMs))
      audio.push(...olderThan(cutoffMs))
      return { motion: ids, audio: ids }
    },
    evictSensorEvents: async (_deviceId, cutoffMs) => {
      const hit = olderThan(cutoffMs)
      sensor.push(...hit)
      return hit.length
    },
    onRetentionDisabled: (deviceId) => disabled.push(deviceId),
    onEvicted: () => {},
    onError: (_deviceId, err) => {
      throw err
    },
    shouldStop: () => false,
  })

  return { tracks, motion, audio, sensor, disabled }
}

describe('trackRetentionDays — one value, and it moves every deletion', () => {
  it('30 days keeps everything younger than 30', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 30 }, null)
    expect(out.tracks).toEqual([40])
    expect(out.motion).toEqual([40])
    expect(out.audio).toEqual([40])
    expect(out.sensor).toEqual([40])
  })

  it('CHANGING it to 10 deletes the 20-day rows — all four families move together', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 10 }, null)
    expect(out.tracks).toEqual([20, 40])
    expect(out.motion).toEqual([20, 40])
    expect(out.audio).toEqual([20, 40])
    expect(out.sensor).toEqual([20, 40])
  })

  it('CHANGING it to 3 takes the 5-day rows too', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 3 }, null)
    expect(out.tracks).toEqual([5, 20, 40])
    expect(out.motion).toEqual([5, 20, 40])
    expect(out.sensor).toEqual([5, 20, 40])
  })
})

describe('retentionMode — the other operator value, and it moves them too', () => {
  it('follow-recordings takes the footage horizon, NOT the custom window', async () => {
    // 15 days of footage on disk, custom window says 3. Follow mode wins.
    const out = await runSweep(
      { retentionMode: 'follow-recordings', trackRetentionDays: 3 },
      NOW - 15 * DAY,
    )
    expect(out.tracks).toEqual([20, 40])
    expect(out.motion).toEqual([20, 40])
    expect(out.sensor).toEqual([20, 40])
  })

  it('CHANGING the mode to custom, same blob, deletes more', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 3 }, NOW - 15 * DAY)
    expect(out.tracks).toEqual([5, 20, 40])
    expect(out.motion).toEqual([5, 20, 40])
    expect(out.sensor).toEqual([5, 20, 40])
  })

  it('follow with no footage falls back to the window — never unbounded', async () => {
    const out = await runSweep({ retentionMode: 'follow-recordings', trackRetentionDays: 10 }, null)
    expect(out.tracks).toEqual([20, 40])
    expect(out.motion).toEqual([20, 40])
  })
})

describe('retention OFF is one decision, and it is never silent', () => {
  it('0 days stops the track sweep AND the terminal roots — one window means one', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 0 }, null)
    expect(out.tracks).toEqual([])
    expect(out.motion).toEqual([])
    expect(out.audio).toEqual([])
    expect(out.sensor).toEqual([])
  })

  it('and it SAYS SO — a device that ages out nothing is reported, not skipped quietly', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 0 }, null)
    expect(out.disabled).toEqual([DEVICE])
  })

  it('a device with a live window reports nothing disabled', async () => {
    const out = await runSweep({ retentionMode: 'custom', trackRetentionDays: 10 }, null)
    expect(out.disabled).toEqual([])
  })
})

describe('the retired knobs cannot resurrect a second clock', () => {
  it('a stored retentionObjectDays:365 does NOT keep object events past the window', async () => {
    // The exact operator scenario D62 exists for: the value is still in the
    // blob, and it decides nothing. Object events ride the track cascade, so
    // the track deletion set is the assertion.
    const out = await runSweep(
      { retentionMode: 'custom', trackRetentionDays: 10, retentionObjectDays: 365 },
      null,
    )
    expect(out.tracks).toEqual([20, 40])
  })

  it('a stored retentionMotionDays:365 does NOT keep motion past the window', async () => {
    const out = await runSweep(
      { retentionMode: 'custom', trackRetentionDays: 10, retentionMotionDays: 365 },
      null,
    )
    expect(out.motion).toEqual([20, 40])
  })

  it('a stored retentionAudioDays:1 does NOT delete audio before the window', async () => {
    const out = await runSweep(
      { retentionMode: 'custom', trackRetentionDays: 30, retentionAudioDays: 1 },
      null,
    )
    expect(out.audio).toEqual([40])
  })
})
