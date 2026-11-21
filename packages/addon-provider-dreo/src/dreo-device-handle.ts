import type { DreoCommand, DreoDeviceState } from './dreo-bridge.js'

/** Sends one command for a device through the account's bridge. */
export type DreoCommandSender = (deviceId: string, command: DreoCommand) => Promise<void>

/**
 * One Dreo device as the device classes see it: the LAST state the cloud reported (never a
 * command's echo — D1061 holds a commanded value until the device confirms), change and
 * reconnect listeners, and the three commands. Owned by the integration manager, which
 * feeds it from the worker's pushes and refreshes.
 */
export class DreoDeviceHandle {
  readonly deviceId: string
  readonly #send: DreoCommandSender
  readonly #changeListeners = new Set<() => void>()
  readonly #reconnectListeners = new Set<() => void>()
  #state: DreoDeviceState

  constructor(deviceId: string, state: DreoDeviceState, send: DreoCommandSender) {
    this.deviceId = deviceId
    this.#state = state
    this.#send = send
  }

  get state(): DreoDeviceState {
    return this.#state
  }

  /** Fold a reported state in and tell the listeners. */
  update(state: DreoDeviceState): void {
    this.#state = state
    for (const listener of [...this.#changeListeners]) listener()
  }

  /** The account's push channel (or its worker) came back after being down. */
  notifyReconnected(): void {
    for (const listener of [...this.#reconnectListeners]) listener()
  }

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener)
    return () => this.#changeListeners.delete(listener)
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener)
    return () => this.#reconnectListeners.delete(listener)
  }

  setPower(on: boolean): Promise<void> {
    return this.#send(this.deviceId, { command: 'power', value: on })
  }

  setSpeed(level: number): Promise<void> {
    return this.#send(this.deviceId, { command: 'speed', value: level })
  }

  setOscillating(on: boolean): Promise<void> {
    return this.#send(this.deviceId, { command: 'oscillating', value: on })
  }
}
