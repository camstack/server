/**
 * D871 — motion and audio events leave on EXACTLY the window and in the same
 * pass as tracks, for every device that holds them.
 *
 * The sweep already used the device's one window; what it did not do was visit
 * every device that HOLDS events. Its scope was "cameras today" plus "devices
 * with a track", so a deleted camera that never persisted a track, or a
 * microphone / sensor that is no camera, kept its audio and motion rows for
 * good (36 k audio and 70 k motion rows older than the oldest track on the live
 * hub). This drives the shipped chain — scope → window → sweep — over an
 * in-memory event table and asserts the property the operator asked for: after
 * a pass NO audio or motion row is older than its device's track window.
 */
import { describe, expect, it } from 'vitest'
import { resolveRetentionCutoffs, resolveRetentionSettings } from '../../retention-policy.js'
import { memoEventDeviceIds, retentionScopeDeviceIds } from '../retention-scope.js'
import { sweepTracklessRoots } from '../trackless-root-sweep.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 400 * DAY

interface EventRow {
  readonly deviceId: number
  readonly kind: 'motion' | 'audio'
  readonly timestamp: number
}

/** 1 = tracked camera, 2 = deleted camera with events and NO track, 3 = a microphone. */
const CAMERA = 1
const DELETED_NO_TRACK = 2
const MICROPHONE = 3
const KEEP_FOREVER = 4

function table(): { rows: EventRow[] } {
  const rows: EventRow[] = []
  for (const deviceId of [CAMERA, DELETED_NO_TRACK, MICROPHONE, KEEP_FOREVER]) {
    for (const days of [1, 3, 20, 40]) {
      rows.push({ deviceId, kind: 'motion', timestamp: NOW - days * DAY })
      rows.push({ deviceId, kind: 'audio', timestamp: NOW - days * DAY })
    }
  }
  return { rows }
}

const BLOBS: Record<number, Record<string, unknown>> = {
  [CAMERA]: { retentionMode: 'custom', trackRetentionDays: 7 },
  [DELETED_NO_TRACK]: {},
  [MICROPHONE]: { retentionMode: 'custom', trackRetentionDays: 7 },
  [KEEP_FOREVER]: { retentionMode: 'custom', trackRetentionDays: 0 },
}

function windowMs(deviceId: number): number | null {
  const settings = resolveRetentionSettings(BLOBS[deviceId] ?? {})
  return resolveRetentionCutoffs(settings, NOW, null).cutoffMs
}

async function pass(data: { rows: EventRow[] }, scope: { eventDevices: boolean }): Promise<void> {
  const deviceIds = await retentionScopeDeviceIds(
    {
      listAll: async () => [{ id: CAMERA }],
      listTrackedDeviceIds: async () => [CAMERA],
      ...(scope.eventDevices
        ? { listEventDeviceIds: async () => [...new Set(data.rows.map((r) => r.deviceId))] }
        : {}),
    },
    () => undefined,
  )
  await sweepTracklessRoots({
    deviceIds,
    nowMs: NOW,
    resolveCutoffs: async (deviceId, nowMs) =>
      resolveRetentionCutoffs(resolveRetentionSettings(BLOBS[deviceId] ?? {}), nowMs, null),
    evictTracklessEvents: async ({ deviceId, cutoffMs }) => {
      const doomed = data.rows.filter((r) => r.deviceId === deviceId && r.timestamp <= cutoffMs)
      data.rows = data.rows.filter((r) => !doomed.includes(r))
      return {
        motion: doomed.filter((r) => r.kind === 'motion').map((r) => String(r.timestamp)),
        audio: doomed.filter((r) => r.kind === 'audio').map((r) => String(r.timestamp)),
      }
    },
    evictSensorEvents: null,
    onRetentionDisabled: () => undefined,
    onEvicted: () => undefined,
    onError: (_deviceId, err) => {
      throw err
    },
    shouldStop: () => false,
  })
}

function staleRows(rows: readonly EventRow[]): readonly EventRow[] {
  return rows.filter((r) => {
    const cutoff = windowMs(r.deviceId)
    return cutoff !== null && r.timestamp <= cutoff
  })
}

describe('motion and audio events follow the track window (D871)', () => {
  it('after a pass no audio or motion row is older than its device window', async () => {
    const data = table()
    expect(staleRows(data.rows).length).toBeGreaterThan(0)

    await pass(data, { eventDevices: true })

    expect(staleRows(data.rows)).toEqual([])
    // A device whose retention is off keeps everything: same rule as its tracks.
    expect(data.rows.filter((r) => r.deviceId === KEEP_FOREVER)).toHaveLength(8)
    // And rows inside the window are untouched.
    expect(
      data.rows.filter((r) => r.deviceId === DELETED_NO_TRACK && r.kind === 'audio'),
    ).toHaveLength(2)
  })

  it('WITHOUT the event-holding devices in scope, an untracked non-camera keeps its stale rows (the defect)', async () => {
    const data = table()

    await pass(data, { eventDevices: false })

    const stale = staleRows(data.rows)
    expect(stale.map((r) => r.deviceId).sort()).toContain(DELETED_NO_TRACK)
    expect(stale.map((r) => r.deviceId)).toContain(MICROPHONE)
    // The tracked camera was always swept.
    expect(stale.some((r) => r.deviceId === CAMERA)).toBe(false)
  })
})

describe('memoEventDeviceIds', () => {
  it('reads once per window, refreshes after it, and a failed refresh keeps the last answer', async () => {
    let reads = 0
    let fail = false
    let now = 0
    const memo = memoEventDeviceIds(
      async () => {
        reads += 1
        if (fail) throw new Error('histogram timed out')
        return [reads]
      },
      () => now,
      1000,
    )

    expect(await memo()).toEqual([1])
    now = 500
    expect(await memo()).toEqual([1])
    expect(reads).toBe(1)

    now = 1500
    fail = true
    expect(await memo()).toEqual([1])
    expect(reads).toBe(2)

    fail = false
    now = 3000
    expect(await memo()).toEqual([3])
  })

  it('throws when the first read fails — the scope then sweeps on the other halves', async () => {
    const memo = memoEventDeviceIds(async () => {
      throw new Error('down')
    })
    const seen: string[] = []
    const ids = await retentionScopeDeviceIds(
      {
        listAll: async () => [{ id: 1 }],
        listTrackedDeviceIds: async () => [2],
        listEventDeviceIds: memo,
      },
      (half) => seen.push(half),
    )
    expect(ids).toEqual([1, 2])
    expect(seen).toEqual(['events'])
  })
})
