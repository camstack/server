import type { KiaConfig } from '../config.js'
import {
  type KiaBridge,
  type KiaBridgeVehicle,
  KiaBridgeError,
  type KiaCommand,
  type KiaCommandResult,
  type KiaVehicleState,
} from '../kia-bridge.js'
import { sportageState } from './kia-fixtures.js'

export function sportage(
  vehicleId = 'veh-1',
  state: Partial<KiaVehicleState> = {},
): KiaBridgeVehicle {
  return {
    vehicleId,
    vin: 'U5YPH81ABPL000000',
    name: 'Sportage',
    model: 'Sportage',
    year: 2023,
    engineType: 'HEV',
    state: sportageState(state),
  }
}

/** A bridge double: the cloud answers what the test set, and every call is recorded. */
export class FakeBridge implements KiaBridge {
  vehicles: readonly KiaBridgeVehicle[] = [sportage()]
  loginError: KiaBridgeError | null = null
  readError: KiaBridgeError | null = null
  refreshError: KiaBridgeError | null = null
  commandError: KiaBridgeError | null = null
  /** What the next cached read answers; null = the login's states. */
  readStates: Record<string, KiaVehicleState> | null = null
  refreshState: KiaVehicleState = sportageState({ reportedAtMs: 1_795_339_000_000 })
  commandState: KiaVehicleState = sportageState()
  commandOutcome: KiaCommandResult['outcome'] = 'success'
  readonly logins: KiaConfig[] = []
  readonly commands: Array<{ vehicleId: string; command: KiaCommand }> = []
  readonly refreshes: string[] = []
  reads = 0
  closed = false

  async login(config: KiaConfig): Promise<readonly KiaBridgeVehicle[]> {
    this.logins.push(config)
    if (this.loginError !== null) throw this.loginError
    return this.vehicles
  }

  async read(): Promise<Readonly<Record<string, KiaVehicleState>>> {
    this.reads += 1
    if (this.readError !== null) throw this.readError
    return this.readStates ?? Object.fromEntries(this.vehicles.map((v) => [v.vehicleId, v.state]))
  }

  async refresh(vehicleId: string): Promise<KiaVehicleState> {
    this.refreshes.push(vehicleId)
    if (this.refreshError !== null) throw this.refreshError
    return this.refreshState
  }

  async command(vehicleId: string, command: KiaCommand): Promise<KiaCommandResult> {
    this.commands.push({ vehicleId, command })
    if (this.commandError !== null) throw this.commandError
    return { outcome: this.commandOutcome, state: this.commandState }
  }

  close(): void {
    this.closed = true
  }
}
