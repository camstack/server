/**
 * `CameraSensorsController` (D672) — lifecycle. Resolution runs OFF the event
 * path, driven only by lifecycle events and coalesced through ONE in-flight
 * refresh with no timer (D3); the hot path routes a sensor's state to its
 * camera from memory alone; a camera nobody has read yet says "not loaded",
 * never "not configured" (R18, D315); and a refresh that lands after stop()
 * applies nothing.
 */
import { type CameraSensorsConfig, type IScopedLogger, type MotionSources } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CameraSensorsController, type CameraIdsRead } from '../camera-sensors/controller.js'
import type {
  CameraSensorDeviceRow,
  CameraSensorsResolverPorts,
  DeviceRowsRead,
  SourceCapsRead,
} from '../camera-sensors/resolver.js'
import { parseCameraSensorsSetting } from '../camera-sensors/settings.js'
import type { CameraSensorsSetting } from '../camera-sensors/settings.js'
import { type CameraSensorsMotion, CameraSensorsSource } from '../camera-sensors/source.js'

const CAM = 103
const CAM2 = 101
const PIR = 3299
const HA = 'provider-homeassistant'
const PIR_STABLE = 'ha:ha_001:dev:porch-binary_sensor.sensore_movimento_porch_motion'

const PORCH: CameraSensorsConfig = {
  sensors: [{ addonId: HA, stableId: PIR_STABLE, mode: 'in-addition' }],
}

interface LogLine {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

interface LogExtras {
  readonly tags?: Readonly<Record<string, unknown>>
  readonly meta?: Readonly<Record<string, unknown>>
}

type StoredSettings = Readonly<Record<number, Readonly<Record<string, unknown>>>>

interface HarnessOptions {
  readonly settings?: StoredSettings
  readonly holdSettings?: boolean
  readonly cameraIds?: readonly number[]
  readonly sources?: MotionSources
  /** Called with every info line, so a test can act from INSIDE a refresh. */
  readonly onInfo?: (message: string) => void
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function pirRow(overrides: Partial<CameraSensorDeviceRow> = {}): CameraSensorDeviceRow {
  return {
    id: PIR,
    addonId: HA,
    stableId: PIR_STABLE,
    name: 'Sensore movimento porch',
    online: true,
    disabled: false,
    isCamera: false,
    ...overrides,
  }
}

function harness(opts: HarnessOptions = {}) {
  const emitted: CameraSensorsMotion[] = []
  const logs: LogLine[] = []
  let settings: StoredSettings = opts.settings ?? {}
  let rows: readonly CameraSensorDeviceRow[] = [pirRow()]
  /** The source caps every device is bound to; `[]` = the provider retracted them. */
  let boundCaps: readonly string[] = ['motion']
  let cameraRead: CameraIdsRead = { kind: 'ids', ids: opts.cameraIds ?? [CAM] }
  let cameraListThrows: string | null = null
  let settingsGate: Deferred<void> | null = opts.holdSettings ? deferred<void>() : null
  let nextResolveGate: Deferred<void> | null = null
  const settingsReads: number[] = []
  let portCalls = 0

  const record =
    (level: string) =>
    (message: string, extras?: LogExtras): void => {
      logs.push({ level, message, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta })
      if (level === 'info') opts.onInfo?.(message)
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }

  const rowsRead = (match: (row: CameraSensorDeviceRow) => boolean): DeviceRowsRead => ({
    kind: 'rows',
    rows: rows.filter(match),
  })
  const ports: CameraSensorsResolverPorts = {
    logger,
    listByAddon: async (addonId) => {
      portCalls += 1
      return rowsRead((row) => row.addonId === addonId)
    },
    listByIds: async (ids) => {
      portCalls += 1
      return rowsRead((row) => ids.includes(row.id))
    },
    sourceCapsOf: async (ids): Promise<SourceCapsRead> => {
      portCalls += 1
      return { kind: 'caps', byDevice: new Map(ids.map((id) => [id, [...boundCaps]])) }
    },
  }

  const source = new CameraSensorsSource({
    logger,
    emitMotion: (motion) => {
      emitted.push(motion)
    },
    motionSourcesFor: () => opts.sources ?? ['onboard'],
    sustainMsFor: () => 15_000,
    cooldownMsFor: () => 30_000,
    maxHoldMsFor: () => 120_000,
    now: () => Date.now(),
  })

  const controller = new CameraSensorsController({
    logger,
    source,
    listCameraIds: async () => {
      if (cameraListThrows !== null) throw new Error(cameraListThrows)
      return cameraRead
    },
    readSetting: async (cameraId): Promise<CameraSensorsSetting> => {
      settingsReads.push(cameraId)
      if (settingsGate !== null) await settingsGate.promise
      if (nextResolveGate !== null) {
        const gate = nextResolveGate
        nextResolveGate = null
        await gate.promise
      }
      return parseCameraSensorsSetting(settings[cameraId] ?? {})
    },
    ports,
  })

  return {
    controller,
    source,
    emitted,
    logs,
    releaseSettings: (next: StoredSettings) => {
      settings = next
      settingsGate?.resolve()
      settingsGate = null
    },
    holdNextResolve: () => {
      nextResolveGate = deferred<void>()
    },
    releaseResolve: () => {
      nextResolveGate?.resolve()
    },
    /** One pass = one camera read through the resolver. */
    resolvePasses: () => settingsReads.length,
    settingsReads,
    setRows: (next: readonly CameraSensorDeviceRow[]) => {
      rows = next
    },
    setBoundCaps: (next: readonly string[]) => {
      boundCaps = next
    },
    setCameraRead: (next: CameraIdsRead) => {
      cameraRead = next
    },
    /** Make `listCameraIds` THROW (a dep that does not wrap its own call). */
    setCameraListThrows: (error: string | null) => {
      cameraListThrows = error
    },
    setSettings: (next: StoredSettings) => {
      settings = next
    },
    clearPortSpies: () => {
      portCalls = 0
    },
    portCalls: () => portCalls,
  }
}

async function booted(opts: HarnessOptions) {
  const h = harness(opts)
  await h.controller.start()
  await h.controller.idle()
  return h
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CameraSensorsController — lifecycle, coalescing, no I/O on the hot path', () => {
  it('reports NOT LOADED, not "not configured", before the first answered read', async () => {
    const h = harness({ holdSettings: true })
    void h.controller.start()
    expect(h.controller.statusFor(CAM)).toEqual({
      state: 'unreadable',
      reason: 'camera sensor mappings not loaded',
    })
    h.releaseSettings({ [CAM]: {} })
    await h.controller.idle()
    expect(h.controller.statusFor(CAM)).toEqual({ state: 'not-configured' })
  })

  it('coalesces a burst of lifecycle events into one extra pass, with no timer', async () => {
    vi.useFakeTimers()
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    h.holdNextResolve()
    h.controller.requestSensor(PIR, 'sensor-online-changed')
    h.controller.requestSensor(PIR, 'sensor-bindings-changed')
    h.controller.requestCamera(CAM, 'settings-updated')
    expect(vi.getTimerCount()).toBe(0)
    h.releaseResolve()
    await h.controller.idle()
    expect(h.resolvePasses()).toBe(3) // boot, the held pass, ONE coalesced follow-up
  })

  // RE-RUN THE DISARM WHENEVER THE CONTROLLER CHANGES (remove the `.finally`
  // re-kick; one depth must go RED). The window sits at depth 2 today; a
  // refactor that moves it past depth 5 leaves every case green and this gate
  // vacuous — widen the sweep if so.
  //
  // A request can land AFTER the drain loop's last check but BEFORE the
  // in-flight promise is cleared. It sees a refresh "in flight" and joins it;
  // only the re-kick in `.finally` keeps it from being lost. Where that window
  // sits in microtask ticks is an engine detail, so the request is fired at
  // several depths: every one of them must produce its own pass.
  it.each([
    1, 2, 3, 4, 5,
  ])('a request landing at microtask depth %i after the last refresh is never lost', async (depth) => {
    let armed = false
    let fired = false
    const fireAt = (remaining: number, h: ReturnType<typeof harness>): void => {
      if (remaining === 0) {
        h.controller.requestCamera(CAM, 'settings-updated')
        return
      }
      queueMicrotask(() => fireAt(remaining - 1, h))
    }
    const holder: { h: ReturnType<typeof harness> | null } = { h: null }
    const h = harness({
      settings: { [CAM]: { cameraSensors: PORCH } },
      onInfo: (message) => {
        if (!armed || fired || message !== 'camera-sensors: attachment ready') return
        fired = true
        if (holder.h !== null) fireAt(depth, holder.h)
      },
    })
    holder.h = h
    await h.controller.start()
    await h.controller.idle()
    // The attachment goes offline → ready again: the ready line is logged
    // at the very end of that refresh, and the request fires from there.
    h.setRows([pirRow({ online: false })])
    h.controller.requestSensor(PIR, 'sensor-online-changed')
    await h.controller.idle()
    h.setRows([pirRow()])
    armed = true
    const before = h.resolvePasses()
    h.controller.requestSensor(PIR, 'sensor-online-changed')
    await h.controller.idle()
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await h.controller.idle()
    expect(fired).toBe(true)
    expect(h.resolvePasses()).toBe(before + 2)
  })

  it('settings-updated refreshes that camera only; a referenced addon registering refreshes only cameras with a NOT-ready ref of it', async () => {
    const h = await booted({
      cameraIds: [CAM, CAM2],
      settings: { [CAM]: { cameraSensors: PORCH }, [CAM2]: {} },
    })
    expect([...h.settingsReads].sort()).toEqual([CAM2, CAM])
    h.settingsReads.length = 0
    h.controller.requestCamera(CAM2, 'settings-updated')
    await h.controller.idle()
    expect(h.settingsReads).toEqual([CAM2])
    h.settingsReads.length = 0
    // Every ref of HA is ready: a new HA device cannot change it.
    h.controller.requestAddon(HA)
    await h.controller.idle()
    expect(h.settingsReads).toEqual([])
    // The sensor is gone (two by-id misses, then a listing without it): missing.
    h.setRows([])
    h.controller.requestCamera(CAM, 'settings-updated')
    await h.controller.idle()
    expect(h.controller.statusFor(CAM)).toMatchObject({ sensors: [{ state: 'missing' }] })
    h.settingsReads.length = 0
    h.setRows([pirRow()])
    h.controller.requestAddon(HA)
    await h.controller.idle()
    expect(h.settingsReads).toEqual([CAM])
    expect(h.controller.statusFor(CAM)).toMatchObject({ sensors: [{ state: 'ready' }] })
    h.settingsReads.length = 0
    h.controller.requestAddon('provider-reolink')
    await h.controller.idle()
    expect(h.settingsReads).toEqual([])
  })

  it('a sensor event refreshes only the cameras that sensor feeds', async () => {
    const h = await booted({
      cameraIds: [CAM, CAM2],
      settings: { [CAM]: { cameraSensors: PORCH }, [CAM2]: {} },
    })
    h.settingsReads.length = 0
    h.controller.requestSensor(PIR, 'sensor-bindings-changed')
    await h.controller.idle()
    expect(h.settingsReads).toEqual([CAM])
  })

  it('a sensor whose binding was retracted and came back is re-attached and routes again (an HA restart)', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    expect(h.controller.watches(PIR)).toBe(true)
    // HA shuts down: every device is decommissioned, its native `motion`
    // binding retracted — one answered read with no source cap un-routes it.
    h.setBoundCaps([])
    h.controller.requestSensor(PIR, 'sensor-bindings-changed')
    await h.controller.idle()
    expect(h.controller.statusFor(CAM)).toMatchObject({
      sensors: [{ state: 'unsupported', deviceId: PIR }],
    })
    expect(h.controller.watches(PIR)).toBe(false)
    // HA is back: the binding re-registers. The camera no longer ROUTES the
    // sensor, but its status still NAMES it, so it is queued and re-attached.
    h.setBoundCaps(['motion'])
    h.controller.requestSensor(PIR, 'sensor-bindings-changed')
    await h.controller.idle()
    expect(h.controller.statusFor(CAM)).toMatchObject({
      sensors: [{ state: 'ready', deviceId: PIR }],
    })
    expect(h.controller.watches(PIR)).toBe(true)
    h.controller.onSensorState({
      sensorId: PIR,
      capName: 'motion',
      slice: { detected: false, lastDetectedAt: 0 },
      observedAtMs: Date.now(),
    })
    h.controller.onSensorState({
      sensorId: PIR,
      capName: 'motion',
      slice: { detected: true, lastDetectedAt: Date.now() },
      observedAtMs: Date.now(),
    })
    expect(h.emitted.at(-1)).toMatchObject({
      deviceId: CAM,
      detected: true,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
    h.controller.stop()
  })

  it('hands the source each routed sensor with its mode and readiness (D673 C1, C3)', async () => {
    const h = harness({
      settings: {
        [CAM]: {
          cameraSensors: { sensors: [{ addonId: HA, stableId: PIR_STABLE, mode: 'replace' }] },
        },
      },
    })
    const setInputs = vi.spyOn(h.source, 'setInputs')
    await h.controller.start()
    await h.controller.idle()
    expect(setInputs).toHaveBeenLastCalledWith(CAM, [
      { deviceId: PIR, mode: 'replace', ready: true },
    ])
    h.controller.stop()
  })

  it('an offline Replace sensor is handed to the source NOT ready — the camera gets its motion back (C3, review M1)', async () => {
    const h = harness({
      settings: {
        [CAM]: {
          cameraSensors: { sensors: [{ addonId: HA, stableId: PIR_STABLE, mode: 'replace' }] },
        },
      },
    })
    h.setRows([pirRow({ online: false })])
    const setInputs = vi.spyOn(h.source, 'setInputs')
    await h.controller.start()
    await h.controller.idle()
    expect(setInputs).toHaveBeenLastCalledWith(CAM, [
      { deviceId: PIR, mode: 'replace', ready: false },
    ])
    h.controller.stop()
  })

  it('a mode change is said, and so is the camera motion it changes (review M3)', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'camera-sensors: camera motion always',
        deviceId: CAM,
      }),
    )
    h.setSettings({
      [CAM]: {
        cameraSensors: { sensors: [{ addonId: HA, stableId: PIR_STABLE, mode: 'replace' }] },
      },
    })
    h.controller.requestCamera(CAM, 'settings-updated')
    await h.controller.idle()
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'camera-sensors: attachment ready',
        deviceId: CAM,
        meta: expect.objectContaining({ mode: 'replace', modeFrom: 'in-addition' }),
      }),
    )
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'camera-sensors: camera motion never',
        deviceId: CAM,
        meta: expect.objectContaining({ from: 'always', to: 'never' }),
      }),
    )
    h.controller.stop()
  })

  it('routes a PIR state change to the camera without any I/O', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    expect(h.controller.watches(PIR)).toBe(true)
    h.clearPortSpies()
    h.controller.onSensorState({
      sensorId: PIR,
      capName: 'motion',
      slice: { detected: false, lastDetectedAt: 0 },
      observedAtMs: 1,
    })
    h.controller.onSensorState({
      sensorId: PIR,
      capName: 'motion',
      slice: { detected: true, lastDetectedAt: 2 },
      observedAtMs: 2,
    })
    expect(h.emitted.at(-1)).toMatchObject({
      deviceId: CAM,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
    await h.controller.idle()
    expect(h.portCalls()).toBe(0)
    h.controller.stop()
  })

  it('logs an attachment going offline with the camera tag', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'camera-sensors: attachment ready',
        deviceId: CAM,
      }),
    )
    h.setRows([pirRow({ online: false })])
    h.controller.requestSensor(PIR, 'sensor-online-changed')
    await h.controller.idle()
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'camera-sensors: attachment offline',
        deviceId: CAM,
        meta: expect.objectContaining({ from: 'ready', to: 'offline', sensorDeviceId: PIR }),
      }),
    )
    // An offline sensor stays routed (R10): it emits nothing anyway.
    expect(h.controller.watches(PIR)).toBe(true)
  })

  it('a refresh in flight when stop() lands applies nothing', async () => {
    const h = harness({ holdSettings: true })
    void h.controller.start()
    // Stop only once the refresh is INSIDE its read: the loop guard alone
    // would stop a refresh that had not started yet.
    for (let i = 0; i < 20 && h.settingsReads.length === 0; i += 1) await Promise.resolve()
    expect(h.settingsReads).toEqual([CAM])
    h.controller.stop()
    h.releaseSettings({ [CAM]: { cameraSensors: PORCH } })
    await h.controller.idle()
    expect(h.controller.watches(PIR)).toBe(false)
    expect(h.controller.statusFor(CAM)).toEqual({
      state: 'unreadable',
      reason: 'camera sensor mappings not loaded',
    })
    h.controller.onSensorState({
      sensorId: PIR,
      capName: 'motion',
      slice: { detected: true, lastDetectedAt: Date.now() },
      observedAtMs: Date.now(),
    })
    expect(h.emitted).toEqual([])
  })

  it('an unreadable camera list leaves mappings unloaded and the next event retries the whole fleet', async () => {
    const h = harness({ settings: { [CAM]: { cameraSensors: PORCH } } })
    h.setCameraRead({ kind: 'unreadable', error: 'device-manager offline' })
    await h.controller.start()
    await h.controller.idle()
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'camera-sensors: camera list unreadable — mappings stay unloaded',
        meta: { error: 'device-manager offline' },
      }),
    )
    expect(h.settingsReads).toEqual([])
    expect(h.controller.watches(PIR)).toBe(false)
    h.setCameraRead({ kind: 'ids', ids: [CAM] })
    // A sensor event while unloaded cannot name its cameras: the whole fleet is retried.
    h.controller.requestSensor(PIR, 'sensor-online-changed')
    await h.controller.idle()
    expect(h.settingsReads).toEqual([CAM])
    expect(h.controller.watches(PIR)).toBe(true)
    expect(h.controller.statusFor(CAM)).toMatchObject({ state: 'configured' })
  })

  it('a camera list that THROWS is unreadable, not a rejected refresh; the next event retries', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = harness({ settings: { [CAM]: { cameraSensors: PORCH } } })
      h.setCameraListThrows('device-manager exploded')
      await h.controller.start()
      await h.controller.idle()
      await new Promise((resolve) => setImmediate(resolve))
      expect(rejections).toEqual([])
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: 'camera-sensors: camera list unreadable — mappings stay unloaded',
          meta: { error: 'device-manager exploded' },
        }),
      )
      h.setCameraListThrows(null)
      h.controller.requestSensor(PIR, 'sensor-online-changed')
      await h.controller.idle()
      expect(h.controller.watches(PIR)).toBe(true)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('a change line says why the refresh ran', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'camera-sensors: attachment ready',
        meta: expect.objectContaining({ reasons: ['boot'] }),
      }),
    )
    h.setRows([pirRow({ online: false })])
    h.controller.requestSensor(PIR, 'sensor-online-changed')
    await h.controller.idle()
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'camera-sensors: attachment offline',
        meta: expect.objectContaining({ reasons: ['sensor-online-changed'] }),
      }),
    )
  })

  it('reasons that meet in one pass are all said', async () => {
    const h = harness({ settings: { [CAM]: { cameraSensors: PORCH } } })
    const boot = h.controller.start()
    // Lands while the boot pass is reading the fleet: same pass, both reasons.
    h.controller.requestCamera(CAM, 'settings-updated')
    await boot
    await h.controller.idle()
    expect(h.logs.find((l) => l.message === 'camera-sensors: attachment ready')).toMatchObject({
      meta: { reasons: ['boot', 'settings-updated'] },
    })
  })

  it('a settings read that fails keeps the routing and says unreadable', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    h.setSettings({ [CAM]: { cameraSensors: { mode: 'confirm', sensors: [] } } })
    h.controller.requestCamera(CAM, 'settings-updated')
    await h.controller.idle()
    expect(h.controller.watches(PIR)).toBe(true)
    expect(h.controller.statusFor(CAM)).toMatchObject({ state: 'unreadable' })
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'camera-sensors: mapping unreadable',
        deviceId: CAM,
      }),
    )
  })

  it('forgetCamera drops the camera and its routing', async () => {
    const h = await booted({ settings: { [CAM]: { cameraSensors: PORCH } } })
    h.controller.forgetCamera(CAM)
    expect(h.controller.watches(PIR)).toBe(false)
    h.controller.stop()
  })
})
