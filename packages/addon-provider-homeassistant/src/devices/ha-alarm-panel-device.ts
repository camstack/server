import {
  alarmPanelCapability,
  type DeviceContext,
  type InferNativeProvider,
  type AlarmPanelStatus,
  type AlarmState,
  type AlarmArmMode,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: AlarmPanelStatus = {
  state: 'disarmed',
  targetMode: null,
  availableModes: [],
  requiresCode: false,
  lastChangedAt: 0,
}

/**
 * HA-backed alarm panel. `alarm-panel` cap with arm/disarm/trigger.
 * HA service map:
 *   - arm({mode, code?}) → alarm_arm_<mode>({code})
 *   - disarm({code?})    → alarm_disarm({code})
 *   - trigger()          → alarm_trigger
 * `code_format !== null` → `requiresCode: true`.
 */
export class HaAlarmPanelDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerAlarmCap()
    this.runtimeState.setCapState('alarm-panel', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const lifecycle = mapHaState(state.state)
    if (lifecycle === null) return
    const attrs = state.attributes
    this.runtimeState.setCapState('alarm-panel', {
      state: lifecycle,
      // HA's transitional words do not name the mode — only settled `armed_*`
      // do. Null here is honest; the NC panel publishes targetMode always.
      targetMode: targetModeFromState(lifecycle),
      availableModes: deriveAvailableModes(attrs),
      requiresCode: attrs['code_format'] !== undefined && attrs['code_format'] !== null,
      lastChangedAt,
    })
  }

  private registerAlarmCap(): void {
    const provider: InferNativeProvider<typeof alarmPanelCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<AlarmPanelStatus>('alarm-panel') ?? COLD_START
      },
      arm: async ({ mode, code }) => {
        const service = `alarm_arm_${mode}`
        await this.callHaService(
          'alarm_control_panel',
          service,
          code !== undefined ? { code } : undefined,
        )
      },
      disarm: async ({ code }) => {
        await this.callHaService(
          'alarm_control_panel',
          'alarm_disarm',
          code !== undefined ? { code } : undefined,
        )
      },
      trigger: async () => {
        await this.callHaService('alarm_control_panel', 'alarm_trigger')
      },
    }
    this.ctx.registerNativeCap(alarmPanelCapability, provider)
  }
}

function mapHaState(s: string): AlarmState | null {
  switch (s) {
    case 'disarmed':
      return 'disarmed'
    case 'armed_home':
      return 'armed_home'
    case 'armed_away':
      return 'armed_away'
    case 'armed_night':
      return 'armed_night'
    case 'armed_vacation':
      return 'armed_vacation'
    case 'armed_custom_bypass':
      return 'armed_custom_bypass'
    case 'arming':
      return 'arming'
    case 'disarming':
      return 'disarming'
    case 'pending':
      return 'pending'
    case 'triggered':
      return 'triggered'
    default:
      return null
  }
}

/** Settled `armed_*` → mode; transitional HA words carry no mode. */
function targetModeFromState(state: AlarmState): AlarmArmMode | null {
  switch (state) {
    case 'armed_home':
      return 'home'
    case 'armed_away':
      return 'away'
    case 'armed_night':
      return 'night'
    case 'armed_vacation':
      return 'vacation'
    case 'armed_custom_bypass':
      return 'custom_bypass'
    default:
      return null
  }
}

function deriveAvailableModes(attrs: Record<string, unknown>): AlarmArmMode[] {
  // HA exposes `supported_features` bitmask:
  // ARM_HOME=1, ARM_AWAY=2, ARM_NIGHT=4, TRIGGER=8, ARM_CUSTOM_BYPASS=16, ARM_VACATION=32.
  const sf = attrs['supported_features']
  if (typeof sf !== 'number') return []
  const out: AlarmArmMode[] = []
  if ((sf & 1) !== 0) out.push('home')
  if ((sf & 2) !== 0) out.push('away')
  if ((sf & 4) !== 0) out.push('night')
  if ((sf & 32) !== 0) out.push('vacation')
  if ((sf & 16) !== 0) out.push('custom_bypass')
  return out
}
