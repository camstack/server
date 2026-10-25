import { MowerDevice as DreameMower, type MowerTaskSubState } from '@apocaliss92/nodedreame'
import {
  type DeviceContext,
  type EnumSensorStatus,
  enumSensorCapability,
  type InferNativeProvider,
} from '@camstack/types'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'enum-sensor'

/** Title-case label per task sub-state ('returning-to-dock' → 'Returning To Dock'). */
function substateLabel(s: MowerTaskSubState): string {
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Mower "Task" sensor (DeviceType.Sensor, `enum-sensor` cap) backed by the live
 * task sub-state decoded from the HEARTBEAT (1:1) push — idle/starting/mowing/
 * paused/finished/failed/exit/returning-to-dock. Unlike the catalog enum sensors
 * (which read one raw MIoT int), this is a DERIVED value, so it reads the typed
 * `MowerDevice.taskSubState` getter rather than a single property. The heartbeat
 * is push-only (the mower does not answer live reads), so the value tracks the
 * device while it is actively mowing and reads "Idle" otherwise.
 */
export class DreameMowerSubstateDevice extends DreameChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:mower-task-substate`,
      system: 'dreame',
    })
  }

  private resolveMower(): DreameMower | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameMower ? handle : null
  }

  /** The current sub-state as a display label ('Idle' when no session is active). */
  #read(): string {
    const sub = this.resolveMower()?.taskSubState ?? null
    return sub === null ? 'Idle' : substateLabel(sub)
  }

  #slice(value: string): EnumSensorStatus {
    return { value, lastFetchedAt: Date.now() }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EnumSensorStatus>(CAP_NAME) ?? this.#slice(this.#read()),
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, this.#slice(this.#read()))
  }

  protected override recomputeSlice(): void {
    const value = this.#read()
    const current = this.runtimeState.getCapState<EnumSensorStatus>(CAP_NAME)
    if (current?.value === value) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(value))
  }
}
