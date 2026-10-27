import { z } from 'zod'
import {
  motionCapability,
  type DeviceContext,
  type InferNativeProvider,
  type MotionStatus,
  type PowerMeterStatus,
} from '@camstack/types'
import type { ValueChangedEvent } from 'nodehomematic'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'
import {
  registerAmbientLightCap,
  registerHumidityCap,
  registerPowerMeterCap,
  registerTemperatureCap,
} from '../homematic-sensor-caps.js'
import { COLD_MOTION, coldMotionKeepingRise } from './hm-cold-start.js'
import { changeStamp, type HmValueOrigin } from './hm-change-stamp.js'

/** Sensor child config: the source channel + the cap(s) it registers. */
export const hmSensorSchema = hmChildSchema.extend({
  channel: z.string().min(1).describe('Source channel address'),
  capabilities: z.array(z.string()).min(1),
  role: z.string().optional(),
})

export type HmSensorConfig = z.infer<typeof hmSensorSchema>

/**
 * One Homematic read-only sensor accessory child — temperature / humidity /
 * ambient-light / power-meter / motion. Registers the caps named in
 * `config.capabilities` via the existing `homematic-sensor-caps.ts` helpers
 * and decodes facade `valueChanged` pushes into their slices, mirroring the
 * legacy flat device's `decodeSensorPush` / `decodePowerPush` routing.
 */
export class HmSensorDevice extends HmChildDevice<typeof hmSensorSchema> {
  private readonly caps: ReadonlySet<string>

  constructor(ctx: DeviceContext) {
    super(ctx, hmSensorSchema)
    this.caps = new Set(this.config.values.capabilities)
    this.registerSensorCaps()
    this.attachValueChangedListener((event, origin) => this.handleValueChanged(event, origin))
  }

  private registerSensorCaps(): void {
    for (const cap of this.caps) {
      switch (cap) {
        case 'temperature-sensor':
          registerTemperatureCap(this.ctx, this.runtimeState)
          break
        case 'humidity-sensor':
          registerHumidityCap(this.ctx, this.runtimeState)
          break
        case 'ambient-light-sensor':
          registerAmbientLightCap(this.ctx, this.runtimeState)
          break
        case 'power-meter':
          registerPowerMeterCap(this.ctx, this.runtimeState)
          break
        case 'motion':
          this.registerMotionCap()
          break
        default:
          this.ctx.logger.debug('HmSensorDevice: cap not wired', {
            meta: { cap, address: this.address, channel: this.channel },
          })
          break
      }
    }
  }

  private registerMotionCap(): void {
    const provider: InferNativeProvider<typeof motionCapability> = {
      getStatus: async () => this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION,
      isDetected: async () =>
        (this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION).detected,
    }
    this.ctx.registerNativeCap(motionCapability, provider)
    this.runtimeState.setCapState(
      'motion',
      coldMotionKeepingRise(this.runtimeState.getCapState<MotionStatus>('motion')),
    )
  }

  private handleValueChanged(event: ValueChangedEvent, origin: HmValueOrigin): void {
    const now = event.ts || Date.now()
    const { parameter, value } = event
    if (this.caps.has('motion') && parameter === 'MOTION' && typeof value === 'boolean') {
      const prev = this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION
      // `lastDetectedAt` is motion's CHANGE stamp: a replayed `true` is a
      // detection whose moment is unknown, never one that happened now
      // (`hm-change-stamp.ts`). Measurements below keep `now` — a fetch time.
      this.runtimeState.setCapState('motion', {
        detected: value,
        lastDetectedAt: value
          ? changeStamp(origin, now, prev.lastDetectedAt, prev.detected)
          : prev.lastDetectedAt,
        autoClearAfterMs: null,
      })
    }
    this.decodeSensorPush(parameter, value, now)
  }

  private decodeSensorPush(parameter: string, value: unknown, now: number): void {
    if (typeof value !== 'number') return
    if (this.caps.has('temperature-sensor') && parameter === 'ACTUAL_TEMPERATURE') {
      this.runtimeState.setCapState('temperature-sensor', {
        temperature: value,
        lastFetchedAt: now,
      })
    }
    if (this.caps.has('humidity-sensor') && parameter === 'HUMIDITY') {
      this.runtimeState.setCapState('humidity-sensor', { humidity: value, lastFetchedAt: now })
    }
    if (this.caps.has('ambient-light-sensor') && parameter === 'ILLUMINATION') {
      this.runtimeState.setCapState('ambient-light-sensor', {
        illuminance: Math.max(0, value),
        lastFetchedAt: now,
      })
    }
    this.decodePowerPush(parameter, value, now)
  }

  /** Decode HmIP energy-meter parameters into the power-meter slice. */
  private decodePowerPush(parameter: string, value: number, now: number): void {
    if (!this.caps.has('power-meter')) return
    const prev = this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? {
      lastFetchedAt: 0,
    }
    switch (parameter) {
      case 'POWER':
        this.runtimeState.setCapState('power-meter', { ...prev, power: value, lastFetchedAt: now })
        return
      case 'ENERGY_COUNTER':
        // HmIP ENERGY_COUNTER is in Wh — normalise to kWh.
        this.runtimeState.setCapState('power-meter', {
          ...prev,
          energy: value / 1000,
          lastFetchedAt: now,
        })
        return
      case 'VOLTAGE':
        this.runtimeState.setCapState('power-meter', {
          ...prev,
          voltage: value,
          lastFetchedAt: now,
        })
        return
      case 'CURRENT':
        // HmIP CURRENT is in mA — normalise to A.
        this.runtimeState.setCapState('power-meter', {
          ...prev,
          current: value / 1000,
          lastFetchedAt: now,
        })
        return
      default:
        return
    }
  }
}
