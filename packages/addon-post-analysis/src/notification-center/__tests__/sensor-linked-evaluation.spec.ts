/**
 * ONE sensor-level evaluation carrying the linked cameras' stills (ADR 0632).
 *
 * A sensor linked to several cameras used to be evaluated once per camera row,
 * so a rule shipped N notifications, each with whatever one camera's marker
 * held. The sensor-level door (`onSensorEvent`) evaluates it ONCE, with every
 * linked camera id on the subject and the shelf owners
 * (`beginLinkedStills`) as its media: the mosaic, or one still per camera.
 */
import { ncTable } from './support/nc-test-deps.js'
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords } from './support/nc-test-deps.js'
import type { NcRuleInput, SensorEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  type LogRecorder,
  makeFakeSettingsStore,
  makeLogRecorder,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { incomingFromSensorEvent } from '../event-intake.js'
import { type NcLinkedStillsRequest, NotificationCenter } from '../index.js'
import type { NcLinkedStills } from '../linked-stills.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 1_786_185_854_852
const SENSOR = 3243
const PRIMARY = 101
const LINKED = [101, 102, 620] as const

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly log: LogRecorder
  /** Every camera the centre asked the snapshot cap for. */
  readonly snapshotCalls: number[]
}

function sensorRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Porta front door',
    delivery: 'device-event',
    targets: [{ targetId: 'zentik' }],
    conditions: { devices: [SENSOR] },
    media: { attach: 'best' },
    throttle: { cooldownSec: 10, scope: 'rule-device' },
    ...overrides,
  })
}

/** The primary camera's view of one sensor change — `deviceId` is the camera. */
function sensorEvent(): SensorEvent {
  return {
    id: `pa-sensor-${Math.random().toString(36).slice(2, 10)}`,
    deviceId: PRIMARY,
    sourceDeviceId: SENSOR,
    kind: 'doorbell',
    value: { lastPressedAt: NOW },
    timestamp: NOW,
  }
}

function makeHarness(options: { readonly snapshotWired?: boolean } = {}): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const log = makeLogRecorder()
  const snapshotCalls: number[] = []
  const targets: NcTargetRef[] = [
    { id: 'zentik', addonId: 'notifiers', name: 'Zentik', kind: 'zentik', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: log.logger,
    // The production windows (every setting at its default), read as the addon does.
    pruneWindows: async () => resolvePruneWindows({}),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    ...(options.snapshotWired === false
      ? {}
      : {
          getSnapshot: async (deviceId: number) => {
            snapshotCalls.push(deviceId)
            return { base64: TINY_JPEG_B64, contentType: 'image/jpeg' }
          },
        }),
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      renderEventMedia: async () => ({ gif: null, mp4: null }),
      getDeviceName: async () => 'Camera front door',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => NOW,
    drainIntervalMs: 5,
    ruleReloadIntervalMs: 3_600_000,
  })
  return { center, store, world, sends, log, snapshotCalls }
}

async function boot(
  rule: NcRuleInput = sensorRule(),
  options: { readonly snapshotWired?: boolean } = {},
): Promise<Harness> {
  const h = makeHarness(options)
  await h.center.start({ evaluation: true })
  await h.center.buildProvider().createRule({ rule, caller: CALLER })
  return h
}

/** A capture request for the default doorbell sensor. */
function linkedRequest(
  cameraIds: readonly number[],
  atMs: number,
  rowCameraIds: readonly number[],
  sensorKind = 'doorbell',
): NcLinkedStillsRequest {
  return { sensorId: SENSOR, sensorKind, cameraIds, atMs, rowCameraIds }
}

/** The shelf's own (owner, camera) pairs — what the model is handed. */
function tilesOf(stills: NcLinkedStills | undefined): readonly unknown[] | undefined {
  return stills?.cameraOwnerIds.map((ownerId, i) => ({ ownerId, cameraId: stills.cameraIds[i] }))
}

async function outboxPayloads(h: Harness): Promise<readonly unknown[]> {
  const rows = [...ncTable(h.world, 'outbox').values()]
  return rows.map((r) => r['payload'])
}

describe('one sensor-level evaluation carries the linked stills', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('three linked cameras → ONE outbox row per target, carrying the mosaic owner', async () => {
    h = await boot()
    const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
    expect(stills).toBeDefined()
    h.center.onSensorEvent({
      event: sensorEvent(),
      linkedCameraIds: LINKED,
      rowCameraIds: [],
      ...(stills !== undefined ? { linkedStills: stills } : {}),
    })

    await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
    const [payload] = await outboxPayloads(h)
    expect(payload).toHaveProperty('subject.trackId', stills?.mosaicOwnerId)
    expect(payload).toHaveProperty('subject.linkedCameraIds', [...LINKED])
    // The model reads the raw tiles, never the composite (D154).
    expect(payload).toHaveProperty('subject.analysisTiles', tilesOf(stills))
    expect(payload).not.toHaveProperty('subject.extraStills')
  })

  it('the mosaic owner resolves through the ordinary media seam — the push carries a picture', async () => {
    h = await boot()
    const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
    h.center.onSensorEvent({
      event: sensorEvent(),
      linkedCameraIds: LINKED,
      rowCameraIds: [],
      ...(stills !== undefined ? { linkedStills: stills } : {}),
    })

    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 5_000 })
    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image'])
    expect([...h.snapshotCalls].sort()).toEqual([...LINKED])
  })

  it('media.linkedCameras each → the primary camera owner plus the others as extra stills', async () => {
    h = await boot(sensorRule({ media: { attach: 'best', linkedCameras: 'each' } }))
    const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
    h.center.onSensorEvent({
      event: sensorEvent(),
      linkedCameraIds: LINKED,
      rowCameraIds: [],
      ...(stills !== undefined ? { linkedStills: stills } : {}),
    })

    await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
    const [payload] = await outboxPayloads(h)
    expect(payload).toHaveProperty('subject.trackId', stills?.cameraOwnerIds[0])
    expect(payload).toHaveProperty(
      'subject.extraStills',
      stills?.cameraOwnerIds
        .slice(1)
        .map((ownerId, i) => ({ ownerId, cameraId: stills.cameraIds[i + 1] })),
    )
    expect(payload).toHaveProperty('subject.analysisTiles', tilesOf(stills))
    expect(payload).toHaveProperty('subject.linkedCameraIds', [...LINKED])
  })

  describe('two linked cameras, neither opted into tracked events (D630 §6 scope)', () => {
    const TWO = [101, 102] as const

    it('a rule scoped to one of the cameras does NOT fire — the set widens media, not matching', async () => {
      h = await boot(sensorRule({ conditions: { devices: [102] } }))
      // No rule that can fire here wants a picture: nothing is photographed.
      const stills = h.center.beginLinkedStills(linkedRequest(TWO, NOW, []))
      expect(stills).toBeUndefined()
      expect(h.snapshotCalls).toEqual([])
      h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: TWO, rowCameraIds: [] })

      // Give the evaluation every chance to enqueue.
      await new Promise((r) => setTimeout(r, 100))
      expect(await outboxPayloads(h)).toEqual([])
    })

    it('a rule scoped to the SENSOR fires, with the two-camera media', async () => {
      h = await boot(sensorRule({ conditions: { devices: [SENSOR] } }))
      const stills = h.center.beginLinkedStills(linkedRequest(TWO, NOW, []))
      expect(stills?.cameraIds).toEqual([...TWO])
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: TWO,
        rowCameraIds: [],
        ...(stills !== undefined ? { linkedStills: stills } : {}),
      })

      await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
      const [payload] = await outboxPayloads(h)
      expect(payload).toHaveProperty('subject.trackId', stills?.mosaicOwnerId)
      expect(payload).toHaveProperty('subject.linkedCameraIds', [...TWO])
      expect(payload).toHaveProperty('subject.analysisTiles', tilesOf(stills))
      await vi.waitFor(() => expect([...h.snapshotCalls].sort()).toEqual([...TWO]))
    })
  })

  describe('the capture gate asks only rules that could fire on THIS kind', () => {
    it('an unscoped doorbell rule never photographs a multi-linked MOTION change', async () => {
      h = await boot(sensorRule({ conditions: { sensorKinds: ['doorbell'] } }))
      expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW, [], 'motion'))).toBeUndefined()
      expect(h.snapshotCalls).toEqual([])
    })

    it('the same rule photographs a doorbell press', async () => {
      h = await boot(sensorRule({ conditions: { sensorKinds: ['doorbell'] } }))
      expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW, [], 'doorbell'))).toBeDefined()
    })

    it('a raise-only flood rule never photographs the back-to-dry edge (D640)', async () => {
      h = await boot(
        sensorRule({ conditions: { sensorKinds: ['flood'], sensorTransition: 'raised' } }),
      )
      const dry = { ...linkedRequest(LINKED, NOW, [], 'flood'), sensorRaised: false }
      expect(h.center.beginLinkedStills(dry)).toBeUndefined()
      expect(h.snapshotCalls).toEqual([])
    })

    it('the same rule photographs water detected, and an edge it cannot read', async () => {
      h = await boot(
        sensorRule({ conditions: { sensorKinds: ['flood'], sensorTransition: 'raised' } }),
      )
      const wet = { ...linkedRequest(LINKED, NOW, [], 'flood'), sensorRaised: true }
      expect(h.center.beginLinkedStills(wet)).toBeDefined()
      // Unknown is capture: the evaluation lets an unreadable edge through, so
      // the picture must exist for it.
      expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW + 1, [], 'flood'))).toBeDefined()
    })

    it('an occupancy rule (it rides device-event) never photographs a sensor change', async () => {
      h = await boot(
        sensorRule({
          conditions: { occupancy: { op: 'became-occupied', count: 1 } },
        }),
      )
      expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW, [], 'doorbell'))).toBeUndefined()
      expect(h.snapshotCalls).toEqual([])
    })
  })

  // A sensor rule's STORED media choice is ignored — it always attaches one
  // snapshot (operator ruling 2026-10-01, `effectiveMediaPolicyForRule`). A
  // stored `attach: 'none'` (authored before the ruling, or by an old viewer)
  // must not stop the capture, or the delivery asks an owner that was never
  // made and goes out text-only (fix round 1, M3).
  it("a sensor rule with a STORED attach:'none' still captures, and ships ONE image", async () => {
    h = await boot(sensorRule({ media: { attach: 'none' } }))
    const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
    expect(stills).toBeDefined()
    h.center.onSensorEvent({
      event: sensorEvent(),
      linkedCameraIds: LINKED,
      rowCameraIds: [],
      ...(stills !== undefined ? { linkedStills: stills } : {}),
    })

    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 5_000 })
    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('a rule scoped to an unrelated device → no capture is started', async () => {
    h = await boot(sensorRule({ conditions: { devices: [999] } }))
    expect(h.center.beginLinkedStills(linkedRequest([101, 102], NOW, []))).toBeUndefined()
    expect(h.snapshotCalls).toEqual([])
  })

  it('a rule that EXCLUDES the sensor (D641) → no capture is started', async () => {
    h = await boot(sensorRule({ conditions: { devicesExclude: [SENSOR] } }))
    expect(h.center.beginLinkedStills(linkedRequest([101, 102], NOW, []))).toBeUndefined()
    expect(h.snapshotCalls).toEqual([])
  })

  it('a rule excluding ONE row camera still photographs — the other row fires', async () => {
    h = await boot(sensorRule({ conditions: { devicesExclude: [101] } }))
    expect(h.center.beginLinkedStills(linkedRequest([101, 102], NOW, [101, 102]))).toBeDefined()
  })

  it('ONE linked camera (no tracked row) → shelf photographs that camera', async () => {
    h = await boot()
    const stills = h.center.beginLinkedStills(linkedRequest([101], NOW, []))
    expect(stills).toBeDefined()
    expect(stills?.cameraIds).toEqual([101])
    expect(h.snapshotCalls).toEqual([101])
  })

  it('a sensor-level row never logs "device event has no marker track"', async () => {
    h = await boot()
    const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
    h.center.onSensorEvent({
      event: sensorEvent(),
      linkedCameraIds: LINKED,
      rowCameraIds: [],
      ...(stills !== undefined ? { linkedStills: stills } : {}),
    })

    await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
    // Neither the per-camera "marker went missing" warn nor the linked-set
    // text-only warn: this row names photographs.
    expect(h.log.entries.some((l) => l.message.includes('no marker'))).toBe(false)
  })

  it('a linked set with no snapshot cap ships text-only and says so ON THE SENSOR', async () => {
    h = await boot(sensorRule(), { snapshotWired: false })
    expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))).toBeUndefined()
    h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: LINKED, rowCameraIds: [] })

    await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
    const line = h.log.entries.find((l) => l.message.includes('no linked-camera pictures'))
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ deviceId: SENSOR })
    expect(h.log.entries.some((l) => l.message.includes('no marker track'))).toBe(false)
  })

  it("…and with a STORED attach:'none' it still says so — the gate reads the EFFECTIVE policy", async () => {
    h = await boot(sensorRule({ media: { attach: 'none' } }), { snapshotWired: false })
    h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: LINKED, rowCameraIds: [] })

    await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
    const line = h.log.entries.find((l) => l.message.includes('no linked-camera pictures'))
    expect(line?.level).toBe('warn')
  })

  it('a rule-device cooldown is keyed by the PRIMARY camera', async () => {
    h = await boot()
    const fire = (cameras: readonly number[]): void =>
      h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: cameras, rowCameraIds: [] })

    fire([101, 102])
    fire([102, 101]) // another primary: its own window
    await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(2))
    fire([101, 620]) // the first primary again: still cooling down
    await new Promise((r) => setTimeout(r, 100))
    const payloads = await outboxPayloads(h)
    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toHaveProperty('subject.deviceId', 101)
    expect(payloads[1]).toHaveProperty('subject.deviceId', 102)
  })

  describe('mutes (D62): the SENSOR mutes the event, a camera mutes only its tile', () => {
    const mute = async (deviceId: number): Promise<void> => {
      await h.center.buildProvider().setDeviceMuted({ deviceId, muted: true })
    }

    it('a muted PRIMARY: the event still fires, led by the next camera, and 101 is never dialled', async () => {
      h = await boot()
      await mute(101)
      const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
      expect(stills?.cameraIds).toEqual([102, 620])
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: LINKED,
        rowCameraIds: [],
        ...(stills !== undefined ? { linkedStills: stills } : {}),
      })

      await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
      const [payload] = await outboxPayloads(h)
      expect(payload).toHaveProperty('subject.deviceId', 102)
      expect(payload).toHaveProperty('subject.trackId', stills?.mosaicOwnerId)
      expect(payload).toHaveProperty('subject.linkedCameraIds', [102, 620])
      await vi.waitFor(() => expect([...h.snapshotCalls].sort()).toEqual([102, 620]))
      const line = h.log.entries.find((l) => l.message.includes('linked camera muted'))
      expect(line?.extras?.tags).toEqual({ deviceId: 101 })
      expect(line?.extras?.meta).toMatchObject({ sensorId: SENSOR, reason: 'muted' })
    })

    it("a muted primary's MARKER is not the picture of the next camera", async () => {
      h = await boot()
      await mute(101)
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: LINKED,
        rowCameraIds: [],
        markerTrackId: 'pa-synth-marker-101',
      })

      await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
      const [payload] = await outboxPayloads(h)
      expect(payload).not.toHaveProperty('subject.trackId')
    })

    it('a muted NON-primary: its tile is absent and it is never dialled', async () => {
      h = await boot()
      await mute(102)
      const stills = h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
      expect(stills?.cameraIds).toEqual([101, 620])
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: LINKED,
        rowCameraIds: [],
        ...(stills !== undefined ? { linkedStills: stills } : {}),
      })

      await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
      const [payload] = await outboxPayloads(h)
      expect(payload).toHaveProperty('subject.deviceId', 101)
      expect(payload).toHaveProperty('subject.linkedCameraIds', [101, 620])
      await vi.waitFor(() => expect([...h.snapshotCalls].sort()).toEqual([101, 620]))
    })

    it('a muted SENSOR: the event is dropped, logged on the sensor, and nothing is dialled', async () => {
      h = await boot()
      await mute(SENSOR)
      expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))).toBeUndefined()
      h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: LINKED, rowCameraIds: [] })

      await vi.waitFor(() =>
        expect(h.log.entries.some((l) => l.message.includes('muted for this sensor'))).toBe(true),
      )
      const line = h.log.entries.find((l) => l.message.includes('muted for this sensor'))
      expect(line?.extras?.tags).toEqual({ deviceId: SENSOR })
      expect(await outboxPayloads(h)).toEqual([])
      expect(h.snapshotCalls).toEqual([])
    })

    it('EVERY linked camera muted: text-only, on the sensor, nothing dialled', async () => {
      h = await boot()
      for (const id of LINKED) await mute(id)
      expect(h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))).toBeUndefined()
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: LINKED,
        rowCameraIds: [],
        markerTrackId: 'pa-synth-marker-101',
      })

      await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
      const [payload] = await outboxPayloads(h)
      expect(payload).toHaveProperty('subject.deviceId', SENSOR)
      expect(payload).not.toHaveProperty('subject.trackId')
      expect(h.snapshotCalls).toEqual([])
      // The operator's own choice, said at INFO on the sensor — never the WARN
      // that reads as pictures that went missing.
      const line = h.log.entries.find((l) => l.message.includes('every linked camera is muted'))
      expect(line?.level).toBe('info')
      expect(line?.extras?.tags).toEqual({ deviceId: SENSOR })
      expect(h.log.entries.some((l) => l.message.includes('no linked-camera pictures'))).toBe(false)
    })

    describe('a camera mute reaches exactly as far as it did per row (D62)', () => {
      it('a contact linked to muted 101 only is silent (the per-row path)', async () => {
        h = await boot()
        await mute(101)
        h.center.onSensorEventPersisted(sensorEvent())

        await vi.waitFor(() =>
          expect(h.log.entries.some((l) => l.message.includes('muted for this camera'))).toBe(true),
        )
        expect(await outboxPayloads(h)).toEqual([])
      })

      it('+ a live-view link from 102 (not opted in): still silent — 102 took no row', async () => {
        h = await boot()
        await mute(101)
        expect(h.center.beginLinkedStills(linkedRequest([101, 102], NOW, [101]))).toBeUndefined()
        h.center.onSensorEvent({
          event: sensorEvent(),
          linkedCameraIds: [101, 102],
          rowCameraIds: [101],
        })

        await vi.waitFor(() =>
          expect(
            h.log.entries.some((l) =>
              l.message.includes('every camera that took its row is muted'),
            ),
          ).toBe(true),
        )
        const line = h.log.entries.find((l) =>
          l.message.includes('every camera that took its row is muted'),
        )
        expect(line?.extras?.tags).toEqual({ deviceId: SENSOR })
        expect(await outboxPayloads(h)).toEqual([])
        expect(h.snapshotCalls).toEqual([])
      })

      it('two opted-in cameras, BOTH muted: silent', async () => {
        h = await boot()
        await mute(101)
        await mute(102)
        expect(
          h.center.beginLinkedStills(linkedRequest([101, 102], NOW, [101, 102])),
        ).toBeUndefined()
        h.center.onSensorEvent({
          event: sensorEvent(),
          linkedCameraIds: [101, 102],
          rowCameraIds: [101, 102],
        })

        await new Promise((r) => setTimeout(r, 100))
        expect(await outboxPayloads(h)).toEqual([])
        expect(h.snapshotCalls).toEqual([])
      })

      it('two opted-in cameras, ONE muted: fires, and only the muted tile is dropped', async () => {
        h = await boot()
        await mute(101)
        const stills = h.center.beginLinkedStills(linkedRequest([101, 102], NOW, [101, 102]))
        expect(stills?.cameraIds).toEqual([102])
        h.center.onSensorEvent({
          event: sensorEvent(),
          linkedCameraIds: [101, 102],
          rowCameraIds: [101, 102],
          ...(stills !== undefined ? { linkedStills: stills } : {}),
        })

        await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
        const [payload] = await outboxPayloads(h)
        expect(payload).toHaveProperty('subject.deviceId', 102)
      })
    })

    it('exactly ONE camera left unmuted: its single still ships, and the row names no set', async () => {
      h = await boot()
      await mute(101)
      const stills = h.center.beginLinkedStills(linkedRequest([101, 102], NOW, []))
      expect(stills?.cameraIds).toEqual([102])
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: [101, 102],
        rowCameraIds: [],
        ...(stills !== undefined ? { linkedStills: stills } : {}),
      })

      await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 5_000 })
      const attachments = h.sends[0]?.notification.attachments ?? []
      expect(attachments.map((a) => a.mediaType)).toEqual(['image'])
      const [payload] = await outboxPayloads(h)
      expect(payload).toHaveProperty('subject.deviceId', 102)
      expect(payload).not.toHaveProperty('subject.linkedCameraIds')
      expect(h.snapshotCalls).toEqual([102])
    })

    it('a muted camera is said ONCE per window, not on every sensor change', async () => {
      h = await boot()
      await mute(101)
      h.center.beginLinkedStills(linkedRequest(LINKED, NOW, []))
      h.center.beginLinkedStills(linkedRequest(LINKED, NOW + 1, []))
      const lines = h.log.entries.filter((l) => l.message.includes('linked camera muted'))
      expect(lines).toHaveLength(1)
      expect(lines[0]?.extras?.tags).toEqual({ deviceId: 101 })
    })
  })

  /**
   * D630 §6 on a linked set: a camera's rule fires when that camera took a
   * timeline row for the sensor (it opted it in) — whether or not it is the
   * primary — and never when it merely links it.
   */
  describe('device scope: the sensor, and the cameras that took a row', () => {
    const TWO = [101, 102] as const

    it('a PRIMARY camera that did not opt in: its camera-scoped rule does NOT fire', async () => {
      h = await boot(sensorRule({ conditions: { devices: [101] } }))
      expect(h.center.beginLinkedStills(linkedRequest(TWO, NOW, [102]))).toBeUndefined()
      h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: TWO, rowCameraIds: [102] })

      await new Promise((r) => setTimeout(r, 100))
      expect(await outboxPayloads(h)).toEqual([])
      expect(h.snapshotCalls).toEqual([])
    })

    it('an opted-in NON-primary camera: its rule fires, with the set as media', async () => {
      h = await boot(sensorRule({ conditions: { devices: [102] } }))
      const stills = h.center.beginLinkedStills(linkedRequest(TWO, NOW, [102]))
      expect(stills?.cameraIds).toEqual([...TWO])
      h.center.onSensorEvent({
        event: sensorEvent(),
        linkedCameraIds: TWO,
        rowCameraIds: [102],
        ...(stills !== undefined ? { linkedStills: stills } : {}),
      })

      await vi.waitFor(async () => expect(await outboxPayloads(h)).toHaveLength(1))
      const [payload] = await outboxPayloads(h)
      expect(payload).toHaveProperty('subject.deviceId', 101)
      expect(payload).toHaveProperty('subject.trackId', stills?.mosaicOwnerId)
    })

    it('an opted-in camera that is MUTED: its rule does not fire', async () => {
      h = await boot(sensorRule({ conditions: { devices: [102] } }))
      await h.center.buildProvider().setDeviceMuted({ deviceId: 102, muted: true })
      expect(h.center.beginLinkedStills(linkedRequest(TWO, NOW, [102]))).toBeUndefined()
      h.center.onSensorEvent({ event: sensorEvent(), linkedCameraIds: TWO, rowCameraIds: [102] })

      await new Promise((r) => setTimeout(r, 100))
      expect(await outboxPayloads(h)).toEqual([])
    })
  })
})

describe('the sensor-level intake line', () => {
  it('is logged on the SENSOR, with the camera count', () => {
    const ctx = incomingFromSensorEvent(sensorEvent(), undefined, {
      linkedCameraIds: LINKED,
      rowCameraIds: [],
      mutedRowCameraIds: [],
    }).log()
    expect(ctx.tags).toEqual({ deviceId: SENSOR })
    expect(ctx.meta).toMatchObject({ primaryCameraId: PRIMARY, linkedCameras: 3, mutedCameras: 0 })
  })

  it('counts the muted cameras too', () => {
    const ctx = incomingFromSensorEvent(
      sensorEvent(),
      undefined,
      { linkedCameraIds: [101, 620], rowCameraIds: [], mutedRowCameraIds: [] },
      [102],
    ).log()
    expect(ctx.meta).toMatchObject({ primaryCameraId: PRIMARY, linkedCameras: 3, mutedCameras: 1 })
  })

  it('every camera muted: no primary camera is claimed — the sensor is its own device', () => {
    const ctx = incomingFromSensorEvent(
      { ...sensorEvent(), deviceId: SENSOR },
      undefined,
      { linkedCameraIds: [], rowCameraIds: [], mutedRowCameraIds: [] },
      LINKED,
    ).log()
    expect(ctx.tags).toEqual({ deviceId: SENSOR })
    expect(ctx.meta).not.toHaveProperty('primaryCameraId')
    expect(ctx.meta).toMatchObject({ linkedCameras: 3, mutedCameras: 3 })
  })
})
