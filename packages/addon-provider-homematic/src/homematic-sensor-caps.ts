import {
  ambientLightSensorCapability,
  humiditySensorCapability,
  powerMeterCapability,
  temperatureSensorCapability,
  type AmbientLightSensorStatus,
  type DeviceContext,
  type HumiditySensorStatus,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  type PowerMeterStatus,
  type TemperatureSensorStatus,
} from '@camstack/types'

/**
 * Registration of the read-only Homematic sensor caps. These are
 * push-only: the slice is seeded cold here and updated from the device
 * class's `valueChanged` handler. Extracted from `HomematicDevice` to
 * keep that class a thin actuator-wiring layer.
 */

const COLD_TEMPERATURE: TemperatureSensorStatus = { celsius: 0, lastFetchedAt: 0 }
const COLD_HUMIDITY: HumiditySensorStatus = { percent: 0, lastFetchedAt: 0 }
const COLD_AMBIENT_LIGHT: AmbientLightSensorStatus = { lux: 0, lastFetchedAt: 0 }
const COLD_POWER: PowerMeterStatus = { lastFetchedAt: 0 }

export function registerTemperatureCap(
  ctx: DeviceContext,
  runtimeState: IDeviceRuntimeState,
): void {
  const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
    getStatus: async () =>
      runtimeState.getCapState<TemperatureSensorStatus>('temperature-sensor') ?? COLD_TEMPERATURE,
  }
  ctx.registerNativeCap(temperatureSensorCapability, provider)
  // Seed cold-start defaults AFTER registerNativeCap so the schema is
  // installed by the kernel context factory before the first write.
  runtimeState.setCapState('temperature-sensor', COLD_TEMPERATURE)
}

export function registerHumidityCap(ctx: DeviceContext, runtimeState: IDeviceRuntimeState): void {
  const provider: InferNativeProvider<typeof humiditySensorCapability> = {
    getStatus: async () =>
      runtimeState.getCapState<HumiditySensorStatus>('humidity-sensor') ?? COLD_HUMIDITY,
  }
  ctx.registerNativeCap(humiditySensorCapability, provider)
  // Seed cold-start defaults AFTER registerNativeCap so the schema is
  // installed by the kernel context factory before the first write.
  runtimeState.setCapState('humidity-sensor', COLD_HUMIDITY)
}

export function registerAmbientLightCap(
  ctx: DeviceContext,
  runtimeState: IDeviceRuntimeState,
): void {
  const provider: InferNativeProvider<typeof ambientLightSensorCapability> = {
    getStatus: async () =>
      runtimeState.getCapState<AmbientLightSensorStatus>('ambient-light-sensor') ??
      COLD_AMBIENT_LIGHT,
  }
  ctx.registerNativeCap(ambientLightSensorCapability, provider)
  // Seed cold-start defaults AFTER registerNativeCap so the schema is
  // installed by the kernel context factory before the first write.
  runtimeState.setCapState('ambient-light-sensor', COLD_AMBIENT_LIGHT)
}

export function registerPowerMeterCap(ctx: DeviceContext, runtimeState: IDeviceRuntimeState): void {
  const provider: InferNativeProvider<typeof powerMeterCapability> = {
    getStatus: async () => runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_POWER,
  }
  ctx.registerNativeCap(powerMeterCapability, provider)
  // Seed cold-start defaults AFTER registerNativeCap so the schema is
  // installed by the kernel context factory before the first write.
  runtimeState.setCapState('power-meter', COLD_POWER)
}
