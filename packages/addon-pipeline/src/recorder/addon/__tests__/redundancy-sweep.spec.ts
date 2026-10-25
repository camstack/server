/**
 * There must be a duplicate pruner, and it must not read the archive.
 *
 * On 2026-08-27 the only pruner of duplicated footage (`runRedundancyJanitor`)
 * was deleted with the dead full-archive walk that was its sole caller — it was
 * UNREACHABLE, not wrong. From that commit until this one, nothing anywhere
 * removed a duplicate, while `SegmentWriter` was restarting 1 814 times per
 * 12 h and every restart re-wrote the broker's ~10 s pre-roll on top of media
 * already on disk.
 *
 * The second assertion is the one that keeps the reconnection honest: the pass
 * must ask for a WINDOW, never for a device's segments. The shape it replaced
 * copied and re-sorted every row a camera owned — ~560 MB of transient heap at
 * the live 7.1 M rows, which is the cost D248 had just removed. A test that
 * only checked "the duplicates went away" would pass either way, and this repo
 * has already shipped three defects that a result-equal assertion protected.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SegmentRow } from '../../types.js'
import { RedundancySweeper } from '../redundancy-sweep.js'

const NOW = 1_787_800_000_000
const HOUR_MS = 60 * 60_000

function makeLogger(): {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly debug: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

function row(startMs: number, durMs: number, name: string): SegmentRow {
  return {
    deviceId: 1441,
    profile: 'high',
    startMs,
    durMs,
    bytes: 1_000,
    path: `1441/high/${name}.m4s`,
    locationId: 'recordings',
  }
}

/**
 * The exact shape a restart leaves: ffmpeg dies mid-segment, respawns, and the
 * broker replays its pre-roll — so the new run re-writes a span the previous
 * run already wrote. The short re-write sits fully inside the long original.
 */
const ORIGINAL = row(NOW - 30 * 60_000, 20_000, 'original')
const PREROLL_DUP = row(NOW - 30 * 60_000 + 4_000, 6_000, 'preroll-dup')
const LATER = row(NOW - 10 * 60_000, 20_000, 'later')

describe('RedundancySweeper', () => {
  it('evicts the segment a restart re-wrote, and keeps everything that adds coverage', async () => {
    const evict = vi.fn(async () => 1_000)
    const logger = makeLogger()
    const sweeper = new RedundancySweeper({
      deviceIds: async () => [1441],
      segmentsInWindow: (_deviceId, profile) =>
        profile === 'high' ? [ORIGINAL, PREROLL_DUP, LATER] : [],
      evict,
      logger,
      intervalMs: HOUR_MS,
      lookbackMs: 2 * HOUR_MS,
      now: () => NOW,
    })

    const result = await sweeper.sweep()

    expect(evict).toHaveBeenCalledTimes(1)
    expect(evict).toHaveBeenCalledWith('recordings', [PREROLL_DUP])
    expect(result).toMatchObject({ files: 1, bytes: 1_000, devices: 1 })
    // Per-camera, always: a reclaim is asked "why 1441 and not 101".
    expect(logger.info).toHaveBeenCalledWith(
      'recorder: removed duplicated segments for device',
      expect.objectContaining({ tags: { deviceId: 1441 } }),
    )
  })

  it('asks for a WINDOW, never for the archive — the read is bounded by lookback', async () => {
    const seen: { deviceId: number; profile: string; fromMs: number; toMs: number }[] = []
    const sweeper = new RedundancySweeper({
      deviceIds: async () => [1441, 101],
      segmentsInWindow: (deviceId, profile, fromMs, toMs) => {
        seen.push({ deviceId, profile, fromMs, toMs })
        return []
      },
      evict: vi.fn(async () => 0),
      logger: makeLogger(),
      intervalMs: HOUR_MS,
      lookbackMs: 2 * HOUR_MS,
      now: () => NOW,
    })

    await sweeper.sweep()

    // THE assertion: every read is a bounded slice, not a device's history.
    expect(seen).not.toHaveLength(0)
    for (const read of seen) {
      expect(read.toMs).toBe(NOW)
      expect(read.fromMs).toBe(NOW - 2 * HOUR_MS)
    }
    expect(seen.map((r) => r.deviceId)).toContain(101)
  })

  it('an evict failure is reported per camera and never aborts the pass', async () => {
    const logger = makeLogger()
    const evict = vi.fn(async (locationId: string) => {
      if (locationId === 'recordings') throw new Error('storage.delete refused')
      return 500
    })
    const other: SegmentRow = { ...PREROLL_DUP, deviceId: 101, locationId: 'recordings-2' }
    const sweeper = new RedundancySweeper({
      deviceIds: async () => [1441, 101],
      segmentsInWindow: (deviceId, profile) => {
        if (profile !== 'high') return []
        return deviceId === 1441
          ? [ORIGINAL, PREROLL_DUP]
          : [{ ...ORIGINAL, deviceId: 101, locationId: 'recordings-2' }, other]
      },
      evict,
      logger,
      intervalMs: HOUR_MS,
      lookbackMs: 2 * HOUR_MS,
      now: () => NOW,
    })

    const result = await sweeper.sweep()

    expect(logger.warn).toHaveBeenCalledWith(
      'recorder: redundancy sweep could not evict duplicates',
      expect.objectContaining({ tags: { deviceId: 1441 } }),
    )
    // The second camera was still swept — a drop is per (device, location).
    expect(result).toMatchObject({ files: 1, bytes: 500, devices: 1 })
  })

  it('reports even when it found nothing — "ran and found zero" is not "no pruner"', async () => {
    const logger = makeLogger()
    const sweeper = new RedundancySweeper({
      deviceIds: async () => [1441],
      segmentsInWindow: () => [],
      evict: vi.fn(async () => 0),
      logger,
      intervalMs: HOUR_MS,
      lookbackMs: 2 * HOUR_MS,
      now: () => NOW,
    })

    await sweeper.sweep()

    expect(logger.info).toHaveBeenCalledWith(
      'recorder: redundancy sweep complete',
      expect.objectContaining({ meta: expect.objectContaining({ files: 0, devices: 0 }) }),
    )
  })

  it('a device-list failure aborts THIS pass and says so — it never deletes blind', async () => {
    const logger = makeLogger()
    const evict = vi.fn(async () => 0)
    const sweeper = new RedundancySweeper({
      deviceIds: async () => {
        throw new Error('settings store unavailable')
      },
      segmentsInWindow: () => [ORIGINAL, PREROLL_DUP],
      evict,
      logger,
      intervalMs: HOUR_MS,
      lookbackMs: 2 * HOUR_MS,
      now: () => NOW,
    })

    await expect(sweeper.sweep()).resolves.toMatchObject({ files: 0 })
    expect(evict).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      'recorder: redundancy sweep could not read the device list',
      expect.anything(),
    )
  })
})
