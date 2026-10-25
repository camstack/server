import {
  switchCapability,
  fanControlCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
  type FanControlStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const FAN_COLD_START: FanControlStatus = {
  percentage: null,
  preset: '',
  availablePresets: [],
  direction: null,
  oscillating: null,
  lastChangedAt: 0,
}

/**
 * HA-backed fan device. Two caps:
 *   - `switch` — on/off
 *   - `fan-control` — percentage / preset / direction / oscillating
 *
 * HA `fan.*` services: turn_on / turn_off / set_percentage /
 * set_preset_mode / set_direction / oscillate.
 */
export class HaFanDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerSwitchCap()
    this.registerFanCap()
    this.runtimeState.setCapState('switch', { on: false, lastChangedAt: 0 })
    this.runtimeState.setCapState('fan-control', FAN_COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const on = state.state === 'on'

    this.runtimeState.setCapState('switch', { on, lastChangedAt })

    const attrs = state.attributes
    const slice: FanControlStatus = {
      percentage: readNumberAttr(attrs, 'percentage'),
      percentageStep: readNumberAttr(attrs, 'percentage_step') ?? undefined,
      preset: readStringAttr(attrs, 'preset_mode') ?? '',
      availablePresets: readStringArray(attrs, 'preset_modes'),
      direction: readFanDirection(attrs['direction']),
      oscillating: readBooleanAttr(attrs, 'oscillating'),
      lastChangedAt,
    }
    this.runtimeState.setCapState('fan-control', slice)
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<SwitchStatus>('switch') ?? { on: false, lastChangedAt: 0 }
        )
      },
      setState: async ({ on }) => {
        await this.callHaService('fan', on ? 'turn_on' : 'turn_off')
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }

  private registerFanCap(): void {
    const provider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<FanControlStatus>('fan-control') ?? FAN_COLD_START
      },
      setPercentage: async ({ percentage }) => {
        await this.callHaService('fan', 'set_percentage', { percentage })
      },
      setPreset: async ({ preset }) => {
        await this.callHaService('fan', 'set_preset_mode', { preset_mode: preset })
      },
      setDirection: async ({ direction }) => {
        await this.callHaService('fan', 'set_direction', { direction })
      },
      setOscillating: async ({ oscillating }) => {
        await this.callHaService('fan', 'oscillate', { oscillating })
      },
    }
    this.ctx.registerNativeCap(fanControlCapability, provider)
  }
}

function readNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}
function readBooleanAttr(attrs: Record<string, unknown>, key: string): boolean | null {
  const v = attrs[key]
  return typeof v === 'boolean' ? v : null
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
function readFanDirection(v: unknown): 'forward' | 'reverse' | null {
  return v === 'forward' || v === 'reverse' ? v : null
}
