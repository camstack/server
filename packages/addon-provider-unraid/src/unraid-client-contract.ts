/**
 * The minimal contract the addon builds against for ONE Unraid server. The real
 * `@apocaliss92/node-unraid` library EXISTS and is ready (v1.0.0) — see
 * `plan-unraid.md`. It is intentionally NOT imported in source: it is not yet
 * installed in this monorepo's node_modules and a hard
 * `import ... from '@apocaliss92/node-unraid'` would make `tsc` fail with
 * TS2307. Instead the whole device layer type-checks against this local
 * {@link UnraidClientLike} contract, which mirrors the shape of the real
 * `UnraidClient` (its `.array` / `.docker` / `.disks` / `.system` /
 * `.notifications` domain namespaces) closely enough that wiring it is a
 * one-file swap in {@link UnraidIntegrationManager}'s `makeClient` factory.
 *
 * The real client speaks the Unraid GraphQL API over HTTP(S) (with live
 * subscriptions over WebSocket). It authenticates with an ADMIN-role API key
 * created via `unraid-api apikey --create`. This contract exposes only the
 * READ surface the poll loop aggregates into an {@link UnraidSnapshot} plus the
 * WRITE surface the array / docker / VM actuators drive.
 */

/** Array lifecycle state — mirrors the real lib's `ArrayState` string-union. */
export type UnraidArrayState =
  | 'STARTED'
  | 'STOPPED'
  | 'NEW_ARRAY'
  | 'RECON_DISK'
  | 'DISABLE_DISK'
  | 'SWAP_DSBL'
  | 'INVALID_EXPANSION'
  | 'PARITY_NOT_BIGGEST'
  | 'TOO_MANY_MISSING_DISKS'
  | 'NEW_DISK_TOO_SMALL'
  | 'NO_DATA_DISKS'

/** Desired array state for `array.setState` — mirrors `ArrayStateInputState`. */
export type UnraidArrayDesiredState = 'START' | 'STOP'

/**
 * Capacity in kilobytes — mirrors the real `array.capacity.kilobytes`. A figure the API left
 * out is `null` (unknown), never 0 (D393).
 */
export interface UnraidCapacityKb {
  readonly total: number | null
  readonly used: number | null
  readonly free: number | null
}

/** Current parity-check status — mirrors the real `ParityCheck` fragment subset. */
export interface UnraidParityCheckInfo {
  /** Whether a parity check is currently running. */
  readonly running: boolean
  /** 0..100 progress of the running check. */
  readonly progress: number
}

/** One array member slot (data/parity/cache) — subset of `ArrayDisk`. */
export interface UnraidArrayDiskInfo {
  /** Stable disk id. */
  readonly id: string
  /** Operator-facing slot name (e.g. `disk1`, `parity`, `cache`). */
  readonly name: string
  /** Filesystem size in bytes (null for a not-yet-formatted slot). */
  readonly fsSizeBytes: number | null
  /** Filesystem used bytes. */
  readonly fsUsedBytes: number | null
  /** Filesystem free bytes. */
  readonly fsFreeBytes: number | null
  /** Disk temperature in Celsius, or null when not reported. */
  readonly tempC: number | null
  /**
   * `true` when the slot is healthy (`status === 'DISK_OK'` and neither the
   * warning nor critical thresholds are tripped). The `disk_N_health` binary
   * reports the INVERSE as a `problem` flag.
   */
  readonly healthy: boolean
}

/** The array read model — subset of the real `ArrayInfo`. */
export interface UnraidArrayInfo {
  readonly state: UnraidArrayState
  readonly capacityKb: UnraidCapacityKb
  readonly parityCheck: UnraidParityCheckInfo | null
  readonly disks: readonly UnraidArrayDiskInfo[]
}

/** One docker container read model — subset of `DockerContainer` + live stats. */
/** A container's run state, from the API's `RUNNING` / `PAUSED` / `EXITED`; a state a newer
 *  API adds is `unknown`. */
export type UnraidContainerState = 'running' | 'paused' | 'exited' | 'unknown'

export interface UnraidContainerInfo {
  /** Stable container id. */
  readonly id: string
  /** Human name (first of the real `names[]`, leading slash stripped). */
  readonly name: string
  readonly state: UnraidContainerState
  /** The image it runs; null when the API reports none. */
  readonly image: string | null
  /** Starts with the array; null when not reported. */
  readonly autostart: boolean | null
  /** A newer image exists; null when the server has not checked. */
  readonly updateAvailable: boolean | null
  /** Live CPU usage percent (from the `dockerContainerStats` subscription); null when the sample failed. */
  readonly cpuPercent: number | null
  /** Live memory usage percent; null when the sample failed. */
  readonly memPercent: number | null
}

/**
 * A VM's run state, read from the libvirt domain state the API reports. `running`
 * includes libvirt's IDLE (a running domain blocked on I/O); `paused` includes a
 * guest suspended to RAM; `stopping` is a domain being shut down.
 */
export type UnraidVmState = 'running' | 'paused' | 'stopping' | 'shut off' | 'crashed' | 'unknown'

/** One VM (libvirt domain) read model — subset of the real `VmDomain`. */
export interface UnraidVmInfo {
  /** Stable VM id (a PrefixedID whose local part is the domain UUID). */
  readonly id: string
  /** Domain name; the id when the API reports none. */
  readonly name: string
  readonly state: UnraidVmState
}

/** Live host CPU reading — composed from the real `systemMetricsCpu` + info. */
export interface UnraidCpuInfo {
  /** Total CPU utilisation percent (`systemMetricsCpu.percentTotal`); null when the sample failed. */
  readonly percent: number | null
  /** CPU package temperature in Celsius, or null when the host exposes none. */
  readonly tempC: number | null
  /** CPU package power draw in watts, or null when the host exposes none. */
  readonly powerW: number | null
}

/** One active warning/alert notification — subset of the real `Notification`. */
export interface UnraidNotificationInfo {
  readonly id: string
  readonly title: string
  readonly subject: string
  readonly description: string
  readonly importance: string
  /** ISO timestamp string, or null. */
  readonly timestamp: string | null
}

/** The notifications read model. */
export interface UnraidNotificationsInfo {
  /** Count of active (unread) warning + alert notifications. */
  readonly activeCount: number
  /** The most-recent active notification, or null when there are none. */
  readonly latest: UnraidNotificationInfo | null
}

/**
 * One UPS read model — the node-unraid `ups` device. Every reading is `null` when the API did
 * not report it (an unreadable value is never 0, D393).
 */
export interface UnraidUpsInfo {
  /** The UPS id (a PrefixedID whose local part names the device). */
  readonly id: string
  /** Display name; the model, then the id, when the API reports none. */
  readonly name: string
  readonly model: string | null
  /** The raw status string the UPS reports (`ONLINE`, `ONBATT`, …). */
  readonly status: string | null
  /** Battery charge, percent. */
  readonly chargeLevel: number | null
  /** Estimated runtime on battery, SECONDS. */
  readonly estimatedRuntimeS: number | null
  /** The battery's health string (`Good`, `Replace`, …). */
  readonly batteryHealth: string | null
  readonly inputVoltage: number | null
  readonly outputVoltage: number | null
  /** Load, percent of the nominal power. */
  readonly loadPercent: number | null
  /** Nominal (rated) power, watts. */
  readonly nominalPowerW: number | null
  /** Power drawn now, watts. */
  readonly currentPowerW: number | null
}

/**
 * One full poll of an Unraid server — the aggregate the integration manager
 * builds from the domain namespaces and fans out to the entity children. The
 * pure {@link import('./unraid-mapping.js')} mapping turns this into entity
 * descriptors.
 */
export interface UnraidSnapshot {
  readonly array: UnraidArrayInfo
  readonly cpu: UnraidCpuInfo
  readonly disks: readonly UnraidArrayDiskInfo[]
  /**
   * Docker containers, or `null` when the list could not be read this poll (Docker service
   * off, API error). `null` is UNKNOWN, never "no containers": nothing adopted is removed
   * for it.
   */
  readonly dockers: readonly UnraidContainerInfo[] | null
  /** VMs, or `null` when the list could not be read this poll. Same rule as `dockers`. */
  readonly vms: readonly UnraidVmInfo[] | null
  readonly notifications: UnraidNotificationsInfo
  /**
   * The UPS devices, or `null` / absent when the list could not be read this poll (a client
   * without the `ups` domain, an API error). Unknown, never "no UPS": nothing adopted is
   * removed for it.
   */
  readonly ups?: readonly UnraidUpsInfo[] | null
  /** Hostname from `system.info()`, when the client reported one. */
  readonly hostname?: string | null
  /** What the server says it IS (D1059), read each poll; absent from a client that cannot read it. */
  readonly identity?: UnraidServerIdentity
}

/**
 * The server's identity as one poll read it (D1059). `systemRead` / `serverRead` say whether
 * `system.info()` / `server.info()` answered: a value of a read that FAILED is unknown, never
 * absent.
 */
export interface UnraidServerIdentity {
  readonly systemRead: boolean
  /** SMBIOS system uuid, or null when the board reports none. */
  readonly machineUuid: string | null
  /**
   * MACs of the physical network interfaces (`eth*`, `en*`, `wl*`, `bond*`); null when the
   * answer carried no network list (unknown, never "no NIC").
   */
  readonly macs: readonly string[] | null
  readonly hostname: string | null
  /** True when `server.info()` answered with a server; a failed or empty answer is unknown. */
  readonly serverRead: boolean
  /** The flash (license) GUID, or null. */
  readonly flashGuid: string | null
  /** The LAN IP the server reports, or null. */
  readonly lanIp: string | null
  /** Why a read is unknown (`system.info: …`, `server.info: …`); empty when both answered. */
  readonly readFailures: readonly string[]
}

/** What `system.info()` reads. */
export interface UnraidSystemInfo {
  readonly hostname: string | null
  readonly machineUuid: string | null
  /** Null when the answer carried no network list. */
  readonly macs: readonly string[] | null
}

/** What `server.info()` reads. */
export interface UnraidServerInfo {
  readonly flashGuid: string | null
  readonly lanIp: string | null
}

/** Array read + control domain — mirrors the real `ArrayDomain` subset. */
export interface UnraidArrayDomainLike {
  /** Read the array state, capacity, parity status, and member disks. */
  get(): Promise<UnraidArrayInfo>
  /** Start or stop the array. */
  setState(desired: UnraidArrayDesiredState): Promise<void>
  /** Parity-check control (`start(correct)` / `cancel`). */
  readonly parity: {
    start(correct: boolean): Promise<void>
    cancel(): Promise<void>
  }
}

/** Docker read + control domain — mirrors the real `DockerDomain` subset. */
export interface UnraidDockerDomainLike {
  /** All containers with live CPU/memory stats folded in. */
  list(): Promise<readonly UnraidContainerInfo[]>
  /** Start a container. */
  start(id: string): Promise<void>
  /** Stop a container. */
  stop(id: string): Promise<void>
  /** Pause a container. */
  pause(id: string): Promise<void>
  /** Unpause a paused container. */
  unpause(id: string): Promise<void>
}

/** VM read + control domain — mirrors the real `VmsDomain` subset. */
export interface UnraidVmsDomainLike {
  /** Every VM and its run state (empty when the host runs none). */
  list(): Promise<readonly UnraidVmInfo[]>
  start(id: string): Promise<void>
  /** Graceful shutdown. */
  stop(id: string): Promise<void>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  /** Power off without asking the guest. */
  forceStop(id: string): Promise<void>
  reboot(id: string): Promise<void>
}

/** System/CPU domain — composed from the real `SystemDomain` metrics. */
export interface UnraidSystemDomainLike {
  /** The live host CPU reading (percent + optional temperature + power). */
  cpu(): Promise<UnraidCpuInfo>
  /** Hostname, SMBIOS uuid and NIC MACs from the server, when the client can read them. */
  info?(): Promise<UnraidSystemInfo>
}

/** Server domain — the flash GUID and LAN IP (`server.info()`). */
export interface UnraidServerDomainLike {
  /** Null when the API answered without a server. */
  info(): Promise<UnraidServerInfo | null>
}

/** Notifications domain — mirrors the real `NotificationsDomain` subset. */
export interface UnraidNotificationsDomainLike {
  /** Active warnings + alerts folded into a count + latest entry. */
  active(): Promise<UnraidNotificationsInfo>
}

/** UPS domain — mirrors the real `UpsDomain` subset. */
export interface UnraidUpsDomainLike {
  /** Every connected UPS (empty when the host has none). */
  list(): Promise<readonly UnraidUpsInfo[]>
}

/**
 * The live client the addon drives one Unraid server with. Mirrors the real
 * `UnraidClient` domain layout so wiring it means implementing this interface
 * over the real client (or passing the real client where the shapes already
 * line up).
 */
export interface UnraidClientLike {
  /** Open the session / validate the API key. */
  connect(): Promise<void>
  /** Tear down the WebSocket + HTTP transports. */
  disconnect(): Promise<void>
  readonly array: UnraidArrayDomainLike
  readonly docker: UnraidDockerDomainLike
  readonly vms: UnraidVmsDomainLike
  readonly system: UnraidSystemDomainLike
  readonly notifications: UnraidNotificationsDomainLike
  /** Absent from a client that cannot read UPS devices. */
  readonly ups?: UnraidUpsDomainLike
  /** Absent from a client that cannot read the server's identity. */
  readonly server?: UnraidServerDomainLike
}

/** Connection inputs the factory needs to build a live {@link UnraidClientLike}. */
export interface UnraidClientFactoryInput {
  readonly host: string
  readonly port: number
  readonly https: boolean
  readonly apiKey: string
  /** Accept a self-signed certificate on the https/wss connection. */
  readonly allowSelfSigned: boolean
}

/** Factory seam: build a live {@link UnraidClientLike} for a connection. */
export type UnraidClientFactory = (input: UnraidClientFactoryInput) => UnraidClientLike
