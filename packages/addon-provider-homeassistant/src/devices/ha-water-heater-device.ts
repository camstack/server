import {
  waterHeaterCapability,
  type DeviceContext,
  type InferNativeProvider,
  type WaterHeaterStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: WaterHeaterStatus = {
  currentTemp: null,
  targetTemp: null,
  operationMode: null,
  availableModes: [],
  away: null,
  minTemp: null,
  maxTemp: null,
  lastChangedAt: 0,
}

/**
 * HA-backed water heater / boiler. Single cap (`water-heater`) with the
 * target-temperature + operation-mode + away surface.
 *
 * HA `water_heater.*` attributes consumed:
 *   - `state.state` → `operationMode`
 *   - `current_temperature` → `currentTemp`
 *   - `temperature` → `targetTemp`
 *   - `operation_list` → `availableModes`
 *   - `away_mode` ('on'/'off') → `away` (null when the attr is absent)
 *   - `min_temp` / `max_temp` → bounds
 *
 * Mutations route to:
 *   - `water_heater.set_temperature({ temperature })`
 *   - `water_heater.set_operation_mode({ operation_mode })`
 *   - `water_heater.set_away_mode({ away_mode })` — HA expects a boolean
 */
export class HaWaterHeaterDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerWaterHeaterCap()
    this.runtimeState.setCapState('water-heater', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const attrs = state.attributes

    this.runtimeState.setCapState('water-heater', {
      currentTemp: readNumberAttr(attrs, 'current_temperature'),
      targetTemp: readNumberAttr(attrs, 'temperature'),
      operationMode: state.state,
      availableModes: readStringArray(attrs, 'operation_list'),
      away: readAwayMode(attrs),
      minTemp: readNumberAttr(attrs, 'min_temp'),
      maxTemp: readNumberAttr(attrs, 'max_temp'),
      lastChangedAt,
    })
  }

  private registerWaterHeaterCap(): void {
    const provider: InferNativeProvider<typeof waterHeaterCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<WaterHeaterStatus>('water-heater') ?? COLD_START
      },
      setTargetTemp: async ({ temp }) => {
        await this.callHaService('water_heater', 'set_temperature', { temperature: temp })
      },
      setOperationMode: async ({ mode }) => {
        await this.callHaService('water_heater', 'set_operation_mode', { operation_mode: mode })
      },
      setAway: async ({ on }) => {
        await this.callHaService('water_heater', 'set_away_mode', { away_mode: on })
      },
    }
    this.ctx.registerNativeCap(waterHeaterCapability, provider)
  }
}

/** HA `away_mode` is reported as the string 'on'/'off'. Returns null when
 *  the attribute is absent (device has no away surface). */
function readAwayMode(attrs: Record<string, unknown>): boolean | null {
  const v = attrs['away_mode']
  if (typeof v === 'string') return v === 'on'
  if (typeof v === 'boolean') return v
  return null
}

function readStringArray(attrs: Record<string, unknown>, key: string): string[] {
  const v = attrs[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

function readNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}
