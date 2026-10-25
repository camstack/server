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
 * WRITE surface the array / docker actuators drive.
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

/** Capacity in kilobytes — mirrors the real `array.capacity.kilobytes`. */
export interface UnraidCapacityKb {
  readonly total: number
  readonly used: number
  readonly free: number
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
export interface UnraidContainerInfo {
  /** Stable container id. */
  readonly id: string
  /** Human name (first of the real `names[]`, leading slash stripped). */
  readonly name: string
  /** `true` when the container state is `RUNNING`. */
  readonly running: boolean
  /** Live CPU usage percent (from the `dockerContainerStats` subscription). */
  readonly cpuPercent: number
  /** Live memory usage percent. */
  readonly memPercent: number
}

/** Live host CPU reading — composed from the real `systemMetricsCpu` + info. */
export interface UnraidCpuInfo {
  /** Total CPU utilisation percent (`systemMetricsCpu.percentTotal`). */
  readonly percent: number
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
 * One full poll of an Unraid server — the aggregate the integration manager
 * builds from the domain namespaces and fans out to the entity children. The
 * pure {@link import('./unraid-mapping.js')} mapping turns this into entity
 * descriptors.
 */
export interface UnraidSnapshot {
  readonly array: UnraidArrayInfo
  readonly cpu: UnraidCpuInfo
  readonly disks: readonly UnraidArrayDiskInfo[]
  readonly dockers: readonly UnraidContainerInfo[]
  readonly notifications: UnraidNotificationsInfo
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
}

/** System/CPU domain — composed from the real `SystemDomain` metrics. */
export interface UnraidSystemDomainLike {
  /** The live host CPU reading (percent + optional temperature + power). */
  cpu(): Promise<UnraidCpuInfo>
}

/** Notifications domain — mirrors the real `NotificationsDomain` subset. */
export interface UnraidNotificationsDomainLike {
  /** Active warnings + alerts folded into a count + latest entry. */
  active(): Promise<UnraidNotificationsInfo>
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
  readonly system: UnraidSystemDomainLike
  readonly notifications: UnraidNotificationsDomainLike
}

/** Connection inputs the factory needs to build a live {@link UnraidClientLike}. */
export interface UnraidClientFactoryInput {
  readonly host: string
  readonly port: number
  readonly https: boolean
  readonly apiKey: string
}

/** Factory seam: build a live {@link UnraidClientLike} for a connection. */
export type UnraidClientFactory = (input: UnraidClientFactoryInput) => UnraidClientLike
