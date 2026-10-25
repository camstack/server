import {
  scriptRunnerCapability,
  type DeviceContext,
  type InferNativeProvider,
  type ScriptRunnerStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: ScriptRunnerStatus = {
  isRunning: false,
  lastRunAt: 0,
  lastRunSuccess: null,
  lastError: null,
  lastChangedAt: 0,
}

/**
 * HA-backed script device — `script.*`. The HA state value alternates
 * between `'on'` (running) and `'off'` (idle). `last_triggered`
 * attribute carries the last invocation timestamp.
 *
 * Run: HA `script.<name>` works as both an entity AND a script call
 * — calling `script.turn_on` runs it (without variables). To pass
 * variables, use `script.<entity_id_suffix>` as the service name with
 * variables as service-data. We use `script.turn_on` for the
 * no-variables path and the script-id service for the variables path.
 */
export class HaScriptDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerScriptCap()
    this.runtimeState.setCapState('script-runner', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const isRunning = state.state === 'on'
    const lastTriggered = state.attributes['last_triggered']
    const lastRunAt = typeof lastTriggered === 'string' ? Date.parse(lastTriggered) || 0 : 0
    const prev = this.runtimeState.getCapState<ScriptRunnerStatus>('script-runner') ?? COLD_START
    this.runtimeState.setCapState('script-runner', {
      isRunning,
      lastRunAt,
      lastRunSuccess: prev.lastRunSuccess,
      lastError: prev.lastError,
      lastChangedAt,
    })
  }

  private registerScriptCap(): void {
    const provider: InferNativeProvider<typeof scriptRunnerCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<ScriptRunnerStatus>('script-runner') ?? COLD_START
      },
      run: async ({ variables }) => {
        // Script entity_id is `script.<name>`. To pass variables, HA
        // wants the call routed to `script.<name>` service directly
        // (not `script.turn_on`).
        const scriptName = this.entityId.split('.')[1] ?? ''
        if (variables !== undefined) {
          await this.callHaService('script', scriptName, variables)
          return
        }
        await this.callHaService('script', 'turn_on')
      },
      stop: async () => {
        await this.callHaService('script', 'turn_off')
      },
    }
    this.ctx.registerNativeCap(scriptRunnerCapability, provider)
  }
}
