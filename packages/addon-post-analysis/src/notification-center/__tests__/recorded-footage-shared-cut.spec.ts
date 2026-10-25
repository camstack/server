/**
 * The recorded-footage wait is bounded in AGGREGATE, not only per row (D686
 * fix round, review H2/L3).
 *
 * The outbox drains rows one at a time. With a per-row 30 s wait alone, a rule
 * with N targets cut the same moment N times, a retry cut it again, and a
 * wedged recorder cost 30 s for EVERY recorded row queued behind the first.
 *
 * - one cut (and one gif derive) per moment, shared by every target row of the
 *   record and by its retries;
 * - after a cut times out, the recorder is BUSY for {@link
 *   NC_RECORDER_BUSY_MS}: recorded rows ship still-only at once, by name.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  NC_RECORDED_FOOTAGE_WAIT_MS,
  NC_RECORDER_BUSY_MS,
  NcDispatcher,
  type NcSendInput,
} from '../dispatcher.js'
import { NC_RECORDED_CUT_MEMO_TTL_MS } from '../recorded-cut-memo.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRecordedClipRequest, NcRecordedClipResult } from '../recorded-clip.js'
import type { NcRecordedGifRequest } from '../recorded-gif.js'

const DEVICE = 101
const SEC = 1_000
const CONCLUDED = 1_790_000_000_000
const PICKUP_AT = CONCLUDED - 300 * SEC

interface Line {
  readonly msg: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown>
}

function pickup(recordId: string, targetId: string): NcOutboxEntry {
  const payload: NcOutboxPayload = {
    ruleName: 'Consegna pacco (front door)',
    delivery: 'package-event',
    priority: 3,
    media: 'best-matching',
    mediaGif: true,
    subject: {
      deviceId: DEVICE,
      className: 'package',
      zones: [],
      timestamp: CONCLUDED,
      observedAt: PICKUP_AT,
      packagePhase: 'picked-up',
    },
  }
  return {
    id: `rule-pkg:${recordId}:${targetId}`,
    ruleId: 'rule-pkg',
    targetId,
    deviceId: DEVICE,
    recordKind: 'package-event',
    recordId,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: CONCLUDED,
    updatedAt: CONCLUDED,
    payload,
  }
}

function bytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n))
  out.fill(7)
  return out
}

function harness(opts: {
  readonly recorded: (req: NcRecordedClipRequest) => Promise<NcRecordedClipResult>
}) {
  const clock = { now: CONCLUDED + 7 * SEC }
  const sends: NcSendInput[] = []
  const cuts: NcRecordedClipRequest[] = []
  const derives: NcRecordedGifRequest[] = []
  const lines: Line[] = []
  const record = (
    msg: string,
    ctx?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
  ): void => {
    lines.push({ msg, deviceId: ctx?.tags?.['deviceId'], meta: ctx?.meta ?? {} })
  }
  const logger: IScopedLogger = { ...makeSilentLogger(), info: record, warn: record }
  const dispatcher = new NcDispatcher({
    logger,
    listTargets: async () => [
      { id: 'phone-a', addonId: 'notifiers', name: 'A', kind: 'zentik', enabled: true },
      { id: 'phone-b', addonId: 'notifiers', name: 'B', kind: 'zentik', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => null,
    ringRetentionSecFor: () => 20,
    renderEventMedia: async () => ({ gif: null, mp4: null }),
    cutRecordedClip: async (req) => {
      cuts.push(req)
      return opts.recorded(req)
    },
    deriveGifFromClip: async (req) => {
      derives.push(req)
      return { ok: true, gif: bytes(4) }
    },
    now: () => clock.now,
  })
  return { dispatcher, clock, sends, cuts, derives, lines }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('one cut per moment', () => {
  it('two targets of one record share ONE cut and ONE derive, and both carry the gif', async () => {
    const h = harness({ recorded: async () => ({ ok: true, mp4: bytes(3), profile: 'low' }) })
    await h.dispatcher.deliver(pickup('292786', 'phone-a'))
    await h.dispatcher.deliver(pickup('292786', 'phone-b'))
    expect(h.cuts).toHaveLength(1)
    expect(h.derives).toHaveLength(1)
    expect(h.sends.map((s) => s.notification.attachments?.map((a) => a.mediaType))).toEqual([
      ['gif'],
      ['gif'],
    ])
  })

  it('a retry of the same row reuses the cut instead of ordering another', async () => {
    const h = harness({ recorded: async () => ({ ok: true, mp4: bytes(3), profile: 'low' }) })
    await h.dispatcher.deliver(pickup('292786', 'phone-a'))
    h.clock.now += 20 * SEC
    await h.dispatcher.deliver(pickup('292786', 'phone-a'))
    expect(h.cuts).toHaveLength(1)
  })

  it('two DIFFERENT records get two cuts', async () => {
    const h = harness({ recorded: async () => ({ ok: true, mp4: bytes(3), profile: 'low' }) })
    await h.dispatcher.deliver(pickup('292786', 'phone-a'))
    await h.dispatcher.deliver(pickup('292790', 'phone-a'))
    expect(h.cuts).toHaveLength(2)
  })
})

describe('the recorder-busy breaker', () => {
  it('after a timed-out cut, the next recorded row ships still-only AT ONCE, by name', async () => {
    vi.useFakeTimers()
    const h = harness({ recorded: () => new Promise<NcRecordedClipResult>(() => {}) })
    const first = h.dispatcher.deliver(pickup('292786', 'phone-a'))
    await vi.advanceTimersByTimeAsync(NC_RECORDED_FOOTAGE_WAIT_MS)
    await first
    h.clock.now += NC_RECORDED_FOOTAGE_WAIT_MS
    // A different moment, well inside the busy window: it must not wait.
    const second = await h.dispatcher.deliver(pickup('292790', 'phone-a'))
    expect(second.ok).toBe(true)
    expect(h.cuts).toHaveLength(1)
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]?.notification.attachments ?? []).toHaveLength(0)
    const busy = h.lines.find((l) => l.msg === 'recorded footage: none — the recorder is busy')
    expect(busy?.meta['reason']).toBe('recorder-busy')
    expect(busy?.deviceId).toBe(DEVICE)
  })

  it('closes after its window: the next row orders a cut again', async () => {
    vi.useFakeTimers()
    let wedged = true
    const h = harness({
      recorded: () =>
        wedged
          ? new Promise<NcRecordedClipResult>(() => {})
          : Promise.resolve({ ok: true, mp4: bytes(3), profile: 'low' }),
    })
    const first = h.dispatcher.deliver(pickup('292786', 'phone-a'))
    await vi.advanceTimersByTimeAsync(NC_RECORDED_FOOTAGE_WAIT_MS)
    await first
    wedged = false
    h.clock.now += NC_RECORDED_FOOTAGE_WAIT_MS + NC_RECORDER_BUSY_MS
    await h.dispatcher.deliver(pickup('292790', 'phone-a'))
    expect(h.cuts).toHaveLength(2)
    expect(h.sends[1]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['gif'])
  })

  it('is sized at about a minute', () => {
    expect(NC_RECORDER_BUSY_MS).toBe(60_000)
  })
})

describe('a row that joins a cut already in flight (re-review R1)', () => {
  it('consults the breaker: inside the busy window it ships at once, by name', async () => {
    vi.useFakeTimers()
    const h = harness({ recorded: () => new Promise<NcRecordedClipResult>(() => {}) })
    const first = h.dispatcher.deliver(pickup('292786', 'phone-a'))
    await vi.advanceTimersByTimeAsync(NC_RECORDED_FOOTAGE_WAIT_MS)
    await first
    h.clock.now += NC_RECORDED_FOOTAGE_WAIT_MS
    // The SAME record's second target: the cut is held, still in flight.
    await h.dispatcher.deliver(pickup('292786', 'phone-b'))
    expect(h.cuts).toHaveLength(1)
    expect(h.sends).toHaveLength(2)
    const busy = h.lines.filter((l) => l.msg === 'recorded footage: none — the recorder is busy')
    expect(busy).toHaveLength(1)
  })

  it('waits only what the cut has left — a spent deadline is timed-out at once', async () => {
    vi.useFakeTimers()
    const h = harness({ recorded: () => new Promise<NcRecordedClipResult>(() => {}) })
    const first = h.dispatcher.deliver(pickup('292786', 'phone-a'))
    await vi.advanceTimersByTimeAsync(NC_RECORDED_FOOTAGE_WAIT_MS)
    await first
    // Past the breaker, but the hung cut is still held and still pending.
    h.clock.now += NC_RECORDED_FOOTAGE_WAIT_MS + NC_RECORDER_BUSY_MS + SEC
    await h.dispatcher.deliver(pickup('292786', 'phone-b'))
    expect(h.cuts).toHaveLength(1)
    expect(h.sends).toHaveLength(2)
    const spent = h.lines.filter(
      (l) => l.msg === 'recorded footage: none — not ready inside the bound',
    )
    expect(spent).toHaveLength(2)
  })
})

describe('shared bytes are copied per row (re-review R3)', () => {
  it("a consumer that mutates one row's gif does not corrupt the next row's", async () => {
    const h = harness({ recorded: async () => ({ ok: true, mp4: bytes(3), profile: 'low' }) })
    await h.dispatcher.deliver(pickup('292786', 'phone-a'))
    h.sends[0]?.notification.attachments?.[0]?.bytes?.fill(0)
    await h.dispatcher.deliver(pickup('292786', 'phone-b'))
    expect([...(h.sends[1]?.notification.attachments?.[0]?.bytes ?? [])]).toEqual([7, 7, 7, 7])
  })
})

describe('shared VIDEO bytes are copied per row too (re-review R3)', () => {
  it("a consumer that mutates one row's mp4 does not corrupt the next row's", async () => {
    const h = harness({ recorded: async () => ({ ok: true, mp4: bytes(3), profile: 'low' }) })
    const clip = (targetId: string): NcOutboxEntry => {
      const base = pickup('292786', targetId)
      return { ...base, payload: { ...base.payload, mediaGif: false, mediaClip: true } }
    }
    await h.dispatcher.deliver(clip('phone-a'))
    h.sends[0]?.notification.attachments?.[0]?.bytes?.fill(0)
    await h.dispatcher.deliver(clip('phone-b'))
    expect([...(h.sends[1]?.notification.attachments?.[0]?.bytes ?? [])]).toEqual([7, 7, 7])
  })
})

describe('held cuts are evicted on the periodic path (re-review R4)', () => {
  it('sweepRecordedCuts drops a cut past its TTL without waiting for a next row', async () => {
    const h = harness({ recorded: async () => ({ ok: true, mp4: bytes(3), profile: 'low' }) })
    await h.dispatcher.deliver(pickup('292786', 'phone-a'))
    expect(h.dispatcher.recordedCutsHeld()).toBe(1)
    h.dispatcher.sweepRecordedCuts(h.clock.now + NC_RECORDED_CUT_MEMO_TTL_MS + 1)
    expect(h.dispatcher.recordedCutsHeld()).toBe(0)
  })
})
