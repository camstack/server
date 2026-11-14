import { z } from 'zod'
import {
  registerPowerSwitch,
  climateControlCapability,
  DeviceFeature,
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
import type { HmChannel, HmValue, ValueChangedEvent } from 'nodehomematic'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'
import {
  HM_DEFAULT_RESTORE_TARGET_C,
  HM_OFF_SETPOINT_C,
  decodeClimate,
  decodeClimateDemand,
  decodeCover,
  decodeLock,
  isHmOffSetpoint,
  toHmClimateMode,
} from '../homematic-decode.js'
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
  /** A cover's `stop` drives the channel's real STOP (`coverStop`). */
  override readonly features: readonly DeviceFeature[] =
    this.config.values.kind === 'cover' ? [DeviceFeature.CoverStoppable] : []

  private readonly kind: HmActuatorConfig['kind']
  /** The actuator cap name actually registered (drives decode routing). */
  private registeredCap: string | null = null
  /** Last setpoint above {@link HM_OFF_SETPOINT_C}; HmIP OFF leaves target at 4.5. */
  private climateRestoreTargetC: number | null = null

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
        const facade = this.requireFacade()
        const prev =
          this.runtimeState.getCapState<ClimateControlStatus>('climate-control') ?? COLD_CLIMATE
        const hmMode = toHmClimateMode(mode)
        const offC = this.climateOffSetpointC()
        if (hmMode === 'off' && prev.target !== null && prev.target > offC) {
          this.climateRestoreTargetC = prev.target
        }
        await facade.climateSetMode(this.address, channel, hmMode)
        // The library's OFF writes 4.5 °C; the device clamps it to its own
        // minimum. Write that minimum so the write and the decode agree.
        if (hmMode === 'off' && offC !== HM_OFF_SETPOINT_C) {
          await facade.climateSetTemperature(this.address, channel, offC)
        }
        // A setpoint write while the CCU is in AUTO becomes a manual
        // override and drops the schedule. Only heat restores the target.
        if (mode === 'heat' && (prev.mode === 'off' || isHmOffSetpoint(prev.target, offC))) {
          const restore = this.climateRestoreTargetC ?? HM_DEFAULT_RESTORE_TARGET_C
          await facade.climateSetTemperature(this.address, channel, restore)
        }
      },
      setTarget: async ({ target }) => {
        if (target > this.climateOffSetpointC()) {
          this.climateRestoreTargetC = target
        }
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
    registerPowerSwitch(this, climateControlCapability, provider)
    this.runtimeState.setCapState('climate-control', COLD_CLIMATE)
    this.registeredCap = 'climate-control'
  }

  /**
   * The off setpoint of THIS thermostat: the entity's own minimum setpoint
   * (the library reads it from the SETPOINT datapoint metadata), else the
   * CCU default {@link HM_OFF_SETPOINT_C}.
   */
  private climateOffSetpointC(): number {
    const entity = this.facade
      ?.customEntities()
      .find((e) => e.device === this.address && e.channel === this.actuatorChannel)
    return entity?.kind === 'climate' ? entity.minTemp : HM_OFF_SETPOINT_C
  }

  /** The channel type of a floor-heating relay's demand report (HmIP-BWTH `:8`). */
  private static readonly FLOOR_DIRECT_CHANNEL_TYPE = 'CLIMATECONTROL_FLOOR_DIRECT_TRANSMITTER'

  private static isFloorDirect(channel: HmChannel): boolean {
    return channel.type === HmActuatorDevice.FLOOR_DIRECT_CHANNEL_TYPE
  }

  /**
   * A climate child reads the `STATE` of the device's floor-direct transmitter
   * as its heat demand. It is the ONLY foreign datapoint it takes: the other
   * parameters of that channel and every other channel (`:9`, `:10`) stay dropped.
   */
  protected override readsForeignDatapoint(channel: HmChannel, parameter: string): boolean {
    return (
      this.registeredCap === 'climate-control' &&
      parameter === 'STATE' &&
      HmActuatorDevice.isFloorDirect(channel)
    )
  }

  private hasFloorDirectChannel(): boolean {
    return this.resolveHmDevice()?.channels.some(HmActuatorDevice.isFloorDirect) === true
  }

  /** Is this event the floor-direct `STATE`, as opposed to the owned channel's own? */
  private isFloorDirectState(event: ValueChangedEvent): boolean {
    if (event.parameter !== 'STATE') return false
    const channel = this.resolveHmDevice()?.channels.find((c) => c.address === event.channel)
    return channel !== undefined && HmActuatorDevice.isFloorDirect(channel)
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
      const offC = this.climateOffSetpointC()
      const next = this.decodeClimateEvent(prev, event, now, offC)
      if (next === null && parameter === 'SET_POINT_MODE') {
        this.ctx.logger.debug('Homematic climate: SET_POINT_MODE unknown — mode unchanged', {
          tags: { deviceId: this.id },
          meta: { value, valueType: typeof value },
        })
      }
      if (next) {
        if (next.target !== null && next.target > offC) {
          this.climateRestoreTargetC = next.target
        }
        this.runtimeState.setCapState('climate-control', next)
      }
    }
  }

  /**
   * Heat demand has two sources: the floor relay's `STATE` (BWTH `:8`) and a
   * radiator valve's `LEVEL`. A device with a floor relay takes its demand from
   * there only, so a `LEVEL` it also carries cannot contradict it.
   */
  private decodeClimateEvent(
    prev: ClimateControlStatus,
    event: ValueChangedEvent,
    now: number,
    offC: number,
  ): ClimateControlStatus | null {
    const { parameter, value } = event
    if (this.isFloorDirectState(event)) {
      return decodeClimateDemand(prev, 'floor-direct-state', value, now)
    }
    if (parameter === 'LEVEL' && !this.hasFloorDirectChannel()) {
      return decodeClimateDemand(prev, 'valve-level', value, now)
    }
    return decodeClimate(prev, parameter, value, now, offC)
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
