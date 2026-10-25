/**
 * Acceptance (D672): camera 103 "Camera porch" and the Home Assistant
 * PIR 3299 through the WHOLE orchestrator — the real addon, its real
 * subscriptions, the real camera-sensors controller and source, the real
 * session dispatcher — over the fake registry and a local event bus.
 *
 * The chain under test: `DeviceStateChanged (3299)` → `CameraSensorsSource` →
 * `MotionOnMotionChanged { 103, onboard, triggeredBy: sensor 3299 }` → the
 * session gate → `detection session: dispatched on motion`.
 *
 * The D475 row half of the chain lives in post-analysis
 * (`pipeline-analytics-e2e.spec.ts`, the D672 cases): one addon, one process.
 * What this file proves for the row is the input it depends on — while the PIR
 * stays high the bridge re-asserts `true` strictly inside
 * `MOTION_CLOSE_AFTER_MS`, always crediting the first trigger, so the
 * `(103, 'onboard')` episode stays ONE row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_SESSION_OPEN_MS } from '../session-dispatch-controller.js'
import {
  createEvent,
  EventCategory,
  MOTION_CLOSE_AFTER_MS,
  type ProviderMotionData,
  providerMotionEvent,
} from '@camstack/types'
import type {
  IEventBus,
  IScopedLogger,
  MotionTriggeredBy,
  StreamSourceEntry,
  SystemEvent,
} from '@camstack/types'
import { createLocalTransport, LocalChildClient, LocalChildRegistry } from '@camstack/system'
import PipelineOrchestratorAddon from '../index.js'
import {
  type FakeDirectoryNode,
  type FakeSensorDevice,
  type FakeSettingsStore,
  type FakeRunner,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBrokerCap,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const PORCH = 103
const PIR = 3299
const PIR_REF = {
  addonId: 'provider-homeassistant',
  stableId:
    'ha:ha_001:dev:45269aa68c25b3951b36c83fdd1f87ce-binary_sensor.sensore_movimento_porch_motion',
} as const
const PIR_TRIGGER: MotionTriggeredBy = { kind: 'sensor', deviceId: PIR }
const GATE = 3301
const GATE_REF = {
  addonId: 'provider-homeassistant',
  stableId: 'ha:ha_001:dev:gate-contact',
} as const
const SENSORS_CONFIG = { sensors: [{ ...PIR_REF, mode: 'in-addition' }] } as const
/** The porch's stored detection wiring: on-motion, onboard only (as live). */
const PORCH_SETTINGS = {
  detectionMode: 'on-motion',
  motionSources: ['onboard'],
  motionStreamProfile: 'low',
  detectionStreamProfile: 'high',
  motionCooldownMs: 30_000,
} as const
/** Two profile slots, so a settings restart rebuilds a REAL config from the store. */
const PORCH_STREAMS: readonly StreamSourceEntry[] = [
  { id: 'sub', label: 'sub', protocol: 'rtsp', url: 'rtsp://porch/sub', profileHint: 'low' },
  { id: 'main', label: 'main', protocol: 'rtsp', url: 'rtsp://porch/main', profileHint: 'high' },
]

type MotionRegion = NonNullable<ProviderMotionData['regions']>[number]

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly tags: Readonly<Record<string, unknown>>
  readonly meta: Readonly<Record<string, unknown>>
}

interface LogExtras {
  readonly tags?: Readonly<Record<string, unknown>>
  readonly meta?: Readonly<Record<string, unknown>>
}

/** A logger that records every line with its merged tags. */
function makeCapturingLogger(
  lines: LogLine[],
  bound: Readonly<Record<string, unknown>> = {},
): IScopedLogger {
  const at =
    (level: LogLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      lines.push({
        level,
        message,
        tags: { ...bound, ...extras?.tags },
        meta: extras?.meta ?? {},
      })
    }
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => makeCapturingLogger(lines, bound),
    withTags: (tags: Readonly<Record<string, unknown>>) =>
      makeCapturingLogger(lines, { ...bound, ...tags }),
  }
}

/** Exposes the protected session registry, like `on-motion-session-cutover.spec.ts`. */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekHasActiveSession(deviceId: number): boolean {
    return this.sessionRegistry.has(deviceId)
  }

  peekSessionTrigger(deviceId: number): MotionTriggeredBy | undefined {
    return this.sessionRegistry.get(deviceId)?.triggeredBy
  }
}

interface Harness {
  readonly addon: TestOrchestrator
  readonly eventBus: IEventBus
  readonly captured: SystemEvent[]
  readonly store: FakeSettingsStore
  readonly runner: FakeRunner
  readonly lines: LogLine[]
}

interface BootOptions {
  /** The stored ref; the acceptance default is the PIR's live stableId. */
  readonly sensorsConfig?: unknown
  /** Run before `initialize`: the fake-timer case takes its baseline here. */
  readonly beforeInit?: () => void
  /** Live bound-caps override for the PIR (a provider restart). */
  readonly boundCaps?: Map<number, readonly string[]>
  /** Further sensors beside the PIR (default: the PIR alone). */
  readonly extraSensors?: readonly FakeSensorDevice[]
  /** The persisted enabled runner nodes (default `['hub']`). */
  readonly enabledNodes?: readonly string[]
  /** The registry's node list (`nodes.directory`); absent = the read fails. */
  readonly nodeDirectory?: readonly FakeDirectoryNode[]
  /** The camera's owning addon (default `test`, a provider that never wrote the slice). */
  readonly cameraOwner?: string
  /** `deviceProvider.getStatus` per provider (see `makeFakeContext`). */
  readonly providerSliceWriters?: Map<string, 'orchestrator' | null>
}

let current: TestOrchestrator | null = null

async function boot(opts: BootOptions = {}): Promise<Harness> {
  const lines: LogLine[] = []
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: 'hub' })
  wireRunnerToBroker(broker, 'hub', runner)
  const streamBroker = makeFakeStreamBrokerCap()
  streamBroker.register(PORCH, 'provider-hikvision', PORCH_STREAMS)
  const { ctx, eventBus, captured, store } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: [...(opts.enabledNodes ?? ['hub'])] },
    ...(opts.nodeDirectory === undefined ? {} : { nodeDirectory: opts.nodeDirectory }),
    ...(opts.cameraOwner === undefined
      ? {}
      : { cameraOwners: new Map([[PORCH, opts.cameraOwner]]) }),
    ...(opts.providerSliceWriters === undefined
      ? {}
      : { providerSliceWriters: opts.providerSliceWriters }),
    providers: { 'stream-broker': streamBroker },
    initialDeviceSettings: new Map([
      [
        PORCH,
        {
          ...PORCH_SETTINGS,
          cameraSensors: opts.sensorsConfig ?? SENSORS_CONFIG,
        },
      ],
    ]),
    sensorDevices: [
      { id: PIR, ...PIR_REF, name: 'Motion', capNames: ['motion'] },
      ...(opts.extraSensors ?? []),
    ],
    ...(opts.boundCaps ? { sensorBoundCaps: opts.boundCaps } : {}),
    logger: makeCapturingLogger(lines),
  })
  opts.beforeInit?.()
  const addon = new TestOrchestrator()
  current = addon
  await addon.initialize(ctx)
  // The orchestrator must KNOW the camera: it learns it from the stream broker's
  // slots in its own boot reconcile (200 ms debounce). A manual `startDetection`
  // bypasses `handleDeviceRegistered`, so under load that reconcile landed
  // mid-test, saw the camera as a gap, rebuilt its config and restarted
  // detection — deleting the session the test had just opened. Wait for the
  // reconcile to arm it instead.
  await waitUntil(() => lines.some((l) => l.message.startsWith('detection armed')), 5_000)
  return { addon, eventBus, captured, store, runner, lines }
}

async function bootReady(): Promise<Harness> {
  const h = await boot()
  await waitUntil(() => h.lines.some((l) => l.message === 'camera-sensors: attachment ready'))
  return h
}

function sensorState(
  h: Harness,
  deviceId: number,
  detected: boolean,
  lastDetectedAt: number,
): void {
  h.eventBus.emit({
    id: `evt-sensor-${deviceId}-${detected}-${lastDetectedAt}-${Math.random()}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceStateChanged,
    data: { deviceId, capName: 'motion', slice: { detected, lastDetectedAt } },
  })
}

function pirState(h: Harness, detected: boolean, lastDetectedAt: number): void {
  sensorState(h, PIR, detected, lastDetectedAt)
}

/** The camera's own firmware motion, as a provider pushes it (D673): raw, no `triggeredBy`. */
/**
 * A real UDS parent registry, wired to the harness bus exactly as the hub wires
 * its own (`moleculer.service.ts`: `lifecycleEvents` → the hub's bus).
 */
async function udsParent(h: Harness): Promise<{
  readonly child: (childId: string) => LocalChildClient
  readonly close: () => Promise<void>
}> {
  const socketNodeId = `accept-${process.pid}-${Math.random().toString(36).slice(2)}`
  const registry = new LocalChildRegistry({
    server: createLocalTransport().createServer(socketNodeId),
    lifecycleEvents: { parentNodeId: () => 'hub', emit: (event) => h.eventBus.emit(event) },
  })
  await registry.start()
  const children: LocalChildClient[] = []
  return {
    child: (childId) => {
      const c = new LocalChildClient({
        nodeId: socketNodeId,
        childId,
        caps: [],
        dispatch: async () => null,
      })
      children.push(c)
      return c
    },
    close: async () => {
      for (const c of children) await c.close()
      await registry.close()
    },
  }
}

function cameraPush(h: Harness, detected: boolean, regions?: MotionRegion[]): void {
  h.eventBus.emit(
    providerMotionEvent(
      { type: 'device', id: PORCH, deviceId: PORCH },
      {
        deviceId: PORCH,
        detected,
        timestamp: Date.now(),
        source: 'onboard',
        ...(regions === undefined ? {} : { regions }),
      },
    ),
  )
}

/** A genuine PIR rise: a quiet baseline, then a fresh `true`. */
function pirRise(h: Harness): void {
  pirState(h, false, 0)
  pirState(h, true, Date.now())
}

function motionEvents(h: Harness): readonly SystemEvent[] {
  return h.captured.filter((e) => e.category === EventCategory.MotionOnMotionChanged)
}

function bridgeEvents(h: Harness): readonly SystemEvent[] {
  return motionEvents(h).filter((e) => {
    const data: unknown = e.data
    return (
      typeof data === 'object' &&
      data !== null &&
      'triggeredBy' in data &&
      JSON.stringify(data.triggeredBy) === JSON.stringify(PIR_TRIGGER)
    )
  })
}

function linesTagged(h: Harness, message: string, deviceId: number): readonly LogLine[] {
  return h.lines.filter((l) => l.message === message && l.tags['deviceId'] === deviceId)
}

const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the camera status (an async read, which `waitUntil` cannot take) until it has `state`. */
async function waitForSensorsState(h: Harness, state: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await h.addon.getCameraStatus({ deviceId: PORCH })
    if (status.cameraSensors?.state === state) return
    if (Date.now() > deadline) {
      throw new Error(
        `cameraSensors never reached ${state}: ${JSON.stringify(status.cameraSensors)}`,
      )
    }
    await settle(10)
  }
}

describe('camera sensors acceptance — camera 103 + PIR 3299 (D672)', () => {
  afterEach(async () => {
    if (current) await current.shutdown()
    current = null
    vi.useRealTimers()
  })

  it('1. the status names the PIR ready, by stable ref, with its registry id and caps', async () => {
    const h = await boot()
    await waitForSensorsState(h, 'configured')
    const status = await h.addon.getCameraStatus({ deviceId: PORCH })
    expect(status.cameraSensors).toEqual({
      state: 'configured',
      cameraMotion: 'always',
      sensors: [
        {
          ...PIR_REF,
          mode: 'in-addition',
          state: 'ready',
          deviceId: PIR,
          name: 'Motion',
          caps: ['motion'],
        },
      ],
    })
  })

  it("2. a PIR rise is emitted as the CAMERA's onboard motion, naming the sensor", async () => {
    const h = await bootReady()
    pirRise(h)
    const emitted = motionEvents(h).map((e) => e.data)
    expect(emitted).toContainEqual(
      expect.objectContaining({
        deviceId: PORCH,
        detected: true,
        source: 'onboard',
        triggeredBy: PIR_TRIGGER,
      }),
    )
  })

  it('3. that event opens a session that names the sensor; the runner is told nothing of it', async () => {
    const h = await bootReady()
    pirRise(h)
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
    const dispatched = linesTagged(h, 'detection session: dispatched on motion', PORCH)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.meta).toMatchObject({ trigger: 'onboard', triggeredBy: PIR_TRIGGER })
    await waitUntil(() => h.runner.attachedCameras.has(PORCH))
    const attached = h.runner.attachedCameras.get(PORCH)
    expect(attached).toBeDefined()
    expect(attached).not.toHaveProperty('cameraSensors')
    expect(attached).not.toHaveProperty('triggeredBy')
  })

  // Pins the dispatcher's refire branch: it rearms and never re-registers.
  // The registry's own keep-first rule is not reachable from here (no
  // whole-addon path re-registers a live session); `session-triggered-by.spec.ts`
  // pins it directly.
  it("4. the camera's own motion during the session does not change who opened it", async () => {
    const h = await bootReady()
    pirRise(h)
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
    cameraPush(h, true)
    await settle()
    expect(h.addon.peekHasActiveSession(PORCH)).toBe(true)
    expect(h.addon.peekSessionTrigger(PORCH)).toEqual(PIR_TRIGGER)
  })

  it('5. a camera that stops listing onboard gets nothing from the bridge, and the drop is said', async () => {
    const h = await bootReady()
    await h.addon.applyDeviceSettingsPatch({
      deviceId: PORCH,
      patch: { motionSources: ['analyzer'] },
    })
    // The restart rebuilds the camera's config from the store: it now lists
    // `analyzer` only, so the gate that drops the bridge is `motionSources`.
    await waitUntil(
      () => linesTagged(h, 'Settings changed — restarting detection', PORCH).length > 0,
    )
    const before = bridgeEvents(h).length
    pirState(h, false, 0)
    pirState(h, true, Date.now())
    await settle()
    expect(bridgeEvents(h).length).toBe(before)
    const dropped = linesTagged(
      h,
      'camera-sensors: trigger not forwarded — the camera does not list `onboard`',
      PORCH,
    )
    expect(dropped).not.toHaveLength(0)
    expect(dropped[0]?.meta).toMatchObject({ detected: true, sources: ['analyzer'] })
    expect(h.addon.peekHasActiveSession(PORCH)).toBe(false)
    // …and the status says so: a ready PIR that can never fire is not healthy.
    const status = await h.addon.getCameraStatus({ deviceId: PORCH })
    expect(status.cameraSensors).toMatchObject({
      state: 'configured',
      notForwarded: 'onboard-not-listed',
      sensors: [{ state: 'ready', deviceId: PIR }],
    })
  })

  it('6. a sensor mode that does not exist is refused by name and the stored value is unchanged', async () => {
    const h = await bootReady()
    await expect(
      h.addon.applyDeviceSettingsPatch({
        deviceId: PORCH,
        patch: { cameraSensors: { sensors: [{ ...PIR_REF, mode: 'sometimes' }] } },
      }),
    ).rejects.toThrow('cameraSensors refused')
    expect(h.store.devices.get(PORCH)?.['cameraSensors']).toEqual(SENSORS_CONFIG)
  })

  it('7. null removes the attachment: not-configured, and a PIR rise emits nothing', async () => {
    const h = await bootReady()
    await h.addon.applyDeviceSettingsPatch({ deviceId: PORCH, patch: { cameraSensors: null } })
    await waitForSensorsState(h, 'not-configured')
    const before = motionEvents(h).length
    pirRise(h)
    await settle()
    expect(motionEvents(h).length).toBe(before)
  })

  it('10. an HA restart retracts and re-registers the PIR binding: it is re-attached and opens a session again', async () => {
    const boundCaps = new Map<number, readonly string[]>()
    const h = await boot({ boundCaps })
    await h.addon.getCameraStatus({ deviceId: PORCH })
    await waitForSensorsState(h, 'configured')
    const bindingsChanged = (reason: 'native-registered' | 'native-unregistered'): void => {
      h.eventBus.emit({
        id: `evt-bindings-${reason}`,
        timestamp: new Date(),
        source: { type: 'device', id: PIR },
        category: EventCategory.DeviceBindingsChanged,
        data: {
          deviceId: PIR,
          capName: 'motion',
          reason,
          addonId: PIR_REF.addonId,
          nodeId: 'hub',
        },
      })
    }
    const attachment = async (): Promise<unknown> => {
      const status = await h.addon.getCameraStatus({ deviceId: PORCH })
      return status.cameraSensors?.state === 'configured'
        ? status.cameraSensors.sensors[0]?.state
        : undefined
    }
    const waitAttachment = async (state: string): Promise<void> => {
      const deadline = Date.now() + 1000
      while ((await attachment()) !== state) {
        if (Date.now() > deadline) throw new Error(`attachment never reached ${state}`)
        await settle(10)
      }
    }
    await waitAttachment('ready')
    // HA shuts down: the provider decommissions the device and retracts `motion`.
    boundCaps.set(PIR, [])
    bindingsChanged('native-unregistered')
    await waitAttachment('unsupported')
    // HA is back: the binding re-registers.
    boundCaps.delete(PIR)
    bindingsChanged('native-registered')
    await waitAttachment('ready')
    pirRise(h)
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
    expect(h.addon.peekSessionTrigger(PORCH)).toEqual(PIR_TRIGGER)
  })

  it('8. shutdown leaves no camera-sensors interval armed', async () => {
    // Only intervals are faked: the sustain tick is one, so "count after
    // shutdown equals count before init" proves the teardown stops it.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let baseline = -1
    const h = await boot({
      beforeInit: () => {
        baseline = vi.getTimerCount()
      },
    })
    await waitUntil(() => h.lines.some((l) => l.message === 'camera-sensors: attachment ready'))
    pirRise(h)
    expect(bridgeEvents(h)).not.toHaveLength(0)
    expect(vi.getTimerCount()).toBeGreaterThan(baseline)
    await h.addon.shutdown()
    current = null
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('9. a PIR held high re-asserts the camera inside the D475 close window, crediting the first trigger', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = await bootReady()
    pirRise(h)
    const afterRise = bridgeEvents(h).length
    // Just under the close window: at least one sustain tick must land, or
    // the (103,'onboard') row would close and a second row would open.
    vi.advanceTimersByTime(MOTION_CLOSE_AFTER_MS - 1)
    const ticks = bridgeEvents(h).slice(afterRise)
    expect(ticks.length).toBeGreaterThanOrEqual(1)
    for (const tick of ticks) {
      expect(tick.data).toMatchObject({
        deviceId: PORCH,
        detected: true,
        source: 'onboard',
        triggeredBy: PIR_TRIGGER,
      })
    }
  })

  it("11. Replace: 103's VMD alone opens no session; PIR 3299 opens it, naming the sensor", async () => {
    const h = await boot({ sensorsConfig: { sensors: [{ ...PIR_REF, mode: 'replace' }] } })
    await waitUntil(() => h.lines.some((l) => l.message === 'camera-sensors: attachment ready'))
    cameraPush(h, true)
    await settle()
    expect(h.addon.peekHasActiveSession(PORCH)).toBe(false)
    expect(
      motionEvents(h).filter((e) => JSON.stringify(e.data).includes('"onboard"')),
    ).toHaveLength(0)
    expect(linesTagged(h, 'camera-sensors: camera motion not counted', PORCH)).not.toHaveLength(0)
    pirRise(h)
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
    expect(h.addon.peekSessionTrigger(PORCH)).toEqual(PIR_TRIGGER)
  })

  it('12. Confirm with Replace: a gate contact open 5 s before the VMD makes the VMD count — one session, named camera, confirmedBy the contact', async () => {
    const h = await boot({
      sensorsConfig: {
        sensors: [
          { ...PIR_REF, mode: 'replace' },
          { ...GATE_REF, mode: 'confirm' },
        ],
      },
      extraSensors: [{ id: GATE, ...GATE_REF, name: 'Gate', capNames: ['motion'] }],
    })
    await waitUntil(
      () => h.lines.filter((l) => l.message === 'camera-sensors: attachment ready').length === 2,
    )
    sensorState(h, GATE, false, 0)
    sensorState(h, GATE, true, Date.now() - 5_000)
    cameraPush(h, true)
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
    expect(h.addon.peekSessionTrigger(PORCH)).toEqual({ kind: 'camera' })
    expect(linesTagged(h, 'detection session: dispatched on motion', PORCH)).toHaveLength(1)
    const counted = linesTagged(h, 'camera-sensors: camera motion counted', PORCH)
    expect(counted).toHaveLength(1)
    expect(counted[0]?.meta).toMatchObject({ confirmedBy: [GATE] })
  })

  it('13. an HA restart under Replace: the PIR`s retracted binding hands the camera back (VMD opens a session), re-registered it is dropped again', async () => {
    const boundCaps = new Map<number, readonly string[]>()
    const h = await boot({
      boundCaps,
      sensorsConfig: { sensors: [{ ...PIR_REF, mode: 'replace' }] },
    })
    const attachment = async (): Promise<unknown> => {
      const status = await h.addon.getCameraStatus({ deviceId: PORCH })
      return status.cameraSensors?.state === 'configured'
        ? status.cameraSensors.sensors[0]?.state
        : undefined
    }
    const waitAttachment = async (state: string): Promise<void> => {
      const deadline = Date.now() + 1000
      while ((await attachment()) !== state) {
        if (Date.now() > deadline) throw new Error(`attachment never reached ${state}`)
        await settle(10)
      }
    }
    const bindingsChanged = (reason: 'native-registered' | 'native-unregistered'): void => {
      h.eventBus.emit({
        id: `evt-bindings-${reason}`,
        timestamp: new Date(),
        source: { type: 'device', id: PIR },
        category: EventCategory.DeviceBindingsChanged,
        data: {
          deviceId: PIR,
          capName: 'motion',
          reason,
          addonId: PIR_REF.addonId,
          nodeId: 'hub',
        },
      })
    }
    await waitAttachment('ready')
    boundCaps.set(PIR, [])
    bindingsChanged('native-unregistered')
    await waitAttachment('unsupported')
    cameraPush(h, true)
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
    expect(h.addon.peekSessionTrigger(PORCH)).toEqual({ kind: 'camera' })
    // A session closes on the camera's falling edge only after its minimum open
    // time (`MIN_SESSION_OPEN_MS`). This step used to pass because the boot
    // reconcile restarted detection mid-test and deleted the session; with the
    // camera armed by that reconcile, the floor is what it is — move the clock
    // past it and send the clear the camera would send.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    vi.setSystemTime(Date.now() + MIN_SESSION_OPEN_MS + 1)
    cameraPush(h, false)
    await waitUntil(() => !h.addon.peekHasActiveSession(PORCH))
    vi.useRealTimers()
    boundCaps.delete(PIR)
    bindingsChanged('native-registered')
    await waitAttachment('ready')
    const before = linesTagged(h, 'detection session: dispatched on motion', PORCH).length
    cameraPush(h, true)
    await settle()
    expect(h.addon.peekHasActiveSession(PORCH)).toBe(false)
    expect(linesTagged(h, 'detection session: dispatched on motion', PORCH)).toHaveLength(before)
  })

  it('14. an unsplit provider: a direct onboard emit under Replace still opens a session (fail open) and the status says it is not enforced', async () => {
    const h = await boot({ sensorsConfig: { sensors: [{ ...PIR_REF, mode: 'replace' }] } })
    await waitUntil(() => h.lines.some((l) => l.message === 'camera-sensors: attachment ready'))
    h.eventBus.emit({
      id: 'evt-porch-unsplit',
      timestamp: new Date(),
      source: { type: 'device', id: PORCH },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: PORCH, detected: true, timestamp: Date.now(), source: 'onboard' },
    })
    // Asked in the same tick as the emit: once the session attaches, the status
    // composer wants runner metrics this fake does not serve.
    const status = await h.addon.getCameraStatus({ deviceId: PORCH })
    expect(status.cameraSensors).toMatchObject({
      state: 'configured',
      notEnforced: 'provider-not-split',
    })
    await waitUntil(() => h.addon.peekHasActiveSession(PORCH))
  })

  it('15. the camera`s regions travel the real bridge: a raw push with regions is the effective event with the same regions', async () => {
    const h = await bootReady()
    const regions = [{ bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, pixelCount: 120, intensity: 0.5 }]
    cameraPush(h, true, regions)
    const effective = motionEvents(h).filter((e) => JSON.stringify(e.data).includes('"camera"'))
    expect(effective).toHaveLength(1)
    expect(effective[0]?.data).toMatchObject({
      deviceId: PORCH,
      source: 'onboard',
      triggeredBy: { kind: 'camera' },
      regions,
    })
  })

  it('16. D696 through the real addon: the boot census opens the slice gate, the camera`s motion slice is written, and a runner process coming up (WorkerOnline, as production sends it) closes the gate until it answers again', async () => {
    const h = await bootReady()
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
    const before = h.lines.length
    // A respawned runner is a FORKED process of its node: production sends it
    // `WorkerOnline { workerId: '<node>/<group>' }` (`agent-registry.service.ts`
    // `classifyNode`), never `AgentOnline`. The gate closes on that event, and
    // the census that follows reopens it.
    h.eventBus.emit(
      createEvent(
        EventCategory.WorkerOnline,
        { type: 'core', id: 'agent-registry' },
        { workerId: 'hub/detection' },
      ),
    )
    const after = (): readonly string[] => h.lines.slice(before).map((l) => l.message)
    expect(after().some((m) => m.startsWith('camera motion slice: writer gate closed'))).toBe(true)
    await waitUntil(
      () => after().some((m) => m.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
  })

  it('17. D696 review F2: an enabled agent the registry lists OFFLINE since boot does not block the slice writer', async () => {
    const h = await boot({
      enabledNodes: ['hub', 'agent-off'],
      nodeDirectory: [
        { id: 'hub', isOnline: true },
        { id: 'agent-off', isOnline: false },
      ],
    })
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
  })

  it('18. D696 re-review R2: the node`s pipeline-executor readiness with a NEW generation (its detection group came back) closes the slice gate before anything re-attaches', async () => {
    const h = await bootReady()
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    const before = h.lines.length
    // What a respawned `detection` process emits (`ReadinessRegistry.emitTransition`).
    h.eventBus.emit(
      createEvent(
        'system.ready-state',
        { type: 'capability', id: 'pipeline-executor', nodeId: 'hub/detection' },
        {
          capName: 'pipeline-executor',
          scope: { type: 'node', nodeId: 'hub' },
          state: 'ready',
          generation: 'respawned-detection-process',
          sourceNodeId: 'hub/detection',
          ts: Date.now(),
        },
      ),
    )
    const after = (): readonly string[] => h.lines.slice(before).map((l) => l.message)
    // Synchronously, on the readiness transition itself.
    expect(after().some((m) => m.startsWith('camera motion slice: writer gate closed'))).toBe(true)
    await waitUntil(
      () => after().some((m) => m.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
  })

  it('19. D696 re-review R2: an AgentOffline is the registry`s word that the node is gone — the gate stops waiting for it at once', async () => {
    const h = await boot({ enabledNodes: ['hub', 'agent-x'] })
    await waitUntil(
      () =>
        h.lines.some(
          (l) =>
            l.message.startsWith('camera motion slice: writer gate closed') &&
            JSON.stringify(l.meta).includes('agent-x'),
        ),
      5_000,
    )
    const before = h.lines.length
    h.eventBus.emit(
      createEvent(
        EventCategory.AgentOffline,
        { type: 'core', id: 'agent-registry' },
        { agentId: 'agent-x' },
      ),
    )
    // On the event itself, not after the census it also asks for.
    expect(
      h.lines
        .slice(before)
        .some((l) => l.message.startsWith('camera motion slice: writer gate open')),
    ).toBe(true)
  })
  it('20. D696 amended: a camera of an OLD provider (getStatus without motionSliceWriter) is never written, though the runner gate is open', async () => {
    const writers = new Map<string, 'orchestrator' | null>([['provider-hikvision', null]])
    const h = await boot({ cameraOwner: 'provider-hikvision', providerSliceWriters: writers })
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    await waitUntil(
      () =>
        h.lines.some(
          (l) =>
            l.level === 'warn' &&
            l.tags['deviceId'] === PORCH &&
            l.message.startsWith('camera motion slice: provider gate closed'),
        ),
      5_000,
    )
    cameraPush(h, true)
    await waitUntil(
      () => h.lines.some((l) => l.message === 'detection session: dispatched on motion'),
      5_000,
    )
    expect(h.store.deviceRuntimeStates.get(PORCH)?.['motion']).toBeUndefined()
  })

  it('21. D696 amended: a camera of a NEW provider (motionSliceWriter: orchestrator) is written', async () => {
    const h = await boot({
      cameraOwner: 'provider-hikvision',
      providerSliceWriters: new Map([['provider-hikvision', 'orchestrator']]),
    })
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
  })

  it('22. D696 amended, through the REAL UDS registry: a rolled-back provider`s pre-init register closes its camera by the time its start() resolves (here the bus is in-process; in production the event reaches the orchestrator as a UDS frame after the ack); its old answer keeps it closed', async () => {
    const writers = new Map<string, 'orchestrator' | null>([['provider-hikvision', 'orchestrator']])
    const h = await boot({ cameraOwner: 'provider-hikvision', providerSliceWriters: writers })
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
    const uds = await udsParent(h)
    // The rolled-back process: it answers WITHOUT the field, and it connects as
    // production does — `LocalChildClient.start()`, its pre-init register.
    writers.set('provider-hikvision', null)
    const before = h.lines.length
    const after = (): readonly LogLine[] => h.lines.slice(before)
    const rolledBack = uds.child('provider-hikvision')
    await rolledBack.start()
    // Closed by the time start() resolves: the child has loaded no addon yet, so
    // it has restored no device and seeded nothing. In this harness the bus is
    // in-process; in production the event crosses to the orchestrator as a UDS
    // frame AFTER the ack, which is the race `update-and-release.md` states.
    expect(
      after().some(
        (l) =>
          l.tags['deviceId'] === PORCH &&
          l.message.startsWith('camera motion slice: provider gate closed'),
      ),
    ).toBe(true)
    await waitUntil(
      () =>
        after().some(
          (l) =>
            l.level === 'warn' &&
            l.tags['deviceId'] === PORCH &&
            JSON.stringify(l.meta).includes('old-provider'),
        ),
      5_000,
    )
    const written = JSON.stringify(slice())
    cameraPush(h, false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(JSON.stringify(slice())).toBe(written)
    await uds.close()
  })

  it('23. D696 amended, through the REAL UDS registry: the provider process leaving (its socket closes) is WorkerOffline — its camera is written again, it cannot write', async () => {
    const writers = new Map<string, 'orchestrator' | null>([['provider-hikvision', null]])
    const h = await boot({ cameraOwner: 'provider-hikvision', providerSliceWriters: writers })
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    await waitUntil(
      () =>
        h.lines.some((l) => l.level === 'warn' && JSON.stringify(l.meta).includes('old-provider')),
      5_000,
    )
    const uds = await udsParent(h)
    const old = uds.child('provider-hikvision')
    await old.start()
    // Production: the hub unregisters the departed child, so its getStatus no longer answers.
    writers.delete('provider-hikvision')
    await old.close()
    await waitUntil(
      () =>
        h.lines.some(
          (l) =>
            l.tags['deviceId'] === PORCH &&
            l.message.startsWith('camera motion slice: provider gate open') &&
            JSON.stringify(l.meta).includes('gone'),
        ),
      5_000,
    )
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
    await uds.close()
  })

  it('24. D696 amended: a DROPPED WorkerOnline (telemetry) costs at most one stale window — the next runner census asks the provider gate again', async () => {
    const writers = new Map<string, 'orchestrator' | null>([['provider-hikvision', 'orchestrator']])
    const h = await boot({ cameraOwner: 'provider-hikvision', providerSliceWriters: writers })
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
    // Rolled back, and its WorkerOnline never arrived.
    writers.set('provider-hikvision', null)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 31_000)
    const before = h.lines.length
    // A session dispatch runs the runner census, which asks the provider gate.
    cameraPush(h, false)
    cameraPush(h, true)
    await waitUntil(
      () =>
        h.lines
          .slice(before)
          .some(
            (l) =>
              l.level === 'warn' &&
              l.tags['deviceId'] === PORCH &&
              JSON.stringify(l.meta).includes('old-provider'),
          ),
      5_000,
    )
  })
  it('25. R1-M1, through the REAL UDS registry: a decoder child restarting leaves the runner gate open and re-publishes nothing; the runner`s own child closes it', async () => {
    const h = await bootReady()
    await waitUntil(
      () => h.lines.some((l) => l.message.startsWith('camera motion slice: writer gate open')),
      5_000,
    )
    const slice = (): unknown => h.store.deviceRuntimeStates.get(PORCH)?.['motion']
    cameraPush(h, true)
    await waitUntil(() => JSON.stringify(slice() ?? null).includes('"detected":true'), 5_000)
    const uds = await udsParent(h)
    const before = h.lines.length
    const after = (): readonly string[] => h.lines.slice(before).map((l) => l.message)
    const decoder = uds.child('decoder-nodeav')
    await decoder.start()
    await decoder.close()
    const respawned = uds.child('decoder-nodeav')
    await respawned.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(after().filter((m) => m.startsWith('camera motion slice: writer gate closed'))).toEqual(
      [],
    )
    expect(after().filter((m) => m.startsWith('camera motion slice: re-published'))).toEqual([])
    expect(after().filter((m) => m.startsWith('camera motion slice: not writing'))).toEqual([])
    // The RUNNER's own child (`<node>/detection`) coming up still closes it.
    const runner = uds.child('detection')
    await runner.start()
    expect(after().some((m) => m.startsWith('camera motion slice: writer gate closed'))).toBe(true)
    await uds.close()
  })
})
