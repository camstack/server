import {
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceType,
  type IDevice,
} from '@camstack/types'
import { z } from 'zod'
import { DEFAULT_KETTLE_DP_MAP, DEFAULT_KETTLE_TARGET_OPTIONS } from '../tuya-dp-mapping.js'
import { tuyaDeviceConfigSchema } from './tuya-base-device.js'
import { TuyaBaseDevice } from './tuya-base-device.js'
import { TuyaDpSwitchDevice } from './tuya-dp-switch-child.js'
import { TuyaEnumSensorDevice } from './tuya-enum-sensor-device.js'
import { TuyaTargetTempSelectDevice } from './tuya-target-temp-select-device.js'
import { TuyaTemperatureSensorDevice } from './tuya-temperature-sensor-device.js'

/** The kettle DP layout (product-specific; defaults from {@link DEFAULT_KETTLE_DP_MAP}). */
export const tuyaKettleDpMapSchema = z.object({
  powerDp: z.string().default(DEFAULT_KETTLE_DP_MAP.powerDp),
  keepWarmDp: z.string().default(DEFAULT_KETTLE_DP_MAP.keepWarmDp),
  targetTempDp: z.string().default(DEFAULT_KETTLE_DP_MAP.targetTempDp),
  currentTempDp: z.string().default(DEFAULT_KETTLE_DP_MAP.currentTempDp),
  statusDp: z.string().default(DEFAULT_KETTLE_DP_MAP.statusDp),
  tempScale: z.number().positive().default(DEFAULT_KETTLE_DP_MAP.tempScale),
})

/** Persisted config for a Tuya kettle Container: the base device config plus the
 *  product-specific DP map + the target-temperature options. */
export const tuyaKettleConfigSchema = tuyaDeviceConfigSchema.extend({
  kettle: tuyaKettleDpMapSchema.default({ ...DEFAULT_KETTLE_DP_MAP }),
  targetOptions: z.array(z.string().min(1)).default([...DEFAULT_KETTLE_TARGET_OPTIONS]),
})

export type TuyaKettleConfig = z.infer<typeof tuyaKettleConfigSchema>

/**
 * A Tuya kettle (water-heater family, `category: bh`) as a `DeviceType.Container`
 * that OWNS the single live LAN client and fans out its thin per-DP entities as
 * accessory children (mirroring localtuya): a power switch, a keep-warm switch,
 * the target-temperature select, the current-temperature sensor, and the
 * work-status enum sensor. The Container declares no cap of its own — every
 * control/read lives on a child driven through the SHARED handle.
 *
 * The exact DP numbers are product-specific (`kettle` config, defaulted from
 * {@link DEFAULT_KETTLE_DP_MAP}) and are calibrated at Phase-C live onboarding.
 */
export class TuyaKettleContainerDevice extends TuyaBaseDevice {
  readonly #kettle: z.infer<typeof tuyaKettleDpMapSchema>
  readonly #targetOptions: readonly string[]

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceType.Container)
    const cfg = tuyaKettleConfigSchema.parse(ctx.persistedConfig ?? {})
    this.#kettle = cfg.kettle
    this.#targetOptions = cfg.targetOptions
    void this.updateSourceInfo({ id: this.tuyaDeviceId, system: 'tuya' })
  }

  // The container carries no cap of its own; its caps live on the children.
  protected override registerCaps(): void {
    // no-op — see class doc
  }

  protected override onDpsPush(): void {
    // no-op — children subscribe to the shared dps fan-out and recompute
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const base: Record<string, unknown> = {
      integrationId: this.integrationId,
      tuyaDeviceId: this.tuyaDeviceId,
      system: 'tuya',
    }
    const child = (
      suffix: string,
      type: DeviceType,
      label: string,
      config: Record<string, unknown>,
      factory: (ctx: DeviceContext) => IDevice,
    ): AccessoryChildSpec => ({
      stableIdSuffix: suffix,
      meta: { type, name: `${this.name} ${label}`, linkDeviceId: this.id },
      config: { ...base, ...config },
      factory,
    })

    return [
      child(
        'power',
        DeviceType.Switch,
        'Power',
        { dp: this.#kettle.powerDp, label: 'Power' },
        (c) => new TuyaDpSwitchDevice(c),
      ),
      child(
        'keepwarm',
        DeviceType.Switch,
        'Keep warm',
        { dp: this.#kettle.keepWarmDp, label: 'Keep warm' },
        (c) => new TuyaDpSwitchDevice(c),
      ),
      child(
        'target',
        DeviceType.Control,
        'Target temperature',
        {
          dp: this.#kettle.targetTempDp,
          scale: this.#kettle.tempScale,
          options: [...this.#targetOptions],
          label: 'Target temperature',
        },
        (c) => new TuyaTargetTempSelectDevice(c),
      ),
      child(
        'temp',
        DeviceType.Sensor,
        'Temperature',
        { dp: this.#kettle.currentTempDp, scale: this.#kettle.tempScale, label: 'Temperature' },
        (c) => new TuyaTemperatureSensorDevice(c),
      ),
      child(
        'status',
        DeviceType.Sensor,
        'Status',
        { dp: this.#kettle.statusDp, label: 'Status' },
        (c) => new TuyaEnumSensorDevice(c),
      ),
    ]
  }
}
