/**
 * Periodic track retention sweeper (design §6) — pure helper unit tests.
 *
 * `sweepTrackRetention` iterates the device set, skips devices whose resolver
 * answers null (keep forever), and prunes the rest at the resolved cutoff.
 *
 * The settings half of this file is gone (D62). `resolveTrackRetentionDays` and
 * `trackRetentionCutoff` were a SECOND parser and a second cutoff arithmetic
 * for `trackRetentionDays`, with no production caller — the sweep is handed a
 * resolved cutoff. Their tests passed for months while the code they described
 * ran nowhere. That parsing lives in `retention-policy.ts` and is tested in
 * `retention-policy.spec.ts`, once.
 */

import type { TrackCascadeCounts } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sweepTrackRetention } from '../track-retention-sweep.js'

const NO_COUNTS: TrackCascadeCounts = {
  tracks: 0,
  events: 0,
  media: 0,
  faces: 0,
  plates: 0,
  embeddings: 0,
}

describe('sweepTrackRetention', () => {
  it('prunes each device at now−retention, skipping retention-disabled devices', async () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const day = 24 * 60 * 60 * 1000
    const pruned: Array<{ deviceId: number; cutoffMs: number }> = []
    const retentionByDevice = new Map<number, number>([
      [1, 7],
      [2, 0], // keep forever → skipped
      [3, 30],
    ])

    const total = await sweepTrackRetention({
      listDeviceIds: async () => [1, 2, 3],
      resolveCutoffMs: async (deviceId, nowMs) => {
        const days = retentionByDevice.get(deviceId) ?? 7
        return days <= 0 ? null : nowMs - days * day
      },
      pruneTracksBefore: async (deviceId, cutoffMs) => {
        pruned.push({ deviceId, cutoffMs })
        return { ...NO_COUNTS, tracks: 2 }
      },
      now: () => now,
    })

    expect(pruned).toEqual([
      { deviceId: 1, cutoffMs: now - 7 * day },
      { deviceId: 3, cutoffMs: now - 30 * day },
    ])
    // 2 devices pruned × 2 tracks each.
    expect(total).toBe(4)
  })

  it('isolates a per-device prune failure', async () => {
    const errors: number[] = []
    const total = await sweepTrackRetention({
      listDeviceIds: async () => [1, 2],
      resolveCutoffMs: async (_deviceId, nowMs) => nowMs - 7 * 24 * 60 * 60 * 1000,
      pruneTracksBefore: async (deviceId) => {
        if (deviceId === 1) throw new Error('boom')
        return { ...NO_COUNTS, tracks: 3 }
      },
      now: () => Date.now(),
      onError: (deviceId) => errors.push(deviceId),
    })

    expect(errors).toEqual([1])
    expect(total).toBe(3)
  })
})
