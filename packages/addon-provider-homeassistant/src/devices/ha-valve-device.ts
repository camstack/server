import {
  valveCapability,
  type DeviceContext,
  type InferNativeProvider,
  type ValveStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: ValveStatus = {
  state: 'closed',
  position: null,
  lastChangedAt: 0,
}

/**
 * HA-backed valve device. One cap (`valve`) registered with the
 * open/close/stop + setPosition surface. The `position` slice field
 * stays `null` when HA doesn't report a `current_position` attribute
 * (open/close-only valves).
 *
 * HA `valve.*` state value ∈ {open, opening, closing, closed} +
 * optional `current_position` attribute (0..100, 0 closed, 100 open).
 * The cap's `ValveState` enum also includes `stopped` — HA doesn't
 * surface that directly, so the push handler never writes it (HA
 * transitions back to a settled state instead).
 */
export class HaValveDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerValveCap()
    this.runtimeState.setCapState('valve', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const lifecycleState = mapHaStateToValveState(state.state)
    if (lifecycleState === null) return
    const position = readNumericAttr(state.attributes, 'current_position')
    this.runtimeState.setCapState('valve', {
      state: lifecycleState,
      position,
      lastChangedAt,
    })
  }

  private registerValveCap(): void {
    const provider: InferNativeProvider<typeof valveCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<ValveStatus>('valve') ?? COLD_START
      },
      open: async () => {
        await this.callHaService('valve', 'open_valve')
      },
      close: async () => {
        await this.callHaService('valve', 'close_valve')
      },
      stop: async () => {
        await this.callHaService('valve', 'stop_valve')
      },
      setPosition: async ({ position }) => {
        await this.callHaService('valve', 'set_valve_position', { position })
      },
    }
    this.ctx.registerNativeCap(valveCapability, provider)
  }
}

function mapHaStateToValveState(s: string): ValveStatus['state'] | null {
  if (s === 'open') return 'open'
  if (s === 'opening') return 'opening'
  if (s === 'closing') return 'closing'
  if (s === 'closed') return 'closed'
  return null
}

function readNumericAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}
