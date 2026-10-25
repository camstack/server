import {
  coverCapability,
  type DeviceContext,
  type InferNativeProvider,
  type CoverStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { haChangeStamp, type HaStatePushContext } from '../ha-change-stamp.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: CoverStatus = {
  state: 'closed',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}

/**
 * HA-backed cover device. One cap (`cover`) registered with the full
 * lifecycle surface (open/close/stop/setPosition/setTiltPosition).
 * Position + tilt slice fields stay `null` when HA doesn't report them
 * (positionless garage door / blind without tilt).
 *
 * HA `cover.*` state value ∈ {open, opening, closing, closed} +
 * optional `current_position` / `current_tilt_position` attributes
 * (0..100, 0 closed, 100 open). The cap's `CoverState` enum also
 * includes `stopped` — HA doesn't surface that directly; we never
 * write it from the push handler (it shows up only when the operator
 * explicitly calls `stop_cover` and we hear the state-changed before
 * a fresh open/close kicks in — but HA itself transitions back to a
 * settled state so this is rare; consumers see `opening/closing` then
 * back to the new settled state).
 */
export class HaCoverDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerCoverCap()
    this.runtimeState.setCapState('cover', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState, push: HaStatePushContext): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lifecycleState = mapHaStateToCoverState(state.state)
    if (lifecycleState === null) return
    const position = readNumericAttr(state.attributes, 'current_position')
    const tilt = readNumericAttr(state.attributes, 'current_tilt_position')
    const prior = this.runtimeState.getCapState<CoverStatus>('cover')
    // A recovery to the word it already held is not a transition (`ha-change-stamp.ts`).
    const stamp = haChangeStamp({
      sameValue: prior?.state === lifecycleState,
      priorChangedAt: prior?.lastChangedAt,
      haChangedAt: Date.parse(state.last_changed) || Date.now(),
      afterOutage: push.afterOutage,
    })
    if (stamp.kind === 'seeded') {
      this.deviceLogger.info('HA→device recovery with no known prior value — no change time', {
        meta: { entityId: this.entityId, cap: 'cover', value: state.state },
      })
    }
    this.runtimeState.setCapState('cover', {
      state: lifecycleState,
      position,
      tiltPosition: tilt,
      lastChangedAt: stamp.at,
    })
  }

  private registerCoverCap(): void {
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_START
      },
      open: async () => {
        await this.callHaService('cover', 'open_cover')
      },
      close: async () => {
        await this.callHaService('cover', 'close_cover')
      },
      stop: async () => {
        await this.callHaService('cover', 'stop_cover')
      },
      setPosition: async ({ position }) => {
        await this.callHaService('cover', 'set_cover_position', { position })
      },
      setTiltPosition: async ({ tiltPosition }) => {
        await this.callHaService('cover', 'set_cover_tilt_position', {
          tilt_position: tiltPosition,
        })
      },
    }
    this.ctx.registerNativeCap(coverCapability, provider)
  }
}

function mapHaStateToCoverState(s: string): CoverStatus['state'] | null {
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
