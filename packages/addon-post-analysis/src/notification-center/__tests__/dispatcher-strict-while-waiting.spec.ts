/**
 * A GATE IS "NOT YET" WHILE A BETTER FRAME CAN STILL ARRIVE, AND "SHIP IT AND
 * SAY SO" ONLY WHEN IT CANNOT.
 *
 * D225 gave the still an age gate and a bounded poll, and D223 gave it a zone
 * filter. Both were then reachable only if the FIRST look came back empty —
 * and two hours after D225 shipped, changed that first look from
 * `trigger-only` to `any` to stop an audio alarm spending 3 s waiting for a
 * still-shelf photograph that D178 guarantees will never be retaken. Its
 * comment justified the change with an assumption rather than a check: *"Tracks
 * are unaffected: at first look their media has not landed at all"*.
 *
 * On a doorstep camera that assumption is false. A person walks up the drive
 * before reaching the door, so the track is already SECONDS old — and already
 * has media on disk — at the instant the zone condition fires. The first look
 * then finds that media, both gates degrade rather than empty the pool, and the
 * bound is never spent.
 *
 * Measured on device 101, rule 'Persona su Uscio', from the delivered bytes on
 * the artefact shelf (sha256-matched back to the track media row that produced
 * them, so the instant is read from the row, not from the burnt-in clock):
 *
 * - track `98184eb9`, 27/08/2026 11:30:44 — the delivered still was the
 *   `keyFrame` from **−5965 ms**, subject 0% inside Uscio, doorstep visibly
 *   empty. `firstFrame` (+203 ms, 37.5% inside), `snapshot` (+1550 ms, 48.4%)
 *   and `lastFrame` (+1906 ms, 39.1%) all landed within the bound.
 * - track `9f2659e6`, 29/08/2026 12:10:20 — the delivered still was in band but
 *   out of PLACE: `keyFrame` at −1158 ms, 0% inside Uscio, while the `snapshot`
 *   at +670 ms (32.8% inside) landed 544 ms after the first look.
 *
 * Two failures of one rule, so one cure: under `trigger-only` both gates are
 * STRICT — an unsatisfied gate empties the pool and the poll keeps waiting —
 * and the first look asks `trigger-only` exactly when the record's media can
 * still grow. Everything that cannot grow another frame keeps D178's zero wait.
 */

import type { IScopedLogger, MediaFile } from '@camstack/types'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { describe, expect, it } from 'vitest'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload, NcOutboxRecordKind } from '../outbox.js'
import type { NcSubjectTrailPoint, NcZonePolygon } from '../trigger-zone-still.js'

const T0 = 1_787_823_044_148
const USCIO_ID = 'cfeec78c-8d69-4678-9d25-937193eacb5d'

/** The real Uscio polygon on device 101, normalized. */
const USCIO: NcZonePolygon = [
  { x: 0.6232558139534884, y: 0.6101342734477763 },
  { x: 0.7519321559713237, y: 0.822337532462056 },
  { x: 0.5474733344990383, y: 1.0055884014393348 },
  { x: 0.23273882380369532, y: 0.9842819598779754 },
  { x: 0.12698024130092675, y: 0.48086383534094124 },
  { x: 0.5071341143556566, y: 0.3589414904217118 },
]

const box = (x: number, y: number, w: number, h: number): NcSubjectTrailPoint['bbox'] => ({
  x,
  y,
  w,
  h,
})

/**
 * Track `98184eb9`'s real trail, normalized: up on the road when the keyFrame
 * was taken, on the doorstep from the trigger onwards.
 */
const TRAIL_98184EB9: readonly NcSubjectTrailPoint[] = [
  { timestamp: T0 - 5965, bbox: box(0.7722, 0.0494, 0.1087, 0.1583) }, // 0% in Uscio
  { timestamp: T0, bbox: box(0.4116, 0.1772, 0.3378, 0.5244) },
  { timestamp: T0 + 203, bbox: box(0.4222, 0.235, 0.3628, 0.5317) }, // 37.5%
  { timestamp: T0 + 1550, bbox: box(0.4259, 0.5156, 0.5016, 0.455) }, // 48.4%
]

/**
 * Track `9f2659e6`'s real trail: still short of the door 1.2 s before the
 * trigger, on it 670 ms after. Both instants are INSIDE the age band, so only
 * the place gate can separate them.
 */
const TRAIL_9F2659E6: readonly NcSubjectTrailPoint[] = [
  { timestamp: T0 - 1158, bbox: box(0.5644, 0.0356, 0.1666, 0.2689) }, // 0% in Uscio
  { timestamp: T0 - 831, bbox: box(0.5413, 0.0217, 0.1669, 0.2828) }, // 0%
  { timestamp: T0, bbox: box(0.4269, 0.0522, 0.2019, 0.4139) },
  { timestamp: T0 + 670, bbox: box(0.4191, 0.1622, 0.1862, 0.3867) }, // 32.8%
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
    base64: Buffer.from(`${kind}-${timestamp}`).toString('base64'),
    sizeBytes: 8,
    timestamp,
  })
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
]

interface EntryShape {
  readonly recordKind?: NcOutboxRecordKind
  readonly payload?: Partial<NcOutboxPayload>
}

function makeEntry(shape: EntryShape = {}): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: shape.recordKind ?? 'object-event',
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
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [USCIO_ID],
        timestamp: T0,
      },
      ...shape.payload,
    },
  }
}

interface Clock {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly elapsed: () => number
}

interface PendingSleep {
  readonly at: number
  readonly resolve: () => void
}

/** The same virtual scheduler `dispatcher-trigger-instant-still.spec.ts` uses:
 *  two concurrent sleepers must keep separate timelines. */
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

describe('NcDispatcher — strict while a better frame can still arrive', () => {
  it('does not settle for a frame from BEFORE the track reached the door (98184eb9)', async () => {
    // At the first look the track already carries its best shot from −5965 ms:
    // the person up on the road, doorstep empty. The frames that show the door
    // land 200–1900 ms later.
    const clock = makeClock()
    const h = makeHarness(
      {
        getMediaForOwner: async (ownerKind) => {
          if (ownerKind !== 'track') return []
          const files: MediaFile[] = [mediaFile('keyFrame', T0 - 5965)]
          if (clock.elapsed() >= 300) files.push(mediaFile('firstFrame', T0 + 203))
          if (clock.elapsed() >= 1600) files.push(mediaFile('snapshot', T0 + 1550))
          return files
        },
        getSubjectTrail: async () => TRAIL_98184EB9,
        getZonePolygons: async () => [USCIO],
      },
      clock,
    )
    await h.dispatcher.deliver(
      makeEntry({ payload: { mediaFrame: 'full', triggerZoneIds: [USCIO_ID] } }),
    )
    expect(attachedName(h)).toBe('firstFrame.jpg')
  })

  it('does not settle for an in-band frame from OUTSIDE the zone that fired (9f2659e6)', async () => {
    // Every candidate at the first look is inside the age band, so only the
    // PLACE gate can separate them — and the frame that shows the doorstep
    // lands 544 ms after that look.
    const clock = makeClock()
    const h = makeHarness(
      {
        getMediaForOwner: async (ownerKind) => {
          if (ownerKind !== 'track') return []
          const files: MediaFile[] = [
            mediaFile('keyFrame', T0 - 1158),
            mediaFile('snapshot', T0 - 831),
          ]
          if (clock.elapsed() >= 600) files.push(mediaFile('snapshot', T0 + 670))
          return files
        },
        getSubjectTrail: async () => TRAIL_9F2659E6,
        getZonePolygons: async () => [USCIO],
      },
      clock,
    )
    await h.dispatcher.deliver(
      makeEntry({ payload: { mediaFrame: 'full', triggerZoneIds: [USCIO_ID] } }),
    )
    expect(attachedName(h)).toBe('snapshot.jpg')
    expect(h.sends[0]?.notification.attachments?.[0]?.bytes).toEqual(
      Uint8Array.from(Buffer.from(`snapshot-${T0 + 670}`)),
    )
  })

  it('still SHIPS the out-of-zone frame when the bound expires, and says so', async () => {
    // Nothing in the zone ever lands. A real picture still beats no picture —
    // the strictness defers, it never drops.
    const clock = makeClock()
    const h = makeHarness(
      {
        getMediaForOwner: async (ownerKind) =>
          ownerKind === 'track' ? [mediaFile('keyFrame', T0 - 1158)] : [],
        getSubjectTrail: async () => TRAIL_9F2659E6,
        getZonePolygons: async () => [USCIO],
      },
      clock,
    )
    await h.dispatcher.deliver(
      makeEntry({ payload: { mediaFrame: 'full', triggerZoneIds: [USCIO_ID] } }),
    )
    expect(attachedName(h)).toBe('keyFrame.jpg')
    expect(
      h.lines.some((l) => l.message === 'still narrowed to the zone that fired the rule'),
    ).toBe(false)
  })

  it('spends NOTHING on a record whose media cannot grow — D178’s shelf photograph', async () => {
    // Device 107, 22:26:34: a second scream inside the shelf's reuse window
    // names a new owner id pointing at the FIRST scream's photograph, 6.1 s
    // before this trigger. No second capture is coming, so no bound is spent.
    const clock = makeClock()
    let reads = 0
    const h = makeHarness(
      {
        // `stillShelfMedia` writes keyFrameSmall/keyFrame/fullFrame onto the
        // synthetic audio track (D189 shapes it like a regular one).
        getMediaForOwner: async (ownerKind) => {
          reads += 1
          return ownerKind === 'track' ? [mediaFile('keyFrameSmall', T0 - 6100)] : []
        },
      },
      clock,
    )
    await h.dispatcher.deliver(
      makeEntry({
        recordKind: 'audio-event',
        payload: {
          subject: {
            deviceId: 107,
            trackId: 'shelf-owner-2',
            className: 'scream',
            zones: [],
            timestamp: T0,
          },
        },
      }),
    )
    expect(attachedName(h)).toBe('keyFrameSmall.jpg')
    expect(clock.elapsed()).toBe(0)
    expect(reads).toBe(1)
  })
})
