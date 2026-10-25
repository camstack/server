/**
 * The minimal contract the future UniFi Network **controller** client library
 * must satisfy. NO such library is wired yet (see `plan-unifi.md`) — this
 * interface is the seam the integration manager builds against, so the whole
 * device layer type-checks today. When a UniFi controller-API wrapper lands
 * (e.g. `node-unifi` / `unifi-client`, or a thin `@apocaliss92/nodeunifi`
 * wrapper), implement this contract in {@link UnifiIntegrationManager}'s
 * `makeClient` factory and drop the "not wired" default; NOTHING else in this
 * addon changes.
 *
 * Scope is the **local controller API only** (UDM / UDM-Pro / Cloud Key / a
 * self-hosted Network controller): infra devices (switches / APs / gateways)
 * and network clients (wired + wireless station leases). Cameras are
 * explicitly out of scope — this addon never touches a camera surface.
 */

/** One physical port on an infra device (switch / gateway PoE port). */
export interface UnifiInfraPort {
  /** 1-based port index as reported by the controller. */
  readonly idx: number
  /** Whether PoE is currently delivering power on this port. */
  readonly poeOn: boolean
  /** Whether the port is PoE-capable at all (drives whether a PoE switch /
   *  power-cycle button child is spawned for it). */
  readonly poeCapable: boolean
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
  /** Hardware model string (e.g. `USW-Lite-8-PoE`, `U6-Pro`, `UDM-SE`). */
  readonly model: string
  /** CPU utilisation percent (0..100), or null when the model does not report it. */
  readonly cpuPercent: number | null
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

/** The live client the addon drives ONE UniFi Network controller with. */
export interface UnifiControllerClient {
  /** Open the session and authenticate (API key or username + password). */
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
}

/** Factory seam: build a live {@link UnifiControllerClient} for a connection. */
export type UnifiControllerClientFactory = (input: {
  readonly host: string
  readonly port: number
  readonly apiKey: string
  readonly username: string
  readonly password: string
  readonly site: string
}) => UnifiControllerClient
