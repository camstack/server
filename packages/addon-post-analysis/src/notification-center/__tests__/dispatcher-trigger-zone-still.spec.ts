/**
 * The dispatcher end of "a notification does not lie about its own reason".
 *
 * Derived from the live row that produced the rule (device 101, 'Persona su
 * Uscio', `{attach:'best', frame:'full'}`, track d0f63887…, 21/08/2026
 * 18:57:29): the track's `keyFrame` — the ladder's first rung — showed the
 * subject up on the driveway, 0% inside Uscio; the `firstFrame` showed him on
 * the doorstep at 40.6%. The delivered picture was the keyFrame.
 *
 * That real row's bad frame was +4901 ms, and the AGE gate (D225,
 * `dispatcher-trigger-instant-still.spec.ts`) now rejects it before this filter
 * is consulted at all. So the candidates here are deliberately BOTH inside the
 * trigger band: what is pinned is the second gate, the one that still has work
 * to do when two frames are equally about the moment and only one is about the
 * PLACE — and the one that carries a `track-end` rule, where there is no
 * trigger instant to be near.
 *
 * Pinned here: the frozen trigger zones narrow the ladder, the narrowing is
 * REPORTED, and every unanswerable case leaves the ladder exactly as it was.
 */

import type { IScopedLogger, MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { describe, expect, it } from 'vitest'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcSubjectTrailPoint } from '../trigger-zone-still.js'

const T0 = 1_787_331_449_282
const USCIO_ID = 'cfeec78c-8d69-4678-9d25-937193eacb5d'

/** The real Uscio polygon on device 101, normalized. */
const USCIO: ReadonlyArray<{ readonly x: number; readonly y: number }> = [
  { x: 0.6232558139534884, y: 0.6101342734477763 },
  { x: 0.7519321559713237, y: 0.822337532462056 },
  { x: 0.5474733344990383, y: 1.0055884014393348 },
  { x: 0.23273882380369532, y: 0.9842819598779754 },
  { x: 0.12698024130092675, y: 0.48086383534094124 },
  { x: 0.5071341143556566, y: 0.3589414904217118 },
]

const norm = (x: number, y: number, w: number, h: number): NcSubjectTrailPoint['bbox'] => ({
  x: x / 640,
  y: y / 360,
  w: w / 640,
  h: h / 360,
})

/**
 * The real trail, compressed into the trigger band: on the doorstep at the
 * trigger, already off it 1.5 s later. Both instants pass the age gate, so the
 * zone filter is the only thing that can separate them.
 */
const TRAIL: readonly NcSubjectTrailPoint[] = [
  { timestamp: T0, bbox: norm(303.1, 176.1, 286.3, 176.7) },
  { timestamp: T0 + 1500, bbox: norm(466.1, 35.7, 85.5, 80.5) },
]

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

/** The ladder's real order for `frame:'full'` on a track owner puts keyFrame
 *  first; the store returns them in whatever order it likes. */
const LIVE_FILES: readonly MediaFile[] = [
  mediaFile('firstFrame', T0),
  mediaFile('keyFrame', T0 + 1500),
]

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
        zones: [USCIO_ID],
        timestamp: T0,
      },
      ...payload,
    },
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
}

function makeHarness(
  overrides: Partial<ConstructorParameters<typeof NcDispatcher>[0]> = {},
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
    getMediaForOwner: async (ownerKind) => (ownerKind === 'track' ? LIVE_FILES : []),
    getZonePolygons: async () => [USCIO],
    getSubjectTrail: async () => TRAIL,
    getDeviceName: async () => 'Camera front door',
    now: () => T0,
    sleep: async () => {},
    ...overrides,
  })
  return { dispatcher, sends, lines }
}

const attachedName = (h: Harness): string | undefined =>
  h.sends[0]?.notification.attachments?.[0]?.name

describe('NcDispatcher — the still is narrowed to the zone that fired the rule', () => {
  it('ships the doorstep frame instead of the best shot taken after he left', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.deliver(makeEntry({ triggerZoneIds: [USCIO_ID] }))
    expect(result.ok).toBe(true)
    expect(attachedName(h)).toBe('firstFrame.jpg')
  })

  it('REPORTS the substitution, with what it would have shipped and the offsets', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry({ triggerZoneIds: [USCIO_ID] }))
    const line = h.lines.find((l) => l.message === 'still narrowed to the zone that fired the rule')
    expect(line).toBeDefined()
    expect(line?.meta['was']).toBe('keyFrame')
    expect(line?.meta['wasOffsetMs']).toBe(1500)
    expect(line?.meta['now']).toBe('firstFrame')
    expect(line?.meta['nowOffsetMs']).toBe(0)
    expect(line?.meta['dropped']).toBe(1)
  })

  it('a row with no frozen trigger zones resolves exactly as before', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry())
    expect(attachedName(h)).toBe('keyFrame.jpg')
    expect(
      h.lines.some((l) => l.message === 'still narrowed to the zone that fired the rule'),
    ).toBe(false)
  })

  it('an unresolvable zone polygon leaves the ladder alone', async () => {
    const h = makeHarness({ getZonePolygons: async () => [] })
    await h.dispatcher.deliver(makeEntry({ triggerZoneIds: [USCIO_ID] }))
    expect(attachedName(h)).toBe('keyFrame.jpg')
  })

  it('an empty trail leaves the ladder alone', async () => {
    const h = makeHarness({ getSubjectTrail: async () => [] })
    await h.dispatcher.deliver(makeEntry({ triggerZoneIds: [USCIO_ID] }))
    expect(attachedName(h)).toBe('keyFrame.jpg')
  })

  it('a trail read that THROWS leaves the ladder alone — it never fails the send', async () => {
    const h = makeHarness({
      getSubjectTrail: async () => {
        throw new Error('store down')
      },
    })
    const result = await h.dispatcher.deliver(makeEntry({ triggerZoneIds: [USCIO_ID] }))
    expect(result.ok).toBe(true)
    expect(attachedName(h)).toBe('keyFrame.jpg')
  })

  it('when NO frame shows the subject in the zone, the ladder ships its first rung', async () => {
    // He was never on the doorstep in a frame we hold pixels for.
    const h = makeHarness({
      getSubjectTrail: async () => [{ timestamp: T0, bbox: norm(466.1, 35.7, 85.5, 80.5) }],
      getMediaForOwner: async (ownerKind) =>
        ownerKind === 'track' ? [mediaFile('keyFrame', T0), mediaFile('firstFrame', T0)] : [],
    })
    await h.dispatcher.deliver(makeEntry({ triggerZoneIds: [USCIO_ID] }))
    expect(attachedName(h)).toBe('keyFrame.jpg')
  })
})
