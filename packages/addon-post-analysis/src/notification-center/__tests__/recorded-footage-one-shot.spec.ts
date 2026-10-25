/**
 * When the anchored moment is older than the clip ring, the footage comes from
 * the RECORDINGS — and it rides the ONE notification (D686).
 *
 * ## What these pin
 *
 * 1. A moment inside the ring is still cut from the ring. The recordings are
 *    not asked, because the footage is already warm.
 * 2. A moment OUTSIDE it (the 102 departure: eight minutes behind the car; a
 *    package pick-up concluded minutes after the parcel went) is cut from the
 *    recordings BEFORE the send, under a bound, and ships in the same message
 *    as the still. A notifier is one-shot: nothing is ever sent a second time
 *    for the same row to "complete" it — Zentik showed that as two messages.
 * 3. A cut that fails, or is not ready inside the bound, costs the footage and
 *    never the alert: ONE message with what there is, and the reason is named
 *    per camera.
 */

import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NC_RECORDED_FOOTAGE_WAIT_MS, NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRecordedClipRequest, NcRecordedClipResult } from '../recorded-clip.js'
import type { NcRecordedGifRequest, NcRecordedGifResult } from '../recorded-gif.js'

const DEVICE = 102
const SEC = 1_000
const CONCLUDED_AT = 1_786_185_854_852
/** The car left eight minutes before the recheck concluded it had. */
const OBSERVED_AT = CONCLUDED_AT - 8 * 60 * SEC

interface Line {
  readonly msg: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown>
}

function lineRecorder(lines: Line[]): IScopedLogger {
  const record = (
    msg: string,
    ctx?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
  ): void => {
    lines.push({ msg, deviceId: ctx?.tags?.['deviceId'], meta: ctx?.meta ?? {} })
  }
  return { ...makeSilentLogger(), info: record, warn: record }
}

function occupancyEntry(observedAt?: number): NcOutboxEntry {
  const payload: NcOutboxPayload = {
    ruleName: 'Posto libero',
    delivery: 'immediate',
    priority: 3,
    media: 'none',
    mediaClip: true,
    subject: {
      deviceId: DEVICE,
      className: 'car',
      zones: [],
      timestamp: CONCLUDED_AT,
      ...(observedAt !== undefined ? { observedAt } : {}),
      occupancy: {
        zone: 'zone-parking',
        count: 0,
        capacity: 1,
        occupied: false,
      },
    },
  }
  return {
    id: 'rule-occ:occ-1:tgt-1',
    ruleId: 'rule-occ',
    targetId: 'tgt-1',
    deviceId: DEVICE,
    recordKind: 'device-event',
    recordId: 'occ-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: CONCLUDED_AT,
    updatedAt: CONCLUDED_AT,
    payload,
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly ringCuts: number[]
  readonly recordedAsks: NcRecordedClipRequest[]
}

function makeDispatcher(opts: {
  readonly now: number
  readonly logger?: IScopedLogger
  readonly recorded?: (req: NcRecordedClipRequest) => Promise<NcRecordedClipResult>
}): Harness {
  const sends: NcSendInput[] = []
  const ringCuts: number[] = []
  const recordedAsks: NcRecordedClipRequest[] = []
  const recorded = opts.recorded
  const dispatcher = new NcDispatcher({
    logger: opts.logger ?? makeSilentLogger(),
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => null,
    renderEventMedia: async (req) => {
      ringCuts.push(req.aroundMs)
      return { gif: null, mp4: Uint8Array.from([9]) }
    },
    ...(recorded !== undefined
      ? {
          cutRecordedClip: async (req: NcRecordedClipRequest): Promise<NcRecordedClipResult> => {
            recordedAsks.push(req)
            return recorded(req)
          },
        }
      : {}),
    now: () => opts.now,
  })
  return { dispatcher, sends, ringCuts, recordedAsks }
}

function mp4(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(3))
  out.set([7, 7, 7])
  return out
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the ring keeps the moments it can still serve', () => {
  it('does not ask the recordings for a window the ring holds', async () => {
    const h = makeDispatcher({
      now: CONCLUDED_AT + 4 * SEC,
      recorded: async () => ({ ok: true, mp4: mp4(), profile: 'low' }),
    })
    await h.dispatcher.deliver(occupancyEntry(CONCLUDED_AT - 10 * SEC))
    expect(h.ringCuts).toEqual([CONCLUDED_AT - 10 * SEC])
    // The cheap, already-warm source served it — no ffmpeg lane was spent.
    expect(h.recordedAsks).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
  })
})

describe('an old moment is cut from the recordings and ships in ONE message (D686)', () => {
  it('waits for the recorded cut and sends it with the alert — never a second send', async () => {
    const h = makeDispatcher({
      now: CONCLUDED_AT,
      recorded: async () => ({ ok: true, mp4: mp4(), profile: 'low' }),
    })
    const result = await h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    expect(result.ok).toBe(true)
    // ONE send, and it already carries the video: a notifier is one-shot.
    expect(h.sends).toHaveLength(1)
    const sent = h.sends[0]?.notification
    expect(sent?.attachments?.map((a) => a.mediaType)).toEqual(['video'])
    expect(sent?.attachments?.[0]?.bytes?.byteLength).toBe(3)
    // Cut on the ANCHORED moment, never the ring.
    expect(h.recordedAsks[0]?.aroundMs).toBe(OBSERVED_AT)
    expect(h.recordedAsks[0]?.deviceId).toBe(DEVICE)
    expect(h.ringCuts).toHaveLength(0)
  })

  it('hands the recorder the bound as a deadline, so its render stops with the wait', async () => {
    const h = makeDispatcher({
      now: CONCLUDED_AT,
      recorded: async () => ({ ok: true, mp4: mp4(), profile: 'low' }),
    })
    await h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    expect(h.recordedAsks[0]?.deadlineMs).toBe(CONCLUDED_AT + NC_RECORDED_FOOTAGE_WAIT_MS)
  })

  it('names the recorded cut on the ring line, so the ring warning is not the end', async () => {
    const lines: Line[] = []
    const h = makeDispatcher({
      now: CONCLUDED_AT,
      logger: lineRecorder(lines),
      recorded: async () => ({ ok: true, mp4: mp4(), profile: 'low' }),
    })
    await h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    const ring = lines.find((l) => l.msg.startsWith('footage window predates the clip ring'))
    expect(ring?.meta['next']).toBe('recorded-cut')
    const attached = lines.find((l) => l.msg === 'recorded footage attached')
    expect(attached?.deviceId).toBe(DEVICE)
    expect(attached?.meta['attachments']).toEqual(['video'])
  })
})

describe('a missing recorded cut never costs the alert, and never sends twice', () => {
  it('ships once without it, by named reason, when the camera does not record', async () => {
    const lines: Line[] = []
    const h = makeDispatcher({
      now: CONCLUDED_AT,
      logger: lineRecorder(lines),
      recorded: async () => ({ ok: false, reason: 'not-recorded' }),
    })
    await h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.attachments ?? []).toHaveLength(0)
    const none = lines.find((l) => l.msg === 'recorded footage: none — the recorded cut failed')
    expect(none?.meta['reason']).toBe('not-recorded')
    expect(none?.deviceId).toBe(DEVICE)
  })

  it('ships once when the recorded cut THROWS, and names it', async () => {
    const lines: Line[] = []
    const h = makeDispatcher({
      now: CONCLUDED_AT,
      logger: lineRecorder(lines),
      recorded: async () => {
        throw new Error('recorder exploded')
      },
    })
    const result = await h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    expect(result.ok).toBe(true)
    expect(h.sends).toHaveLength(1)
    const none = lines.find((l) => l.msg === 'recorded footage: none — the recorded cut threw')
    expect(none?.deviceId).toBe(DEVICE)
  })

  it('ships once, still-only, when the cut is not ready inside the bound', async () => {
    vi.useFakeTimers()
    const lines: Line[] = []
    const h = makeDispatcher({
      now: CONCLUDED_AT,
      logger: lineRecorder(lines),
      // A render queued behind a timelapse: it never answers in time.
      recorded: () => new Promise<NcRecordedClipResult>(() => {}),
    })
    const pending = h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    await vi.advanceTimersByTimeAsync(NC_RECORDED_FOOTAGE_WAIT_MS)
    const result = await pending
    expect(result.ok).toBe(true)
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.attachments ?? []).toHaveLength(0)
    const none = lines.find((l) => l.msg === 'recorded footage: none — not ready inside the bound')
    expect(none?.meta['reason']).toBe('timed-out')
    expect(none?.meta['boundMs']).toBe(NC_RECORDED_FOOTAGE_WAIT_MS)
    expect(none?.deviceId).toBe(DEVICE)
  })

  it('ships exactly as before when no recordings wiring exists at all', async () => {
    const h = makeDispatcher({ now: CONCLUDED_AT })
    await h.dispatcher.deliver(occupancyEntry(OBSERVED_AT))
    expect(h.sends).toHaveLength(1)
    expect(h.ringCuts).toHaveLength(0)
  })
})

// ── D682 + D686: a package pick-up's GIF is cut around the pick-up ───

describe('a package pick-up gets still + recorded gif in ONE message (D682, D686)', () => {
  const PICKUP_DEVICE = 101
  /** The detector concluded the departure five minutes after the parcel went. */
  const PICKUP_CONCLUDED = 1_790_000_000_000
  const PICKUP_AT = PICKUP_CONCLUDED - 300 * SEC

  function packageEntry(opts: {
    readonly phase: 'delivered' | 'picked-up'
    readonly observedAt?: number
  }): NcOutboxEntry {
    const payload: NcOutboxPayload = {
      ruleName: 'Consegna pacco (front door)',
      delivery: 'package-event',
      priority: 3,
      media: 'best-matching',
      mediaGif: true,
      subject: {
        deviceId: PICKUP_DEVICE,
        className: 'package',
        zones: [],
        timestamp: PICKUP_CONCLUDED,
        ...(opts.observedAt !== undefined ? { observedAt: opts.observedAt } : {}),
        packagePhase: opts.phase,
      },
    }
    return {
      id: 'rule-pkg:283529:tgt-1',
      ruleId: 'rule-pkg',
      targetId: 'tgt-1',
      deviceId: PICKUP_DEVICE,
      recordKind: 'package-event',
      recordId: '283529',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: PICKUP_CONCLUDED,
      updatedAt: PICKUP_CONCLUDED,
      payload,
    }
  }

  interface GifHarness {
    readonly dispatcher: NcDispatcher
    readonly sends: NcSendInput[]
    readonly ringCuts: Array<{ aroundMs: number; wantGif: boolean }>
    readonly recordedAsks: NcRecordedClipRequest[]
    readonly derives: NcRecordedGifRequest[]
    readonly lines: Line[]
  }

  function gifHarness(opts: {
    readonly now: number
    readonly recorded?: NcRecordedClipResult
    readonly derived?: NcRecordedGifResult
    readonly withDerive?: boolean
  }): GifHarness {
    const sends: NcSendInput[] = []
    const ringCuts: Array<{ aroundMs: number; wantGif: boolean }> = []
    const recordedAsks: NcRecordedClipRequest[] = []
    const derives: NcRecordedGifRequest[] = []
    const lines: Line[] = []
    const dispatcher = new NcDispatcher({
      logger: lineRecorder(lines),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
      ],
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      ringRetentionSecFor: () => 20,
      renderEventMedia: async (req) => {
        ringCuts.push({ aroundMs: req.aroundMs, wantGif: req.wantGif })
        return { gif: Uint8Array.from([0x47, 0x49, 0x46]), mp4: null }
      },
      cutRecordedClip: async (req) => {
        recordedAsks.push(req)
        return opts.recorded ?? { ok: true, mp4: mp4(), profile: 'mid' }
      },
      ...(opts.withDerive === false
        ? {}
        : {
            deriveGifFromClip: async (req: NcRecordedGifRequest): Promise<NcRecordedGifResult> => {
              derives.push(req)
              return opts.derived ?? { ok: true, gif: gifBytes() }
            },
          }),
      now: () => opts.now,
    })
    return { dispatcher, sends, ringCuts, recordedAsks, derives, lines }
  }

  function gifBytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(4))
    out.set([0x47, 0x49, 0x46, 0x38])
    return out
  }

  it('cuts the pick-up from the recordings and sends ONE message carrying the gif', async () => {
    // The 2026-09-30 pick-up on 101: anchor 318 s old, the ring holds 20 s.
    const h = gifHarness({ now: PICKUP_CONCLUDED + 18 * SEC })
    await h.dispatcher.deliver(packageEntry({ phase: 'picked-up', observedAt: PICKUP_AT }))
    // The ring was never asked for the conclusion instant (the doormat).
    expect(h.ringCuts).toHaveLength(0)
    // One recorded cut, centred on the PICK-UP, and the gif derived from it.
    expect(h.recordedAsks).toHaveLength(1)
    expect(h.recordedAsks[0]?.aroundMs).toBe(PICKUP_AT)
    expect(h.derives).toHaveLength(1)
    expect(h.derives[0]?.mp4.byteLength).toBe(3)
    expect(h.derives[0]?.deviceId).toBe(PICKUP_DEVICE)
    // ONE message — the gif rides it; no video, the rule did not ask for one.
    expect(h.sends).toHaveLength(1)
    const sent = h.sends[0]?.notification
    expect(sent?.attachments?.map((a) => a.mediaType)).toEqual(['gif'])
    expect(sent?.attachments?.[0]?.mime).toBe('image/gif')
  })

  it('ships ONE message with no gif, by named reason, when the recordings do not cover it', async () => {
    const h = gifHarness({
      now: PICKUP_CONCLUDED + 7 * SEC,
      recorded: { ok: false, reason: 'not-covered' },
    })
    await h.dispatcher.deliver(packageEntry({ phase: 'picked-up', observedAt: PICKUP_AT }))
    expect(h.sends).toHaveLength(1)
    expect(h.derives).toHaveLength(0)
    const none = h.lines.find((l) => l.msg === 'recorded footage: none — the recorded cut failed')
    expect(none?.meta['reason']).toBe('not-covered')
    expect(none?.deviceId).toBe(PICKUP_DEVICE)
  })

  it('ships ONE message with no gif, by named reason, when the derive fails', async () => {
    const h = gifHarness({
      now: PICKUP_CONCLUDED + 7 * SEC,
      derived: { ok: false, reason: 'derive-failed' },
    })
    await h.dispatcher.deliver(packageEntry({ phase: 'picked-up', observedAt: PICKUP_AT }))
    expect(h.sends).toHaveLength(1)
    expect((h.sends[0]?.notification.attachments ?? []).some((a) => a.mediaType === 'gif')).toBe(
      false,
    )
    const none = h.lines.find(
      (l) => l.msg === 'recorded footage: none — the gif could not be derived',
    )
    expect(none?.meta['reason']).toBe('gif-derive-failed')
    expect(none?.deviceId).toBe(PICKUP_DEVICE)
  })

  it('does not order a recorded cut a gif-only rule could not use (no derive wired)', async () => {
    const h = gifHarness({ now: PICKUP_CONCLUDED + 7 * SEC, withDerive: false })
    await h.dispatcher.deliver(packageEntry({ phase: 'picked-up', observedAt: PICKUP_AT }))
    expect(h.recordedAsks).toHaveLength(0)
    const ring = h.lines.find((l) => l.msg.startsWith('footage window predates the clip ring'))
    expect(ring?.meta['next']).toBe('no-clip')
    const none = h.lines.find((l) => l.msg.startsWith('recorded gif: none'))
    expect(none?.meta['reason']).toBe('no-derive')
    expect(none?.deviceId).toBe(PICKUP_DEVICE)
  })

  it('logs a pick-up whose moment is unknown, instead of cutting the doormat silently', async () => {
    const h = gifHarness({ now: PICKUP_CONCLUDED + 7 * SEC })
    await h.dispatcher.deliver(packageEntry({ phase: 'picked-up' }))
    const line = h.lines.find(
      (l) => l.msg === 'package pick-up footage anchored on the conclusion — moment unknown',
    )
    expect(line?.deviceId).toBe(PICKUP_DEVICE)
    expect(line?.meta['reason']).toBe('unknown')
  })

  it('ships NO recorded gif for a pick-up whose moment is unknown — never the doormat', async () => {
    const h = gifHarness({ now: PICKUP_CONCLUDED + 300 * SEC })
    await h.dispatcher.deliver(packageEntry({ phase: 'picked-up' }))
    expect(h.ringCuts).toHaveLength(0)
    expect(h.recordedAsks).toHaveLength(0)
    expect(h.derives).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    const none = h.lines.find((l) => l.msg.startsWith('recorded gif: none'))
    expect(none?.meta['reason']).toBe('moment-unknown')
    expect(none?.deviceId).toBe(PICKUP_DEVICE)
    const ring = h.lines.find((l) => l.msg.startsWith('footage window expired while queued'))
    expect(ring?.meta['next']).toBe('no-clip')
  })

  it('ships NO recorded video either for a pick-up whose moment is unknown', async () => {
    const base = packageEntry({ phase: 'picked-up' })
    const entry: NcOutboxEntry = { ...base, payload: { ...base.payload, mediaClip: true } }
    const h = gifHarness({ now: PICKUP_CONCLUDED + 300 * SEC })
    await h.dispatcher.deliver(entry)
    expect(h.recordedAsks).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    const video = h.lines.find((l) => l.msg.startsWith('recorded video: none'))
    expect(video?.meta['reason']).toBe('moment-unknown')
    expect(video?.deviceId).toBe(PICKUP_DEVICE)
  })

  it('cuts the recorded video of a DATED pick-up into the same single message', async () => {
    const base = packageEntry({ phase: 'picked-up', observedAt: PICKUP_AT })
    const entry: NcOutboxEntry = {
      ...base,
      payload: { ...base.payload, mediaGif: true, mediaClip: true },
    }
    const h = gifHarness({ now: PICKUP_CONCLUDED + 7 * SEC })
    await h.dispatcher.deliver(entry)
    expect(h.recordedAsks[0]?.aroundMs).toBe(PICKUP_AT)
    expect(h.sends).toHaveLength(1)
    // Gif first, video second — the order the ring path ships them in.
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['gif', 'video'])
  })

  // D691 (amends D682): the operator withdrew the pick-up-only exclusion. A
  // DATED occupancy edge the ring lost — the 102 departure, committed 290 s
  // after the car left — is the same news as a pick-up: its gif is cut from
  // the recordings around the moment it happened and rides the ONE message.
  it('cuts the gif of a DATED occupancy edge the ring lost from the recordings (D691)', async () => {
    const occupancy = occupancyEntry(OBSERVED_AT)
    const entry: NcOutboxEntry = {
      ...occupancy,
      payload: { ...occupancy.payload, mediaClip: false, mediaGif: true },
    }
    const h = gifHarness({ now: CONCLUDED_AT })
    await h.dispatcher.deliver(entry)
    expect(h.ringCuts).toHaveLength(0)
    expect(h.recordedAsks).toHaveLength(1)
    expect(h.recordedAsks[0]?.aroundMs).toBe(OBSERVED_AT)
    expect(h.recordedAsks[0]?.deadlineMs).toBe(CONCLUDED_AT + NC_RECORDED_FOOTAGE_WAIT_MS)
    expect(h.derives).toHaveLength(1)
    expect(h.derives[0]?.deviceId).toBe(DEVICE)
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['gif'])
    const ring = h.lines.find((l) => l.msg.startsWith('footage window predates the clip ring'))
    expect(ring?.meta['next']).toBe('recorded-cut')
  })

  it('cuts NO recorded gif for an occupancy edge that could not date itself', async () => {
    const occupancy = occupancyEntry()
    const entry: NcOutboxEntry = {
      ...occupancy,
      payload: { ...occupancy.payload, mediaClip: false, mediaGif: true },
    }
    const h = gifHarness({ now: CONCLUDED_AT + 300 * SEC })
    await h.dispatcher.deliver(entry)
    expect(h.recordedAsks).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    const none = h.lines.find((l) => l.msg.startsWith('recorded gif: none'))
    expect(none?.meta['reason']).toBe('moment-unknown')
    expect(none?.deviceId).toBe(DEVICE)
  })

  it('keeps the recorded gif to self-dating kinds: a queued detection gets none, by name', async () => {
    const DETECTED_AT = 1_790_000_000_000
    const payload: NcOutboxPayload = {
      ruleName: 'Persona',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      mediaGif: true,
      subject: { deviceId: DEVICE, className: 'person', zones: [], timestamp: DETECTED_AT },
    }
    const entry: NcOutboxEntry = {
      id: 'rule-det:ev-1:tgt-1',
      ruleId: 'rule-det',
      targetId: 'tgt-1',
      deviceId: DEVICE,
      recordKind: 'object-event',
      recordId: 'ev-1',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: DETECTED_AT,
      updatedAt: DETECTED_AT,
      payload,
    }
    // Queued across a restart: 300 s old, far outside a 20 s ring.
    const h = gifHarness({ now: DETECTED_AT + 300 * SEC })
    await h.dispatcher.deliver(entry)
    expect(h.recordedAsks).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    const none = h.lines.find((l) => l.msg.startsWith('recorded gif: none'))
    expect(none?.meta['reason']).toBe('not-self-dating')
    expect(none?.deviceId).toBe(DEVICE)
  })

  it('leaves the DELIVERY gif exactly as it was: the ring, around the event, in the alert', async () => {
    const h = gifHarness({ now: PICKUP_CONCLUDED + 7 * SEC })
    await h.dispatcher.deliver(packageEntry({ phase: 'delivered' }))
    expect(h.ringCuts).toEqual([{ aroundMs: PICKUP_CONCLUDED, wantGif: true }])
    expect(h.recordedAsks).toHaveLength(0)
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toContain('gif')
    expect(h.lines.some((l) => l.msg.includes('anchored on the conclusion'))).toBe(false)
  })
})
