import { z } from 'zod'
import {
  BaseDevice,
  switchCapability,
  brightnessCapability,
  colorCapability,
  lockControlCapability,
  coverCapability,
  contactCapability,
  motionCapability,
  temperatureSensorCapability,
  humiditySensorCapability,
  buttonCapability,
  type ColorStatus,
  type CoverStatus,
  type DeviceContext,
  type DeviceFeature,
  type InferNativeProvider,
  type LockControlStatus,
} from '@camstack/types'
import { alexaAccounts, alexaCommands } from '../alexa-gateway.js'
import type { AlexaCap } from '../alexa-domain-mapping.js'
import {
  decodeDetectionState,
  decodeHumidityPercent,
  decodeLockState,
  decodePercentage,
  decodePowerState,
  decodeTemperatureCelsius,
  mergeAlexaMotionStatus,
  type AlexaMotionStatus,
} from '../alexa-state-to-cap.js'

/**
 * Persisted config every imported Alexa device carries. `applianceId` resolves
 * the live appliance from the account resolver; `brokerId` selects the account;
 * `capabilities` is the derived cap list (persisted so a restore needs no live
 * account). `system`/`integrationId`/`name` are provenance.
 */
export const alexaDeviceSchema = z.object({
  applianceId: z.string().min(1).describe('Alexa appliance / entity id'),
  brokerId: z.string().min(1).describe('Registry broker id'),
  capabilities: z.array(z.string()).default([]),
  system: z.literal('alexa').optional(),
  integrationId: z.string().optional(),
})

export type AlexaDeviceConfig = z.infer<typeof alexaDeviceSchema>

/** The cap set this device class knows how to register (v1 subset). */
const KNOWN_CAPS: ReadonlySet<AlexaCap> = new Set<AlexaCap>([
  'switch',
  'brightness',
  'color',
  'lock-control',
  'cover',
  'contact',
  'motion',
  'temperature-sensor',
  'humidity-sensor',
  'button',
  // NOTE: 'climate-control', 'control' and 'numeric-sensor' are mapped by the
  // domain table but their cap registration is a follow-up — see TODO below.
])

/**
 * One imported Alexa smart-home appliance as a flat CamStack device. Registers
 * the typed caps derived from the appliance's Alexa capability interfaces and
 * routes outbound commands to the live account through the {@link alexaCommands}
 * sink. Mirrors the Matter endpoint device (flat, not a container).
 *
 * State decoding: the live alexa-remote2 client polls real states onto
 * {@link alexaAccounts}; each `getStatus` prefers the latest decoded live value
 * (via `alexa-state-to-cap`) and falls back to the runtime/cold slice when a
 * property hasn't been polled yet — e.g. PowerController.powerState 'ON' →
 * switch.on, BrightnessController.brightness 0..100 → brightness.percentage,
 * ContactSensor.detectionState 'DETECTED' → contact.entryOpen.
 *
 * TODO(caps): 'climate-control' (ThermostatController), 'control'
 * (RangeController/ModeController) and 'numeric-sensor' are mapped but not yet
 * registered here — they need their full multi-field slices wired.
 */
export class AlexaDevice extends BaseDevice<typeof alexaDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly applianceId: string
  private readonly brokerId: string
  private readonly caps: readonly AlexaCap[]

  constructor(ctx: DeviceContext) {
    const persisted = alexaDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, alexaDeviceSchema, { type: ctx.deviceMeta.type })
    this.applianceId = persisted.applianceId
    this.brokerId = persisted.brokerId
    this.caps = persisted.capabilities.filter(isKnownCap)
    this.online = alexaAccounts.getAppliance(this.brokerId, this.applianceId) !== null
    void this.updateSourceInfo({ id: this.applianceId, system: 'alexa' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    for (const cap of this.caps) this.registerCap(cap)
  }

  /** Latest polled value for one of this appliance's Alexa interface properties. */
  private liveState(interfaceName: string, property: string): unknown {
    return alexaAccounts.getState(this.brokerId, this.applianceId, interfaceName, property)
  }

  /** Send an outbound Alexa directive for this appliance via the live account. */
  private async command(
    interfaceName: string,
    action: string,
    args?: Record<string, unknown>,
  ): Promise<void> {
    await alexaCommands.invoke(this.brokerId, {
      applianceId: this.applianceId,
      interfaceName,
      action,
      ...(args !== undefined ? { args } : {}),
    })
  }

  private registerCap(cap: AlexaCap): void {
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
      case 'button':
        return this.registerButton()
      case 'climate-control':
      case 'control':
      case 'numeric-sensor':
        // Mapped but not yet registered — see class TODO.
        return
    }
  }

  // ── Actionable caps ────────────────────────────────────────────────────

  private registerSwitch(): void {
    const COLD = { on: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => {
        const cached = this.runtimeState.getCapState<typeof COLD>('switch') ?? COLD
        const live = decodePowerState(this.liveState('Alexa.PowerController', 'powerState'))
        return live === null ? cached : { ...cached, on: live }
      },
      setState: async ({ on }) => {
        await this.command('Alexa.PowerController', on ? 'TurnOn' : 'TurnOff')
        this.runtimeState.setCapState('switch', { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState('switch', COLD)
  }

  private registerBrightness(): void {
    const COLD = { percentage: 0, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      getStatus: async () => {
        const cached = this.runtimeState.getCapState<typeof COLD>('brightness') ?? COLD
        const live = decodePercentage(this.liveState('Alexa.BrightnessController', 'brightness'))
        return live === null ? cached : { ...cached, percentage: live }
      },
      setBrightness: async ({ percentage }) => {
        const brightness = Math.round(Math.max(0, Math.min(100, percentage)))
        await this.command('Alexa.BrightnessController', 'SetBrightness', { brightness })
        this.runtimeState.setCapState('brightness', { percentage, lastChangedAt: Date.now() })
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
        // TODO(color): translate the discriminated color union to Alexa's
        // ColorController.SetColor (hue/saturation/brightness) or
        // ColorTemperatureController.SetColorTemperature.
        await this.command('Alexa.ColorController', 'SetColor', { color })
        this.runtimeState.setCapState('color', { ...COLD, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(colorCapability, provider)
    this.runtimeState.setCapState('color', COLD)
  }

  private registerLock(): void {
    const COLD: LockControlStatus = { state: 'unlocked', lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      getStatus: async () => {
        const cached = this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD
        const live = decodeLockState(this.liveState('Alexa.LockController', 'lockState'))
        return live === null ? cached : { ...cached, state: live }
      },
      lock: async () => {
        await this.command('Alexa.LockController', 'Lock')
        this.runtimeState.setCapState('lock-control', {
          state: 'locked',
          lastChangedAt: Date.now(),
        })
      },
      unlock: async () => {
        await this.command('Alexa.LockController', 'Unlock')
        this.runtimeState.setCapState('lock-control', {
          state: 'unlocked',
          lastChangedAt: Date.now(),
        })
      },
      open: async () => {
        await this.command('Alexa.LockController', 'Unlock')
        this.runtimeState.setCapState('lock-control', {
          state: 'unlocked',
          lastChangedAt: Date.now(),
        })
      },
    }
    this.ctx.registerNativeCap(lockControlCapability, provider)
    this.runtimeState.setCapState('lock-control', COLD)
  }

  private registerCover(): void {
    const COLD: CoverStatus = { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD,
      open: async () => {
        await this.command('Alexa.PercentageController', 'SetPercentage', { percentage: 100 })
        this.runtimeState.setCapState('cover', {
          ...COLD,
          state: 'open',
          position: 100,
          lastChangedAt: Date.now(),
        })
      },
      close: async () => {
        await this.command('Alexa.PercentageController', 'SetPercentage', { percentage: 0 })
        this.runtimeState.setCapState('cover', {
          ...COLD,
          state: 'closed',
          position: 0,
          lastChangedAt: Date.now(),
        })
      },
      stop: async () => {
        // Alexa's percentage cover model has no discrete stop — no-op.
      },
      setPosition: async ({ position }) => {
        const percentage = Math.round(Math.max(0, Math.min(100, position)))
        await this.command('Alexa.PercentageController', 'SetPercentage', { percentage })
        this.runtimeState.setCapState('cover', {
          ...COLD,
          state: 'open',
          position,
          lastChangedAt: Date.now(),
        })
      },
      setTiltPosition: async () => {
        // Alexa's PercentageController has no tilt surface — no-op.
      },
    }
    this.ctx.registerNativeCap(coverCapability, provider)
    this.runtimeState.setCapState('cover', COLD)
  }

  private registerButton(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      // An Alexa SceneController scene fires via Activate.
      press: async () => {
        await this.command('Alexa.SceneController', 'Activate')
      },
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }

  // ── Read-only sensor caps ──────────────────────────────────────────────

  private registerContact(): void {
    const COLD = { entryOpen: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof contactCapability> = {
      getStatus: async () => {
        const cached = this.runtimeState.getCapState<typeof COLD>('contact') ?? COLD
        const live = decodeDetectionState(this.liveState('Alexa.ContactSensor', 'detectionState'))
        return live === null ? cached : { ...cached, entryOpen: live }
      },
    }
    this.ctx.registerNativeCap(contactCapability, provider)
    this.runtimeState.setCapState('contact', COLD)
  }

  private registerMotion(): void {
    const COLD: AlexaMotionStatus = {
      detected: false,
      lastDetectedAt: null,
      autoClearAfterMs: null,
    }
    const liveDetected = (): boolean | null =>
      decodeDetectionState(this.liveState('Alexa.MotionSensor', 'detectionState'))
    // Sync the slice on every read so `lastDetectedAt` is written on a rise
    // (and survives a fall), matching HA / Matter / Homematic. A previous
    // getStatus only overlaid `detected` and left the stamp at cold null.
    const readAndSync = (): AlexaMotionStatus => {
      const cached = this.runtimeState.getCapState('motion') ?? COLD
      const next = mergeAlexaMotionStatus(cached, liveDetected(), Date.now())
      if (next.detected !== cached.detected || next.lastDetectedAt !== cached.lastDetectedAt) {
        this.runtimeState.setCapState('motion', next)
      }
      return next
    }
    const provider: InferNativeProvider<typeof motionCapability> = {
      getStatus: async () => readAndSync(),
      isDetected: async () => readAndSync().detected,
    }
    this.ctx.registerNativeCap(motionCapability, provider)
    // The level is a placeholder until the first poll, but a stored rise
    // (hydrated from the persisted runtime state) is a fact: a restart must
    // not turn "detected an hour ago" into "never detected".
    const stored = this.runtimeState.getCapField('motion', 'lastDetectedAt')
    this.runtimeState.setCapState('motion', {
      ...COLD,
      lastDetectedAt: typeof stored === 'number' && stored > 0 ? stored : null,
    })
  }

  private registerTemperatureSensor(): void {
    const COLD = { celsius: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () => {
        const cached = this.runtimeState.getCapState<typeof COLD>('temperature-sensor') ?? COLD
        const live = decodeTemperatureCelsius(
          this.liveState('Alexa.TemperatureSensor', 'temperature'),
        )
        return live === null ? cached : { ...cached, celsius: live }
      },
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, provider)
    this.runtimeState.setCapState('temperature-sensor', COLD)
  }

  private registerHumiditySensor(): void {
    const COLD = { percent: 0, lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof humiditySensorCapability> = {
      getStatus: async () => {
        const cached = this.runtimeState.getCapState<typeof COLD>('humidity-sensor') ?? COLD
        const live = decodeHumidityPercent(this.liveState('Alexa.HumiditySensor', 'humidity'))
        return live === null ? cached : { ...cached, percent: live }
      },
    }
    this.ctx.registerNativeCap(humiditySensorCapability, provider)
    this.runtimeState.setCapState('humidity-sensor', COLD)
  }
}

/** Type guard: is a persisted cap string one this device class can register? */
function isKnownCap(cap: string): cap is AlexaCap {
  return (KNOWN_CAPS as ReadonlySet<string>).has(cap)
}
