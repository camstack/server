/**
 * D871 — one ops-log row per retention pass, per-device counts in the payload.
 */
import { describe, expect, it } from 'vitest'
import { RetentionSweepSummary, type SweepSummaryDetail } from '../sweep-summary.js'

describe('RetentionSweepSummary', () => {
  it('folds both halves of the pass and every device into ONE cluster-level row', () => {
    const summary = new RetentionSweepSummary()
    summary.add(101, { tracks: 3, media: 9 })
    summary.add(101, { motion: 40, audio: 5 })
    summary.add(102, { audio: 12 })
    summary.addBytes(2048)

    const row = summary.build()

    expect(row).toMatchObject({
      op: 'prune',
      reason: 'retention',
      deviceId: null,
      itemsAffected: 3 + 9 + 40 + 5 + 12,
      bytesReclaimed: 2048,
    })
    const detail: SweepSummaryDetail = JSON.parse(row?.detail ?? '{}')
    expect(detail).toEqual({
      sweep: 'retention',
      devices: {
        '101': { tracks: 3, media: 9, motion: 40, audio: 5 },
        '102': { audio: 12 },
      },
    })
  })

  it('writes nothing when the pass removed nothing', () => {
    const summary = new RetentionSweepSummary()
    summary.add(101, { tracks: 0 })

    expect(summary.build()).toBeNull()
  })

  it('36 devices over 288 ticks make 288 rows, not 10 368', () => {
    let rows = 0
    for (let tick = 0; tick < 288; tick += 1) {
      const summary = new RetentionSweepSummary()
      for (let device = 1; device <= 36; device += 1) summary.add(device, { audio: 1 })
      if (summary.build() !== null) rows += 1
    }
    expect(rows).toBe(288)
  })
})
