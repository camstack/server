import {
  automationControlCapability,
  type DeviceContext,
  type InferNativeProvider,
  type AutomationControlStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: AutomationControlStatus = {
  enabled: false,
  isRunning: false,
  lastTriggeredAt: 0,
  lastError: null,
  lastChangedAt: 0,
}

/**
 * HA-backed automation device — `automation.*`. HA state.state ∈
 * {`on`, `off`} reflects enabled, not running. Running state isn't
 * directly surfaced by HA on the entity; we approximate by detecting
 * a `last_triggered` change relative to the previous push.
 *
 * Methods:
 *   enable  → automation.turn_on
 *   disable → automation.turn_off
 *   trigger({skipCondition?}) → automation.trigger({skip_condition?})
 */
export class HaAutomationDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerAutomationCap()
    this.runtimeState.setCapState('automation-control', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const enabled = state.state === 'on'
    const lastTriggered = state.attributes['last_triggered']
    const lastTriggeredAt = typeof lastTriggered === 'string' ? Date.parse(lastTriggered) || 0 : 0
    const prev =
      this.runtimeState.getCapState<AutomationControlStatus>('automation-control') ?? COLD_START
    this.runtimeState.setCapState('automation-control', {
      enabled,
      isRunning: prev.isRunning,
      lastTriggeredAt,
      lastError: prev.lastError,
      lastChangedAt,
    })
  }

  private registerAutomationCap(): void {
    const provider: InferNativeProvider<typeof automationControlCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<AutomationControlStatus>('automation-control') ?? COLD_START
        )
      },
      enable: async () => {
        await this.callHaService('automation', 'turn_on')
      },
      disable: async () => {
        await this.callHaService('automation', 'turn_off')
      },
      trigger: async ({ skipCondition }) => {
        const data = skipCondition !== undefined ? { skip_condition: skipCondition } : undefined
        await this.callHaService('automation', 'trigger', data)
      },
    }
    this.ctx.registerNativeCap(automationControlCapability, provider)
  }
}
