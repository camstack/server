/**
 * The camera-sensors bridge wired into the orchestrator's subscriptions over a
 * local event bus, for the specs that drive a raw camera push (`ProviderMotion`)
 * or an attached sensor end to end (D673): the real `CameraSensorsSource` +
 * `CameraSensorsController` over fake ports, `wireOrchestratorSubscriptions`,
 * and the real `SessionDispatchController` behind block 9b.
 */
import {
  type CameraSensorsConfig,
  createEvent,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  type MotionOnMotionChangedData,
  MotionOnMotionChangedDataSchema,
  type MotionStatus,
  providerMotionEvent,
} from '@camstack/types'
import { CameraSensorsController } from '../camera-sensors/controller.js'
import { CameraMotionSlice } from '../camera-sensors/motion-slice.js'
import type { CameraSensorsResolverPorts } from '../camera-sensors/resolver.js'
import { type CameraSensorsSetting, parseCameraSensorsSetting } from '../camera-sensors/settings.js'
import { CameraSensorsSource } from '../camera-sensors/source.js'
import {
  type OrchestratorSubscriptionsDeps,
  wireOrchestratorSubscriptions,
} from '../orchestrator-subscriptions.js'
import { DEFAULT_MAX_SESSION_HOLD_MS } from '../session-dispatch-controller.js'
import { makeLocalEventBus } from './e2e-helpers.js'
import { makeHarness } from './session-dispatch-harness.js'

/** The camera and the attached PIR of the in-addition / wiring specs. */
export const HARNESS_CAMERA = 103
export const HARNESS_PIR = 3299
export const HARNESS_PIR_ADDON = 'provider-homeassistant'
export const HARNESS_PIR_STABLE_ID = 'ha:porch-pir'

/** The harness camera's config: the dispatch harness's cooldown, the schema-default max hold. */
export const HARNESS_COOLDOWN_MS = 30_000
export const HARNESS_MAX_HOLD_MS = DEFAULT_MAX_SESSION_HOLD_MS

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

/** One captured line: level, message, the device it names, its meta. */
export interface Line {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

interface LineExtras {
  readonly tags?: Readonly<Record<string, unknown>>
  readonly meta?: Readonly<Record<string, unknown>>
}

/** What a spec asks of session dispatch, over the existing `makeHarness`. */
export interface DispatchProbe {
  readonly settle: () => Promise<void>
  /** A session was dispatched for the camera at least once. */
  readonly dispatched: (deviceId: number) => boolean
  /** A session is open for the camera now. */
  readonly open: (deviceId: number) => boolean
}

export interface CameraSensorsWire {
  readonly lines: readonly Line[]
  readonly bus: IEventBus
  readonly dispatch: DispatchProbe
  /** The dispatch harness behind block 9b (the sessions it attached, its registry). */
  readonly sessions: ReturnType<typeof makeHarness>
  readonly controller: CameraSensorsController
  /** A camera's raw push: `ProviderMotion`, no `triggeredBy`. */
  readonly emitRaw: (deviceId: number, detected: boolean, regions?: readonly Region[]) => void
  /** An unsplit provider: `MotionOnMotionChanged { source: 'onboard' }` with no `triggeredBy`. */
  readonly emitDirect: (deviceId: number, detected: boolean) => void
  /** The attached PIR's `motion` level (a quiet baseline is taken first). */
  readonly raisePir: (on: boolean) => void
  /** The operator soft-disables / re-enables the PIR (`deviceManager.setDisabled`). */
  readonly setPirDisabled: (disabled: boolean) => void
  readonly onboardOnBus: () => readonly MotionOnMotionChangedData[]
  /** Every `motion` slice the orchestrator wrote (D696), in order. */
  readonly sliceWrites: readonly SliceWrite[]
  /** The fake hub's current `motion` slice of a device. */
  readonly hubSlice: (deviceId: number) => Readonly<Record<string, unknown>> | null
  /** Let the slice writer's queued writes land. */
  readonly settleSlice: () => Promise<void>
  readonly teardown: () => void
}

export interface SliceWrite {
  readonly deviceId: number
  readonly slice: MotionStatus
}

type Region = NonNullable<MotionOnMotionChangedData['regions']>[number]

export interface CameraSensorsWireOptions {
  /** The camera's stored setting; default: parsed from the config. */
  readonly readSetting?: () => Promise<CameraSensorsSetting>
  /** Do not run the boot pass: the camera's config is NOT loaded yet. */
  readonly skipBoot?: boolean
  /** The motion-slice writer gate (D696); default open (every runner says it does not write). */
  readonly writerOpen?: boolean
}

export async function wireCameraSensors(
  config: CameraSensorsConfig | null,
  options: CameraSensorsWireOptions = {},
): Promise<CameraSensorsWire> {
  const { bus, captured: events } = makeLocalEventBus()
  const lines: Line[] = []
  const record =
    (level: string) =>
    (message: string, extras?: LineExtras): void => {
      lines.push({ level, message, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta })
    }
  const captured: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => captured,
    withTags: () => captured,
  }
  const sessions = makeHarness({ sources: ['onboard'] })
  let pirDisabled = false
  const ports: CameraSensorsResolverPorts = {
    logger: silent,
    listByAddon: async () => ({
      kind: 'rows',
      rows: [
        {
          id: HARNESS_PIR,
          addonId: HARNESS_PIR_ADDON,
          stableId: HARNESS_PIR_STABLE_ID,
          name: 'PIR',
          online: true,
          disabled: pirDisabled,
          isCamera: false,
        },
      ],
    }),
    listByIds: async () => ({ kind: 'rows', rows: [] }),
    sourceCapsOf: async (ids) => ({
      kind: 'caps',
      byDevice: new Map(ids.map((id) => [id, ['motion']])),
    }),
  }
  const source = new CameraSensorsSource({
    logger: captured,
    emitMotion: (m) =>
      bus.emit(
        createEvent(
          EventCategory.MotionOnMotionChanged,
          { type: 'device', id: m.deviceId, deviceId: m.deviceId },
          {
            deviceId: m.deviceId,
            detected: m.detected,
            timestamp: m.timestamp,
            source: 'onboard',
            triggeredBy: m.triggeredBy,
            ...(m.regions === undefined ? {} : { regions: m.regions }),
          },
        ),
      ),
    motionSourcesFor: () => ['onboard'],
    sustainMsFor: () => 15_000,
    cooldownMsFor: () => HARNESS_COOLDOWN_MS,
    maxHoldMsFor: () => HARNESS_MAX_HOLD_MS,
    now: () => Date.now(),
  })
  const controller = new CameraSensorsController({
    logger: silent,
    source,
    listCameraIds: async () => ({ kind: 'ids', ids: [HARNESS_CAMERA] }),
    readSetting:
      options.readSetting ??
      (async () => parseCameraSensorsSetting(config === null ? {} : { cameraSensors: config })),
    ports,
  })
  if (options.skipBoot !== true) {
    await controller.start()
    await controller.idle()
  }
  const idle = async (): Promise<void> => undefined
  const sliceWrites: SliceWrite[] = []
  const hub = new Map<number, Readonly<Record<string, unknown>>>()
  const cameraMotionSlice = new CameraMotionSlice({
    logger: captured,
    writeSlice: async (deviceId, slice) => {
      sliceWrites.push({ deviceId, slice })
      hub.set(deviceId, slice)
    },
    readSlice: async (deviceId) => ({ kind: 'answered', slice: hub.get(deviceId) ?? null }),
    listCameraIds: async () => ({ kind: 'ids', ids: [HARNESS_CAMERA] }),
    motionSourcesFor: () => ['onboard'],
    windowMsFor: () => HARNESS_COOLDOWN_MS,
    maxHoldMsFor: () => HARNESS_MAX_HOLD_MS,
    now: () => Date.now(),
    onEdgeWhileClosed: () => undefined,
    // The harness camera's provider is not one that ever wrote the slice.
    isCameraOpen: () => true,
  })
  if (options.writerOpen !== false) await cameraMotionSlice.setWriterOpen(true)
  const deps: OrchestratorSubscriptionsDeps = {
    eventBus: bus,
    logger: captured,
    cameraSensors: controller,
    cameraMotionSlice,
    scheduleReconcile: () => undefined,
    handleDeviceRegistered: idle,
    handleDeviceUnregistered: idle,
    handleSettingsChanged: idle,
    handlePipelineCameraUpdated: idle,
    handleInferenceResult: idle,
    noteMetrics: () => undefined,
    handleLazyAudioMotion: idle,
    getActiveDetectionConfig: () => undefined,
    handleSessionMotion: (deviceId, detected, emittedAt, trigger, triggeredBy) =>
      sessions.controller.handleSessionMotion(deviceId, detected, emittedAt, trigger, triggeredBy),
    noteSessionSubjectPresent: () => undefined,
    noteSessionTrackedFrame: () => undefined,
    noteWatchdogSignal: () => undefined,
  }
  const unsubscribe = wireOrchestratorSubscriptions(deps)

  const emitRaw = (deviceId: number, detected: boolean, regions?: readonly Region[]): void => {
    bus.emit(
      providerMotionEvent(
        { type: 'device', id: deviceId, deviceId },
        {
          deviceId,
          detected,
          timestamp: Date.now(),
          source: 'onboard',
          ...(regions === undefined ? {} : { regions }),
        },
      ),
    )
  }
  const emitDirect = (deviceId: number, detected: boolean): void => {
    bus.emit(
      createEvent(
        EventCategory.MotionOnMotionChanged,
        { type: 'device', id: deviceId, deviceId },
        { deviceId, detected, timestamp: Date.now(), source: 'onboard' },
      ),
    )
  }
  const pirLevel = (detected: boolean, lastDetectedAt: number): void => {
    bus.emit({
      id: `pir-${lastDetectedAt}-${detected}-${Math.random()}`,
      timestamp: new Date(lastDetectedAt),
      source: { type: 'device', id: HARNESS_PIR },
      category: EventCategory.DeviceStateChanged,
      data: {
        deviceId: HARNESS_PIR,
        capName: 'motion',
        slice: { detected, lastDetectedAt },
      },
    })
  }
  let pirBaselined = false
  const raisePir = (on: boolean): void => {
    if (on && !pirBaselined) pirLevel(false, 0)
    pirBaselined = true
    pirLevel(on, Date.now())
  }
  const setPirDisabled = (disabled: boolean): void => {
    pirDisabled = disabled
    bus.emit(
      createEvent(
        disabled ? EventCategory.DeviceDisabled : EventCategory.DeviceEnabled,
        { type: 'device', id: HARNESS_PIR, deviceId: HARNESS_PIR },
        { deviceId: HARNESS_PIR, integrationId: 'ha_001' },
      ),
    )
  }
  const dispatch: DispatchProbe = {
    // Session dispatch is async but touches only in-memory fakes: a microtask drain settles it
    // (and works under fake timers, unlike a timer-based wait).
    settle: async () => {
      for (let i = 0; i < 200; i += 1) await Promise.resolve()
    },
    dispatched: (deviceId) =>
      sessions.lines.some(
        (l) =>
          l.message === 'detection session: dispatched on motion' &&
          l.tags['deviceId'] === deviceId,
      ),
    open: (deviceId) => sessions.controller.sessionRegistry.has(deviceId),
  }
  const onboardOnBus = (): readonly MotionOnMotionChangedData[] =>
    events.flatMap((event) => {
      if (event.category !== EventCategory.MotionOnMotionChanged) return []
      const parsed = MotionOnMotionChangedDataSchema.safeParse(event.data)
      return parsed.success && parsed.data.source === 'onboard' ? [parsed.data] : []
    })
  return {
    lines,
    bus,
    dispatch,
    sessions,
    controller,
    emitRaw,
    emitDirect,
    raisePir,
    setPirDisabled,
    onboardOnBus,
    sliceWrites,
    hubSlice: (deviceId) => hub.get(deviceId) ?? null,
    settleSlice: async () => {
      await dispatch.settle()
      await cameraMotionSlice.idle()
    },
    teardown: () => {
      unsubscribe()
      controller.stop()
      cameraMotionSlice.stop()
    },
  }
}
