import {
  switchCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * HA-backed CamStack switch device. Materialised on adoption of any
 * HA entity whose `mappedTo.capabilities` contains `switch` — covers
 * the `switch.*`, `input_boolean.*` domains and `fan.*` parents that
 * register `switch + fan-control` (the switch cap component lives
 * here; fan-control lands on `HaFanDevice` in F3).
 *
 * Lifecycle:
 *   - HA pushes state.state ∈ {'on','off'} via the wildcard
 *     `subscribe_entities`. `handleStatePush` translates into the
 *     `switch` cap's runtime-state slice — the kernel propagates the
 *     change to UI consumers via the per-device proxy.
 *   - `setState({on})` translates into a `switch.turn_on` /
 *     `switch.turn_off` service call via `callHaService`. The
 *     subsequent HA state-changed push round-trips through
 *     `handleStatePush` to settle the slice.
 *
 * Both directions converge on the kernel's runtime-state slice as the
 * single source of truth.
 */
export class HaSwitchDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerSwitchCap()
    // The seed is written OVER the slice hydrated from the persisted runtime
    // state (the schema was installed by `registerSwitchCap`). Keep the stored
    // LEVEL when present: inventing `false` over a stored `true` is a false
    // falling edge that re-arms every one-shot consumer (composer `rose` on a
    // HA doorbell switch) when HA then pushes the real `on` after a provider
    // restart. Mirror `HaBinarySensorDevice`.
    const stored = this.runtimeState.getCapState<SwitchStatus>('switch')
    const seededOn = typeof stored?.on === 'boolean' ? stored.on : false
    const seededChangedAt =
      typeof stored?.lastChangedAt === 'number' &&
      Number.isFinite(stored.lastChangedAt) &&
      stored.lastChangedAt > 0
        ? stored.lastChangedAt
        : 0
    this.runtimeState.setCapState('switch', { on: seededOn, lastChangedAt: seededChangedAt })
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const on = state.state === 'on'
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const previous = this.runtimeState.getCapState<SwitchStatus>('switch')
    if (previous && previous.on === on && previous.lastChangedAt === lastChangedAt) return
    this.runtimeState.setCapState('switch', { on, lastChangedAt })
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => {
        const status = this.runtimeState.getCapState<SwitchStatus>('switch')
        return status ?? { on: false, lastChangedAt: 0 }
      },
      setState: async ({ on }) => {
        // The HA domain is recoverable from the entity_id; we use the
        // generic `homeassistant.turn_on` / `turn_off` service which
        // works across `switch.*`, `input_boolean.*`, and `fan.*` —
        // HA dispatches to the right concrete handler. This sidesteps
        // the need to encode the domain at the cap-method boundary.
        const domain = this.entityId.split('.')[0] ?? 'homeassistant'
        await this.callHaService(domain, on ? 'turn_on' : 'turn_off')
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }
}
