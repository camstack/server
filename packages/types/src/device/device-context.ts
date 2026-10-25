import type { IScopedLogger } from '../interfaces/logging.js'
import type { IEventBus } from '../interfaces/event-bus.js'
import type { IDevice } from './device.js'
import type {
  CapabilityDefinition,
  InferNativeProvider,
} from '../capabilities/capability-definition.js'
import type { IKernelStreamProbe } from '../interfaces/addon.js'
import type { AddonApi } from '../generated/addon-api.js'
import type { DeviceProxy } from '../generated/device-proxy.js'
import type { DeviceMeta, InitialDeviceMeta } from './device-management.js'
import type { DeviceType } from './device-type.js'

/** What a device states about the config it persists. */
export interface DevicePersistConfigOptions {
  /** Dotted paths its schema declares secret (`collectZodSecretPaths`). */
  readonly secretConfigPaths?: readonly string[]
}

export interface DeviceContext {
  /** Progressive, system-wide unique numeric device id. Injected from the
   *  hub's `device-manager` via `DeviceManagerApi.allocateDeviceId` before
   *  `BaseDevice` is constructed, so `IDevice.id` is always populated. */
  readonly id: number
  readonly stableId: string
  /** Numeric id of the parent device, or null when standalone. Resolved
   *  by the caller of `DeviceManagerApi.create()` from the parent IDevice. */
  readonly parentDeviceId: number | null
  readonly logger: IScopedLogger
  readonly api: AddonApi
  readonly eventBus: IEventBus
  /**
   * Persist the device's config blob. `options.secretConfigPaths` names the
   * paths its schema declares secret, so the hub's door keeps those values in
   * the keychain instead of the blob (D787).
   */
  readonly persistConfig: (data: unknown, options?: DevicePersistConfigOptions) => Promise<void>
  /**
   * Snapshot of the persisted runtime-state blob loaded at boot.
   * `BaseDevice` hands this to `DeviceRuntimeState.fromInitial` so
   * the device wakes up with the last-known battery / sleep flag
   * already populated. Empty object on first boot or for ctx
   * factories that don't wire runtime state (tests).
   *
   * Runtime-state WRITES route through `fetchDevice(id).deviceState
   * .setCapSlice(...)` — the canonical cross-layer entrypoint via the
   * codegen DeviceProxy. `BaseDevice.runtimeState.setCapState` lazily
   * resolves the proxy and pre-binds `deviceId`.
   */
  readonly initialRuntimeState?: Record<string, unknown>
  /**
   * Snapshot of the persisted device-config blob loaded from the
   * per-device DB at boot. Symmetric with `initialRuntimeState` —
   * the kernel pre-loads from disk before the BaseDevice constructor
   * runs so the in-memory `DeviceConfig` wakes up with operator-
   * edited values without the addon having to thread `saved.config`
   * through `kernel.devices.create()`.
   *
   * Optional only to support test harnesses that build a bare ctx;
   * production kernel context factories always populate it.
   */
  readonly persistedConfig?: Record<string, unknown>
  /**
   * Read-only snapshot of the operator-organisational meta surface
   * (name / location / disabled / type / parentDeviceId / addonId).
   * Loaded by the kernel from the device-meta DB row before the
   * device class constructor runs — `BaseDevice` reads `name` /
   * `location` / `disabled` from here so subclass schemas don't
   * have to duplicate the fields. Mutations go through
   * `devices.setName / setLocation / setDisabled` — `applySettingsPatch`
   * is hardware-config only.
   *
   * Always populated by the kernel in production. Test fixtures must
   * supply a non-null value too — `BaseDevice` constructor throws
   * when missing.
   */
  readonly deviceMeta: DeviceMeta
  /**
   * Lazy resolver for a device-scoped facade — same shape as
   * `AddonContext.fetchDevice(id)`. Returns a `DeviceProxy` with
   * `deviceId` pre-bound on every cap method, so callers say
   * `dev.deviceState.setCapSlice({capName, slice})` instead of
   * `ctx.api.deviceState.setCapSlice.mutate({deviceId: ctx.id, ...})`.
   * Always wired by the production context factory; test ctx
   * fixtures supply a stub.
   */
  readonly fetchDevice: (deviceId: number) => Promise<DeviceProxy>
  /**
   * Reverse-pointer hook called by `BaseDevice` constructor right
   * after building its `runtimeState`. The kernel context factory
   * stashes the reference so that `registerNativeCap`, fired from
   * inside the same constructor's call chain, can install the cap's
   * `runtimeState` schema onto the device's state without needing
   * the device to be registered in `DeviceRegistry` yet (it isn't —
   * register happens AFTER the constructor returns).
   *
   * Optional for tests / backwards compat — caps with `runtimeState`
   * registered in a context without this hook silently skip schema
   * installation, falling back to memory-only state.
   */
  readonly bindRuntimeState?: (
    state: import('./device-runtime-state.js').IDeviceRuntimeState,
  ) => void
  readonly devices: DeviceManagerApi
  /**
   * Kernel stream-probe entrypoint — same typed contract as the
   * one exposed to addons via `ctx.kernel.streamProbe`. Mirrored
   * onto the device context so devices that reprobe their inputs
   * on edit (e.g. RTSP multi-stream reclassification) never need
   * to branch on transport or reach through `ctx.api`. Optional
   * only to support test harnesses that build a bare ctx.
   */
  readonly streamProbe?: IKernelStreamProbe

  /** Register a native provider for `cap` on the device this context belongs to.
   *  Multiple calls for the same cap throw. */
  registerNativeCap<TCap extends CapabilityDefinition>(
    cap: TCap,
    provider: InferNativeProvider<TCap>,
  ): void

  /**
   * Remove the native provider THIS context registered for `capName` (D663: the composer ungrafts an added cap when a
   * foreign native appears or the target is gone). OPTIONAL on the published interface: every `DeviceContext` fake in the
   * repo keeps compiling, and an older hub that lacks it leaves the graft routable until the composer respawns — a
   * tolerable degradation, recorded in D663's rollback note. No-op when another addon registered the cap. In a worker
   * process that holds nothing for the cap, it retracts a binding a PREVIOUS incarnation of this addon left (a respawn):
   * the hub drops only an entry this addon registered.
   */
  unregisterNativeCap?(capName: string): void
}

/** Constructor type for BaseDevice subclasses.
 *
 *  Deliberately ONE-ARG: the device class receives only its `ctx`,
 *  and the kernel pre-loads the persisted config blob into
 *  `ctx.persistedConfig` BEFORE this constructor runs. This makes
 *  the device entirely self-managing — no operator-supplied config
 *  ever bypasses the per-device DB. Providers create new devices by
 *  passing initial config to `kernel.devices.create()` (or
 *  `persistInitialConfig` for the advanced flow) which writes to the
 *  DB FIRST; the constructor then reads that same blob from
 *  `ctx.persistedConfig`.
 *
 *  Subclasses with extra constructor args (e.g. accessory child
 *  devices that take a `parent` reference) extend this contract by
 *  having their own concrete signature; the kernel-side `create()`
 *  uses `DeviceConstructor` only for the standard 1-arg path.
 *  Custom-arg subclasses go through the lower-level `allocateDeviceId
 *  + persistInitialConfig + createContext + register` flow.
 */
export type DeviceConstructor<T extends IDevice = IDevice> = new (ctx: DeviceContext) => T

/** Map entry helper — concrete camera/hub classes widen to `DeviceConstructor<IDevice>`. */
export function widenDeviceConstructor<T extends IDevice>(
  ctor: DeviceConstructor<T>,
): DeviceConstructor<IDevice> {
  return ctor as DeviceConstructor<IDevice>
}

export interface DeviceManagerApi {
  /**
   * Create, register, and persist a device in one call.
   * Handles: context creation → instantiation → registry + DB persistence.
   */
  create<T extends IDevice>(
    stableId: string,
    DeviceClass: DeviceConstructor<T>,
    config: Record<string, unknown>,
    parentDeviceId?: number | null,
    /**
     * Operator-supplied meta (`name` / `location` / `disabled`) the
     * kernel writes to the meta row BEFORE the device class
     * constructor runs. The constructor reads these via
     * `ctx.deviceMeta`. Mandatory when creating a NEW device — the
     * placeholder `name = stableId` would otherwise stick. Restore
     * paths omit it (the persisted row already carries the
     * operator's edits).
     */
    initialMeta?: InitialDeviceMeta,
  ): Promise<T>

  /**
   * Reserve (or re-resolve) the progressive numeric id for a given
   * `(addonId, stableId)` pair. Idempotent: repeated calls for the same
   * stableId return the same id — allocation only happens the first time.
   * Callers that bypass `create()` (boot-restore, discovery adoption) call
   * this first so `createContext` and `BaseDevice` have the id to bind.
   */
  allocateDeviceId(stableId: string): Promise<number>

  /** Low-level context creation (for hub devices managing children).
   *  `id` MUST come from `allocateDeviceId` — feeding it here binds
   *  `DeviceContext.id` so `BaseDevice` exposes it on `IDevice.id`.
   *
   *  `persistedConfig` is stuffed into `DeviceContext.persistedConfig`
   *  so the device's BaseDevice constructor self-hydrates. Pass the
   *  result of `loadConfig(id)` for the restore path; default `{}` for
   *  a fresh device. Callers wired through `kernel.devices.create()`
   *  don't need to think about this — the standard `create()` shortcut
   *  loads it automatically. */
  createContext(
    stableId: string,
    id: number,
    parentDeviceId?: number | null,
    persistedConfig?: Record<string, unknown>,
  ): DeviceContext

  /** `createContext` for a device the context will BUILD, hydrated like
   *  `create()`: the device's stored runtime state is loaded first. A load
   *  that did not answer REJECTS — a device built on an empty state writes
   *  its cold-start defaults over the restored values (D677). A brand-new
   *  device's `{}` is an answer, never a refusal.
   *
   *  `createContext` stays synchronous and EMPTY-state for callers that build
   *  no device from it (a composer graft registers method-serving natives
   *  only) and for addons compiled before this method existed. Optional: an
   *  older kernel does not provide it — a caller falls back to
   *  `createContext` there. */
  loadContext?(
    stableId: string,
    id: number,
    parentDeviceId?: number | null,
    persistedConfig?: Record<string, unknown>,
  ): Promise<DeviceContext>

  /** Read the per-device persisted config blob from the DB. Returns
   *  `{}` for devices that have no persisted row yet (newly allocated
   *  but not registered). Used by callers going through the manual
   *  `allocateDeviceId + createContext + register` flow (e.g. accessory
   *  child devices that need a custom-arg constructor) to self-hydrate
   *  the child without threading `saved.config` from the addon's
   *  `onRestoreDevices` boundary. */
  loadConfig(deviceId: number): Promise<Record<string, unknown>>

  /** Pre-persist an initial config blob to the per-device DB BEFORE
   *  the device class is instantiated. The constructor then reads
   *  the same blob via `ctx.persistedConfig`. Mandatory when a
   *  provider needs to seed a NEW device with operator-supplied
   *  config (form input from the Add-Device modal) — the device
   *  class never receives the config directly, only via the DB.
   *  Idempotent: calling for an already-persisted id overwrites the
   *  blob (used for re-seed flows like "operator re-edits during
   *  initial wizard"). */
  persistInitialConfig(stableId: string, config: Record<string, unknown>): Promise<number>

  /** Update the device's display name. Surfaces immediately in
   *  the UI device list + on `IDevice.name` for live consumers. */
  setName(deviceId: number, name: string): Promise<void>

  /** Set the operator-organisational location label
   *  ("Kitchen" / "Front yard" / …). Pass `null` to clear. */
  setLocation(deviceId: number, location: string | null): Promise<void>

  /** Soft-disable the device. Disabled devices stay in the registry
   *  + DB so the operator can flip back on without re-adding, but
   *  BaseDevice gates lifecycle hooks (publishToBroker, alarm-stream
   *  subscribe, …) to skip work. */
  setDisabled(deviceId: number, disabled: boolean): Promise<void>

  /** Low-level registration (for advanced use cases) */
  register(device: IDevice): Promise<void>

  /** Remove a device and all its children (cascading) */
  remove(deviceId: number): Promise<void>

  /**
   * Tear a device (and its children) down in-memory WITHOUT touching
   * the persisted device-meta / config / bindings. Used by addon
   * shutdown paths (graceful SIGTERM in group-runner, in-process
   * `restartAddon`) so each device's `removeDevice()` lifecycle hook
   * fires (closes alarm streams, ISAPI clients, polling timers,
   * intercom sessions, …) and native caps unregister cleanly. The
   * persisted index remains intact so the next boot's
   * `restoreDevices` rehydrates the same set.
   *
   * Difference from `remove(id)`: same in-memory teardown, but no
   * `device-manager.removeDevice` call. Use `remove` when the operator
   * deletes a device from the UI; use `decommission` for restart /
   * shutdown lifecycle paths where the device should reappear on
   * the next boot.
   */
  decommission(deviceId: number): Promise<void>

  /**
   * Re-align a device's structural / mapping-derived spec and propagate the
   * change to the live instance — generic, provider-agnostic, keyed only by
   * `deviceId`. A provider calls this when an upstream source it owns reports
   * that a device's derived shape changed (type, semantic role, or the
   * mapping-derived config that selects the concrete device class).
   *
   * Behaviour:
   *  - `type` / `role` → applied via the existing meta setters.
   *  - `config` → merged over the persisted config (a patch). When the merge
   *    actually changes the blob, the live instance is rebuilt: the kernel
   *    tears it down with {@link decommission} (preserving the persisted
   *    meta/config rows, hence the operator's name/location/id), re-persists
   *    the merged config, then reconstructs via the device's creation factory
   *    so a config that maps to a different class yields the new class. No
   *    rebuild happens when nothing changed.
   *
   * The framework never interprets `config` (an opaque, provider-owned blob —
   * it carries no kernel-level semantics like capabilities or device_class).
   * Rebuild is only possible for devices created through `create()` or accessory
   * spawn (which register a reconstruction factory); for others only the
   * `type`/`role` meta updates apply.
   */
  applyDerivedSpec(
    deviceId: number,
    derived: { type?: DeviceType; role?: string; config?: Record<string, unknown> },
  ): Promise<void>

  /** List all devices for this addon */
  getAll(): Promise<ReadonlyArray<IDevice>>

  /** List children of a specific device */
  getChildren(parentDeviceId: number): Promise<ReadonlyArray<IDevice>>
}

/**
 * Read-only global view of the kernel `DeviceRegistry`, exposed to addons
 * that need to observe devices across ALL addons (not just their own).
 *
 * Typical consumers are infrastructure addons that provide a service
 * to every device in the system — e.g. `addon-stream-broker` registers
 * stream sources for every camera regardless of which provider addon
 * instantiated it, so it needs to enumerate cameras coming from
 * `addon-provider-rtsp`, `addon-provider-reolink`, etc.
 *
 * The interface is deliberately read-only: addons can list / query but
 * never mutate the registry. Mutations still go through the per-addon
 * `DeviceManagerApi` (`ctx.devices`) so each addon only creates devices
 * under its own id.
 */
export interface IDeviceRegistryReader {
  /** Return every device across every addon. Snapshot — does not subscribe. */
  getAll(): readonly IDevice[]

  /** Look up any registered device by its progressive numeric id. */
  getById(id: number): IDevice | null

  /** Owning addonId for a registered numeric id, or null if unknown. */
  getAddonId(id: number): string | null

  /** Return every child of a parent device. */
  getChildren(parentDeviceId: number): readonly IDevice[]
}

/**
 * Full device registry — extends the reader with listing helpers and
 * mutation methods. Exposed on `AddonContext.deviceRegistry` for
 * infrastructure addons that manage devices across all providers
 * (e.g. `device-manager`).
 *
 * Hub-only: agents/workers don't have a local device registry.
 */
export interface IDeviceRegistry extends IDeviceRegistryReader {
  /** Return all devices for a specific addon. */
  getAllForAddon(addonId: string): readonly IDevice[]

  /** Return every device paired with its owning addon id. */
  getAllWithAddonId(): readonly { addonId: string; device: IDevice }[]

  /** Return all addon ids that have registered devices. */
  getAddonIds(): readonly string[]

  /** Remove a device from the registry. */
  remove(deviceId: number): void
}
