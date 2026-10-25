/**
 * Cutting a notification clip out of the recordings, and the three different
 * ways of not being able to.
 *
 * The point of the file is that `not-recorded`, `not-covered` and `cut-failed`
 * are three different pieces of news with three different fixes, and that each
 * one reaches the log with `tags: { deviceId }` — a missing clip is always
 * asked per-camera.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  cutRecordedClip,
  type NcRecordedClipPorts,
  type NcRecordedClipRequest,
  type NcRecordedExportOrder,
  type NcRecordedExportRecord,
  recordedClipWindow,
} from '../recorded-clip.js'

const DEVICE = 102
const NOW = 1_786_185_854_852
/** The moment the car actually left — eight minutes before anyone concluded it. */
const OBSERVED_AT = NOW - 8 * 60_000

interface Line {
  readonly level: 'info' | 'warn' | 'debug'
  readonly msg: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown>
}

function recorder(lines: Line[]): IScopedLogger {
  const push =
    (level: Line['level']) =>
    (msg: string, ctx?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      lines.push({
        level,
        msg,
        deviceId: ctx?.tags?.deviceId as number | undefined,
        meta: ctx?.meta ?? {},
      })
    }
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('warn'),
  } as unknown as IScopedLogger
}

const REQUEST: NcRecordedClipRequest = {
  deviceId: DEVICE,
  aroundMs: OBSERVED_AT,
  preRollSec: 4,
  postRollSec: 6,
  ruleId: 'rule-occ',
  recordId: 'occ-1',
  deadlineMs: NOW + 30_000,
}

function ready(id: string): NcRecordedExportRecord {
  return { id, state: 'ready', error: null }
}

function ports(
  lines: Line[],
  over: Partial<NcRecordedClipPorts> = {},
): NcRecordedClipPorts & { readonly orders: NcRecordedExportOrder[] } {
  const orders: NcRecordedExportOrder[] = []
  return {
    orders,
    logger: recorder(lines),
    now: () => NOW,
    sleep: async () => {},
    getAvailability: async () => ({
      ranges: [
        { profile: 'high', startMs: OBSERVED_AT - 3_600_000, endMs: NOW },
        { profile: 'low', startMs: OBSERVED_AT - 3_600_000, endMs: NOW },
      ],
      profilesWithFootage: ['high', 'low'],
    }),
    createExport: async (input) => {
      orders.push(input)
      return ready('exp-1')
    },
    getExport: async () => ready('exp-1'),
    readExportBytes: async () => ({ base64: Buffer.from([0, 1, 2, 3]).toString('base64') }),
    ...over,
  }
}

describe('recordedClipWindow', () => {
  it('spans the pre-roll and the post-roll around the anchored moment', () => {
    expect(recordedClipWindow(REQUEST)).toEqual({
      fromMs: OBSERVED_AT - 4_000,
      toMs: OBSERVED_AT + 6_000,
    })
  })
})

describe('cutRecordedClip — the happy path', () => {
  it('cuts the anchored window and picks the CHEAPEST band that covers it', async () => {
    const lines: Line[] = []
    const p = ports(lines)
    const result = await cutRecordedClip(p, REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.profile).toBe('low')
    expect(result.mp4.byteLength).toBe(4)
    // The order is the anchored window, not the conclusion's.
    expect(p.orders[0]?.fromMs).toBe(OBSERVED_AT - 4_000)
    expect(p.orders[0]?.toMs).toBe(OBSERVED_AT + 6_000)
    const landed = lines.find((l) => l.msg === 'recorded clip: cut from the recordings')
    expect(landed?.deviceId).toBe(DEVICE)
  })

  it('deletes the temporary export rather than leaving it for its maxLifeMs', async () => {
    const lines: Line[] = []
    const deleted: string[] = []
    const result = await cutRecordedClip(
      ports(lines, {
        deleteExport: async ({ exportId }) => {
          deleted.push(exportId)
        },
      }),
      REQUEST,
    )
    expect(result.ok).toBe(true)
    expect(deleted).toEqual(['exp-1'])
  })
})

describe('cutRecordedClip — three refusals, three names', () => {
  it('"this camera does not record" is NOT a fault: not-recorded, at info', async () => {
    const lines: Line[] = []
    const p = ports(lines, {
      getAvailability: async () => ({ ranges: [], profilesWithFootage: [] }),
      createExport: async () => {
        throw new Error('must not be reached — the cheap question comes first')
      },
    })
    const result = await cutRecordedClip(p, REQUEST)
    expect(result).toEqual({ ok: false, reason: 'not-recorded' })
    const line = lines.find((l) => l.msg.startsWith('recorded clip: this camera does not record'))
    expect(line?.level).toBe('info')
    expect(line?.deviceId).toBe(DEVICE)
    expect(line?.meta.reason).toBe('not-recorded')
  })

  it('"it records, but not that moment" is not-covered — the camera is fine', async () => {
    const lines: Line[] = []
    const p = ports(lines, {
      // Footage exists, just not eight minutes ago: a gap, a restart, or
      // retention that already walked past it.
      getAvailability: async () => ({
        ranges: [{ profile: 'high', startMs: NOW - 60_000, endMs: NOW }],
        profilesWithFootage: ['high'],
      }),
      createExport: async () => {
        throw new Error('must not be reached — nothing covers the window')
      },
    })
    const result = await cutRecordedClip(p, REQUEST)
    expect(result).toEqual({ ok: false, reason: 'not-covered' })
    const line = lines.find(
      (l) => l.msg === 'recorded clip: the recording does not cover that moment',
    )
    expect(line?.level).toBe('info')
    expect(line?.deviceId).toBe(DEVICE)
    expect(line?.meta.profiles).toEqual(['high'])
  })

  it('a render that FAILS is cut-failed, at warn, with the recorder’s own words', async () => {
    const lines: Line[] = []
    const p = ports(lines, {
      createExport: async () => ({ id: 'exp-9', state: 'queued', error: null }),
      getExport: async () => ({ id: 'exp-9', state: 'failed', error: 'ffmpeg exited 1' }),
    })
    const result = await cutRecordedClip(p, REQUEST)
    expect(result).toEqual({ ok: false, reason: 'cut-failed' })
    const line = lines.find((l) => l.msg === 'recorded clip: the render did not produce a file')
    expect(line?.level).toBe('warn')
    expect(line?.deviceId).toBe(DEVICE)
    expect(line?.meta.error).toBe('ffmpeg exited 1')
  })

  it('an availability read that THROWS is cut-failed, never "does not record"', async () => {
    // The distinction that matters: an unreadable answer is unknown, and
    // unknown must never be reported as "recording is off on this camera".
    const lines: Line[] = []
    const p = ports(lines, {
      getAvailability: async () => {
        throw new Error('recorder unreachable')
      },
    })
    expect(await cutRecordedClip(p, REQUEST)).toEqual({ ok: false, reason: 'cut-failed' })
    expect(lines.some((l) => l.msg.includes('does not record'))).toBe(false)
    const line = lines.find(
      (l) => l.msg === 'recorded clip: the recording availability read failed',
    )
    expect(line?.deviceId).toBe(DEVICE)
    expect(line?.meta.cause).toBe('availability-read')
  })

  it('an EMPTY file is cut-failed — an attachment that plays nothing is worse than none', async () => {
    const lines: Line[] = []
    const p = ports(lines, { readExportBytes: async () => ({ base64: '' }) })
    expect(await cutRecordedClip(p, REQUEST)).toEqual({ ok: false, reason: 'cut-failed' })
    const line = lines.find((l) => l.msg === 'recorded clip: the finished file was empty')
    expect(line?.deviceId).toBe(DEVICE)
  })

  it("a render that never finishes stops at the CALLER's deadline, and says timed-out", async () => {
    const lines: Line[] = []
    let clock = NOW
    const calls: string[] = []
    const p = ports(lines, {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
      },
      createExport: async () => ({ id: 'exp-7', state: 'rendering', error: null }),
      // Still rendering long past the caller's deadline; it would fail a
      // minute later — a cut that ignored the deadline says cut-failed there.
      getExport: async () =>
        clock < NOW + 60_000
          ? { id: 'exp-7', state: 'rendering', error: null }
          : { id: 'exp-7', state: 'failed', error: 'too late' },
      cancelExport: async ({ exportId }) => {
        calls.push(`cancel:${exportId}`)
      },
      deleteExport: async ({ exportId }) => {
        calls.push(`delete:${exportId}`)
      },
      pollMs: 1_000,
    })
    expect(await cutRecordedClip(p, { ...REQUEST, deadlineMs: NOW + 10_000 })).toEqual({
      ok: false,
      reason: 'timed-out',
    })
    // Nobody is waiting for the render any more: it is CANCELLED (killed or
    // unqueued on the recorder) before its row and file are deleted — a delete
    // alone left the engine rendering it for nobody (review H1).
    expect(clock).toBe(NOW + 10_000)
    expect(calls).toEqual(['cancel:exp-7', 'delete:exp-7'])
    const line = lines.find(
      (l) => l.msg === 'recorded clip: the render did not finish inside its bound',
    )
    expect(line?.level).toBe('warn')
    expect(line?.deviceId).toBe(DEVICE)
    expect(line?.meta.reason).toBe('timed-out')
  })

  it('a deadline already spent by the availability read queues no render at all', async () => {
    const lines: Line[] = []
    const p = ports(lines, { now: () => NOW + 30_000 })
    expect(await cutRecordedClip(p, REQUEST)).toEqual({ ok: false, reason: 'timed-out' })
    expect(p.orders).toHaveLength(0)
    const line = lines.find((l) => l.msg === 'recorded clip: the bound was spent before the render')
    expect(line?.deviceId).toBe(DEVICE)
  })
})
