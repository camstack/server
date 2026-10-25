/**
 * The doorbell's picture — a DEVICE event carrying media, on the live path.
 *
 * ## What was wrong
 *
 * `buildEntries` freezes a media owner onto the outbox payload only for the
 * kinds that have one, and a device event had none: no `eventId` (there is no
 * object-event row), no `trackId` (nothing was tracked). The dispatcher's
 * attachment ladder therefore had nothing to resolve, and every doorbell
 * notification this hub ever sent was text-only. The operator caught it on a
 * real press on 2026-08-08 12:44 — gif and video attached, no photo.
 *
 * ## What fixes it, and what does NOT
 *
 * NOT a second photograph taken at delivery time. The same press already
 * materialises a synthetic marker track carrying a snapshot of the camera,
 * taken BEFORE the track is persisted (`sensor-marker-projector.ts`); the
 * notification simply names that track as its owner. So the tests below assert
 * the property that matters — **the notification path has no device-event
 * branch**: the still comes out of `getMediaForOwner('track', …)`, the same
 * call an object event's still comes out of.
 *
 * The footage is unchanged and is asserted here anyway, because "the doorbell
 * has no media" was the report and only half of it was true: `produceEventMedia`
 * has always been given the camera and the event's instant, and works for ANY
 * event of that camera.
 */
import { ncTable } from './support/nc-test-deps.js'
import type { InMemoryRecords } from '@camstack/types'
import type { MediaFile, NcRuleInput, SensorEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcEventMediaRequest, NcSendInput, NcTargetRef } from '../dispatcher.js'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { completeLoggerStub, ncPruneWindowsPort, makeNcRecords } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 1_786_185_854_852
const CAMERA = 101
/** The marker track the press projected — the notification's media owner. */
const MARKER = 'pa-synth-80d15a41'

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

interface LoggedLine {
  readonly level: 'info' | 'warn' | 'debug' | 'error'
  readonly message: string
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  /** Every `(ownerKind, ownerId)` the dispatcher asked for. */
  readonly mediaLookups: string[]
  readonly mediaRequests: NcEventMediaRequest[]
}

function doorbellRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Campanello (front door)',
    delivery: 'device-event',
    targets: [{ targetId: 'zentik' }],
    conditions: { devices: [CAMERA], sensorKinds: ['doorbell'] },
    // The live rule's own policy.
    media: { attach: 'best' },
    throttle: { cooldownSec: 10, scope: 'rule-device' },
    ...overrides,
  })
}

/** One row of the press, exactly as `ingestSensorStateChange` inserts it. */
function press(): SensorEvent {
  return {
    id: `pa-sensor-${Math.random().toString(36).slice(2, 10)}`,
    deviceId: CAMERA,
    sourceDeviceId: CAMERA,
    kind: 'doorbell',
    value: { lastPressedAt: NOW },
    timestamp: NOW,
  }
}

/** The marker's persisted media — `keyFrameSmall`, the ONE kind
 *  `SyntheticTrackMaterializer` writes. */
function markerMedia(): readonly MediaFile[] {
  return [
    makeTestMediaFile({
      kind: 'keyFrameSmall',
      base64: TINY_JPEG_B64,
      sizeBytes: 640,
      timestamp: NOW,
    }),
  ]
}

function makeHarness(mediaByOwner: ReadonlyMap<string, readonly MediaFile[]>): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const lines: LoggedLine[] = []
  const mediaLookups: string[] = []
  const mediaRequests: NcEventMediaRequest[] = []
  const record =
    (level: LoggedLine['level']) =>
    (
      message: string,
      opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ): void => {
      lines.push({
        level,
        message,
        ...(opts?.tags ? { tags: opts.tags } : {}),
        ...(opts?.meta ? { meta: opts.meta } : {}),
      })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (): unknown => logger,
  }
  const targets: NcTargetRef[] = [
    { id: 'zentik', addonId: 'notifiers', name: 'Zentik', kind: 'zentik', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: completeLoggerStub(logger),
    pruneWindows: ncPruneWindowsPort(),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async (ownerKind, ownerId) => {
        mediaLookups.push(`${ownerKind}:${ownerId}`)
        return mediaByOwner.get(ownerId) ?? []
      },
      renderEventMedia: async (req) => {
        mediaRequests.push(req)
        return {
          gif: req.wantGif ? Uint8Array.from([1, 2, 3]) : null,
          mp4: req.wantMp4 ? Uint8Array.from([4, 5, 6]) : null,
        }
      },
      getDeviceName: async () => 'Camera front door',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => NOW,
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
  })
  return { center, store, world, sends, lines, mediaLookups, mediaRequests }
}

async function boot(
  mediaByOwner: ReadonlyMap<string, readonly MediaFile[]>,
  rule: NcRuleInput = doorbellRule(),
): Promise<Harness> {
  const h = makeHarness(mediaByOwner)
  await h.center.start({ evaluation: true })
  await h.center.buildProvider().createRule({ rule, caller: CALLER })
  return h
}

describe('a device event carries the marker track’s picture', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('attaches the still resolved from the marker track — no device-event branch', async () => {
    h = await boot(new Map([[MARKER, markerMedia()]]))

    h.center.onSensorEventPersisted(press(), MARKER)
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image'])
    expect(attachments[0]?.mime).toBe('image/jpeg')
    // THE discriminating assertion: the frame came out of the ordinary
    // media-owner lookup, addressed to the marker TRACK. Remove the trackId
    // from the subject and this list is empty.
    expect(h.mediaLookups).toContain(`track:${MARKER}`)
  })

  it('freezes the device’s own event token on the outbox row, for {{eventType}}', async () => {
    h = await boot(new Map([[MARKER, markerMedia()]]))

    // An event-emitter slice (`EventEmitterStatus.lastEvent.eventType`) — the
    // only kind that carries a token; `readSensorEventType` (rule-engine.ts).
    h.center.onSensorEventPersisted(
      { ...press(), value: { lastEvent: { eventType: 'double_press' } } },
      MARKER,
    )
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    const rows = [...ncTable(h.world, 'outbox').values()]
    expect(rows[0]?.['payload']).toHaveProperty('subject.eventType', 'double_press')
  })

  it('freezes the rule’s ONE picture mode on the row — a pre-D897 doorbell rule keeps its clean snapshot', async () => {
    // A sensor rule's stored triple was ignored until D897, so its migration is
    // what it actually shipped: the clean scene. No legacy field reaches the row.
    h = await boot(
      new Map([[MARKER, markerMedia()]]),
      doorbellRule({
        media: { attach: 'best', frame: 'full', zoneCrop: true },
      }),
    )
    h.center.onSensorEventPersisted(press(), MARKER)
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    const rows = [...ncTable(h.world, 'outbox').values()]
    const payload = rows[0]?.['payload']
    expect(payload).toHaveProperty('mediaImage', 'clean')
    expect(payload).not.toHaveProperty('mediaFrame')
    expect(payload).not.toHaveProperty('mediaZoneIds')
    // A doorbell press is not a zone trigger: no overlay is frozen.
    expect(payload).not.toHaveProperty('mediaShowTriggerZone')
  })

  it('a doorbell rule that asks for scene-boxes freezes it — the selector is the sensor’s own now', async () => {
    h = await boot(
      new Map([[MARKER, markerMedia()]]),
      doorbellRule({ media: { image: 'scene-boxes' } }),
    )
    h.center.onSensorEventPersisted(press(), MARKER)
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    const rows = [...ncTable(h.world, 'outbox').values()]
    expect(rows[0]?.['payload']).toHaveProperty('mediaImage', 'scene-boxes')
  })

  it('without a marker it ships text-only, and says so per camera', async () => {
    // A camera-less device event, a debounced projection, a failed one: all one
    // state — nothing owns a frame of this press.
    h = await boot(new Map())

    h.center.onSensorEventPersisted(press())
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    const line = h.lines.find((l) => l.message.includes('no marker track'))
    expect(line?.level).toBe('warn')
    // Grouped by CAMERA — the question always arrives as "why did 101 …".
    expect(line?.tags).toEqual({ deviceId: CAMERA })
    expect(line?.meta?.['sensorKind']).toBe('doorbell')
  })

  it('a marker that landed without its snapshot is named too, not silent', async () => {
    // The marker exists (so the subject HAS an owner) and owns no media — the
    // snapshot timed out inside the bound. The dispatcher must say which.
    h = await boot(new Map([[MARKER, []]]))

    h.center.onSensorEventPersisted(press(), MARKER)
    // An owner that holds nothing is exactly the case the bounded still wait
    // exists for (NC_STILL_WAIT_MS), so this delivery is ~3 s late by design.
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    const line = h.lines.find((l) => l.message.includes('no still could be resolved'))
    expect(line?.tags).toEqual({ deviceId: CAMERA })
    expect(line?.meta?.['owners']).toEqual([`track:${MARKER}`])
  })

  it('cuts the gif and the clip the sensor rule asked for — the same media path as a detection (D897)', async () => {
    // From 2026-10-01 to D897 a sensor rule's stored gif/clip were ignored at
    // evaluation. D897 puts sensors on the same rules and the same path: what
    // the rule stores is what it ships.
    h = await boot(
      new Map([[MARKER, markerMedia()]]),
      doorbellRule({
        media: { attach: 'best', gif: true, clip: true, clipPreRollSec: 5, clipPostRollSec: 5 },
      }),
    )

    h.center.onSensorEventPersisted(press(), MARKER)
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    expect(h.mediaRequests.length).toBeGreaterThan(0)
    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments[0]?.mediaType).toBe('image')
    expect(h.lines.some((l) => l.message.includes('ignored at evaluation'))).toBe(false)
  })
})

/**
 * A sensor linked to NO camera (D630 §6). The pipeline hands it over through
 * `onUnownedSensorEvent` with the sensor as its own device and no marker — so
 * text-only is the DESIGN, and it must not read as "the marker went missing".
 */
describe('a sensor linked to no camera', () => {
  const CONTACT = 3243
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  function contactOpened(): SensorEvent {
    return {
      id: 'pa-sensor-unowned-1',
      deviceId: CONTACT,
      sourceDeviceId: CONTACT,
      kind: 'contact',
      value: { entryOpen: true },
      timestamp: NOW,
    }
  }

  it('fires a rule scoped on the sensor, text-only, without the missing-marker warn', async () => {
    h = await boot(
      new Map(),
      doorbellRule({ conditions: { devices: [CONTACT], sensorKinds: ['contact'] } }),
    )

    h.center.onUnownedSensorEvent(contactOpened(), [])
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))

    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    expect(h.lines.filter((l) => l.message.includes('no marker track'))).toEqual([])
    const line = h.lines.find((l) => l.message.includes('linked to no camera'))
    expect(line?.level).toBe('debug')
    expect(line?.tags).toEqual({ deviceId: CONTACT })
  })

  it('truly unlinked (no cameras): text-only and says "linked to no camera"', async () => {
    // Link-alone media (1+ cameras, not tracked) no longer uses this door —
    // see sensor-linked-wiring / sensor-linked-evaluation. Only zero cameras.
    h = await boot(
      new Map(),
      doorbellRule({ conditions: { devices: [CONTACT], sensorKinds: ['contact'] } }),
    )

    h.center.onUnownedSensorEvent(contactOpened(), [])
    await vi.waitFor(() => expect(h.sends).toHaveLength(1))
    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    const line = h.lines.find((l) => l.message.includes('linked to no camera'))
    expect(line?.level).toBe('debug')
    expect(h.lines.filter((l) => l.message.includes('none opted into tracked events'))).toEqual([])
  })

  // A rule scoped to a CAMERA is about that camera's events. A sensor-level
  // event is the sensor's own device — even when that camera links it (and did
  // not opt it into tracked events) — so the camera's rule stays silent.
  for (const linked of [[], [CAMERA]] as const) {
    it(`a rule scoped to a camera does not fire (linkedCameraIds=[${linked.join(',')}])`, async () => {
      h = await boot(
        new Map(),
        doorbellRule({ conditions: { devices: [CAMERA], sensorKinds: ['contact'] } }),
      )

      h.center.onUnownedSensorEvent(contactOpened(), linked)
      // Give the evaluation every chance to enqueue and drain.
      await new Promise((r) => setTimeout(r, 100))

      expect(h.sends).toEqual([])
    })
  }
})
