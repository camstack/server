import { z } from 'zod'
import {
  BaseDevice,
  switchCapability,
  brightnessCapability,
  colorCapability,
  lockControlCapability,
  coverCapability,
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
import type { MatterAttributeReport } from '../matter-controller.js'
import { decodeMatterAttribute, MatterAttributeId } from '../matter-attr-decode.js'
import { MatterClusterId, type MatterEndpointCap } from '../matter-cluster-mapping.js'
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
}

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
  /** Live RequirePinForRemoteOperation. Commands read this, not a stored PIN. */
  private pinRequired = false

  private readonly brokerId: string
  private readonly nodeId: string
  private readonly endpointId: number
  private readonly caps: readonly MatterEndpointCap[]
  private readonly registeredCaps: Set<MatterEndpointCap> = new Set()
  private reportUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = matterEndpointSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, matterEndpointSchema, { type: ctx.deviceMeta.type })
    this.brokerId = persisted.brokerId
    this.nodeId = persisted.nodeId
    this.endpointId = persisted.endpointId
    this.caps = persisted.capabilities.filter(isKnownCap)
    this.pinRequired =
      matterNodes.getAttribute(
        this.brokerId,
        this.nodeId,
        this.endpointId,
        MatterClusterId.DoorLock,
        MatterAttributeId.RequirePinForRemoteOperation,
      ) === true
    this.online = matterNodes.getNode(this.brokerId, this.nodeId)?.online ?? true
    void this.updateSourceInfo({ id: `${this.nodeId}:${this.endpointId}`, system: 'matter' })
  }

  /** PIN-required locks advertise the feature the lock UI already understands. */
  override get features(): readonly DeviceFeature[] {
    return this.pinRequired ? [DeviceFeature.LockPinRequired] : []
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
  }

  override async removeDevice(): Promise<void> {
    if (this.reportUnsub !== null) {
      this.reportUnsub()
      this.reportUnsub = null
    }
    await super.removeDevice()
  }

  /** Decode a live report into the owning cap's runtime-state slice. */
  private applyReport(brokerId: string, report: MatterAttributeReport): void {
    if (brokerId !== this.brokerId) return
    if (report.nodeId !== this.nodeId || report.endpointId !== this.endpointId) return
    const decoded = decodeMatterAttribute({
      clusterId: report.clusterId,
      attributeId: report.attributeId,
      value: report.value,
    })
    if (decoded === null) return
    if (decoded.detail === 'pin-required' || decoded.detail === 'pin-not-required') {
      const next = decoded.detail === 'pin-required'
      if (next !== this.pinRequired) {
        this.pinRequired = next
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
    this.runtimeState.patchCapState(CAP_SLICE_NAME[decoded.cap], decoded.patch)
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

  private registerLock(): void {
    const COLD: LockControlStatus = { state: 'unlocked', lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD,
      lock: async ({ code }) => {
        await this.invokeLock('lockDoor', 'locking', code)
      },
      unlock: async ({ code }) => {
        await this.invokeLock('unlockDoor', 'unlocking', code)
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
    commandName: 'lockDoor' | 'unlockDoor',
    pending: 'locking' | 'unlocking',
    code: string | undefined,
  ): Promise<void> {
    const plan = planDoorLockCommand({ pinRequired: this.pinRequired, code })
    if (!plan.ok) {
      this.ctx.logger.warn('Matter lock command refused: PIN required and none was provided', {
        tags: { deviceId: this.id },
        meta: { nodeId: this.nodeId, endpointId: this.endpointId, commandName },
      })
      throw new Error('matter-broker: this lock requires a PIN for remote operation')
    }
    const previous = this.runtimeState.getCapState<LockControlStatus>('lock-control')
    this.runtimeState.setCapState('lock-control', { state: pending, lastChangedAt: Date.now() })
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
      level: 0,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    }
    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () => this.runtimeState.getCapState<BatteryStatus>('battery') ?? COLD,
      wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    this.runtimeState.setCapState('battery', COLD)
  }
}

/** Type guard: is a persisted cap string one this device class can register? */
function isKnownCap(cap: string): cap is MatterEndpointCap {
  return (KNOWN_CAPS as ReadonlySet<string>).has(cap)
}
