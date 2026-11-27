import type { DreoConfig } from '../config.js'
import {
  type DreoBridge,
  type DreoBridgeDevice,
  DreoBridgeError,
  type DreoCommand,
  type DreoDeviceState,
  type DreoPush,
} from '../dreo-bridge.js'

export const IDLE_STATE: DreoDeviceState = {
  on: false,
  speed: 2,
  speedMin: 1,
  speedMax: 4,
  oscillating: false,
  horizontalOscillating: null,
  verticalOscillating: null,
  preset: null,
  presets: null,
  temperature: null,
  humidity: null,
  pm25: null,
  connected: true,
}

export function fanDevice(
  deviceId = 'dev-1',
  state: Partial<DreoDeviceState> = {},
): DreoBridgeDevice {
  return {
    deviceId,
    model: 'DR-HAF001S',
    name: 'Fan',
    supported: true,
    state: { ...IDLE_STATE, ...state },
  }
}

/** A bridge double: the cloud answers what the test set, and every call is recorded. */
export class FakeBridge implements DreoBridge {
  devices: readonly DreoBridgeDevice[] = [fanDevice()]
  loginError: DreoBridgeError | null = null
  commandError: DreoBridgeError | null = null
  refreshed: Record<string, DreoDeviceState> = {}
  readonly logins: DreoConfig[] = []
  readonly commands: Array<{ deviceId: string; command: DreoCommand }> = []
  refreshCalls = 0
  closed = false
  readonly #listeners: Array<(push: DreoPush) => void> = []

  async login(config: DreoConfig): Promise<readonly DreoBridgeDevice[]> {
    this.logins.push(config)
    if (this.loginError !== null) throw this.loginError
    return this.devices
  }

  async command(deviceId: string, command: DreoCommand): Promise<void> {
    if (this.commandError !== null) throw this.commandError
    this.commands.push({ deviceId, command })
  }

  async refresh(): Promise<Readonly<Record<string, DreoDeviceState>>> {
    this.refreshCalls += 1
    return this.refreshed
  }

  onPush(listener: (push: DreoPush) => void): void {
    this.#listeners.push(listener)
  }

  close(): void {
    this.closed = true
  }

  /** A line the worker pushes on its own. */
  push(push: DreoPush): void {
    for (const listener of this.#listeners) listener(push)
  }
}
