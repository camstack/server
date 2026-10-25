import {
  humidifierCapability,
  type DeviceContext,
  type InferNativeProvider,
  type HumidifierStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: HumidifierStatus = {
  on: false,
  currentHumidity: null,
  targetHumidity: null,
  mode: null,
  availableModes: [],
  action: null,
  minHumidity: null,
  maxHumidity: null,
  lastChangedAt: 0,
}

/**
 * HA-backed humidifier / dehumidifier. Single cap (`humidifier`) with
 * the on/off + target-humidity + mode surface.
 *
 * HA `humidifier.*` attributes consumed:
 *   - `state.state` ∈ {on, off} → `on`
 *   - `current_humidity` → `currentHumidity`
 *   - `humidity` → `targetHumidity`
 *   - `mode` → `mode`
 *   - `available_modes` → `availableModes`
 *   - `action` → `action` (verbatim)
 *   - `min_humidity` / `max_humidity` → bounds
 *
 * Mutations route to:
 *   - `humidifier.turn_on` / `humidifier.turn_off`
 *   - `humidifier.set_humidity({ humidity })`
 *   - `humidifier.set_mode({ mode })`
 */
export class HaHumidifierDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerHumidifierCap()
    this.runtimeState.setCapState('humidifier', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const attrs = state.attributes

    this.runtimeState.setCapState('humidifier', {
      on: state.state === 'on',
      currentHumidity: readNumberAttr(attrs, 'current_humidity'),
      targetHumidity: readNumberAttr(attrs, 'humidity'),
      mode: readStringAttr(attrs, 'mode'),
      availableModes: readStringArray(attrs, 'available_modes'),
      action: readStringAttr(attrs, 'action'),
      minHumidity: readNumberAttr(attrs, 'min_humidity'),
      maxHumidity: readNumberAttr(attrs, 'max_humidity'),
      lastChangedAt,
    })
  }

  private registerHumidifierCap(): void {
    const provider: InferNativeProvider<typeof humidifierCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<HumidifierStatus>('humidifier') ?? COLD_START
      },
      setOn: async ({ on }) => {
        await this.callHaService('humidifier', on ? 'turn_on' : 'turn_off')
      },
      setTargetHumidity: async ({ humidity }) => {
        await this.callHaService('humidifier', 'set_humidity', { humidity })
      },
      setMode: async ({ mode }) => {
        await this.callHaService('humidifier', 'set_mode', { mode })
      },
    }
    this.ctx.registerNativeCap(humidifierCapability, provider)
  }
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' ? v : null
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
