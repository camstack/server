import {
  lawnMowerControlCapability,
  type DeviceContext,
  type InferNativeProvider,
  type LawnMowerControlStatus,
  RUNNING_STATE_COLD,
  type RunningStateStatus,
  runningFromLawnMower,
  runningStateCapability,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: LawnMowerControlStatus = {
  activity: 'idle',
  batteryLevel: null,
  progress: null,
  currentCode: null,
  currentCodeLabel: null,
  severity: 'info',
  lastChangedAt: 0,
}

/**
 * HA-backed robotic lawn-mower device. One cap (`lawn-mower-control`)
 * with the mowing lifecycle surface (startMowing / pause / dock).
 *
 * HA `lawn_mower.*` activity value ∈ {mowing, docked, paused, error}.
 * `battery_level` (0..100) is an optional attribute — it stays null
 * when HA doesn't report it.
 */
export class HaLawnMowerDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerLawnMowerCap()
    this.registerRunningCap()
    this.runtimeState.setCapState('lawn-mower-control', COLD_START)
    this.runtimeState.setCapState('running-state', RUNNING_STATE_COLD)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const activity = mapHaStateToLawnMowerActivity(state.state)
    const batteryLevel = readNumericAttr(state.attributes, 'battery_level')
    if (activity !== null) {
      this.runtimeState.setCapState('lawn-mower-control', {
        activity,
        batteryLevel,
        progress: readNumericAttr(state.attributes, 'mowing_progress'),
        currentCode: null,
        currentCodeLabel: null,
        severity: activity === 'error' ? 'error' : 'info',
        lastChangedAt,
      })
    }
    const fetchedAt = Date.now()
    const previous = this.runtimeState.getCapState<RunningStateStatus>('running-state')
    this.runtimeState.setCapState(
      'running-state',
      runningFromLawnMower(activity, previous, fetchedAt, lastChangedAt),
    )
  }

  private registerRunningCap(): void {
    const provider: InferNativeProvider<typeof runningStateCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<RunningStateStatus>('running-state') ?? RUNNING_STATE_COLD,
    }
    this.ctx.registerNativeCap(runningStateCapability, provider)
  }

  private registerLawnMowerCap(): void {
    const provider: InferNativeProvider<typeof lawnMowerControlCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<LawnMowerControlStatus>('lawn-mower-control') ?? COLD_START
        )
      },
      startMowing: async () => {
        await this.callHaService('lawn_mower', 'start_mowing')
      },
      pause: async () => {
        await this.callHaService('lawn_mower', 'pause')
      },
      dock: async () => {
        await this.callHaService('lawn_mower', 'dock')
      },
    }
    this.ctx.registerNativeCap(lawnMowerControlCapability, provider)
  }
}

function mapHaStateToLawnMowerActivity(s: string): LawnMowerControlStatus['activity'] | null {
  if (s === 'mowing') return 'mowing'
  if (s === 'docked') return 'docked'
  if (s === 'paused') return 'paused'
  if (s === 'error') return 'error'
  if (s === 'idle') return 'idle'
  return null
}

function readNumericAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}
