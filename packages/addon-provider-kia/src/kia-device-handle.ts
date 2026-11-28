import type { VehicleRefreshResult } from '@dominevo/types'
import type { KiaCommand, KiaCommandResult, KiaVehicleState } from './kia-bridge.js'

/** What a vehicle handle can ask of its account (the integration manager implements it). */
export interface KiaVehicleOps {
  /** Wake the car and read it; typed refusals, never a throw for an expected one. */
  requestRefresh(vehicleId: string): Promise<VehicleRefreshResult>
  /** Send one command; throws {@link KiaBudgetExhaustedError} when the day's allowance is spent. */
  command(vehicleId: string, command: KiaCommand): Promise<KiaCommandResult>
}

/**
 * One vehicle as the device classes see it: the LAST state the cloud reported (never a
 * command's echo, D1061 holds a commanded value until the car confirms), change listeners and
 * the two operations that cost quota. Owned by the integration manager, which feeds it from
 * the scheduled read, a forced refresh or a command's read-back.
 */
export class KiaVehicleHandle {
  readonly vehicleId: string
  readonly #ops: KiaVehicleOps
  readonly #changeListeners = new Set<() => void>()
  #state: KiaVehicleState

  constructor(vehicleId: string, state: KiaVehicleState, ops: KiaVehicleOps) {
    this.vehicleId = vehicleId
    this.#state = state
    this.#ops = ops
  }

  get state(): KiaVehicleState {
    return this.#state
  }

  /** Fold a reported state in and tell the listeners. */
  update(state: KiaVehicleState): void {
    this.#state = state
    for (const listener of [...this.#changeListeners]) listener()
  }

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener)
    return () => this.#changeListeners.delete(listener)
  }

  requestRefresh(): Promise<VehicleRefreshResult> {
    return this.#ops.requestRefresh(this.vehicleId)
  }

  command(command: KiaCommand): Promise<KiaCommandResult> {
    return this.#ops.command(this.vehicleId, command)
  }
}
