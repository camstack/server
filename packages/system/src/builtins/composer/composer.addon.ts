/**
 * The `composer` builtin (D659): runs every declarative composition in ONE
 * isolated runner (`execution.isolate` + `group: composer`). It is
 * frame-free and low-crash, and its group is a group of ONE — no device
 * provider or data plane shares it, so a crash respawns nothing else (D29,
 * enforced by `scripts/check-runner-group-isolation.ts`). `CrashSupervisor`
 * bounds it like every forked runner (D6). Hub-only: declarations are cluster
 * state.
 *
 * Slice 2 (D663): a composition on an EXISTING device claims its fields on the
 * hub (`deviceState.claimFields` …) and reads its own replaced fields from the
 * native shadow (`getNativeCapSlice`, `device.native-shadow-changed`) — the one
 * subscriber that category has (`scripts/check-owner-only-events.ts`).
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  BaseAddon,
  buildCapabilityLookup,
  COMPOSER_ADDON_ID,
  composerCapability,
  type DeclaredDeviceRow,
  DeclaredDevices,
  DAY_MS,
  DEFAULT_HISTORY_RETENTION,
  errMsg,
  EventCategory,
  type HistoryRetention,
  type IComposerProvider,
  isReadingQuantity,
  type ProviderRegistration,
} from '@camstack/types'
import { isRecord, parseDeviceStateChanged } from '../shared/device-state-changed.js'
import { normalizedNativeOwner } from '../core-blocks/composition-sources.js'
import { invokeActuatorCall } from './actuator-invoke.js'
import { type ComposedDeviceHandle, isComposedDevice } from './composed-device.js'
import { Composer, type NativeShadowChangedData } from './composer.js'
import { NodeDeadlineTimer } from './deadline-timer.js'
import { historySeriesKey, pulseHistoryFromQuery } from './pulse-seed-resolve.js'
import { GraftHost } from './graft-host.js'
import { type BoundCapsRead, SourceTracker } from './source-tracker.js'

/** Ignored by `DeclaredDevices` whenever `integrationId` is supplied, which is always here. */
const DECLARED_INTEGRATION_NAME_UNUSED = 'Blocks'

/** The device-history query ceiling. A switch's raw tier is change-only, so this is the whole window. */
const PULSE_HISTORY_MAX_POINTS = 5_000

/** The owner-only shadow payload is not in the typed catalog: narrowed at the boundary, like `device.state-changed`. */
function parseNativeShadowChanged(data: unknown): NativeShadowChangedData | null {
  if (!isRecord(data)) return null
  const deviceId = data['deviceId']
  const capName = data['capName']
  const native = data['native']
  if (typeof deviceId !== 'number' || typeof capName !== 'string') return null
  if (!isRecord(native)) return null
  return { deviceId, capName, native }
}

export class ComposerAddon extends BaseAddon<Record<string, never>> {
  private composer: Composer | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const api = this.ctx.api
    const logger = this.ctx.logger
    /** ONE `getBindings`: the tracker's binding check and the target description share it. */
    const readBoundCaps = async (deviceId: number): Promise<BoundCapsRead> => {
      try {
        const bindings = await api.deviceManager.getBindings.query({ deviceId })
        return {
          kind: 'caps',
          caps: new Map(
            bindings.entries.flatMap((entry) => {
              const owner = normalizedNativeOwner(entry.nativeAddonId)
              return owner === null ? [] : [[entry.capName, owner] as const]
            }),
          ),
        }
      } catch (err: unknown) {
        return { kind: 'unreadable', error: errMsg(err) }
      }
    }
    const tracker = new SourceTracker({
      logger: logger.child('sources'),
      listDevicesOf: async (addonId) => {
        try {
          const rows = await api.deviceManager.listAll.query({ addonId, projection: 'slim' })
          return {
            kind: 'rows',
            rows: rows.map((r) => ({ id: r.id, stableId: r.stableId, type: r.type })),
          }
        } catch (err: unknown) {
          return { kind: 'unreadable', error: errMsg(err) }
        }
      },
      readSlice: async (deviceId, capName, view) => {
        try {
          const slice =
            view === 'native'
              ? await api.deviceState.getNativeCapSlice.query({ deviceId, capName })
              : await api.deviceState.getCapSlice.query({ deviceId, capName })
          return slice === null || slice === undefined ? { kind: 'none' } : { kind: 'slice', slice }
        } catch (err: unknown) {
          return { kind: 'unreadable', error: errMsg(err) }
        }
      },
      readBoundCaps,
    })
    // THE OWNER FILTER IS LOAD-BEARING: the sweep deletes every indexed row
    // not declared. Scoped to `composer`, it can never reach another owner —
    // and a composition on an EXISTING device declares nothing (D663).
    const listOwnDevices = async (): Promise<readonly DeclaredDeviceRow[]> =>
      api.deviceManager.listAll.query({ addonId: COMPOSER_ADDON_ID })
    const declared = new DeclaredDevices({
      logger: logger.child('declaration'),
      addonId: COMPOSER_ADDON_ID,
      devices: this.ctx.kernel.devices,
      localNodeId: this.ctx.kernel.localNodeId,
      // The composer NEVER mints an integration: `integrationId` is always
      // supplied (the Blocks integration `core-blocks` owns), so these are
      // unreachable. Throwing names the wiring mistake if that ever changes.
      getIntegration: async () => {
        throw new Error('composer: devices hang off the Blocks integration; it never reads its own')
      },
      createIntegration: async () => {
        throw new Error('composer: devices hang off the Blocks integration; it never mints one')
      },
      updateIntegration: async () => {
        throw new Error('composer: devices hang off the Blocks integration; it never updates one')
      },
      listOwnDevices,
    })
    const devices = this.ctx.kernel.devices
    const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
    // A graft is a native on a device this runner does not own, through
    // `createContext` — D659's unverified-live forked-runner path (live item 1);
    // Task 16 step 4.1 is its live proof.
    const grafts = new GraftHost(
      {
        createContext: (stableId, id) => devices.createContext(stableId, id),
        logger: logger.child('graft'),
      },
      lookupCap,
      async (deviceId, capName) =>
        (await api.deviceState.getCapSlice.query({ deviceId, capName })) ?? null,
    )
    this.composer = new Composer({
      logger: logger.child('composer'),
      tracker,
      lookupCap,
      readPersisted: async () =>
        (await listOwnDevices()).map((r) => ({ id: r.id, stableId: r.stableId })),
      declare: async (integrationId, declarations) => {
        const result = await declared.reconcile({
          integrationName: DECLARED_INTEGRATION_NAME_UNUSED,
          integrationId,
          devices: declarations,
        })
        const handles = new Map<string, ComposedDeviceHandle>()
        for (const outcome of result.devices) {
          if (isComposedDevice(outcome.device)) handles.set(outcome.stableId, outcome.device)
          else
            logger.error(
              'a declared composition is not a ComposedDevice — its caps cannot be written',
              {
                tags: { deviceId: outcome.deviceId },
                meta: { stableId: outcome.stableId },
              },
            )
        }
        return { devices: handles }
      },
      devices: {
        setName: (deviceId, name) => devices.setName(deviceId, name),
        decommission: (deviceId) => devices.decommission(deviceId),
        applyDerivedSpec: (deviceId, derived) => devices.applyDerivedSpec(deviceId, derived),
      },
      claims: {
        claimFields: (input) => api.deviceState.claimFields.mutate(input),
        patchOwnedFields: (input) => api.deviceState.patchOwnedFields.mutate(input),
        releaseClaim: (input) => api.deviceState.releaseClaim.mutate(input),
        listClaims: (input) => api.deviceState.listClaims.query(input),
      },
      events: this.ctx.eventBus,
      readExistingTargetCap: async (deviceId, capName) =>
        (await api.deviceState.getCapSlice.query({ deviceId, capName })) ?? null,
      readPulseHistory: async (deviceId, cap, fieldPath, fromMs, toMs) => {
        try {
          const result = await api.deviceHistory.query.query({
            deviceId,
            key: historySeriesKey(cap, fieldPath),
            from: fromMs,
            to: toMs,
            resolution: 'raw',
            maxPoints: PULSE_HISTORY_MAX_POINTS,
          })
          return { kind: 'series', series: pulseHistoryFromQuery(result.series) }
        } catch (err: unknown) {
          return { kind: 'unread', error: errMsg(err) }
        }
      },
      readHistory: (input) =>
        api.deviceHistory.query.query({
          deviceId: input.deviceId,
          key: input.key,
          from: input.from,
          to: input.to,
          resolution: input.resolution,
          maxPoints: input.maxPoints,
        }),
      readHistoryRetention: async () => {
        const raw = await api.addonSettingsRaw.getGlobal.query({ addonId: 'device-history' })
        return historyRetentionOf(raw)
      },
      readSourceQuantity: async (deviceId) => {
        const found = await api.deviceManager.getDevice.query({ deviceId })
        const quantity = found?.sourceInfo?.quantity
        return isReadingQuantity(quantity) ? quantity : null
      },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      describeTarget: readBoundCaps,
      grafts,
      now: () => Date.now(),
      newTimer: () => new NodeDeadlineTimer(() => Date.now()),
      readActuatorMember: async (deviceId) => {
        try {
          const bindings = await api.deviceManager.getBindings.query({ deviceId })
          const found = await api.deviceManager.getDevice.query({ deviceId })
          return {
            kind: 'ready',
            caps: bindings.entries.map((entry) => entry.capName),
            features: found === null ? [] : [...found.features],
          }
        } catch (err: unknown) {
          return { kind: 'unreadable', error: errMsg(err) }
        }
      },
      invokeActuator: (call) =>
        invokeActuatorCall(
          {
            switchSetState: async (deviceId, on) => {
              await api.switch.setState.mutate({ deviceId, on })
            },
            setBrightness: async (deviceId, level) => {
              await api.brightness.setBrightness.mutate({ deviceId, level })
            },
            setColor: async (deviceId, color) => {
              await api.color.setColor.mutate({ deviceId, color })
            },
            fanSetPercentage: async (deviceId, speed) => {
              await api.fanControl.setPercentage.mutate({ deviceId, speed })
            },
            fanSetPreset: async (deviceId, preset) => {
              await api.fanControl.setPreset.mutate({ deviceId, preset })
            },
            fanSetDirection: async (deviceId, direction) => {
              await api.fanControl.setDirection.mutate({ deviceId, direction })
            },
            fanSetOscillating: async (deviceId, oscillating) => {
              await api.fanControl.setOscillating.mutate({ deviceId, oscillating })
            },
            coverOpen: async (deviceId) => {
              await api.cover.open.mutate({ deviceId })
            },
            coverClose: async (deviceId) => {
              await api.cover.close.mutate({ deviceId })
            },
            coverStop: async (deviceId) => {
              await api.cover.stop.mutate({ deviceId })
            },
            coverSetPosition: async (deviceId, position) => {
              await api.cover.setPosition.mutate({ deviceId, position })
            },
            coverSetTiltPosition: async (deviceId, tiltPosition) => {
              await api.cover.setTiltPosition.mutate({ deviceId, tiltPosition })
            },
            valveOpen: async (deviceId) => {
              await api.valve.open.mutate({ deviceId })
            },
            valveClose: async (deviceId) => {
              await api.valve.close.mutate({ deviceId })
            },
            valveSetPosition: async (deviceId, position) => {
              await api.valve.setPosition.mutate({ deviceId, position })
            },
            lockLock: async (deviceId, code) => {
              await api.lockControl.lock.mutate({
                deviceId,
                ...(code === undefined ? {} : { code }),
              })
            },
            lockUnlock: async (deviceId, code) => {
              await api.lockControl.unlock.mutate({
                deviceId,
                ...(code === undefined ? {} : { code }),
              })
            },
            mediaPlay: async (deviceId) => {
              await api.mediaPlayer.play.mutate({ deviceId })
            },
            mediaPause: async (deviceId) => {
              await api.mediaPlayer.pause.mutate({ deviceId })
            },
            mediaSetVolume: async (deviceId, volumeLevel) => {
              await api.mediaPlayer.setVolume.mutate({ deviceId, volumeLevel })
            },
            climateSetMode: async (deviceId, mode) => {
              await api.climateControl.setMode.mutate({ deviceId, mode })
            },
            climateSetTarget: async (deviceId, target) => {
              await api.climateControl.setTarget.mutate({ deviceId, target })
            },
            climateSetFanMode: async (deviceId, fanMode) => {
              await api.climateControl.setFanMode.mutate({ deviceId, fanMode })
            },
          },
          call,
        ),
    })
    // `device.state-changed` is not in the typed catalog: the shared parser (R9).
    this.subscribe({ category: EventCategory.DeviceStateChanged }, (event) => {
      const data = parseDeviceStateChanged(event.data)
      if (data !== null)
        void this.composer?.onStateChanged(data).catch((err: unknown) => {
          this.logEventFailure('device.state-changed', data.deviceId, err)
        })
    })
    // The owner-only native shadow (D224, D663): the composer is its one subscriber.
    this.subscribe({ category: EventCategory.DeviceNativeShadowChanged }, (event) => {
      const data = parseNativeShadowChanged(event.data)
      if (data !== null)
        void this.composer?.onNativeChanged(data).catch((err: unknown) => {
          this.logEventFailure(EventCategory.DeviceNativeShadowChanged, data.deviceId, err)
        })
    })
    // These two ARE typed by `EventCatalog`: the overload gives `event.data` its shape.
    this.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
      void this.composer?.onDeviceUnregistered(event.data.deviceId).catch((err: unknown) => {
        this.logEventFailure('device.unregistered', event.data.deviceId, err)
      })
    })
    this.subscribe({ category: EventCategory.DeviceBindingsChanged }, (event) => {
      void this.composer?.onBindingsChanged(event.data).catch((err: unknown) => {
        this.logEventFailure('device.bindings-changed', event.data.deviceId, err)
      })
    })
    logger.info('composer ready — waiting for core-blocks to apply the compositions')
    return [{ capability: composerCapability, provider: this.buildProvider() }]
  }

  protected async onShutdown(): Promise<void> {
    this.composer?.shutdown()
    this.composer = null
  }

  /** An event handler never rejects unhandled: in a forked runner that is a crash strike (D6). */
  private logEventFailure(category: string, deviceId: number, err: unknown): void {
    this.ctx.logger.warn(
      'composer: handling a device event failed — the next event or apply re-reads',
      {
        tags: { deviceId },
        meta: { category, error: errMsg(err) },
      },
    )
  }

  private buildProvider(): IComposerProvider {
    return {
      applyBlocks: async (input) => this.requireComposer().apply(input),
      getStates: async ({ blockIds }) => ({
        states: [...this.requireComposer().getStates(blockIds)],
      }),
    }
  }

  private requireComposer(): Composer {
    if (this.composer === null) throw new Error('composer: not initialized')
    return this.composer
  }
}

export default ComposerAddon

/** `dayDays` of 0 keeps the daily tier forever (device-history). A missing number is the default. */
function historyRetentionOf(raw: Readonly<Record<string, unknown>>): HistoryRetention {
  return {
    rawMs: positiveDays(raw['rawDays'], DEFAULT_HISTORY_RETENTION.rawMs),
    fiveMinuteMs: positiveDays(raw['fiveMinuteDays'], DEFAULT_HISTORY_RETENTION.fiveMinuteMs),
    hourMs: positiveDays(raw['hourDays'], DEFAULT_HISTORY_RETENTION.hourMs),
    dayMs: positiveDaysOrForever(raw['dayDays']),
  }
}

function positiveDays(value: unknown, fallbackMs: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * DAY_MS
    : fallbackMs
}

function positiveDaysOrForever(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value * DAY_MS
}
