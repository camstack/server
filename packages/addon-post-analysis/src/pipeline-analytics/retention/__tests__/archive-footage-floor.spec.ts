/**
 * D674 — the follow-recordings floor comes from the ARCHIVE's ledger, one call
 * for every camera, and an unreadable answer is never "no footage".
 *
 * The fake api carries BOTH surfaces the floor could be asked of. Its
 * `recording.getAvailability` throws on any window wider than a day: the old
 * `earliestFootageMs` asked `[0, now)` per camera every ten minutes, and the
 * recorder walked and cached every hour since 1970 to answer it (11.9 M Map
 * keys, the OOM of 2026-09-28).
 */
import type { IScopedLogger, RecordingStorageUsage } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { sweepTracklessRoots } from '../trackless-root-sweep.js'
import {
  ArchiveFootageFloors,
  FOOTAGE_FLOOR_RETRY_MS,
  UNREADABLE_FLOOR_CUTOFFS,
} from '../archive-footage-floor.js'
import { FOLLOW_FLOOR_DAYS, type RetentionSettings } from '../../retention-policy.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 28, 10, 21)
const FOLLOW: RetentionSettings = { retentionMode: 'follow-recordings', trackRetentionDays: 7 }
const CUSTOM: RetentionSettings = { retentionMode: 'custom', trackRetentionDays: 3 }

interface Line {
  readonly level: 'warn' | 'info'
  readonly message: string
  readonly extras: unknown
}

function recordingLogger(lines: Line[]): IScopedLogger {
  const logger = {
    debug: () => {},
    error: () => {},
    info: (message: string, extras?: unknown) => lines.push({ level: 'info', message, extras }),
    warn: (message: string, extras?: unknown) => lines.push({ level: 'warn', message, extras }),
    child: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function usage(devices: RecordingStorageUsage['devices']): RecordingStorageUsage {
  return { nodeId: 'hub', totalUsedBytes: 0, devices, devicesRead: 'archive', complete: true }
}

interface Harness {
  readonly floors: ArchiveFootageFloors
  readonly storageUsage: ReturnType<typeof vi.fn>
  readonly availability: ReturnType<typeof vi.fn>
  readonly lines: Line[]
  readonly setNow: (ms: number) => void
}

function harness(answer: () => Promise<RecordingStorageUsage>): Harness {
  const lines: Line[] = []
  let now = NOW
  const storageUsage = vi.fn(answer)
  const availability = vi.fn(async (input: { fromMs: number; toMs: number }) => {
    if (input.toMs - input.fromMs > DAY) {
      throw new Error(`walked ${String((input.toMs - input.fromMs) / 3_600_000)} hours`)
    }
    return { read: 'read', ranges: [], profilesWithFootage: [] }
  })
  const api = {
    recording: { getAvailability: { query: availability } },
    recordingArchive: { getStorageUsage: { query: storageUsage } },
  }
  const floors = new ArchiveFootageFloors({
    api,
    logger: recordingLogger(lines),
    now: () => now,
  })
  return { floors, storageUsage, availability, lines, setNow: (ms) => (now = ms) }
}

describe('D674 — the follow floor is the archive ledger, never an availability walk', () => {
  it('reads oldestMs from getStorageUsage and makes no availability call', async () => {
    const oldest = NOW - 20 * DAY
    const h = harness(async () => usage([{ deviceId: 104, usedBytes: 1, oldestMs: oldest }]))
    const cutoffs = await h.floors.cutoffsFor(104, FOLLOW, NOW)
    expect(cutoffs).toEqual({ cutoffMs: oldest, effectiveMode: 'follow-recordings' })
    expect(h.availability).not.toHaveBeenCalled()
  })

  it('keeps the FOLLOW_FLOOR_DAYS floor: footage younger than it never shortens tracks', async () => {
    const h = harness(async () => usage([{ deviceId: 104, usedBytes: 1, oldestMs: NOW - 2 * DAY }]))
    expect((await h.floors.cutoffsFor(104, FOLLOW, NOW)).cutoffMs).toBe(
      NOW - FOLLOW_FLOOR_DAYS * DAY,
    )
  })

  it('asks the archive ONCE for every camera in a pass', async () => {
    const h = harness(async () =>
      usage([
        { deviceId: 104, usedBytes: 1, oldestMs: NOW - 10 * DAY },
        { deviceId: 101, usedBytes: 1, oldestMs: NOW - 11 * DAY },
        { deviceId: 102, usedBytes: 1, oldestMs: NOW - 12 * DAY },
      ]),
    )
    await Promise.all([104, 101, 102].map((d) => h.floors.cutoffsFor(d, FOLLOW, NOW)))
    await h.floors.cutoffsFor(104, FOLLOW, NOW)
    expect(h.storageUsage).toHaveBeenCalledTimes(1)
  })

  it('a camera the archive holds no footage for falls back to the custom window', async () => {
    const h = harness(async () => usage([{ deviceId: 101, usedBytes: 0, oldestMs: null }]))
    expect(await h.floors.cutoffsFor(104, FOLLOW, NOW)).toEqual({
      cutoffMs: NOW - 7 * DAY,
      effectiveMode: 'custom',
    })
    expect(await h.floors.cutoffsFor(101, FOLLOW, NOW)).toEqual({
      cutoffMs: NOW - 7 * DAY,
      effectiveMode: 'custom',
    })
  })

  it('a custom camera never asks the archive', async () => {
    const h = harness(async () => usage([]))
    expect(await h.floors.cutoffsFor(104, CUSTOM, NOW)).toEqual({
      cutoffMs: NOW - 3 * DAY,
      effectiveMode: 'custom',
    })
    expect(h.storageUsage).not.toHaveBeenCalled()
  })
})

describe('D674 — an unreadable floor skips the camera, logged, never 0 / "no footage"', () => {
  it('a failed read turns retention OFF for the pass instead of the custom window', async () => {
    const h = harness(async () => {
      throw new Error('recorder unreachable')
    })
    const cutoffs = await h.floors.cutoffsFor(104, FOLLOW, NOW)
    // Before D674 this was the custom window: `now - 7 d` on a camera whose
    // archive reaches back further — a delete taken on a failed read.
    expect(cutoffs).toEqual(UNREADABLE_FLOOR_CUTOFFS)
    expect(cutoffs.cutoffMs).toBeNull()
    const skip = h.lines.find((l) => l.message.includes('this camera is not swept'))
    expect(skip).toMatchObject({ level: 'warn', extras: { tags: { deviceId: 104 } } })
    expect(h.lines.some((l) => l.message.includes('archive floor could not be read'))).toBe(true)
  })

  it('says so once per episode, not once per pass', async () => {
    const h = harness(async () => {
      throw new Error('recorder unreachable')
    })
    await h.floors.cutoffsFor(104, FOLLOW, NOW)
    await h.floors.cutoffsFor(104, FOLLOW, NOW)
    expect(h.lines.filter((l) => l.message.includes('this camera is not swept'))).toHaveLength(1)
  })

  it('an answer whose rows are not the archive is unreadable', async () => {
    for (const devicesRead of ['unavailable', undefined] as const) {
      const h = harness(async () => ({
        nodeId: 'hub',
        totalUsedBytes: 0,
        devices: [{ deviceId: 104, usedBytes: 1, oldestMs: NOW - 30 * DAY }],
        ...(devicesRead !== undefined ? { devicesRead } : {}),
      }))
      expect(await h.floors.cutoffsFor(104, FOLLOW, NOW)).toEqual(UNREADABLE_FLOOR_CUTOFFS)
    }
  })

  it('a row with no oldestMs field (an older recorder) is unreadable for that camera only', async () => {
    const h = harness(async () =>
      usage([
        { deviceId: 104, usedBytes: 1 },
        { deviceId: 101, usedBytes: 1, oldestMs: NOW - 30 * DAY },
      ]),
    )
    expect(await h.floors.cutoffsFor(104, FOLLOW, NOW)).toEqual(UNREADABLE_FLOOR_CUTOFFS)
    expect((await h.floors.cutoffsFor(101, FOLLOW, NOW)).cutoffMs).toBe(NOW - 30 * DAY)
  })

  it('retries a failed read after the retry window, and logs the recovery', async () => {
    let fail = true
    const h = harness(async () => {
      if (fail) throw new Error('recorder unreachable')
      return usage([{ deviceId: 104, usedBytes: 1, oldestMs: NOW - 30 * DAY }])
    })
    await h.floors.cutoffsFor(104, FOLLOW, NOW)
    fail = false
    h.setNow(NOW + FOOTAGE_FLOOR_RETRY_MS)
    expect((await h.floors.cutoffsFor(104, FOLLOW, NOW)).cutoffMs).toBe(NOW - 30 * DAY)
    expect(h.lines.some((l) => l.level === 'info' && l.message.includes('readable again'))).toBe(
      true,
    )
  })
})

describe('D674 review M2 — only a COMPLETE archive answer may say "no footage"', () => {
  it('an incomplete answer is unreadable for EVERY camera — absent and present alike', async () => {
    const h = harness(async () => ({
      ...usage([{ deviceId: 101, usedBytes: 1, oldestMs: NOW - 2 * DAY }]),
      complete: false,
    }))
    // Absent: may hold footage past the row cap.
    expect(await h.floors.cutoffsFor(104, FOLLOW, NOW)).toEqual(UNREADABLE_FLOOR_CUTOFFS)
    // Present: its oldestMs is the oldest of the NEWEST rows — too young.
    expect(await h.floors.cutoffsFor(101, FOLLOW, NOW)).toEqual(UNREADABLE_FLOOR_CUTOFFS)
    expect(h.lines.filter((l) => l.message.includes('this camera is not swept'))).toHaveLength(2)
  })

  it('an answer without the field (a recorder predating D674) is not complete', async () => {
    const { complete: _dropped, ...legacy } = usage([
      { deviceId: 101, usedBytes: 1, oldestMs: NOW - 30 * DAY },
    ])
    const h = harness(async () => legacy)
    expect(await h.floors.cutoffsFor(104, FOLLOW, NOW)).toEqual(UNREADABLE_FLOOR_CUTOFFS)
  })

  it('says the read failure once per EPISODE, and its end once', async () => {
    let fail = true
    const h = harness(async () => {
      if (fail) throw new Error('recorder unreachable')
      return usage([])
    })
    for (let i = 0; i < 3; i++) {
      h.setNow(NOW + i * FOOTAGE_FLOOR_RETRY_MS)
      await h.floors.cutoffsFor(104, FOLLOW, NOW)
    }
    expect(
      h.lines.filter((l) => l.message.includes('archive floor could not be read')),
    ).toHaveLength(1)
    fail = false
    h.setNow(NOW + 3 * FOOTAGE_FLOOR_RETRY_MS)
    await h.floors.cutoffsFor(104, FOLLOW, NOW)
    expect(h.lines.filter((l) => l.message.includes('floor is readable again'))).toHaveLength(1)
  })
})

describe("D674 review M1 — an unreadable floor is not the operator's keep-forever", () => {
  it('the trackless sweep skips the device WITHOUT reporting "retention OFF"', async () => {
    const disabled: number[] = []
    const evicted: number[] = []
    await sweepTracklessRoots({
      deviceIds: [104, 101],
      nowMs: NOW,
      resolveCutoffs: async (deviceId) =>
        deviceId === 104
          ? UNREADABLE_FLOOR_CUTOFFS
          : { cutoffMs: null, effectiveMode: 'custom' as const },
      evictTracklessEvents: async ({ deviceId }) => {
        evicted.push(deviceId)
        return { motion: [], audio: [] }
      },
      evictSensorEvents: null,
      onEvicted: () => {},
      onRetentionDisabled: (deviceId) => disabled.push(deviceId),
      onError: (_d, err) => {
        throw err
      },
      shouldStop: () => false,
    })
    // 101 is the operator's trackRetentionDays = 0; 104 only could not be read.
    expect(disabled).toEqual([101])
    expect(evicted).toEqual([])
  })
})
