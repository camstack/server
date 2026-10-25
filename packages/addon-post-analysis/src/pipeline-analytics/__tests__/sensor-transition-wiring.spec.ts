/**
 * The WIRING of the transition gate — booted addon, real bus, real ingest.
 *
 * `sensor-transition-gate.spec.ts` proves the predicate. This proves it is
 * actually ASKED: the gate is one line in `handleSensorStateChanged`, and a
 * unit test of the gate alone stays green with that line deleted. Which is the
 * whole defect — the predicate already existed in `@camstack/types`
 * (`evaluateSensorEdge`), the doorbell and the recorder already called it, and
 * post-analysis was the consumer that did not.
 *
 * The scenario is camera 101 / contact sensor 4131, 2026-08-30 03:22–04:45:
 * a Zigbee contact that flaps `off → unavailable → off` and a provider that
 * re-writes the cold slice on every device rebuild. Neither is a door opening.
 * Both produced a `SensorEvent` row and a synthetic `contact` track.
 */

import type { IScopedLogger, SensorEvent, Track } from '@camstack/types'
import { makeDeviceStateChangedEvent } from '../../__tests__/support/events.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from '../../notification-center/index.js'
import { MotionEpisodeTracker } from '../motion-episode-tracker.js'
import { SyntheticTrackMaterializer } from '../services/synthetic-track.js'
import {
  bootSensorWiring,
  FAKE_SNAPSHOT,
  flushSensorWiring,
  SENSOR_WIRING_CAMERA_ID,
  SENSOR_WIRING_SENSOR_ID,
  type SensorWiringBooted,
} from './sensor-wiring-harness.js'
import { type FakeEventBus, makeLogRecorder, makeSilentLogger } from './test-helpers.js'

const CAMERA_ID = SENSOR_WIRING_CAMERA_ID
const SENSOR_ID = SENSOR_WIRING_SENSOR_ID

type Booted = SensorWiringBooted

const flush = flushSensorWiring

/** Emit one `DeviceStateChanged` exactly as `device-state-mirror` does. */
function emitSlice(bus: FakeEventBus, capName: string, slice: Record<string, unknown>): void {
  bus.bus.emit(makeDeviceStateChangedEvent(SENSOR_ID, capName, slice))
}

async function boot(logger: IScopedLogger = makeSilentLogger()): Promise<Booted> {
  return bootSensorWiring({ logger })
}

describe('a contact that did not move produces neither a row nor a track', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('drops the cold-slice rebuild and the availability recovery, keeps the real cycle', async () => {
    booted = await boot()
    const { addon, bus } = booted
    const now = Date.now()

    // 1. `HaBinarySensorDevice`'s constructor, on a device rebuild.
    emitSlice(bus, 'contact', { entryOpen: false, lastChangedAt: 0 })
    await flush()
    // 2. The real state seconds later — hours-old transition, door still shut.
    emitSlice(bus, 'contact', { entryOpen: false, lastChangedAt: now - 3_600_000 })
    await flush()
    // 3. `unavailable → off`: fresh `lastChangedAt`, `entryOpen` unmoved.
    emitSlice(bus, 'contact', { entryOpen: false, lastChangedAt: now })
    await flush()

    expect(await addon.getSensorEvents({ deviceId: CAMERA_ID })).toEqual([])
    const quiet: readonly Track[] = await addon.listTracks({ deviceId: CAMERA_ID })
    expect(quiet.filter((t) => t.className === 'contact')).toEqual([])

    // 4. The door actually opens, then actually closes. BOTH are events.
    emitSlice(bus, 'contact', { entryOpen: true, lastChangedAt: now + 1_000 })
    await flush()
    emitSlice(bus, 'contact', { entryOpen: false, lastChangedAt: now + 12_000 })
    await flush()

    const rows: readonly SensorEvent[] = await addon.getSensorEvents({ deviceId: CAMERA_ID })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.value?.['entryOpen'])).toEqual([false, true])
    expect(rows.every((r) => r.sourceDeviceId === SENSOR_ID)).toBe(true)
  })

  it('never gates a cap that has no boolean level — three presses, three rows', async () => {
    booted = await boot()
    const { addon, bus } = booted
    const now = Date.now()
    // A doorbell carries no level: the ARRIVAL is the event. Gating it is the
    // silence of 2026-08-08, when 101's press produced a row, a ring, a
    // matched rule and no marker.
    for (let i = 0; i < 3; i++) {
      emitSlice(bus, 'doorbell', { lastPressedAt: now + i })
      await flush()
    }
    const rows = await addon.getSensorEvents({ deviceId: CAMERA_ID })
    expect(rows.filter((r) => r.kind === 'doorbell')).toHaveLength(3)
  })
})

/**
 * D630 §6 — a sensor linked to NO camera. The ingest writes no row (no camera
 * owns one) but the state change must still reach the Notification Center,
 * as its own device. Before, `no-camera` was a pure drop: an unlinked door
 * contact could never fire a rule, and so never trigger the alarm.
 */
describe('a sensor linked to no camera still reaches the notification rules', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('hands the camera-less event to the centre and writes no row', async () => {
    const UNLINKED = 3243
    const handed = vi
      .spyOn(NotificationCenter.prototype, 'onUnownedSensorEvent')
      .mockImplementation(() => undefined)
    booted = await boot()
    const { addon, bus } = booted

    const now = Date.now()
    const emit = (entryOpen: boolean, lastChangedAt: number): void =>
      bus.bus.emit(makeDeviceStateChangedEvent(UNLINKED, 'contact', { entryOpen, lastChangedAt }))
    // The shut baseline, then the door actually opening.
    emit(false, now - 60_000)
    await flush()
    emit(true, now)
    await flush()

    expect(handed).toHaveBeenCalledTimes(1)
    expect(handed.mock.calls[0]?.[0]).toMatchObject({
      deviceId: UNLINKED,
      sourceDeviceId: UNLINKED,
      kind: 'contact',
      value: { entryOpen: true },
    })
    expect(handed.mock.calls[0]?.[1]).toEqual([])
    expect(await addon.getSensorEvents({ deviceId: UNLINKED })).toEqual([])
  })

  it('a sensor linked only by an opted-out camera is evaluated once, naming that camera', async () => {
    const OPTED_OUT = 5150
    // Link alone owns notification media (D700, aaf37d743): ONE linked camera
    // with no tracked row takes the sensor-level door with that camera as its
    // media owner — never the unowned, text-only one.
    const unownedDoor = vi
      .spyOn(NotificationCenter.prototype, 'onUnownedSensorEvent')
      .mockImplementation(() => undefined)
    const handed = vi
      .spyOn(NotificationCenter.prototype, 'onSensorEvent')
      .mockImplementation(() => undefined)
    booted = await boot()
    const { addon, bus, deviceManager } = booted
    // Camera 101 links the sensor but did NOT opt it into tracked events:
    // no timeline row on 101, yet the sensor is not "linked to no camera".
    deviceManager.setLinkedCamera(CAMERA_ID, [
      { deviceId: SENSOR_ID, name: 'Contatto porta' },
      { deviceId: OPTED_OUT, name: 'Finestra', producesTrackedEvents: false },
    ])

    const now = Date.now()
    const emit = (entryOpen: boolean, lastChangedAt: number): void =>
      bus.bus.emit(makeDeviceStateChangedEvent(OPTED_OUT, 'contact', { entryOpen, lastChangedAt }))
    emit(false, now - 60_000)
    await flush()
    emit(true, now)
    await flush()

    expect(unownedDoor).not.toHaveBeenCalled()
    expect(handed).toHaveBeenCalledTimes(1)
    expect(handed.mock.calls[0]?.[0]).toMatchObject({
      event: { deviceId: CAMERA_ID, sourceDeviceId: OPTED_OUT, kind: 'contact' },
      linkedCameraIds: [CAMERA_ID],
      rowCameraIds: [],
    })
    expect(await addon.getSensorEvents({ deviceId: CAMERA_ID })).toEqual([])
    expect(await addon.getSensorEvents({ deviceId: OPTED_OUT })).toEqual([])
  })
})

/**
 * The hand-off to the Notification Center runs AFTER the ingest's own catch,
 * inside a handler the bus calls under `void`. A throw there used to be an
 * unhandled rejection with no device on it; it is a tagged warn now.
 */
describe('a notification-centre hand-off that throws is a tagged warn', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  function emitContact(bus: FakeEventBus, deviceId: number, entryOpen: boolean, at: number): void {
    bus.bus.emit(makeDeviceStateChangedEvent(deviceId, 'contact', { entryOpen, lastChangedAt: at }))
  }

  it('persisted rows: the throw is logged against the camera', async () => {
    vi.spyOn(NotificationCenter.prototype, 'onSensorEventPersisted').mockImplementation(() => {
      throw new Error('centre exploded')
    })
    const rec = makeLogRecorder()
    booted = await boot(rec.logger)
    const now = Date.now()
    emitContact(booted.bus, SENSOR_ID, false, now - 60_000)
    await flush()
    emitContact(booted.bus, SENSOR_ID, true, now)
    await flush()

    // The persisted path awaits the marker projection (a snapshot) before the
    // hand-off, so wait for the line rather than a fixed number of ticks — a
    // handler still running at shutdown is what threw "ctx accessed before
    // initialize()" into this file under load.
    const line = await vi.waitFor(() => {
      const found = rec.entries.find((e) =>
        e.message.includes('hand-off to the notification centre failed'),
      )
      expect(found).toBeDefined()
      return found
    })
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ deviceId: CAMERA_ID })
  })

  it('a sensor-level event: the throw is logged against the sensor', async () => {
    const UNLINKED = 3243
    vi.spyOn(NotificationCenter.prototype, 'onUnownedSensorEvent').mockImplementation(() => {
      throw new Error('centre exploded')
    })
    const rec = makeLogRecorder()
    booted = await boot(rec.logger)
    const now = Date.now()
    emitContact(booted.bus, UNLINKED, false, now - 60_000)
    await flush()
    emitContact(booted.bus, UNLINKED, true, now)
    await flush()

    // The persisted path awaits the marker projection (a snapshot) before the
    // hand-off, so wait for the line rather than a fixed number of ticks — a
    // handler still running at shutdown is what threw "ctx accessed before
    // initialize()" into this file under load.
    const line = await vi.waitFor(() => {
      const found = rec.entries.find((e) =>
        e.message.includes('hand-off to the notification centre failed'),
      )
      expect(found).toBeDefined()
      return found
    })
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ deviceId: UNLINKED })
  })
})

/**
 * A materialize that REJECTS for one camera is not a debounce: the skip is
 * reported on that camera with the error, and the caller logs it at WARN —
 * never at the debug level ordinary skips ride at.
 */
describe('a marker materialize that rejects is a warn on its camera', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('logs the rejection at warn with the camera tag, the sensor and the message', async () => {
    vi.spyOn(SyntheticTrackMaterializer.prototype, 'materializeOrShare').mockRejectedValue(
      new Error('persist exploded'),
    )
    const rec = makeLogRecorder()
    booted = await boot(rec.logger)
    const now = Date.now()
    emitSlice(booted.bus, 'contact', { entryOpen: false, lastChangedAt: now - 60_000 })
    await flush()
    emitSlice(booted.bus, 'contact', { entryOpen: true, lastChangedAt: now })
    await flush()

    const line = await vi.waitFor(() => {
      const found = rec.entries.find((e) =>
        e.message.includes('synthetic sensor-track materialize rejected'),
      )
      expect(found).toBeDefined()
      return found
    })
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ deviceId: CAMERA_ID })
    expect(line?.extras?.meta).toMatchObject({
      sourceDeviceId: SENSOR_ID,
      error: 'persist exploded',
      reason: 'not-materialized',
    })
  })
})

/**
 * The bus calls `handleSensorStateChanged` under `void`, so nothing awaits it —
 * and it awaits a snapshot (the marker) before its last `ctx` read. A shutdown
 * that tore the context down underneath it threw "ctx accessed before
 * initialize()" as an unhandled rejection, about one run in seven of this file.
 * Shutdown DRAINS the handlers already in flight before it tears anything down.
 */
describe('shutdown drains an in-flight sensor handler', () => {
  let booted: Booted | undefined
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }

  afterEach(async () => {
    process.off('unhandledRejection', onRejection)
    rejections.length = 0
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('waits for the handler, which finishes against a live context', async () => {
    process.on('unhandledRejection', onRejection)
    let release: () => void = () => undefined
    const held = new Promise<void>((r) => {
      release = r
    })
    const rec = makeLogRecorder()
    const { addon, bus } = await bootSensorWiring({
      logger: rec.logger,
      snapshot: {
        getSnapshot: {
          query: async () => {
            await held
            return FAKE_SNAPSHOT
          },
        },
      },
    })
    const now = Date.now()
    emitSlice(bus, 'contact', { entryOpen: false, lastChangedAt: now - 60_000 })
    await flush()
    // The door opens: the row lands, and the marker's snapshot is now HELD.
    emitSlice(bus, 'contact', { entryOpen: true, lastChangedAt: now })
    await flush()

    const shutdown = addon.shutdown()
    const early = await Promise.race([
      shutdown.then(() => 'shut down' as const),
      new Promise<'still draining'>((r) => setTimeout(() => r('still draining'), 300)),
    ])
    release()
    await shutdown
    await flush()

    expect(early).toBe('still draining')
    // The handler ran to its end against a live context: its marker line landed.
    expect(rec.entries.some((e) => e.message.includes('synthetic sensor-track projected'))).toBe(
      true,
    )
    expect(rejections).toEqual([])
  })

  it('the motion-episode close is not queued behind a handler that is still draining', async () => {
    const closed = vi.spyOn(MotionEpisodeTracker.prototype, 'closeAll')
    let release: () => void = () => undefined
    const held = new Promise<void>((r) => {
      release = r
    })
    const { addon, bus } = await bootSensorWiring({
      snapshot: {
        getSnapshot: {
          query: async () => {
            await held
            return FAKE_SNAPSHOT
          },
        },
      },
    })
    const now = Date.now()
    emitSlice(bus, 'contact', { entryOpen: false, lastChangedAt: now - 60_000 })
    await flush()
    emitSlice(bus, 'contact', { entryOpen: true, lastChangedAt: now })
    await flush()

    const shutdown = addon.shutdown()
    try {
      // The handler is still parked on its snapshot — and the episodes close anyway.
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith('addon-shutdown'), {
        timeout: 500,
      })
    } finally {
      release()
      await shutdown
    }
  })
})

/**
 * 2026-09-29, camera 101: one doorbell press reached post-analysis as TWO
 * `DeviceStateChanged(doorbell)` 7 ms apart. The second projection was
 * debounced into `null`, its notification had no marker, and it was the one
 * that won the rule — shipped without a still. Both hand-offs now name the
 * window's marker.
 */
describe('two state changes of one press name the SAME marker', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('both notification hand-offs carry the window marker trackId', async () => {
    const persisted = vi
      .spyOn(NotificationCenter.prototype, 'onSensorEventPersisted')
      .mockImplementation(() => {})
    booted = await boot()
    const now = Date.now()
    // Two slices whose stamp ADVANCES, 7 ms apart: both are presses to the
    // transition gate, and the second projection is debounced into the first
    // one's window — it must still name that window's marker.
    emitSlice(booted.bus, 'doorbell', { lastPressedAt: now, pressCountSinceStart: 1 })
    emitSlice(booted.bus, 'doorbell', { lastPressedAt: now + 7, pressCountSinceStart: 2 })
    await flush()

    await vi.waitFor(() => expect(persisted).toHaveBeenCalledTimes(2))
    const trackIds = persisted.mock.calls.map((call) => call[1])
    expect(trackIds[0]).toBeDefined()
    expect(trackIds[1]).toBe(trackIds[0])
    const markers = (await booted.addon.listTracks({ deviceId: CAMERA_ID })).filter(
      (t) => t.className === 'doorbell',
    )
    expect(markers).toHaveLength(1)
    expect(markers[0]?.snapshots.length).toBeGreaterThan(0)
  })

  it('a re-emitted slice with an OLDER stamp is not a second press (advance gate)', async () => {
    const persisted = vi
      .spyOn(NotificationCenter.prototype, 'onSensorEventPersisted')
      .mockImplementation(() => {})
    booted = await boot()
    const now = Date.now()
    // The 2026-09-29 shape: one press reached post-analysis twice, the second
    // carrying an older stamp. The doorbell is gated on `lastPressedAt`
    // strictly advancing, so only the first is a press — and it keeps its marker.
    emitSlice(booted.bus, 'doorbell', { lastPressedAt: now, pressCountSinceStart: 1 })
    emitSlice(booted.bus, 'doorbell', { lastPressedAt: now - 7, pressCountSinceStart: 0 })
    await flush()

    await vi.waitFor(() => expect(persisted).toHaveBeenCalledTimes(1))
    await flush()
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(persisted.mock.calls[0]?.[1]).toBeDefined()
    const markers = (await booted.addon.listTracks({ deviceId: CAMERA_ID })).filter(
      (t) => t.className === 'doorbell',
    )
    expect(markers).toHaveLength(1)
    expect(markers[0]?.snapshots.length).toBeGreaterThan(0)
  })
})

describe('a camera-resolved marker that did not materialize is a warn (review L3)', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('logs NOT materialized at warn on the camera', async () => {
    vi.spyOn(SyntheticTrackMaterializer.prototype, 'materializeOrShare').mockResolvedValue({
      kind: 'not-materialized',
    })
    const rec = makeLogRecorder()
    booted = await boot(rec.logger)
    emitSlice(booted.bus, 'doorbell', { lastPressedAt: Date.now() })
    await flush()

    const line = await vi.waitFor(() => {
      const found = rec.entries.find((e) => e.message.includes('sensor-track NOT materialized'))
      expect(found).toBeDefined()
      return found
    })
    expect(line?.level).toBe('warn')
    expect(line?.extras?.tags).toEqual({ deviceId: CAMERA_ID })
    expect(line?.extras?.meta).toMatchObject({
      sourceDeviceId: SENSOR_ID,
      reason: 'not-materialized',
    })
  })
})
