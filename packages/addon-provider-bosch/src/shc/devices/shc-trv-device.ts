import {
  batteryCapability,
  heatingValveCapability,
  temperatureSensorCapability,
  type BatteryStatus,
  type DeviceContext,
  type HeatingValveStatus,
  type InferNativeProvider,
  type TemperatureSensorStatus,
} from '@camstack/types'
import type {
  ShcBatteryLevelState,
  ShcTemperatureLevelState,
  ShcValveTappetState,
} from '../shc-types.js'
import { ShcBaseDevice } from './shc-device-base.js'

const TEMP_CAP = 'temperature-sensor'
const BATTERY_CAP = 'battery'
const VALVE_CAP = 'heating-valve'

const TEMP_COLD: TemperatureSensorStatus = { temperature: 0, lastFetchedAt: 0 }
const BATTERY_COLD: BatteryStatus = {
  level: null,
  charging: 'unknown',
  sleeping: false,
  lastUpdated: 0,
}
const VALVE_COLD: HeatingValveStatus = { position: null, lastFetchedAt: 0 }

/** Radiator TRV — local temperature, valve position, battery (no room setpoint). */
export class ShcTrvDevice extends ShcBaseDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  protected override registerCaps(): void {
    const tempProvider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<TemperatureSensorStatus>(TEMP_CAP) ?? TEMP_COLD,
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, tempProvider)
    this.runtimeState.setCapState(TEMP_CAP, TEMP_COLD)

    const batteryProvider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<BatteryStatus>(BATTERY_CAP) ?? BATTERY_COLD,
      wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
    }
    this.ctx.registerNativeCap(batteryCapability, batteryProvider)
    this.runtimeState.setCapState(BATTERY_CAP, BATTERY_COLD)

    const valveProvider: InferNativeProvider<typeof heatingValveCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<HeatingValveStatus>(VALVE_CAP) ?? VALVE_COLD,
    }
    this.ctx.registerNativeCap(heatingValveCapability, valveProvider)
    this.runtimeState.setCapState(VALVE_CAP, VALVE_COLD)
  }

  protected override async refreshFromController(): Promise<void> {
    const client = this.resolveClient()
    if (client === null) return
    const now = Date.now()

    try {
      const temp = await client.getServiceState<ShcTemperatureLevelState>(
        this.shcDeviceId,
        'TemperatureLevel',
      )
      const temperature = temp.temperature
      if (typeof temperature === 'number' && Number.isFinite(temperature)) {
        const prev = this.runtimeState.getCapState<TemperatureSensorStatus>(TEMP_CAP)
        this.runtimeState.setCapState(TEMP_CAP, { temperature: temperature, lastFetchedAt: now })
        if (prev !== undefined && prev.temperature !== temperature && prev.lastFetchedAt !== 0) {
          this.deviceLog('info', 'SHC temperature updated from controller', {
            celsius: temperature,
            previous: prev.temperature,
          })
        }
      }
    } catch {
      // optional service
    }

    try {
      const valve = await client.getServiceState<ShcValveTappetState>(
        this.shcDeviceId,
        'ValveTappet',
      )
      const position =
        typeof valve.position === 'number' && Number.isFinite(valve.position)
          ? Math.min(100, Math.max(0, valve.position))
          : null
      const prevValve = this.runtimeState.getCapState<HeatingValveStatus>(VALVE_CAP)
      this.runtimeState.setCapState(VALVE_CAP, { position, lastFetchedAt: now })
      if (
        prevValve !== undefined &&
        prevValve.position !== position &&
        prevValve.lastFetchedAt !== 0
      ) {
        this.deviceLog('info', 'SHC valve updated from controller', {
          position,
          previous: prevValve.position,
        })
      }
    } catch {
      // optional
    }

    try {
      const batt = await client.getServiceState<ShcBatteryLevelState>(
        this.shcDeviceId,
        'BatteryLevel',
      )
      this.runtimeState.setCapState(BATTERY_CAP, {
        level: batt.batteryLevel ?? null,
        charging: 'unknown',
        sleeping: false,
        lastUpdated: now,
      })
    } catch {
      // optional
    }
  }
}
