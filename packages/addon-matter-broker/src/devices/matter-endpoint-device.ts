import { z } from 'zod'
import {
  BaseDevice,
  switchCapability,
  brightnessCapability,
  colorCapability,
  lockControlCapability,
  coverCapability,
  registerPowerSwitch,
  climateControlCapability,
  powerMeterCapability,
  contactCapability,
  motionCapability,
  temperatureSensorCapability,
  humiditySensorCapability,
  pressureSensorCapability,
  ambientLightSensorCapability,
  batteryCapability,
  buttonCapability,
  floodCapability,
  smokeCapability,
  carbonMonoxideCapability,
  airQualitySensorCapability,
  valveCapability,
  eventEmitterCapability,
  EventCategory,
  createEvent,
  conventionalEventVocabulary,
  type EventEmitterStatus,
  type EventFire,
  type ValveStatus,
  HvacModeSchema,
  type BatteryStatus,
  type ClimateControlStatus,
  type ColorStatus,
  type CoverStatus,
  DeviceFeature,
  type DeviceContext,
  type InferNativeProvider,
  type LockControlStatus,
  type PowerMeterStatus,
} from '@camstack/types'
import { matterCommands, matterNodes } from '../matter-gateway.js'
import type { MatterAttributeReport, MatterEventReport } from '../matter-controller.js'
import { decodeMatterEvent, LOCK_EVENT_TYPES, SWITCH_EVENT_TYPES } from '../matter-event-decode.js'
import { decodeMatterAttribute, MatterAttributeId } from '../matter-attr-decode.js'
import {
  isLeakEndpoint,
  MatterClusterId,
  type MatterEndpointCap,
} from '../matter-cluster-mapping.js'
import { planDoorLockCommand } from '../matter-lock-command.js'

/**
 * Persisted config every Matter endpoint child carries. `nodeId`/`endpointId`
 * resolve the live endpoint; `brokerId` selects the fabric; `clusterIds` are the
 * endpoint's server clusters; `capabilities` is the derived cap list (the SAME
 * list the container computed, persisted so a restore needs no live controller).
 */
export const matterEndpointSchema = z.object({
  brokerId: z.string().min(1).describe('Registry broker id'),
  nodeId: z.string().min(1).describe('Matter operational node id'),
  endpointId: z.number().int().nonnegative().describe('Endpoint index within the node'),
  clusterIds: z.array(z.number().int().nonnegative()).default([]),
  deviceTypeIds: z.array(z.number().int().nonnegative()).default([]),
  attributes: z.array(z.string()).default([]),
  /** DoorLock FeatureMap carries Unbolting; absent = unknown (no Open). */
  lockUnbolting: z.boolean().optional(),
  /** A folded PowerSource-only endpoint whose reports feed this child's battery. */
  powerSourceEndpointId: z.number().int().nonnegative().optional(),
  capabilities: z.array(z.string()).default([]),
  system: z.literal('matter').optional(),
  integrationId: z.string().optional(),
})

export type MatterEndpointConfig = z.infer<typeof matterEndpointSchema>

/** The cap set this device class knows how to register. */
const KNOWN_CAPS: ReadonlySet<MatterEndpointCap> = new Set<MatterEndpointCap>([
  'switch',
  'brightness',
  'color',
  'lock-control',
  'cover',
  'climate-control',
  'power-meter',
  'contact',
  'motion',
  'temperature-sensor',
  'humidity-sensor',
  'pressure-sensor',
  'ambient-light-sensor',
  'battery',
  'button',
  'flood',
  'smoke',
  'carbon-monoxide',
  'air-quality-sensor',
  'valve',
  'event-emitter',
])

/** Which CamStack cap a decoded attribute patch updates → the cap's slice name. */
const CAP_SLICE_NAME: Readonly<Record<MatterEndpointCap, string>> = {
  switch: 'switch',
  brightness: 'brightness',
  color: 'color',
  'lock-control': 'lock-control',
  cover: 'cover',
  'climate-control': 'climate-control',
  'power-meter': 'power-meter',
  contact: 'contact',
  motion: 'motion',
  'temperature-sensor': 'temperature-sensor',
  'humidity-sensor': 'humidity-sensor',
  'pressure-sensor': 'pressure-sensor',
  'ambient-light-sensor': 'ambient-light-sensor',
  battery: 'battery',
  button: 'button',
  flood: 'flood',
  smoke: 'smoke',
  'carbon-monoxide': 'carbon-monoxide',
  'air-quality-sensor': 'air-quality-sensor',
  valve: 'valve',
  'event-emitter': 'event-emitter',
}

/** An event older than this on arrival is a resubscribe replay, not news. */
const EVENT_MAX_AGE_MS = 10 * 60_000

/** Cold-start climate-control slice (no readings yet). */
const COLD_CLIMATE: ClimateControlStatus = {
  mode: 'off',
  availableModes: ['off', 'heat', 'cool', 'auto'],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: [],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  lastFetchedAt: 0,
}

/** Cold-start power-meter slice (no readings yet). */
const COLD_POWER: PowerMeterStatus = { lastFetchedAt: 0 }

/**
 * One Matter endpoint as a CamStack accessory child. Registers the typed caps
 * derived from the endpoint's clusters and routes outbound commands to the live
 * controller through the {@link matterCommands} sink.
 *
 * Inbound attribute reports: on activate the device subscribes to the shared
 * {@link matterNodes} resolver's report stream (filtered to its own
 * node/endpoint) and decodes each report via {@link decodeMatterAttribute} into
 * the matching cap's runtime-state slice — OnOff→switch, LevelControl→brightness,
 * BooleanState→contact, Occupancy→motion, *Measurement→sensors,
 * Thermostat→climate-control, ElectricalPower/Energy→power-meter. Until a report
 * arrives, each cap reads its cold-start default.
 */
export class MatterEndpointDevice extends BaseDevice<typeof matterEndpointSchema> {
  private readonly brokerId: string
  private readonly nodeId: string
  private readonly endpointId: number
  private readonly powerSourceEndpointId: number | undefined
  private readonly lockUnbolting: boolean
  private readonly caps: readonly MatterEndpointCap[]
  private readonly registeredCaps: Set<MatterEndpointCap> = new Set()
  private reportUnsub: (() => void) | null = null
  private eventUnsub: (() => void) | null = null
  private presenceUnsub: (() => void) | null = null
  /** What BooleanState means here: a door contact or a leak/rain detector. */
  private readonly booleanState: 'contact' | 'flood'
  /** A real BatPercentRemaining was seen: the level-only enum must not overwrite it. */
  private batteryPercentSeen = false
  private eventSeq = 0
  private eventCount = 0

  constructor(ctx: DeviceContext) {
    const persisted = matterEndpointSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, matterEndpointSchema, { type: ctx.deviceMeta.type })
    this.brokerId = persisted.brokerId
    this.nodeId = persisted.nodeId
    this.endpointId = persisted.endpointId
    this.powerSourceEndpointId = persisted.powerSourceEndpointId
    this.lockUnbolting = persisted.lockUnbolting === true
    this.caps = persisted.capabilities.filter(isKnownCap)
    this.booleanState = isLeakEndpoint({ deviceTypeIds: persisted.deviceTypeIds })
      ? 'flood'
      : 'contact'
    this.online = matterNodes.getNode(this.brokerId, this.nodeId)?.online ?? true
    void this.updateSourceInfo({ id: `${this.nodeId}:${this.endpointId}`, system: 'matter' })
  }

  /**
   * A cover advertises `cover-stoppable` (WindowCovering `stopMotion` is
   * mandatory). A lock's PIN requirement is slice state (`codeRequired`, #459).
   */
  override get features(): readonly DeviceFeature[] {
    return [
      ...(this.caps.includes('cover') ? [DeviceFeature.CoverStoppable] : []),
      ...(this.caps.includes('lock-control') && this.lockUnbolting ? [DeviceFeature.LockOpen] : []),
    ]
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    for (const cap of this.caps) {
      this.registerCap(cap)
      this.registeredCaps.add(cap)
    }
    this.reportUnsub = matterNodes.onAttributeReport((brokerId, report) => {
      this.applyReport(brokerId, report)
    })
    this.eventUnsub = matterNodes.onEvent((brokerId, event) => {
      this.applyEvent(brokerId, event)
    })
    // An unreachable node is offline. Its last slice (a lock that read
    // "locked") is a memory, not a fact, and must not be presented as one.
    this.presenceUnsub = matterNodes.onNodePresence((brokerId, nodeId, online) => {
      if (brokerId !== this.brokerId || nodeId !== this.nodeId) return
      if (this.online !== online) this.markOnline(online)
    })
  }

  override async removeDevice(): Promise<void> {
    if (this.reportUnsub !== null) {
      this.reportUnsub()
      this.reportUnsub = null
    }
    this.eventUnsub?.()
    this.eventUnsub = null
    this.presenceUnsub?.()
    this.presenceUnsub = null
    await super.removeDevice()
  }

  /** Decode a live report into the owning cap's runtime-state slice. */
  private applyReport(brokerId: string, report: MatterAttributeReport): void {
    if (brokerId !== this.brokerId) return
    if (report.nodeId !== this.nodeId) return
    const fromFoldedPowerSource =
      this.powerSourceEndpointId !== undefined &&
      report.endpointId === this.powerSourceEndpointId &&
      report.clusterId === MatterClusterId.PowerSource
    if (report.endpointId !== this.endpointId && !fromFoldedPowerSource) return
    const decoded = decodeMatterAttribute({
      clusterId: report.clusterId,
      attributeId: report.attributeId,
      value: report.value,
      booleanState: this.booleanState,
    })
    if (decoded === null) return
    if (decoded.detail === 'pin-required' || decoded.detail === 'pin-not-required') {
      const next = decoded.detail === 'pin-required'
      if (next !== this.lockCodeRequired()) {
        this.ctx.logger.info('Matter lock PIN requirement changed', {
          tags: { deviceId: this.id },
          meta: { nodeId: this.nodeId, endpointId: this.endpointId, pinRequired: next },
        })
      }
    } else if (decoded.detail !== undefined) {
      this.ctx.logger.info('Matter lock detail', {
        tags: { deviceId: this.id },
        meta: { nodeId: this.nodeId, endpointId: this.endpointId, detail: decoded.detail },
      })
    }
    if (!this.registeredCaps.has(decoded.cap)) return
    if (Object.keys(decoded.patch).length === 0) return
    if (decoded.detail === 'battery-percent') this.batteryPercentSeen = true
    if (decoded.detail === 'battery-level-only' && this.batteryPercentSeen) return
    this.runtimeState.patchCapState(CAP_SLICE_NAME[decoded.cap], decoded.patch)
  }

  /**
   * A Matter event becomes an `event-emitter` fire on the bus. Everything that
   * does not become one is logged with its reason (D391): a keypad unlock that
   * silently vanished would read as "nobody opened the door".
   */
  private applyEvent(brokerId: string, event: MatterEventReport): void {
    if (brokerId !== this.brokerId) return
    if (event.nodeId !== this.nodeId || event.endpointId !== this.endpointId) return
    const tags = { deviceId: this.id }
    const meta = { nodeId: this.nodeId, endpointId: this.endpointId, eventId: event.eventId }
    if (!this.registeredCaps.has('event-emitter')) {
      this.ctx.logger.debug('Matter event dropped: endpoint has no event-emitter', { tags, meta })
      return
    }
    if (event.timestampMs !== null && Date.now() - event.timestampMs > EVENT_MAX_AGE_MS) {
      this.ctx.logger.info('Matter event dropped: older than the replay window', {
        tags,
        meta: { ...meta, ageMs: Date.now() - event.timestampMs },
      })
      return
    }
    const decoded = decodeMatterEvent({
      clusterId: event.clusterId,
      eventId: event.eventId,
      value: event.value,
    })
    if (decoded.kind === 'dropped') {
      this.ctx.logger.info('Matter event dropped: ' + decoded.reason, { tags, meta })
      return
    }
    const fire: EventFire = {
      deviceId: this.id,
      eventType: decoded.eventType,
      data: { ...decoded.data },
      timestamp: event.timestampMs ?? Date.now(),
      seq: ++this.eventSeq,
    }
    this.ctx.eventBus.emit(
      createEvent(
        EventCategory.EventEmitted,
        {
          type: 'device',
          id: this.stableId,
          deviceId: this.id,
          addonId: this.ctx.deviceMeta.addonId,
        },
        fire,
      ),
    )
    this.eventCount += 1
    this.runtimeState.setCapState('event-emitter', this.eventStatus(fire))
  }

  /** The event tokens this endpoint can fire, by the cluster it carries. */
  private eventTypes(): readonly string[] {
    return this.caps.includes('lock-control') ? LOCK_EVENT_TYPES : SWITCH_EVENT_TYPES
  }

  private eventStatus(lastEvent: EventFire | null): EventEmitterStatus {
    const types = this.eventTypes()
    return {
      eventTypes: [...types],
      vocabulary: conventionalEventVocabulary(types),
      lastEvent,
      eventCountSinceStart: this.eventCount,
    }
  }

  /** Invoke a cluster command on this endpoint via the live controller. */
  private async invoke(
    clusterId: number,
    commandName: string,
    args?: Record<string, unknown>,
  ): Promise<void> {
    await matterCommands.invoke(this.brokerId, {
      nodeId: this.nodeId,
      endpointId: this.endpointId,
      clusterId,
      commandName,
      ...(args !== undefined ? { args } : {}),
    })
  }

  private registerCap(cap: MatterEndpointCap): void {
    switch (cap) {
      case 'switch':
        return this.registerSwitch()
      case 'brightness':
        return this.registerBrightness()
      case 'color':
        return this.registerColor()
      case 'lock-control':
        return this.registerLock()
      case 'cover':
        return this.registerCover()
      case 'contact':
        return this.registerContact()
      case 'motion':
        return this.registerMotion()
      case 'temperature-sensor':
        return this.registerTemperatureSensor()
      case 'humidity-sensor':
        return this.registerHumiditySensor()
      case 'pressure-sensor':
        return this.registerPressureSensor()
      case 'ambient-light-sensor':
        return this.registerAmbientLightSensor()
      case 'battery':
        return this.registerBattery()
      case 'button':
        return this.registerButton()
      case 'flood':
        return this.registerFlood()
      case 'smoke':
        return this.registerSmoke()
      case 'carbon-monoxide':
        return this.registerCarbonMonoxide()
      case 'air-quality-sensor':
        return this.registerAirQuality()
      case 'valve':
        return this.registerValve()
      case 'event-emitter':
        return this.registerEventEmitter()
      case 'climate-control':
        return this.registerClimateControl()
      case 'power-meter':
        return this.registerPowerMeter()
    }
  }

  // ── Actionable caps ────────────────────────────────────────────────────

  private registerSwitch(): void {
    const COLD = { on: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('switch') ?? COLD,
      setState: async ({ on }) => {
        await this.invoke(MatterClusterId.OnOff, on ? 'on' : 'off')
        this.runtimeState.setCapState('switch', { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState('switch', COLD)
  }

  private registerBrightness(): void {
    const COLD = { level: 0, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('brightness') ?? COLD,
      setBrightness: async ({ level: percentage }) => {
        // Matter LevelControl level is 0..254; scale the 0..100 percentage.
        const level = Math.round((Math.max(0, Math.min(100, percentage)) / 100) * 254)
        await this.invoke(MatterClusterId.LevelControl, 'moveToLevel', { level })
        this.runtimeState.setCapState('brightness', {
          level: percentage,
          lastChangedAt: Date.now(),
        })
      },
    }
    this.ctx.registerNativeCap(brightnessCapability, provider)
    this.runtimeState.setCapState('brightness', COLD)
  }

  private registerColor(): void {
    const COLD: ColorStatus = { mode: 'rgb', rgb: { r: 0, g: 0, b: 0 }, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof colorCapability> = {
      getStatus: async () => this.runtimeState.getCapState<ColorStatus>('color') ?? COLD,
      setColor: async ({ color }) => {
        // TODO(color): translate the cap's discriminated color union to the
        // matter.js ColorControl command (moveToColor / moveToColorTemperature).
        await this.invoke(MatterClusterId.ColorControl, 'moveToColor', { color })
        this.runtimeState.setCapState('color', { ...COLD, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(colorCapability, provider)
    this.runtimeState.setCapState('color', COLD)
  }

  /** The lock slice's `codeRequired` — what commands read; `null` until reported. */
  private lockCodeRequired(): boolean | null {
    return this.runtimeState.getCapState<LockControlStatus>('lock-control')?.codeRequired ?? null
  }

  private registerLock(): void {
    // RequirePinForRemoteOperation as already cached for the node; unknown → null (D393).
    const cachedPin = matterNodes.getAttribute(
      this.brokerId,
      this.nodeId,
      this.endpointId,
      MatterClusterId.DoorLock,
      MatterAttributeId.RequirePinForRemoteOperation,
    )
    const COLD: LockControlStatus = {
      state: 'unlocked',
      codeRequired: typeof cachedPin === 'boolean' ? cachedPin : null,
      lastChangedAt: 0,
    }
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD,
      lock: async ({ code }) => {
        await this.invokeLock('lockDoor', 'locking', code)
      },
      unlock: async ({ code }) => {
        // A lock with a separate unbolt command: unlock = unbolt only, open = unlatch.
        await this.invokeLock(this.lockUnbolting ? 'unboltDoor' : 'unlockDoor', 'unlocking', code)
      },
      open: async () => {
        await this.invokeLock('unlockDoor', 'unlocking', undefined)
      },
    }
    this.ctx.registerNativeCap(lockControlCapability, provider)
    this.runtimeState.setCapState('lock-control', COLD)
  }

  /**
   * Send lockDoor / unlockDoor. The final locked/unlocked state arrives on the
   * attribute subscription — this method only records the in-flight transition.
   * A PIN is forwarded on the command and nowhere else.
   */
  private async invokeLock(
    commandName: 'lockDoor' | 'unlockDoor' | 'unboltDoor',
    pending: 'locking' | 'unlocking',
    code: string | undefined,
  ): Promise<void> {
    const plan = planDoorLockCommand({ pinRequired: this.lockCodeRequired(), code })
    if (!plan.ok) {
      this.ctx.logger.warn('Matter lock command refused: PIN required and none was provided', {
        tags: { deviceId: this.id },
        meta: { nodeId: this.nodeId, endpointId: this.endpointId, commandName },
      })
      throw new Error('matter-broker: this lock requires a PIN for remote operation')
    }
    const previous = this.runtimeState.getCapState<LockControlStatus>('lock-control')
    this.runtimeState.patchCapState('lock-control', { state: pending, lastChangedAt: Date.now() })
    try {
      const args = 'pinCode' in plan.args ? plan.args : undefined
      await this.invoke(MatterClusterId.DoorLock, commandName, args)
    } catch (err) {
      if (previous !== undefined) this.runtimeState.setCapState('lock-control', previous)
      throw err
    }
  }

  private registerCover(): void {
    const COLD: CoverStatus = { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD,
      open: async () => {
        await this.invoke(MatterClusterId.WindowCovering, 'upOrOpen')
        this.runtimeState.setCapState('cover', {
          ...COLD,
          state: 'open',
          position: 100,
          lastChangedAt: Date.now(),
        })
      },
      close: async () => {
        await this.invoke(MatterClusterId.WindowCovering, 'downOrClose')
        this.runtimeState.setCapState('cover', {
          ...COLD,
          state: 'closed',
          position: 0,
          lastChangedAt: Date.now(),
        })
      },
      stop: async () => {
        await this.invoke(MatterClusterId.WindowCovering, 'stopMotion')
      },
      setPosition: async ({ position }) => {
        // Matter lift percentage is 0..10000 (hundredths of a percent).
        const liftPercent100ths = Math.round(Math.max(0, Math.min(100, position)) * 100)
        await this.invoke(MatterClusterId.WindowCovering, 'goToLiftPercentage', {
          liftPercent100ths,
        })
        this.runtimeState.setCapState('cover', {
          ...COLD,
          state: 'open',
          position,
          lastChangedAt: Date.now(),
        })
      },
      setTiltPosition: async ({ tiltPosition }) => {
        const tiltPercent100ths = Math.round(Math.max(0, Math.min(100, tiltPosition)) * 100)
        await this.invoke(MatterClusterId.WindowCovering, 'goToTiltPercentage', {
          tiltPercent100ths,
        })
      },
    }
    this.ctx.registerNativeCap(coverCapability, provider)
    this.runtimeState.setCapState('cover', COLD)
  }

  private registerClimateControl(): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_CLIMATE,
      setMode: async ({ mode }) => {
        // Thermostat.SystemMode is a writable ATTRIBUTE, not a cluster command;
        // the v1 controller seam exposes commands only, so the write-back is
        // deferred. Record the requested mode; the next inbound SystemMode report
        // reconciles to the device's actual state.
        this.runtimeState.patchCapState('climate-control', {
          mode: HvacModeSchema.parse(mode),
          lastFetchedAt: Date.now(),
        })
      },
      setFanMode: async ({ fanMode }) => {
        // Matter exposes fan via the separate FanControl cluster (not modelled in
        // v1); record the requested mode so the UI reflects the intent.
        this.runtimeState.patchCapState('climate-control', { fanMode, lastFetchedAt: Date.now() })
      },
      setPreset: async ({ preset }) => {
        this.runtimeState.patchCapState('climate-control', { preset, lastFetchedAt: Date.now() })
      },
      setTarget: async ({ target }) => {
        // Matter sets thermostat setpoints by WRITING the OccupiedHeating/Cooling
        // Setpoint attribute (not a cluster command). The v1 controller seam
        // exposes outbound *commands* only, so the write-back is deferred; we
        // record the requested target so the UI reflects it and the next inbound
        // report reconciles to the device's actual value.
        this.runtimeState.patchCapState('climate-control', {
          target,
          lastFetchedAt: Date.now(),
        })
      },
      setTargetRange: async ({ targetLow, targetHigh }) => {
        this.runtimeState.patchCapState('climate-control', {
          targetLow,
          targetHigh,
          lastFetchedAt: Date.now(),
        })
      },
      setTargetHumidity: async ({ targetHumidity }) => {
        this.runtimeState.patchCapState('climate-control', {
          targetHumidity,
          lastFetchedAt: Date.now(),
        })
      },
      // Matter v1 seam does not model louver swing; the slice reports null on
      // both axes (no DeviceFeature advertised), so these setters reject.
      setSwingVertical: async () => {
        throw new Error('MatterEndpointDevice: vertical swing not supported')
      },
      setSwingHorizontal: async () => {
        throw new Error('MatterEndpointDevice: horizontal swing not supported')
      },
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
    registerPowerSwitch(this, climateControlCapability, provider)
    this.runtimeState.setCapState('climate-control', COLD_CLIMATE)
  }

  private registerPowerMeter(): void {
    const provider: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_POWER,
    }
    this.ctx.registerNativeCap(powerMeterCapability, provider)
    this.runtimeState.setCapState('power-meter', COLD_POWER)
  }

  private registerButton(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      // A stateless Matter Switch endpoint has no command to invoke from the
      // controller side — pressing maps to nothing outbound (the device pushes
      // switch events inbound). TODO(button): forward inbound switch events to
      // the button's onEvent once attribute decoding is wired.
      press: async () => undefined,
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }

  // ── Read-only sensor caps ──────────────────────────────────────────────

  private registerEventEmitter(): void {
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EventEmitterStatus>('event-emitter') ??
        this.eventStatus(null),
    }
    this.ctx.registerNativeCap(eventEmitterCapability, provider)
    this.runtimeState.setCapState('event-emitter', this.eventStatus(null))
  }

  private registerFlood(): void {
    const COLD = { flooded: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof floodCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('flood') ?? COLD,
    }
    this.ctx.registerNativeCap(floodCapability, provider)
    this.runtimeState.setCapState('flood', COLD)
  }

  private registerSmoke(): void {
    const COLD = { detected: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof smokeCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('smoke') ?? COLD,
    }
    this.ctx.registerNativeCap(smokeCapability, provider)
    this.runtimeState.setCapState('smoke', COLD)
  }

  private registerCarbonMonoxide(): void {
    const COLD = { detected: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof carbonMonoxideCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('carbon-monoxide') ?? COLD,
    }
    this.ctx.registerNativeCap(carbonMonoxideCapability, provider)
    this.runtimeState.setCapState('carbon-monoxide', COLD)
  }

  private registerAirQuality(): void {
    const COLD = { lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof airQualitySensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<typeof COLD>('air-quality-sensor') ?? COLD,
    }
    this.ctx.registerNativeCap(airQualitySensorCapability, provider)
    this.runtimeState.setCapState('air-quality-sensor', COLD)
  }

  private registerValve(): void {
    const COLD: ValveStatus = { state: 'closed', position: null, lastChangedAt: 0 }
    const move = async (
      command: 'open' | 'close',
      pending: 'opening' | 'closing',
    ): Promise<void> => {
      const previous = this.runtimeState.getCapState<ValveStatus>('valve') ?? COLD
      this.runtimeState.setCapState('valve', {
        ...previous,
        state: pending,
        lastChangedAt: Date.now(),
      })
      try {
        await this.invoke(MatterClusterId.ValveConfigurationAndControl, command)
      } catch (err) {
        this.runtimeState.setCapState('valve', previous)
        throw err
      }
    }
    const provider: InferNativeProvider<typeof valveCapability> = {
      getStatus: async () => this.runtimeState.getCapState<ValveStatus>('valve') ?? COLD,
      open: async () => move('open', 'opening'),
      close: async () => move('close', 'closing'),
      // Matter's valve cluster has open and close only; there is nothing to stop.
      stop: async () => {
        throw new Error('matter-broker: a Matter valve cannot be stopped mid-travel')
      },
    }
    this.ctx.registerNativeCap(valveCapability, provider)
    this.runtimeState.setCapState('valve', COLD)
  }

  private registerContact(): void {
    const COLD = { entryOpen: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof contactCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('contact') ?? COLD,
    }
    this.ctx.registerNativeCap(contactCapability, provider)
    this.runtimeState.setCapState('contact', COLD)
  }

  private registerMotion(): void {
    const COLD = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
    const provider: InferNativeProvider<typeof motionCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('motion') ?? COLD,
      isDetected: async () =>
        this.runtimeState.getCapState<typeof COLD>('motion')?.detected ?? false,
    }
    this.ctx.registerNativeCap(motionCapability, provider)
    // The level is a placeholder until the first report, but a stored rise
    // (hydrated from the persisted runtime state) is a fact: a restart must
    // not turn "detected an hour ago" into "never detected".
    const stored = this.runtimeState.getCapField('motion', 'lastDetectedAt')
    this.runtimeState.setCapState('motion', {
      ...COLD,
      lastDetectedAt: typeof stored === 'number' && stored > 0 ? stored : null,
    })
  }

  private registerTemperatureSensor(): void {
    const COLD = { temperature: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<typeof COLD>('temperature-sensor') ?? COLD,
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, provider)
    this.runtimeState.setCapState('temperature-sensor', COLD)
  }

  private registerHumiditySensor(): void {
    const COLD = { humidity: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof humiditySensorCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('humidity-sensor') ?? COLD,
    }
    this.ctx.registerNativeCap(humiditySensorCapability, provider)
    this.runtimeState.setCapState('humidity-sensor', COLD)
  }

  private registerPressureSensor(): void {
    const COLD = { pressure: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof pressureSensorCapability> = {
      getStatus: async () => this.runtimeState.getCapState<typeof COLD>('pressure-sensor') ?? COLD,
    }
    this.ctx.registerNativeCap(pressureSensorCapability, provider)
    this.runtimeState.setCapState('pressure-sensor', COLD)
  }

  private registerAmbientLightSensor(): void {
    const COLD = { illuminance: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof ambientLightSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<typeof COLD>('ambient-light-sensor') ?? COLD,
    }
    this.ctx.registerNativeCap(ambientLightSensorCapability, provider)
    this.runtimeState.setCapState('ambient-light-sensor', COLD)
  }

  private registerBattery(): void {
    const COLD: BatteryStatus = {
      // Unknown until the node reports — 0 would read as a flat battery (D315).
      level: null,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    }
    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () => this.runtimeState.getCapState<BatteryStatus>('battery') ?? COLD,
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    this.runtimeState.setCapState('battery', COLD)
  }
}

/** Type guard: is a persisted cap string one this device class can register? */
function isKnownCap(cap: string): cap is MatterEndpointCap {
  return (KNOWN_CAPS as ReadonlySet<string>).has(cap)
}
