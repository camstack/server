/**
 * An `immediate` notification's picture is about the TRIGGER INSTANT.
 *
 * Operator, 2026-08-21: *"se una scena è settata su immediate, dovrebbe inviare
 * immediatamente la notifica al primo frame utile … In caso un frame diverso sia
 * selezionato, certamente si aspetta il primo frame di quel tipo disponibile"* [if a scene is set to immediate, it should send the notification immediately at the first useful frame … If a different frame is selected, he surely expects the first available frame of that type].
 *
 * The defect he named is a SEQUENCING one: the still was resolved once at the
 * trigger, and — when that found nothing — re-read only AFTER the footage
 * render, which blocks 7–8 s for a 6 s post-roll. By then the ladder is looking
 * at a track that has walked away, and its first rung (the track's best shot)
 * is a frame from seconds later. Device 101, rule 'Persona su Uscio', track
 * d0f63887…: the frame that shipped was +4901 ms and showed an empty doorstep.
 *
 * Measured on the same 54 fires: a full-scene frame within ±1 s of the trigger
 * existed for 52 (96%) and within ±2 s for 53 (98%) — but the ladder's TOP rung
 * (the native keyFrame) was in band only 46% of the time, because that capture
 * misses and retries (36 misses over 105 track starts on 101 in 6 h). So
 * "hold out for the kind the rule asked for" would wait for exactly the frame
 * that arrives late. The gate has to be the frame's own INSTANT, and the ladder
 * then runs among the frames that are about it.
 *
 * Pinned here: the age gate, the concurrency (the still never waits on the
 * render), the reported degrade, and that a non-`immediate` rule is untouched.
 */

import type { IScopedLogger, MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { describe, expect, it } from 'vitest'
import {
  NC_STILL_WAIT_MS,
  NC_TRIGGER_STILL_MAX_AGE_MS,
  NcDispatcher,
  type NcSendInput,
  type NcTargetRef,
} from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const T0 = 1_787_331_449_282

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown>
}

function makeRecordingLogger(): { logger: IScopedLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  const at =
    (level: string) =>
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

function mediaFile(kind: MediaFile['kind'], timestamp: number): MediaFile {
  return makeTestMediaFile({
    kind,
    base64: Buffer.from(`${kind}-bytes`).toString('base64'),
    sizeBytes: 8,
    timestamp,
  })
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
]

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

/**
 * A VIRTUAL clock — no test spends real seconds, and concurrent sleepers keep
 * separate timelines.
 *
 * A naive "sleep advances a counter" fake cannot express this file's subject:
 * the render sleeping 7 s would drag the poll's clock 7 s forward, which is
 * precisely the coupling the production change removes. So sleeps go on a
 * queue ordered by wake time and a real `setTimeout(…, 0)` tick wakes the
 * earliest — the poll's 500 ms steps all fire before the render's 7 s does.
 */
interface Clock {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly elapsed: () => number
}

interface PendingSleep {
  readonly at: number
  readonly resolve: () => void
}

function makeClock(): Clock {
  let t = T0
  const pending: PendingSleep[] = []
  let armed = false
  const tick = (): void => {
    armed = false
    if (pending.length === 0) return
    const next = Math.min(...pending.map((p) => p.at))
    t = Math.max(t, next)
    for (const p of pending.filter((p) => p.at <= t)) p.resolve()
    pending.splice(0, pending.length, ...pending.filter((p) => p.at > t))
    arm()
  }
  const arm = (): void => {
    if (armed || pending.length === 0) return
    armed = true
    setTimeout(tick, 0)
  }
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: t + ms, resolve })
        arm()
      }),
    elapsed: () => t - T0,
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  readonly clock: Clock
}

function makeHarness(
  overrides: Partial<ConstructorParameters<typeof NcDispatcher>[0]> = {},
  clock: Clock = makeClock(),
): Harness {
  const { logger, lines } = makeRecordingLogger()
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger,
    listTargets: async () => TARGETS,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Camera front door',
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  })
  return { dispatcher, sends, lines, clock }
}

const attachedName = (h: Harness): string | undefined =>
  h.sends[0]?.notification.attachments?.[0]?.name

const attachedKinds = (h: Harness): readonly string[] =>
  (h.sends[0]?.notification.attachments ?? []).map((a) => a.mediaType)

const oneByte = (): Uint8Array => Uint8Array.from([1])

describe('NcDispatcher — an immediate still is about the trigger instant', () => {
  it('rejects the best shot from AFTER the trigger and ships the frame of the moment', async () => {
    // The live shape, with NO zone condition — this is why the age gate and not
    // the zone filter is the primary cure.
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) =>
        ownerKind === 'track'
          ? [mediaFile('keyFrame', T0 + 5001), mediaFile('firstFrame', T0 - 134)]
          : [],
    })
    await h.dispatcher.deliver(makeEntry())
    expect(attachedName(h)).toBe('firstFrame.jpg')
  })

  it('the age gate is the SAME bound the zone trail uses', () => {
    expect(NC_TRIGGER_STILL_MAX_AGE_MS).toBe(2_000)
  })

  it('freezes the FIRST frame that lands — the render never gets to re-choose', async () => {
    // Both candidates are IN BAND, so only the sequencing can tell them apart:
    // firstFrame is written 1 s in, the ladder's top rung 6 s in (during the
    // render). Re-reading after the render would ship the keyFrame.
    const clock = makeClock()
    const h = makeHarness(
      {
        getMediaForOwner: async (ownerKind) => {
          if (ownerKind !== 'track') return []
          const files: MediaFile[] = []
          if (clock.elapsed() >= 1000) files.push(mediaFile('firstFrame', T0 - 100))
          if (clock.elapsed() >= 6000) files.push(mediaFile('keyFrame', T0 + 500))
          return files
        },
        renderEventMedia: async () => {
          // The 7–8 s the post-roll costs. It must not move the still.
          await clock.sleep(7000)
          return { gif: oneByte(), mp4: null }
        },
      },
      clock,
    )
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(attachedName(h)).toBe('firstFrame.jpg')
    expect(attachedKinds(h)).toEqual(['image', 'gif'])
  })

  it('gives up on the still under its OWN bound, never the render’s', async () => {
    const clock = makeClock()
    let renderDone = false
    let lastStillReadAt = -1
    const h = makeHarness(
      {
        getMediaForOwner: async () => {
          lastStillReadAt = clock.elapsed()
          return []
        },
        renderEventMedia: async () => {
          await clock.sleep(7000)
          renderDone = true
          return { gif: oneByte(), mp4: null }
        },
      },
      clock,
    )
    await h.dispatcher.deliver(makeEntry({ mediaGif: true }))
    expect(renderDone).toBe(true)
    // Every media read happened inside the still's own bound.
    expect(lastStillReadAt).toBeLessThanOrEqual(NC_STILL_WAIT_MS)
    expect(attachedKinds(h)).toEqual(['gif'])
  })

  it('ships a stale frame rather than nothing — and SAYS how old it is', async () => {
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) =>
        ownerKind === 'track' ? [mediaFile('keyFrame', T0 + 9000)] : [],
    })
    await h.dispatcher.deliver(makeEntry())
    expect(attachedName(h)).toBe('keyFrame.jpg')
    const line = h.lines.find(
      (l) => l.message === 'no still from the trigger instant — shipping a later frame',
    )
    expect(line).toBeDefined()
    expect(line?.meta['kind']).toBe('keyFrame')
    expect(line?.meta['offsetMs']).toBe(9000)
  })

  it('a row that sat in the outbox keeps its picture — it does not poll, but it still resolves', async () => {
    // The retry / restart / unreachable-target case. The row is older than
    // NC_STILL_WAIT_MAX_AGE_MS, so there is nothing to wait for; asking for the
    // trigger instant ONLY would have shipped text-only where this used to ship
    // the frame it has.
    const clock = makeClock()
    const h = makeHarness(
      {
        getMediaForOwner: async (ownerKind) =>
          ownerKind === 'track' ? [mediaFile('keyFrame', T0 + 45_000)] : [],
      },
      clock,
    )
    await h.dispatcher.deliver(
      makeEntry({ subject: { ...makeEntry().payload.subject, timestamp: T0 - 60_000 } }),
    )
    expect(attachedName(h)).toBe('keyFrame.jpg')
    // …and it never slept: an aged row is resolved, not polled.
    expect(clock.elapsed()).toBe(0)
  })

  it('does not burn the bound when a frame already exists but is out of band', async () => {
    // The live still-shelf case (device 107, 22:26:34): a second scream inside
    // the shelf's reuse window names a new owner pointing at the FIRST scream's
    // photograph (D178), so its instant is 6.1 s before this trigger and no
    // second capture is coming. Polling for one spent 3 s of a crying-child
    // alarm on nothing.
    //
    // The row is an `audio-event`, and saying so is load-bearing: this fixture
    // used to build the file's default `object-event` while its comment
    // described a scream, and it passed only because the first look was then
    // permissive for EVERY record. That permissiveness is what shipped an empty
    // doorstep on 'Persona su Uscio' — see
    // `dispatcher-strict-while-waiting.spec.ts`.
    const clock = makeClock()
    const h = makeHarness(
      {
        getMediaForOwner: async (ownerKind) =>
          ownerKind === 'track' ? [mediaFile('keyFrameSmall', T0 - 6122)] : [],
      },
      clock,
    )
    await h.dispatcher.deliver({
      ...makeEntry({
        ruleName: 'Pianto o urla nelle bedrooms',
        subject: {
          deviceId: 107,
          trackId: 'trk-1',
          className: 'scream',
          zones: [],
          timestamp: T0,
        },
      }),
      recordKind: 'audio-event',
    })
    expect(attachedName(h)).toBe('keyFrameSmall.jpg')
    // Shipped at once, and honest about the age it settled for.
    expect(clock.elapsed()).toBe(0)
    const line = h.lines.find(
      (l) => l.message === 'no still from the trigger instant — shipping a later frame',
    )
    expect(line?.meta['offsetMs']).toBe(-6122)
  })

  it('a non-immediate rule is untouched — a track-end still is about the whole track', async () => {
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) =>
        ownerKind === 'track'
          ? [mediaFile('keyFrame', T0 + 5001), mediaFile('firstFrame', T0 - 134)]
          : [],
    })
    await h.dispatcher.deliver(makeEntry({ delivery: 'track-end' }))
    expect(attachedName(h)).toBe('keyFrame.jpg')
    expect(
      h.lines.some(
        (l) => l.message === 'no still from the trigger instant — shipping a later frame',
      ),
    ).toBe(false)
  })

  it('the age gate runs BEFORE the zone filter — moment first, then place', async () => {
    // Two in-band candidates, one of them outside the zone; and one out-of-band
    // candidate INSIDE it. The moment wins: the out-of-band frame never enters
    // the pool the zone filter sees.
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) =>
        ownerKind === 'track'
          ? [
              mediaFile('keyFrame', T0 + 400), // in band, outside the zone
              mediaFile('firstFrame', T0 - 100), // in band, inside the zone
              mediaFile('lastFrame', T0 + 30_000), // outside band, inside the zone
            ]
          : [],
      getZonePolygons: async () => [
        [
          { x: 0.0, y: 0.5 },
          { x: 0.5, y: 0.5 },
          { x: 0.5, y: 1.0 },
          { x: 0.0, y: 1.0 },
        ],
      ],
      getSubjectTrail: async () => [
        { timestamp: T0 - 100, bbox: { x: 0.1, y: 0.6, w: 0.2, h: 0.3 } }, // inside
        { timestamp: T0 + 400, bbox: { x: 0.7, y: 0.05, w: 0.1, h: 0.1 } }, // outside
        { timestamp: T0 + 30_000, bbox: { x: 0.1, y: 0.6, w: 0.2, h: 0.3 } }, // inside
      ],
    })
    await h.dispatcher.deliver(makeEntry({ triggerZoneIds: ['z1'] }))
    expect(attachedName(h)).toBe('firstFrame.jpg')
  })

  it('zoneCrop still ships firstFrame when the native keyFrame missed (57f39fcc)', async () => {
    // Live: attach best-matching + zoneCrop, track held thumbnail + firstFrame
    // + lastFrame, never a keyFrame. The zone-crop override used to ask only
    // for the retired keyFrame family → text-only, gif-only delivery.
    const h = makeHarness({
      getMediaForOwner: async (ownerKind) =>
        ownerKind === 'track'
          ? [
              mediaFile('thumbnail', T0),
              mediaFile('firstFrame', T0 - 680),
              mediaFile('lastFrame', T0 - 680),
            ]
          : [],
    })
    await h.dispatcher.deliver(
      makeEntry({ media: 'best-matching', mediaZoneIds: ['fa03b60a-5669-4a8a-976b-bac422f5f530'] }),
    )
    expect(attachedName(h)).toBe('firstFrame.jpg')
    expect(h.lines.some((l) => l.message.includes('ships text-only'))).toBe(false)
  })
})
