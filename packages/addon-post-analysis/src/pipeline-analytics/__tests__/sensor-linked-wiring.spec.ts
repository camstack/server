/**
 * `handleSensorStateChanged` for a sensor linked to SEVERAL cameras (ADR 0632)
 * — booted addon, real bus, real ingest, the notification centre spied.
 *
 * The capture set is started at the trigger, before the rows and markers are
 * awaited, and the change is evaluated ONCE at the sensor level — never once
 * per camera row. The timeline rows still honour the opt-in, and the cameras
 * that took one are what a camera-scoped rule matches on (D630 §6).
 */

import type { SensorEvent } from '@camstack/types'
import { makeDeviceStateChangedEvent } from '../../__tests__/support/events.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from '../../notification-center/index.js'
import type { NcLinkedStills } from '../../notification-center/linked-stills.js'
import { SyntheticTrackMaterializer } from '../services/synthetic-track.js'
import {
  bootSensorWiring,
  flushSensorWiring,
  type SensorWiringBooted,
  type SensorWiringLinks,
} from './sensor-wiring-harness.js'
import type { FakeEventBus } from './test-helpers.js'

const SENSOR = 3243

/** 101 opted the contact into tracked events; 102 only links it. */
const ONE_OPTED_IN: SensorWiringLinks = [
  [101, [{ deviceId: SENSOR, name: 'Contatto porta' }]],
  [102, [{ deviceId: SENSOR, name: 'Contatto porta', producesTrackedEvents: false }]],
]

const NONE_OPTED_IN: SensorWiringLinks = [
  [101, [{ deviceId: SENSOR, name: 'Contatto porta', producesTrackedEvents: false }]],
  [102, [{ deviceId: SENSOR, name: 'Contatto porta', producesTrackedEvents: false }]],
]

const FAKE_STILLS: NcLinkedStills = {
  sensorId: SENSOR,
  cameraIds: [101, 102],
  mosaicOwnerId: 'nc-linked-mosaic:test',
  cameraOwnerIds: ['nc-linked:101', 'nc-linked:102'],
}

function emitContact(bus: FakeEventBus, deviceId: number, entryOpen: boolean, at: number): void {
  bus.bus.emit(makeDeviceStateChangedEvent(deviceId, 'contact', { entryOpen, lastChangedAt: at }))
}

/** The shut baseline, then the door actually opening. */
async function openDoor(booted: SensorWiringBooted, deviceId = SENSOR): Promise<void> {
  const now = Date.now()
  emitContact(booted.bus, deviceId, false, now - 60_000)
  await flushSensorWiring()
  emitContact(booted.bus, deviceId, true, now)
  await flushSensorWiring()
}

function spyCentre() {
  return {
    begin: vi
      .spyOn(NotificationCenter.prototype, 'beginLinkedStills')
      .mockImplementation(() => undefined),
    linked: vi.spyOn(NotificationCenter.prototype, 'onSensorEvent').mockImplementation(() => {}),
    persisted: vi
      .spyOn(NotificationCenter.prototype, 'onSensorEventPersisted')
      .mockImplementation(() => {}),
    unowned: vi
      .spyOn(NotificationCenter.prototype, 'onUnownedSensorEvent')
      .mockImplementation(() => {}),
  }
}

describe('a sensor linked to several cameras is evaluated ONCE (ADR 0632)', () => {
  let booted: SensorWiringBooted | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('two linking cameras (one opted in, one not) → ONE evaluation carrying both', async () => {
    const nc = spyCentre()
    booted = await bootSensorWiring({ links: ONE_OPTED_IN })
    await openDoor(booted)

    await vi.waitFor(() => expect(nc.linked).toHaveBeenCalledTimes(1))
    expect(nc.persisted).not.toHaveBeenCalled()
    expect(nc.unowned).not.toHaveBeenCalled()
    const [input] = nc.linked.mock.calls[0] ?? []
    expect(input).toMatchObject({
      linkedCameraIds: [101, 102],
      rowCameraIds: [101],
      event: { deviceId: 101, sourceDeviceId: SENSOR, kind: 'contact' },
    })
    // The capture set got the SAME unfiltered list, and the opted-in cameras.
    expect(nc.begin).toHaveBeenCalledTimes(1)
    expect(nc.begin.mock.calls[0]?.[0]).toMatchObject({
      sensorId: SENSOR,
      sensorKind: 'contact',
      cameraIds: [101, 102],
      rowCameraIds: [101],
      // The edge, read off the same slice the evaluation reads (D640): an
      // opening is a raise, so a raise-only rule's capture is not skipped.
      sensorRaised: true,
    })
    // Timeline rows still honour the opt-in.
    const rows: readonly SensorEvent[] = await booted.addon.getSensorEvents({ deviceId: 101 })
    expect(rows).toHaveLength(1)
    expect(await booted.addon.getSensorEvents({ deviceId: 102 })).toEqual([])
    // The evaluation's record IS the primary camera's row.
    expect(input?.event.id).toBe(rows[0]?.id)
  })

  it('neither camera opted in → ONE evaluation, no row, never the unowned door', async () => {
    const nc = spyCentre()
    booted = await bootSensorWiring({ links: NONE_OPTED_IN })
    await openDoor(booted)

    await vi.waitFor(() => expect(nc.linked).toHaveBeenCalledTimes(1))
    expect(nc.unowned).not.toHaveBeenCalled()
    expect(nc.persisted).not.toHaveBeenCalled()
    const [input] = nc.linked.mock.calls[0] ?? []
    expect(input).toMatchObject({
      linkedCameraIds: [101, 102],
      rowCameraIds: [],
      event: { deviceId: 101, sourceDeviceId: SENSOR, kind: 'contact', value: { entryOpen: true } },
    })
    expect(input?.event.id).toMatch(/^pa-sensor-/)
    expect(await booted.addon.getSensorEvents({ deviceId: 101 })).toEqual([])
  })

  it('the capture set is started BEFORE the markers are awaited, and handed over', async () => {
    const order: string[] = []
    const nc = spyCentre()
    nc.begin.mockImplementation(() => {
      order.push('beginLinkedStills')
      return FAKE_STILLS
    })
    vi.spyOn(SyntheticTrackMaterializer.prototype, 'materializeOrShare').mockImplementation(
      async () => {
        order.push('materialize')
        return { kind: 'not-materialized' }
      },
    )
    booted = await bootSensorWiring({ links: ONE_OPTED_IN })
    await openDoor(booted)

    await vi.waitFor(() => expect(nc.linked).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['beginLinkedStills', 'materialize'])
    expect(nc.linked.mock.calls[0]?.[0].linkedStills).toBe(FAKE_STILLS)
  })

  it("one linking camera (tracked) → today's per-row path", async () => {
    const nc = spyCentre()
    booted = await bootSensorWiring({ links: [[101, [{ deviceId: SENSOR, name: 'Contatto' }]]] })
    await openDoor(booted)

    await vi.waitFor(() => expect(nc.persisted).toHaveBeenCalledTimes(1))
    expect(nc.linked).not.toHaveBeenCalled()
    expect(nc.begin).not.toHaveBeenCalled()
  })

  it('one linking camera (link only, not tracked) → shelf + sensor-level hand-off, no timeline row', async () => {
    const nc = spyCentre()
    booted = await bootSensorWiring({
      links: [[101, [{ deviceId: SENSOR, name: 'Contatto', producesTrackedEvents: false }]]],
    })
    await openDoor(booted)

    await vi.waitFor(() => expect(nc.linked).toHaveBeenCalledTimes(1))
    expect(nc.unowned).not.toHaveBeenCalled()
    expect(nc.persisted).not.toHaveBeenCalled()
    expect(nc.begin).toHaveBeenCalledTimes(1)
    expect(nc.begin.mock.calls[0]?.[0]).toMatchObject({
      sensorId: SENSOR,
      cameraIds: [101],
      rowCameraIds: [],
    })
    expect(await booted.addon.getSensorEvents({ deviceId: 101 })).toEqual([])
  })

  // A camera's own `motion` that no linking camera opted in is a DROP today
  // (`camera-native-cap`): cameras that merely link it must not turn it into
  // a notification — let alone a capture at motion rate.
  it("a camera's own motion no camera opted in stays a drop, however many link it", async () => {
    const CAMERA = 620
    const nc = spyCentre()
    booted = await bootSensorWiring({
      links: [
        [CAMERA, []],
        [101, [{ deviceId: CAMERA, name: 'Cortile', producesTrackedEvents: false }]],
        [102, [{ deviceId: CAMERA, name: 'Cortile', producesTrackedEvents: false }]],
      ],
    })
    const now = Date.now()
    const emit = (detected: boolean, at: number): void =>
      booted?.bus.bus.emit(
        makeDeviceStateChangedEvent(CAMERA, 'motion', { detected, lastDetectedAt: at }),
      )
    emit(false, now - 60_000)
    await flushSensorWiring()
    emit(true, now)
    await flushSensorWiring()
    await new Promise((r) => setTimeout(r, 50))

    expect(nc.begin).not.toHaveBeenCalled()
    expect(nc.linked).not.toHaveBeenCalled()
    expect(nc.unowned).not.toHaveBeenCalled()
  })
})
