/**
 * The contract every UniFi Network controller client satisfies — the seam the integration manager
 * builds against. Built per connection by `unifi-client-factory.ts`: `UnifiLiveClient` (API key,
 * the UniFi OS Integration API), `UnifiAiounifiClient` (a local account: the classic Network API
 * through aiounifi in a Python worker, with the websocket event stream) or `UnifiDualClient`
 * (both: the API key for everything, the local account for PoE on/off and the port readings).
 *
 * Scope is the **local controller API only** (UDM / UDM-Pro / Cloud Key / a
 * self-hosted Network controller): infra devices (switches / APs / gateways)
 * and network clients (wired + wireless station leases). Cameras are
 * explicitly out of scope — this addon never touches a camera surface.
 */

import type { UnifiInfraKind } from './unifi-device-kind.js'

/** One physical port on an infra device (switch / gateway PoE port). */
export interface UnifiInfraPort {
  /** 1-based port index as reported by the controller. */
  readonly idx: number
  /** Whether PoE is on: the port's PoE mode is not `off` (classic API), or PoE is delivering
   *  power (Integration API, which has no mode). */
  readonly poeOn: boolean
  /** Whether the port is PoE-capable at all — only such a port becomes a device. */
  readonly poeCapable: boolean
  /** Whether the Ethernet link is up, or null when the controller did not say. */
  readonly linkUp: boolean | null
  /** Negotiated link speed in Mbps, or null when unknown / down. */
  readonly speedMbps: number | null
  /** PoE power drawn, in W, or null when not reported. */
  readonly poePowerW: number | null
  /** PoE voltage, in V, or null when not reported. */
  readonly poeVoltageV: number | null
  /** PoE current, in A, or null when not reported. */
  readonly poeCurrentA: number | null
  /** MAC of the wired client on this port (classic `stat/sta` `sw_mac` + `sw_port`), or null. */
  readonly clientMac: string | null
  /** Name of that client, or null when unknown. */
  readonly clientName: string | null
}

/** Controller-reported operational state of an infra device. */
export type UnifiInfraState =
  | 'online'
  | 'offline'
  | 'pending'
  | 'adopting'
  | 'upgrading'
  | 'unknown'

/**
 * A point-in-time snapshot of one infra device (UDM/USX-Max gateway, U6-Pro AP,
 * USW Lite-8-PoE / Flex-Mini switch, …) as read from the controller. Positional
 * only — no live command state is cached here beyond the last poll.
 */
export interface UnifiInfraSnapshot {
  /** Controller-stable device id (`_id` / MAC-derived). Stable across reboots. */
  readonly id: string
  /** Operator-assigned device name from the controller. */
  readonly name: string
  /** The device MAC (lower-case), or null when the controller did not report it. */
  readonly mac: string | null
  /** The device's IP address on the LAN, or null when the controller did not report it. */
  readonly ip: string | null
  /** The hardware serial (classic API `serial`), or null — the Integration API reports none. */
  readonly serial: string | null
  /** Hardware model string (e.g. `USW-Lite-8-PoE`, `U6-Pro`, `UDM-SE`). */
  readonly model: string
  /** What the device is (console, switch, access point, other) — `classifyUnifiInfra`. */
  readonly kind: UnifiInfraKind
  /** CPU utilisation percent (0..100), or null when the model does not report it. */
  readonly cpuPercent: number | null
  /** Memory utilisation percent (0..100), or null when the model does not report it. */
  readonly memoryPercent: number | null
  /** CPU / system temperature in Celsius, or null when not reported. */
  readonly cpuTempC: number | null
  /** Number of clients currently associated with this device. */
  readonly clients: number
  /** Controller-reported operational state. */
  readonly state: UnifiInfraState
  /** Device uptime in seconds, or null when not reported. */
  readonly uptimeSec: number | null
  /** Per-port PoE table (empty for non-switch models). */
  readonly ports: readonly UnifiInfraPort[]
  /** Whether the status LED is currently on. */
  readonly ledOn: boolean
  /** Whether the device is currently reachable through the controller. */
  readonly online: boolean
  /** Whether the client can switch this device's PoE ports on and off. A CONFIGURATION fact
   *  (a local account is set), never the outcome of a read — so a failed read never retires a
   *  switch. */
  readonly poeSwitchable: boolean
}

/**
 * A point-in-time snapshot of one network client (a device_tracker in the HA
 * reference surface). `connected` drives the `home` / `not_home` presence state.
 */
export interface UnifiClientSnapshot {
  /** Client MAC — the stable identity key. */
  readonly mac: string
  /** Friendly hostname / name as reported by the controller (may be empty). */
  readonly hostname: string
  /** Last-known IP address, or null when unknown. */
  readonly ip: string | null
  /** Whether the client is currently associated / online (→ `home`). */
  readonly connected: boolean
  /** Whether the client record is still present in the controller. */
  readonly online: boolean
}

/**
 * What a client pushes between polls: the tables after a live (websocket) change, or the state
 * of its event stream — the integration polls slowly while it is up and at the configured
 * interval while it is not.
 */
export type UnifiLiveChange =
  | {
      readonly kind: 'tables'
      readonly infra: readonly UnifiInfraSnapshot[]
      readonly clients: readonly UnifiClientSnapshot[]
    }
  | {
      readonly kind: 'stream'
      readonly up: boolean
      readonly reason: string | null
    }

/** The live client the addon drives ONE UniFi Network controller with. */
export interface UnifiControllerClient {
  /** Open the session and authenticate. */
  connect(): Promise<void>
  /** Close the session. */
  disconnect(): Promise<void>
  /** Enumerate all infra devices known to the controller site. */
  listInfraDevices(): Promise<readonly UnifiInfraSnapshot[]>
  /** Enumerate all network clients known to the controller site. */
  listClients(): Promise<readonly UnifiClientSnapshot[]>
  /** Resolve one infra device by id from the last-known table, or null. */
  getInfraDevice(id: string): UnifiInfraSnapshot | null
  /** Resolve one client by MAC from the last-known table, or null. */
  getClient(mac: string): UnifiClientSnapshot | null
  /** Toggle PoE power on a switch/gateway port. */
  setPortPoe(deviceId: string, portIdx: number, on: boolean): Promise<void>
  /** Restart (reboot) an infra device. */
  restartDevice(deviceId: string): Promise<void>
  /** Power-cycle a single PoE port (off → on). */
  powerCyclePort(deviceId: string, portIdx: number): Promise<void>
  /** Turn the device status LED on / off. */
  setLed(deviceId: string, on: boolean): Promise<void>
  /**
   * The failure of the part of the client that did not answer while the rest did (the local
   * account of a {@link UnifiControllerClient} that signs in with an API key too), or null.
   */
  degradedError(): Error | null
  /** Live changes between polls; a client without an event stream never calls `listener`. */
  onLiveChange(listener: (change: UnifiLiveChange) => void): () => void
}

/** Factory seam: build a live {@link UnifiControllerClient} for a connection. */
export type UnifiControllerClientFactory = (input: {
  readonly host: string
  readonly port: number
  readonly apiKey: string
  readonly username: string
  readonly password: string
  readonly site: string
  readonly allowSelfSigned: boolean
}) => UnifiControllerClient
