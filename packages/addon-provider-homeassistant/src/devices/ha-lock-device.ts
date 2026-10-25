import {
  lockControlCapability,
  type DeviceContext,
  type InferNativeProvider,
  type LockControlStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { haChangeStamp, type HaStatePushContext } from '../ha-change-stamp.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: LockControlStatus = {
  state: 'unlocked',
  lastChangedAt: 0,
}

/**
 * HA-backed lock device. `lock-control` cap with `lock` / `unlock`
 * mutations. Optional `code` argument is forwarded as HA service-data
 * — locks that don't require a code ignore it; locks that require it
 * reject the call when missing.
 *
 * HA `lock.*` state ∈ {locked, unlocked, locking, unlocking, jammed,
 * open}. The cap enum omits `open` (rare physical-latch concept);
 * we map it to `unlocked` for slice writes.
 */
export class HaLockDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerLockCap()
    this.runtimeState.setCapState('lock-control', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState, push: HaStatePushContext): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lifecycleState = mapHaStateToLockState(state.state)
    if (lifecycleState === null) return
    const prior = this.runtimeState.getCapState<LockControlStatus>('lock-control')
    // A recovery to the word it already held is not a transition (`ha-change-stamp.ts`).
    const stamp = haChangeStamp({
      sameValue: prior?.state === lifecycleState,
      priorChangedAt: prior?.lastChangedAt,
      haChangedAt: Date.parse(state.last_changed) || Date.now(),
      afterOutage: push.afterOutage,
    })
    if (stamp.kind === 'seeded') {
      this.deviceLogger.info('HA→device recovery with no known prior value — no change time', {
        meta: { entityId: this.entityId, cap: 'lock-control', value: state.state },
      })
    }
    this.runtimeState.setCapState('lock-control', {
      state: lifecycleState,
      lastChangedAt: stamp.at,
    })
  }

  private registerLockCap(): void {
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<LockControlStatus>('lock-control') ?? COLD_START
      },
      lock: async ({ code }) => {
        const data = code !== undefined ? { code } : undefined
        await this.callHaService('lock', 'lock', data)
      },
      unlock: async ({ code }) => {
        const data = code !== undefined ? { code } : undefined
        await this.callHaService('lock', 'unlock', data)
      },
      open: async () => {
        await this.callHaService('lock', 'open')
      },
    }
    this.ctx.registerNativeCap(lockControlCapability, provider)
  }
}

function mapHaStateToLockState(s: string): LockControlStatus['state'] | null {
  if (s === 'locked') return 'locked'
  if (s === 'unlocked' || s === 'open') return 'unlocked'
  if (s === 'locking') return 'locking'
  if (s === 'unlocking') return 'unlocking'
  if (s === 'jammed') return 'jammed'
  return null
}
