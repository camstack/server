import {
  vacuumControlCapability,
  type DeviceContext,
  type InferNativeProvider,
  RUNNING_STATE_COLD,
  type RunningStateStatus,
  runningFromVacuumState,
  runningStateCapability,
  type VacuumControlStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: VacuumControlStatus = {
  state: 'idle',
  batteryLevel: null,
  fanSpeed: null,
  availableFanSpeeds: [],
  progress: null,
  errorCode: null,
  errorLabel: null,
  lastChangedAt: 0,
}

/**
 * HA-backed robot-vacuum device. One cap (`vacuum-control`) with the
 * cleaning lifecycle surface (start / pause / stop / returnToBase /
 * locate / setFanSpeed).
 *
 * HA `vacuum.*` state value ∈ {cleaning, docked, paused, idle,
 * returning, error} (+ legacy {on, off}). `battery_level` (0..100),
 * `fan_speed` (current token) and `fan_speed_list` (accepted tokens)
 * are optional attributes — they stay null / [] when HA doesn't
 * report them.
 */
export class HaVacuumDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerVacuumCap()
    this.registerRunningCap()
    this.runtimeState.setCapState('vacuum-control', COLD_START)
    this.runtimeState.setCapState('running-state', RUNNING_STATE_COLD)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastChangedAt = Date.parse(state.last_changed) || Date.now()
    const lifecycleState = mapHaStateToVacuumState(state.state)
    if (lifecycleState === null) return
    const batteryLevel = readNumericAttr(state.attributes, 'battery_level')
    const fanSpeed = readStringAttr(state.attributes, 'fan_speed')
    const availableFanSpeeds = readStringArrayAttr(state.attributes, 'fan_speed_list')
    this.runtimeState.setCapState('vacuum-control', {
      state: lifecycleState,
      batteryLevel,
      fanSpeed,
      availableFanSpeeds,
      // HA's vacuum domain exposes no tank telemetry — these stay null.
      progress: null,
      errorCode: null,
      // HA surfaces an error string in the `error` attribute when faulted.
      errorLabel: lifecycleState === 'error' ? readStringAttr(state.attributes, 'error') : null,
      lastChangedAt,
    })
    const fetchedAt = Date.now()
    const previous = this.runtimeState.getCapState<RunningStateStatus>('running-state')
    this.runtimeState.setCapState(
      'running-state',
      runningFromVacuumState(lifecycleState, previous, fetchedAt, lastChangedAt),
    )
  }

  private registerRunningCap(): void {
    const provider: InferNativeProvider<typeof runningStateCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<RunningStateStatus>('running-state') ?? RUNNING_STATE_COLD,
    }
    this.ctx.registerNativeCap(runningStateCapability, provider)
  }

  private registerVacuumCap(): void {
    const provider: InferNativeProvider<typeof vacuumControlCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<VacuumControlStatus>('vacuum-control') ?? COLD_START
      },
      start: async () => {
        await this.callHaService('vacuum', 'start')
      },
      pause: async () => {
        await this.callHaService('vacuum', 'pause')
      },
      stop: async () => {
        await this.callHaService('vacuum', 'stop')
      },
      returnToBase: async () => {
        await this.callHaService('vacuum', 'return_to_base')
      },
      locate: async () => {
        await this.callHaService('vacuum', 'locate')
      },
      setFanSpeed: async ({ speed }) => {
        await this.callHaService('vacuum', 'set_fan_speed', { fan_speed: speed })
      },
    }
    this.ctx.registerNativeCap(vacuumControlCapability, provider)
  }
}

function mapHaStateToVacuumState(s: string): VacuumControlStatus['state'] | null {
  if (s === 'cleaning') return 'cleaning'
  if (s === 'docked') return 'docked'
  if (s === 'paused') return 'paused'
  if (s === 'returning') return 'returning'
  if (s === 'idle') return 'idle'
  if (s === 'error') return 'error'
  // Legacy on/off + anything unrecognised → settle on idle.
  return 'idle'
}

function readNumericAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' ? v : null
}

function readStringArrayAttr(attrs: Record<string, unknown>, key: string): string[] {
  const v = attrs[key]
  if (!Array.isArray(v)) return []
  return v.filter((item): item is string => typeof item === 'string')
}
