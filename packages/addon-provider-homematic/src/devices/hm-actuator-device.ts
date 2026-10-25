import { z } from 'zod'
import {
  climateControlCapability,
  coverCapability,
  lockControlCapability,
  switchCapability,
  type ClimateControlStatus,
  type CoverStatus,
  type DeviceContext,
  type InferNativeProvider,
  type LockControlStatus,
  type SwitchStatus,
} from '@camstack/types'
import type { HmValue, ValueChangedEvent } from 'nodehomematic'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'
import { decodeClimate, decodeCover, decodeLock, toHmClimateMode } from '../homematic-decode.js'
import { COLD_CLIMATE, COLD_COVER, COLD_LOCK, COLD_SWITCH } from './hm-cold-start.js'
import { changeStamp, stampForOrigin, type HmValueOrigin } from './hm-change-stamp.js'

/** Actuator child config: the owning channel + the custom-entity kind. */
export const hmActuatorSchema = hmChildSchema.extend({
  channel: z.string().min(1).describe('Custom-entity channel address'),
  kind: z.enum(['switch', 'cover', 'light', 'lock', 'climate']),
})

export type HmActuatorConfig = z.infer<typeof hmActuatorSchema>

/**
 * One Homematic actuator accessory child — switch / cover / light / lock /
 * climate. The control cap is wired against the library custom-entity channel
 * (carried in config as `channel`), exactly as the legacy flat device did so
 * `coverOpen` / `switchTurnOn` / … dispatch to the channel the facade requires.
 * Status flows back via the facade `valueChanged` stream, decoded by the
 * existing pure decoders (`decodeCover` / `decodeLock` / `decodeClimate`).
 */
export class HmActuatorDevice extends HmChildDevice<typeof hmActuatorSchema> {
  private readonly kind: HmActuatorConfig['kind']
  /** The actuator cap name actually registered (drives decode routing). */
  private registeredCap: string | null = null

  constructor(ctx: DeviceContext) {
    super(ctx, hmActuatorSchema)
    this.kind = this.config.values.kind
    this.registerActuatorCap()
    this.attachValueChangedListener((event, origin) => this.handleValueChanged(event, origin))
  }

  private get actuatorChannel(): string {
    // hmActuatorSchema requires a non-empty channel.
    return this.config.values.channel
  }

  private registerActuatorCap(): void {
    switch (this.kind) {
      case 'switch':
        return this.registerSwitchCap()
      case 'cover':
        return this.registerCoverCap()
      case 'lock':
        return this.registerLockCap()
      case 'climate':
        return this.registerClimateCap()
      case 'light':
        // No verified `light` facade control surface in the lib's custom
        // entities (HmLight exists but the facade exposes no brightness write
        // helper here). Register switch semantics so on/off still works.
        this.ctx.logger.debug('HmActuatorDevice: light kind → switch semantics', {
          meta: { address: this.address, channel: this.actuatorChannel },
        })
        return this.registerSwitchCap()
      default:
        return
    }
  }

  // ── switch ───────────────────────────────────────────────────────────

  private registerSwitchCap(): void {
    const channel = this.actuatorChannel
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH,
      setState: async ({ on }) => {
        const facade = this.requireFacade()
        if (on) await facade.switchTurnOn(this.address, channel)
        else await facade.switchTurnOff(this.address, channel)
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState('switch', COLD_SWITCH)
    this.registeredCap = 'switch'
  }

  // ── cover ────────────────────────────────────────────────────────────

  private registerCoverCap(): void {
    const channel = this.actuatorChannel
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_COVER,
      open: async () => {
        await this.requireFacade().coverOpen(this.address, channel)
      },
      close: async () => {
        await this.requireFacade().coverClose(this.address, channel)
      },
      stop: async () => {
        await this.requireFacade().coverStop(this.address, channel)
      },
      setPosition: async ({ position }) => {
        await this.requireFacade().coverSetPosition(this.address, channel, position)
      },
      // HmIP-BROLL roller shutters have no slat tilt; no facade helper.
      setTiltPosition: async () => this.unsupported('cover tilt'),
    }
    this.ctx.registerNativeCap(coverCapability, provider)
    this.runtimeState.setCapState('cover', COLD_COVER)
    this.registeredCap = 'cover'
  }

  // ── lock-control ─────────────────────────────────────────────────────

  private registerLockCap(): void {
    const channel = this.actuatorChannel
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD_LOCK,
      lock: async () => {
        await this.requireFacade().lockLock(this.address, channel)
      },
      unlock: async () => {
        await this.requireFacade().lockUnlock(this.address, channel)
      },
      open: async () => {
        await this.requireFacade().lockOpen(this.address, channel)
      },
    }
    this.ctx.registerNativeCap(lockControlCapability, provider)
    this.runtimeState.setCapState('lock-control', COLD_LOCK)
    this.registeredCap = 'lock-control'
  }

  // ── climate-control ──────────────────────────────────────────────────

  private registerClimateCap(): void {
    const channel = this.actuatorChannel
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_CLIMATE,
      setMode: async ({ mode }) => {
        await this.requireFacade().climateSetMode(this.address, channel, toHmClimateMode(mode))
      },
      setTarget: async ({ target }) => {
        await this.requireFacade().climateSetTemperature(this.address, channel, target)
      },
      setPreset: async ({ preset }) => {
        await this.requireFacade().climateSetBoost(this.address, channel, preset === 'boost')
      },
      // HmIP thermostats have no fan surface, are single-setpoint and do not
      // control humidity — reject loudly.
      setFanMode: async () => this.unsupported('climate fan mode'),
      setTargetRange: async () => this.unsupported('climate dual setpoint'),
      setTargetHumidity: async () => this.unsupported('climate humidity control'),
      setSwingVertical: async () => this.unsupported('climate vertical swing'),
      setSwingHorizontal: async () => this.unsupported('climate horizontal swing'),
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
    this.runtimeState.setCapState('climate-control', COLD_CLIMATE)
    this.registeredCap = 'climate-control'
  }

  // ── Value-change decode (status read-back) ────────────────────────────

  private handleValueChanged(event: ValueChangedEvent, origin: HmValueOrigin): void {
    const now = event.ts || Date.now()
    const { parameter, value } = event
    const cap = this.registeredCap
    if (cap === 'switch' && parameter === 'STATE' && typeof value === 'boolean') {
      const prev = this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH
      const lastChangedAt = changeStamp(origin, now, prev.lastChangedAt, prev.on === value)
      this.runtimeState.setCapState('switch', { on: value, lastChangedAt })
      return
    }
    if (cap === 'cover') return this.applyCover(parameter, value, now, origin)
    if (cap === 'lock-control') return this.applyLock(parameter, value, now, origin)
    if (cap === 'climate-control') {
      const prev =
        this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_CLIMATE
      const next = decodeClimate(prev, parameter, value, now)
      if (next) this.runtimeState.setCapState('climate-control', next)
    }
  }

  private applyCover(parameter: string, value: HmValue, now: number, origin: HmValueOrigin): void {
    const prev = this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_COVER
    const next = decodeCover(prev, parameter, value, now)
    // A travel datapoint this build cannot read is the ONE thing that
    // silently costs the whole moving state, and for a long time nothing on
    // this path said a word — the value-change route logged nothing at all,
    // so "the cover never reports a move" could only be reasoned about from
    // source, never measured. It names the raw value and its type, because
    // the defect was exactly a type: `nodehomematic` hands the CONVERTED
    // enum member over, and this decoder was testing for the wire index.
    if (next === null && (parameter === 'ACTIVITY_STATE' || parameter === 'DIRECTION')) {
      this.ctx.logger.warn('Homematic cover: travel value not understood — state unchanged', {
        tags: { deviceId: this.id },
        meta: { deviceId: this.id, parameter, value, valueType: typeof value },
      })
    }
    if (next === null) return
    this.runtimeState.setCapState(
      'cover',
      stampForOrigin(origin, prev, next, next.state === prev.state),
    )
  }

  private applyLock(parameter: string, value: HmValue, now: number, origin: HmValueOrigin): void {
    const prev = this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD_LOCK
    const next = decodeLock(parameter, value, now)
    if (next === null) {
      // An UNKNOWN LOCK_STATE writes nothing (see `decodeLock`) — and says so,
      // with whether the slice it left alone is still a placeholder.
      if (parameter === 'LOCK_STATE') {
        this.ctx.logger.info('Homematic lock: LOCK_STATE unknown — state unchanged', {
          tags: { deviceId: this.id },
          meta: {
            value,
            valueType: typeof value,
            origin,
            keptState: prev.state,
            keptPlaceholder: prev.lastChangedAt === 0,
          },
        })
      }
      return
    }
    this.runtimeState.setCapState(
      'lock-control',
      stampForOrigin(origin, prev, next, next.state === prev.state),
    )
  }
}
