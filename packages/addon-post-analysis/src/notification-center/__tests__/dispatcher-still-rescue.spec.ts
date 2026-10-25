/**
 * The still must not lose a race it was never running.
 *
 * Live audit (device 101, rule 'Persona su Uscio', media
 * `{attach:'best', frame:'full', gif:true}`): 15 fires, 11 carried both
 * attachments, 3 shipped GIF-ONLY and 1 image-only. Every gif-only row had its
 * keyframe land 1.5–5.5 s AFTER the trigger — comfortably inside the 7–8 s the
 * footage render was already blocking the same dispatch for. The still was
 * resolved ONCE, before that wait, and never looked again.
 *
 * These tests pin the four rules that follow from that:
 *  - re-resolve the still AFTER the footage render when the first look found
 *    nothing (free — the wait already happened);
 *  - when there is no wait to piggyback on — no footage requested, or a render
 *    that DECLINED in milliseconds — poll the ladder under a small bound
 *    instead. "It was attempted" is not "we waited";
 *  - say on the delivered line WHICH kinds actually shipped, and which the rule
 *    asked for and did not get;
 *  - a row whose footage window aged out of the clip ring while it sat in the
 *    outbox says so, once, instead of producing two fallback failures.
 */

import type { IScopedLogger, MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { describe, expect, it } from 'vitest'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const T0 = 1_753_000_000_000

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface LogRecorder {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
}

function makeRecordingLogger(): LogRecorder {
  const lines: LoggedLine[] = []
  const at =
    (level: LoggedLine['level']) =>
    (message: string, extras?: { meta?: Record<string, unknown> }): void => {
      lines.push({ level, message, meta: extras?.meta ?? {} })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

function mediaFile(kind: MediaFile['kind']): MediaFile {
  return makeTestMediaFile({
    kind,
    base64: Buffer.from(`${kind}-bytes`).toString('base64'),
    sizeBytes: 8,
    timestamp: T0,
  })
}

function makeEntry(payload: Partial<NcOutboxPayload> = {}): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: T0,
    updatedAt: T0,
    payload: {
      ruleName: 'Persona su Uscio',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      mediaFrame: 'full',
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [],
        timestamp: T0,
      },
      ...payload,
    },
  }
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
]

const oneByte = (): Uint8Array => Uint8Array.from([1])

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  readonly slept: number[]
  readonly mediaReads: number
}

/**
 * A dispatcher whose clock sits ON the subject instant — the live case. The
 * default fakes hold NO media and render NO footage; each test overrides the
 * one dep it is about.
 */
function makeHarness(
  overrides: Partial<ConstructorParameters<typeof NcDispatcher>[0]> = {},
): Harness {
  const { logger, lines } = makeRecordingLogger()
  const sends: NcSendInput[] = []
  const slept: number[] = []
  const counters = { mediaReads: 0 }
  const dispatcher = new NcDispatcher({
    logger,
    listTargets: async () => TARGETS,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => {
      counters.mediaReads += 1
      return []
    },
    getDeviceName: async () => 'Uscio',
    now: () => T0,
    sleep: async (ms: number) => {
      slept.push(ms)
    },
    ...overrides,
  })
  return {
    dispatcher,
    sends,
    lines,
    slept,
    get mediaReads(): number {
      return counters.mediaReads
    },
  }
}

// ── 1. The free rescue ──────────────────────────────────────────────────────

describe('NcDispatcher — the still is re-resolved after the footage render', () => {
  it('a keyframe that lands DURING the render is still attached', async () => {
    // The exact live shape: nothing at t0, the track's keyFrame written while
    // the broker was cutting the gif.
    let rendered = false
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) =>
        rendered && ownerKind === 'track' ? [mediaFile('keyFrame')] : [],
      renderEventMedia: async () => {
        rendered = true
        return { gif: oneByte(), mp4: null }
      },
    })
    const result = await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(result.ok).toBe(true)
    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image', 'gif'])
    expect(attachments[0]?.name).toBe('keyFrame.jpg')
  })

  it('costs NOTHING when the first look already found the still', async () => {
    // The 11-of-15 case. One media read, no second pass.
    let reads = 0
    const h = makeHarness({
      getMediaForOwner: async () => {
        reads += 1
        return [mediaFile('keyFrame')]
      },
      renderEventMedia: async () => ({ gif: oneByte(), mp4: null }),
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(reads).toBe(1)
    expect((h.sends[0]?.notification.attachments ?? []).map((a) => a.mediaType)).toEqual([
      'image',
      'gif',
    ])
  })

  it('does not re-look when the rule wanted no picture at all', async () => {
    const h = makeHarness({
      renderEventMedia: async () => ({ gif: oneByte(), mp4: null }),
    })
    await h.dispatcher.deliver(makeEntry({ media: 'none', mediaGif: true }))
    expect(h.mediaReads).toBe(0)
  })

  it('the text-only line is emitted once, AFTER the second look also failed', async () => {
    const h = makeHarness({
      renderEventMedia: async () => ({ gif: oneByte(), mp4: null }),
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    const textOnly = h.lines.filter((l) => l.message.startsWith('no still could be resolved'))
    expect(textOnly).toHaveLength(1)
  })
})

// ── 2. The bounded wait ─────────────────────────────────────────────────────

describe('NcDispatcher — bounded still wait when no footage is requested', () => {
  it('polls the ladder until the keyframe lands', async () => {
    let polls = 0
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) => {
        polls += 1
        // Lands on the third look (≈1 s in), the median of the live sample.
        return polls >= 3 && ownerKind === 'track' ? [mediaFile('keyFrame')] : []
      },
    })
    await h.dispatcher.deliver(makeEntry({}))
    expect((h.sends[0]?.notification.attachments ?? []).map((a) => a.name)).toEqual([
      'keyFrame.jpg',
    ])
    expect(h.slept.length).toBeGreaterThan(0)
    expect(h.slept.every((ms) => ms === 500)).toBe(true)
  })

  it('gives up after the bound rather than holding the notification', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.deliver(makeEntry({}))
    expect(result.ok).toBe(true)
    // 3 s at 500 ms — six waits, never a seventh.
    expect(h.slept).toHaveLength(6)
    expect((h.sends[0]?.notification.attachments ?? []).length).toBe(0)
  })

  it('does not wait when the render already gave the still time to land', async () => {
    const h = makeHarness({
      renderEventMedia: async () => ({ gif: oneByte(), mp4: null }),
      getMediaForOwner: async () => [mediaFile('keyFrame')],
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(h.slept).toHaveLength(0)
  })

  it('a render that returned in milliseconds is NOT a wait — the ladder is polled anyway', async () => {
    // `attempted` used to stand in for "we have already blocked 7–8 s", and for
    // a real cut it does. It is not the same claim: the render returns in
    // milliseconds when the broker declines, and the re-read then happened
    // exactly as early as the first look — the failure this whole file exists
    // to prevent, in the one shape it was left in. An AUDIO still makes it
    // routine: the photograph starts at the match and lands a beat later.
    // Gate on whether the media LANDED, never on a proxy for elapsed time (D58).
    let polls = 0
    const h = makeHarness({
      renderEventMedia: async () => ({ gif: oneByte(), mp4: null }),
      getMediaForOwner: async (ownerKind) => {
        polls += 1
        return polls > 4 && ownerKind === 'track' ? [mediaFile('keyFrame')] : []
      },
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(h.slept.length).toBeGreaterThan(0)
    expect((h.sends[0]?.notification.attachments ?? []).map((a) => a.name)).toEqual([
      'keyFrame.jpg',
      'event.gif',
    ])
  })

  it('never waits for a row that has been queued for minutes', async () => {
    // The wait exists to overlap the seconds in which media is still being
    // written. A row that already spent that time gains nothing from another 3 s.
    const h = makeHarness({ now: () => T0 + 600_000 })
    await h.dispatcher.deliver(makeEntry({}))
    expect(h.slept).toHaveLength(0)
  })
})

// ── 4. What actually shipped ────────────────────────────────────────────────

describe('NcDispatcher — the delivered line names the attachments', () => {
  it('lists the kinds that shipped', async () => {
    const h = makeHarness({
      getMediaForOwner: async () => [mediaFile('keyFrame')],
      renderEventMedia: async () => ({ gif: oneByte(), mp4: oneByte() }),
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true, mediaClip: true }))
    const delivered = h.lines.find((l) => l.message === 'notification delivered')
    expect(delivered?.meta.attachments).toEqual(['still', 'gif', 'video'])
    expect(delivered?.meta.dropped).toBeUndefined()
  })

  it('names what the rule asked for and did not get', async () => {
    const h = makeHarness({
      getMediaForOwner: async () => [],
      renderEventMedia: async () => ({ gif: null, mp4: null }),
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    const delivered = h.lines.find((l) => l.message === 'notification delivered')
    expect(delivered?.meta.attachments).toEqual([])
    expect(delivered?.meta.dropped).toEqual(['still', 'gif'])
  })

  it('a dropped GIF is a WARNING, never a debug line nobody reads', async () => {
    const h = makeHarness({
      getMediaForOwner: async () => [mediaFile('keyFrame')],
      renderEventMedia: async () => {
        throw new Error('clip buffer does not cover the moment')
      },
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    const warn = h.lines.find((l) => l.level === 'warn' && l.message.includes('gif'))
    expect(warn).toBeDefined()
    expect(warn?.meta.action).toBe('send-without-video')
  })
})

// ── 5. The row that straddled a restart ─────────────────────────────────────

describe('NcDispatcher — a footage window that expired while queued', () => {
  it('says so once and ships the still, instead of two failed cuts', async () => {
    let renders = 0
    const h = makeHarness({
      // 45 s late — the addon restarted under this row (live, 2026-08-12).
      now: () => T0 + 45_000,
      getMediaForOwner: async () => [mediaFile('keyFrame')],
      renderEventMedia: async () => {
        renders += 1
        return { gif: oneByte(), mp4: null }
      },
    })
    const result = await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(result.ok).toBe(true)
    expect(renders).toBe(0)
    const warn = h.lines.find((l) => l.message.includes('footage window expired while queued'))
    expect(warn?.level).toBe('warn')
    expect(warn?.meta.ageSec).toBe(45)
    expect((h.sends[0]?.notification.attachments ?? []).map((a) => a.mediaType)).toEqual(['image'])
  })

  it('a fresh row still gets its cut', async () => {
    let renders = 0
    const h = makeHarness({
      now: () => T0 + 3_000,
      renderEventMedia: async () => {
        renders += 1
        return { gif: oneByte(), mp4: null }
      },
    })
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(renders).toBe(1)
    expect(h.lines.some((l) => l.message.includes('footage window expired'))).toBe(false)
  })
})
