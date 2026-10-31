import type { z } from 'zod'
import type { CapabilityDefinition, InferProvider } from '../capabilities/capability-definition.js'
import type { CustomActionCaller, CustomActionsSpec } from '../capabilities/custom-actions.js'
import type { PipelineSlot } from '../types/pipeline.js'
import type { AddonDataPlane } from './addon-data-plane.js'
import type { CoralInfo } from './platform.js'
import type { AddonPeerBytes } from './addon-peer-bytes.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { RecordsAccess } from '../records/records-access.js'
import type { IntegrationInstanceRef } from '../addon/integration-instance-ref.js'
import type { CapabilityDeclaration } from './capability.js'
import type { ConfigUISchemaWithValues, FieldProbeResult } from './config-ui.js'
import type { IEventBus, ReadinessScope } from './event-bus.js'
import type { ICapabilityRegistry } from './kernel-abstractions.js'
import type { IScopedLogger } from './logging.js'
import type { ICapabilityHandle } from './readiness.js'
import type { StorageLocationDeclaration } from './storage-location-declaration.js'
/** Sub-process info (inlined from deleted worker-protocol.ts) */
export interface SubProcessInfo {
  readonly pid: number
  readonly name: string
  readonly command: string
  readonly state: 'running' | 'stopped' | 'crashed'
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
}

/** Worker process stats (inlined from deleted worker-protocol.ts) */
export interface WorkerProcessStats {
  readonly pid: number
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly heapUsed?: number
  readonly uptimeSeconds: number
  readonly restartCount: number
  /**
   * Runner lifecycle state. `failed` is terminal — the D6 crash
   * circuit-breaker reached `MAX_CRASHES_IN_WINDOW` crashes inside
   * `CRASH_WINDOW_MS` and stopped respawning. Distinct from `crashed`
   * (a transient state between an exit and the next backoff respawn).
   * `refused` (D877) is also terminal but is NOT a crash: the addon said, in
   * a typed way, that it will not start (and why); the breaker never counted it
   * and an operator action retries it.
   */
  readonly state: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed' | 'failed' | 'refused'
}

/** Storage interface for addon file operations */
export interface IAddonFileStorage {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  deleteFile(path: string): Promise<void>
  listFiles(prefix?: string): Promise<readonly string[]>
  exists(path: string): Promise<boolean>
}

export interface RequiredStep {
  readonly slot: PipelineSlot
  readonly outputClasses: readonly string[]
  readonly description: string
}

/**
 * Minimal model-management API exposed to addons via AddonContext.
 */
export interface IAddonModelManager {
  /** Ensure a model is downloaded. Returns the local file path. */
  ensure(modelId: string, format?: import('../types/models.js').ModelFormat): Promise<string>

  /** Ensure extra files for a model are downloaded. Returns paths. */
  ensureExtraFiles(modelId: string): Promise<readonly string[]>

  /** Absolute path to the shared models directory. */
  getModelsDir(): string

  /** Check if a model is already downloaded. */
  isDownloaded(modelId: string, format?: import('../types/models.js').ModelFormat): boolean
}

/** Process management for addon sub-processes (ffmpeg, python, etc.) */
export interface IAddonProcessManager {
  /** Spawn a child process managed by this addon's worker */
  spawn(config: SubProcessConfig): Promise<IManagedSubProcess>
  /** List all sub-processes spawned by this addon */
  listProcesses(): readonly SubProcessInfo[]
  /** Get worker stats (this addon's worker process) */
  getWorkerStats(): WorkerProcessStats
}

export interface SubProcessConfig {
  readonly name: string
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly autoRestart?: boolean
  readonly maxRestarts?: number
}

export interface IManagedSubProcess {
  readonly pid: number
  readonly name: string
  getStats(): WorkerProcessStats
  write(data: Buffer): void
  readonly stdout: AsyncIterable<Buffer>
  readonly stderr: AsyncIterable<Buffer>
  kill(signal?: NodeJS.Signals): void
  wait(): Promise<{ code: number | null; signal: string | null }>
  onExit(handler: (code: number | null) => void): void
  onError(handler: (error: Error) => void): void
}

/** Dependency manager — ensures binaries/tools are available for addons */
export interface IAddonDepsManager {
  /** Ensure a named binary is available (check local -> PATH -> download) */
  ensureBinary(opts: {
    readonly name: string
    readonly downloadUrl: string
    readonly isArchive?: boolean
    readonly archiveFormat?: 'zip' | 'tar.gz' | 'tar.xz'
    readonly archiveInnerPath?: string
  }): Promise<string>

  /** Ensure ffmpeg is available */
  ensureFfmpeg(): Promise<string>

  /** Ensure Python is available, returns path or null if unavailable */
  ensurePython(): Promise<string | null>

  /** Install Python packages in the managed Python environment */
  installPythonPackages(packages: readonly string[]): Promise<void>

  /**
   * Install a pip requirements file into the embedded Python.
   * Idempotent: keyed on (file basename + sha256 of contents). Marker
   * lives under the python install dir so re-downloading python wipes
   * everything together.
   */
  installPythonRequirements(requirementsFile: string): Promise<void>

  /** Get the deps directory path */
  getDepsDir(): string
}

/**
 * AddonContext -- injected into every addon at initialize().
 *
 * The context includes both the CamstackContext fields (id, logger, eventBus, storage, config)
 * and addon-specific extras (addonConfig, models, locationPaths, router, network).
 */
/**
 * AddonContext -- injected into every addon at initialize().
 *
 * The `api` field is typed as `AddonApi` — a generated interface that
 * mirrors the server's tRPC router namespaces. This gives addons type-safe
 * access to server procedures without depending on the server package.
 *
 * To regenerate after changing routers: npx tsx scripts/generate-api-types.ts
 */
// ── Provider registration (return from initialize) ──────────────────────
/**
 * A capability provider binding returned from `ICamstackAddon.initialize()`.
 * The kernel registers each entry in the CapabilityRegistry after init completes.
 */
export interface ProviderRegistration<TCap extends CapabilityDefinition = CapabilityDefinition> {
  /** Capability definition this provider implements. Read `capability.name` to look up by name. */
  readonly capability: TCap
  /**
   * The provider object implementing the capability interface.
   *
   * - With a specific `TCap` (e.g. `ProviderRegistration<typeof metricsProviderCapability>`)
   *   the provider is strictly checked against `InferProvider<TCap>`.
   * - With the default `TCap = CapabilityDefinition` (used by heterogeneous arrays like
   *   `ProviderRegistration[]` returned from `onInitialize()`) the provider is typed as
   *   `object`: a mapped type over the default `Record<string, CapabilityMethodSchema>`
   *   collapses to an index signature that class instances cannot satisfy structurally.
   *   The runtime capability router enforces the contract; the strict compile-time check
   *   is applied at the specific-cap boundary (ProviderRegistration<typeof xxxCap>) instead.
   */
  readonly provider: CapabilityDefinition extends TCap ? object : InferProvider<TCap>
  /**
   * @deprecated D4 — behavioural metadata moved to `CapabilityDefinition`.
   * This field survives only as an optional hint; the kernel reads
   * `capability.kind` and warns (via `describeProviderKindDrift`) if a
   * hint set here disagrees. New code MUST NOT set it.
   */
  readonly kind?: 'native' | 'wrapper'
  /**
   * @deprecated D4 — see `kind`. The kernel reads
   * `capability.defaultActive`. New code MUST NOT set it.
   */
  readonly defaultActive?: boolean
}

/**
 * Return value of `ICamstackAddon.initialize()`. Both sections are optional —
 * addons that provide only capabilities omit `customActions`; addons that only
 * expose actions omit `providers`; pure consumers may return void.
 */
export interface AddonInitResult<TCatalog extends CustomActionsSpec = CustomActionsSpec> {
  readonly providers?: readonly ProviderRegistration[]
  readonly customActions?: TCatalog
  /**
   * Required iff `customActions` is set. One async handler per catalog entry —
   * a typed dispatch map rather than a single generic function so that each
   * handler's input/output types collapse to the concrete `z.infer<...>` of
   * its schema at the provider site (TypeScript cannot unify the output of a
   * generic `<K>(action: K, input) => Promise<...>` signature with a concrete
   * per-action return type, so the map form is strictly more typeable).
   */
  readonly actionHandlers?: {
    readonly [K in keyof TCatalog & string]: (
      input: z.infer<TCatalog[K]['input']>,
      caller?: CustomActionCaller,
    ) => Promise<z.infer<TCatalog[K]['output']>>
  }
}

// ── Kernel services ─────────────────────────────────────────────────────
/**
 * Infrastructure services injected by the kernel at boot time.
 * Grouped under `ctx.kernel` to separate kernel plumbing from
 * addon-level concerns (logger, settings, devices, api).
 */
export interface IKernelServices {
  /**
   * The Moleculer nodeID for this process (e.g. `'hub'` on the hub, or the
   * agent's own name on remote nodes). Addons use this to distinguish local
   * dispatch from remote dispatch without a direct Moleculer dependency.
   */
  readonly localNodeId?: string

  /**
   * The runner id hosting an addon — its `execution.group`, else itself
   * (`resolveRunnerId`). Hub in-process contexts only: the keychain uses it to
   * accept a grouped runner's transport stamp (the group id) for the refs of
   * the addons that runner hosts. Absent elsewhere; callers fall back to
   * identity.
   */
  readonly runnerIdForAddon?: (addonId: string) => string

  /**
   * Local storage provider — direct filesystem access with zero serialization.
   * Use for file I/O (write/read with Buffer data) that can't go through tRPC.
   * Always co-located: storage is a kernel-level service injected at boot.
   */
  readonly storage?: import('./storage.js').IStorageProvider

  /**
   * Per-process system-readiness tracker. One `ReadinessRegistry` is
   * created per broker by the kernel at boot and shared across every
   * addon on that broker — consumers that need `awaitReady` /
   * `onReadyState` should use this singleton rather than constructing
   * their own so subscriptions on the event bus stay de-duplicated and
   * the snapshot is consistent across the process.
   *
   * Tests that run without a real kernel (no `ctx.kernel`) should
   * either inject a mock or fall back to creating a local
   * `ReadinessRegistry`; the production code in kernel always
   * populates this field.
   */
  readonly readinessRegistry?: import('../capabilities/index.js').ITypedReadinessRegistry

  /**
   * Global device registry — read + mutate devices across all addons.
   * Hub-only: workers don't have a local registry (use `ctx.devices`
   * for per-addon scoped management, or `ctx.api.deviceManager.*` for
   * cross-process access).
   */
  readonly deviceRegistry?: import('../device/device-context.js').IDeviceRegistry

  /**
   * Per-addon scoped device management — create, register, remove, list devices.
   * Used by device provider addons (rtsp, onvif) to manage cameras.
   */
  readonly devices: import('../device/device-context.js').DeviceManagerApi

  /**
   * Cluster runtime — exposes the underlying message broker for addons that
   * need to participate in cluster-wide RPC outside the capability/tRPC
   * surface (e.g. log forwarding, hub readiness probes).
   *
   * Optional: only the agent and hub processes populate this. Forked workers
   * receive their broker through their own runner harness — they do not see
   * `cluster.broker` on ctx.kernel.
   */
  readonly cluster?: {
    readonly broker: IClusterBroker
  }

  /**
   * Kernel stream-probe bundle. Both entrypoints land on the same
   * hub-side `StreamProbeService` (ffprobe + HTTP reachability check
   * with a 1h cache). Hub resolves them directly; forked workers +
   * remote agents route through the `$stream-probe.*` Moleculer
   * broker service. Providers that call
   * `ctx.kernel.streamProbe.probe(url)` don't need to know where
   * they run.
   */
  readonly streamProbe?: IKernelStreamProbe

  /**
   * Kernel hardware-accel resolver. Platform-probe that picks an
   * ordered preference list of hw decode backends for the **local
   * host**. Every node (hub + forked worker + remote agent) runs its
   * own probe because hwaccel is inherently hardware-bound: decoder
   * addons on an NVIDIA agent get `['cuda', 'nvdec']`, the same addon
   * on a Mac hub gets `['videotoolbox']`. Cross-node queries for the
   * admin UI go via the node-pinned `platform-probe` capability
   * (`resolveHwAccel`), not a bespoke Moleculer service.
   */
  readonly hwaccel?: IKernelHwAccel

  /**
   * Kernel inference-runtime hardware resolver — the node's own inference
   * accelerators (gpu/npu), probed LOCALLY in-process. The exact model as
   * {@link hwaccel}: every node (hub + forked worker + remote agent) resolves
   * its OWN hardware, NEVER the `platform-probe` singleton (which returns the
   * hub's hardware to a forked agent child). The detection-pipeline maps this to
   * a runtime via the shared `scoreRuntimes` / `pickBestRuntime`.
   */
  readonly inferenceEngine?: IKernelInferenceEngine

  /**
   * Capability registry — provider lookups, native-cap resolution, wrapper listing.
   * Hub-only: forked workers don't see this (they use `ctx.api` for cross-process calls).
   */
  readonly capabilityRegistry?: ICapabilityRegistry

  /**
   * Per-addon storage-location declarations across every installed addon.
   *
   * Each inner array is one addon's `camstack.addons[].storageLocations`
   * declaration (addons declaring none are omitted). The storage-orchestrator
   * builtin aggregates these via `buildStorageLocationRegistry(perAddon)` to
   * seed one `<id>:default` instance per declared location.
   *
   * Hub-only: injected from the kernel's `AddonLoader`. Absent on forked
   * workers and remote agents (the orchestrator runs hub-side).
   */
  readonly listStorageLocationDeclarations?: () => StorageLocationDeclaration[][]

  /**
   * D3 handshake-fed native-cap view of the whole cluster. Returns every
   * `(nodeId, addonId, capName, deviceId)` tuple known from the most recent
   * `$hub.registerNode` handshake for each node. Updated atomically after
   * each device restore re-handshake.
   *
   * Hub-only: injected by `addon-registry.service.ts` from
   * `MoleculerService.listClusterNativeCaps()`. Absent on forked workers
   * and remote agents (they use `ctx.api` for cross-process queries).
   *
   * Used by `device-manager.addon.ts` as the reliable source for remote
   * native-cap routing — replaces the pull-based `syncWorkerNativeCaps`
   * sweep that was lossy during the Moleculer transport handshake window.
   */
  readonly listClusterNativeCaps?: () => ReadonlyArray<{
    readonly nodeId: string
    readonly addonId: string
    readonly capName: string
    readonly deviceId: number
  }>

  /**
   * Per-device slice of {@link listClusterNativeCaps}, served from the
   * registry's incrementally-maintained `deviceId → entries` index — O(caps
   * for that device) instead of flattening the whole cluster and filtering.
   * Use this in per-device hot paths (`getBindings`, run for every device by
   * `getAllBindings`); falls back to filtering `listClusterNativeCaps()` when
   * absent (forked workers / older hosts).
   */
  readonly listClusterNativeCapsForDevice?: (deviceId: number) => ReadonlyArray<{
    readonly nodeId: string
    readonly addonId: string
    readonly capName: string
    readonly deviceId: number
  }>
  /**
   * Node-routed capability proxy (hub-side builtins only): every method call
   * on the returned object forwards to `capName`'s provider ON `nodeId` via
   * the cluster transport — the same routing the generated cap routers use
   * for `{nodeId}` inputs. Null when the capability is not reachable on that
   * node. Lets a hub builtin (e.g. storage-orchestrator) execute work WHERE
   * the data lives instead of assuming its own filesystem.
   */
  readonly resolveNodeCapability?: (
    capName: string,
    nodeId: string,
  ) => Record<string, (params: unknown) => Promise<unknown>> | null
}

/**
 * Canonical hwaccel backend names. Accepted by both the `ffmpeg` CLI
 * (`-hwaccel <name>`) and node-av `HardwareDeviceContext.create()`
 * (`AV_HWDEVICE_TYPE_<upper>`), so a single string drives both layers.
 */
export type HwAccelBackend =
  | 'videotoolbox'
  | 'cuda'
  | 'nvdec'
  | 'vaapi'
  | 'qsv'
  | 'd3d11va'
  | 'dxva2'
  | 'amf'
  | 'vdpau'
  | 'drm'

/** Resolution output — preference list + rationale for observability. */
export interface HwAccelResolution {
  readonly preferred: readonly HwAccelBackend[]
  readonly rationale: string
}

export interface IKernelHwAccel {
  /**
   * Probe the local host and return the preferred backends.
   *
   * `prefer` accepts:
   *   - `null` / `undefined` → auto, use platform probe
   *   - `'none'` → hwaccel disabled; returns empty list
   *   - an explicit backend name → single-entry list (skip probe)
   *
   * Implementations are pure functions over the host — safe to call
   * repeatedly; results are deterministic per host.
   */
  readonly resolve: (prefer?: HwAccelBackend | 'none' | null) => Promise<HwAccelResolution>
}

/** THIS node's inference accelerators (gpu/npu/coral), probed locally in-process. */
export interface KernelInferenceHardware {
  readonly gpu: { readonly type: string } | null
  readonly npu: { readonly type: string } | null
  /** Coral Edge TPU hardware (USB and/or PCIe), when found — whole, units included. */
  readonly coral?: CoralInfo | null
}

export interface IKernelInferenceEngine {
  /**
   * Probe the LOCAL host and return its inference accelerators. Deterministic
   * per host — safe to call repeatedly. The exact model as {@link IKernelHwAccel}:
   * every node resolves its OWN hardware, so the detection-pipeline never adopts
   * a remote node's runtime from the `platform-probe` singleton.
   */
  readonly resolveHardware: () => Promise<KernelInferenceHardware>
}

export interface IKernelStreamProbe {
  /**
   * Run ffprobe on an RTSP / HTTP stream URL and return the raw
   * metadata. Use this when you need the width/height/codec/fps data
   * for profile classification. `classifyStream` / `classifyStreams`
   * in `@camstack/types` turn the metadata into a `StreamQuality`.
   */
  readonly probe: (
    url: string,
    options?: { force?: boolean },
  ) => Promise<import('./device-capabilities/camera.js').StreamMetadata>
  /**
   * Generic field probe dispatcher — keys starting with `stream` run
   * ffprobe, others run an HTTP GET that aborts at response headers.
   * Returns a `FieldProbeResult` suitable for the admin UI's "Test"
   * button on any `probe`-typed form field.
   */
  readonly probeField: (key: string, value: unknown) => Promise<FieldProbeResult>
}

/**
 * Minimal structural shape of a cluster-message-broker (Moleculer in the
 * current implementation). Captured in @camstack/types so cluster-aware
 * addons can consume it without pulling a moleculer dependency.
 *
 * Add new methods sparingly — every addition becomes a contract the broker
 * implementation must satisfy.
 */
export interface IClusterBroker {
  readonly nodeID: string
  call<TParams = unknown, TResult = unknown>(
    action: string,
    params?: TParams,
    opts?: { nodeID?: string; timeout?: number },
  ): Promise<TResult>
  waitForServices(service: string | readonly string[], timeout?: number): Promise<void>
  readonly localBus: {
    on(event: string, handler: (payload: { node: { id: string } }) => void): void
  }
}

export interface AddonContext<TConfig = Record<string, unknown>> {
  /** Immutable progressive ID */
  readonly id: string
  /** Pre-scoped logger */
  readonly logger: IScopedLogger
  /** System event bus */
  readonly eventBus: IEventBus
  /** Bootstrap configuration from server settings (read-only) */
  readonly addonConfig: Readonly<TConfig>
  /**
   * Private data directory for this addon.
   * `<nodeDataDir>/addons-data/{addonId}` — the addon owns it exclusively.
   */
  readonly dataDir: string

  /**
   * Node-local data ROOT for this node (`CAMSTACK_DATA` ?? the kernel boot dir).
   * The single, centralized anchor for internal per-node working directories
   * (models, logs, addons-data). Always writable on the local node — unlike the
   * hub-singleton `storage` cap, which returns the hub's path to every node.
   * Use this (never `api.storage.resolve`) for internal node-local dirs.
   */
  readonly nodeDataDir: string

  // --- Kernel services ---

  /** Infrastructure services provided by the kernel. */
  readonly kernel: IKernelServices

  // --- Settings ---

  /**
   * Capability settings API — 3-level resolution (defaults → global → per-device).
   * Replaces context.config (IElementConfig) and context.addonConfig.
   */
  /**
   * Three-level settings store API.
   *
   * Raw, non-merging accessors for the addon's `addon_settings` row and
   * per-device overrides, plus a `(getSection, setSection)` pair for the
   * cluster-wide yml-backed sections consumed by the built-in
   * `system-config` addon.
   *
   * The addon combines these raw reads with its own schema via
   * `hydrateSchema()` inside `getAddonSettings / getGlobalSettings /
   * getDeviceSettings` on `ICamstackAddon`. There is no defaults
   * injection or cross-level merge at this layer.
   *
   * KEYCHAIN (D798): the view a `BaseAddon` reaches as `this.ctx.settings`
   * answers keychain VALUES on every read — `readAddonStore`,
   * `readAddonStoreResult`, `readAddonStoreKeyResult`, `readDeviceStore`,
   * `readDeviceStoreBatch` — never `{ $secret }` markers. A value the keychain
   * cannot serve right now stays a marker ("stored, unavailable"), never `''`.
   * Writing a resolved read back is a no-op for every unchanged secret.
   * The marker-bearing blob is private to `BaseAddon`.
   *
   * Cleanup note: the earlier `getGlobal / getDevice / updateGlobal /
   * updateDevice` trio (with a polymorphic `getGlobal({ section })`
   * overload) was removed after every caller migrated. The only
   * consumer of the yml-section path was `system-config`, which now
   * goes through the explicit `getSection / setSection` pair below.
   */
  readonly settings?: {
    /**
     * Read the raw addon store for this addon. Holds both `addon`-level
     * and `global`-level values; they're disjoint by schema invariant so
     * they can share one physical store. No defaults merged in. Returns
     * an empty object if the addon has never written anything.
     *
     * @internal Low-level primitive — addons MUST NOT call this directly.
     * Use the high-level, schema-driven, per-node-aware API instead:
     * `this.getGlobalSettings()` / `this.updateGlobalSettings()`,
     * `this.resolveGlobalStore()` (raw view for a `getGlobalSettings`
     * override), or `this.state<T>()` (durable JSON blob). Enforced by the
     * `no-raw-addon-store` biome guard over the addon source tree; the
     * sanctioned `BaseAddon` wrappers (in `@camstack/types`) and the
     * allowlisted engine-cascade holdouts are the only callers.
     */
    readAddonStore(): Promise<Record<string, unknown>>

    /**
     * The same read, THREE-WAY: a stored blob, no blob, or a read that FAILED.
     * `readAddonStore` folds a failure into `{}`, which a caller cannot tell
     * from "never written"; this one does not (D651). Optional: a settings view
     * that predates it answers nothing, and the caller must treat that as
     * unreadable, never as empty.
     *
     * @internal Same rule as `readAddonStore`: addons reach it only through
     * `BaseAddon.readStoredGlobalKey`.
     */
    readAddonStoreResult?(): Promise<AddonStoreRead>

    /**
     * ONE key of the addon store, three-way — `present`, `absent` (the store
     * answered, the key was never written) or `unreadable` — reading that key's
     * row only, never the whole store (D675). Optional: only the in-process
     * kernel view answers it; a caller must treat its absence as unreadable.
     *
     * @internal Same rule as `readAddonStore`.
     */
    readAddonStoreKeyResult?(key: string): Promise<StoredKeyRead>

    /**
     * Write a patch into the addon store. Keys not in the patch are
     * preserved. Keys explicitly set to `null` are preserved as-is (they
     * do NOT fall back to schema default on subsequent reads — that
     * layering happens only at `hydrateSchema` time).
     *
     * @internal Low-level primitive — addons MUST NOT call this directly.
     * Use `this.updateGlobalSettings()` or `this.state<T>().set()`. Enforced
     * by the `no-raw-addon-store` biome guard (see `readAddonStore`).
     */
    writeAddonStore(patch: Record<string, unknown>): Promise<void>

    /**
     * Read the raw per-device store for this addon + device. No defaults,
     * no merge with the addon store. Returns `{}` when no overrides exist.
     */
    readDeviceStore(deviceId: number): Promise<Record<string, unknown>>

    /**
     * The same read for MANY devices, as one store round trip.
     *
     * Exists because the per-device form does not amortise: `listAll` in the
     * full projection called it once per fleet row, sequentially, on hub-main's
     * event loop — 967 round trips per listing, and the sqlite profiler
     * measured the result at 9 229 `query addon-device-settings` a minute
     * steady-state on 2026-08-25, dwarfing every other read in the cluster.
     * Same shape as `deviceManager.getLinkedDevicesBatch`, which removed the
     * previous instance of this exact pattern the same day.
     *
     * Returns an entry for EVERY id asked for — `{}` for a device with no
     * overrides — so a caller can never mistake "not read" for "no override".
     * THROWS when the store could not be asked.
     *
     * REQUIRED (D870): hub-main and every forked runner reach the same rows
     * through the same module, so there is no view that cannot answer it.
     */
    readDeviceStoreBatch(
      deviceIds: readonly number[],
    ): Promise<ReadonlyMap<number, Record<string, unknown>>>

    /**
     * The device ids this addon holds a per-device store for — ids only, no
     * values. The read side of a fleet-wide pass over the standard per-device
     * settings (D865): a caller that needs "every device with a config of
     * mine" lists the ids, then reads them with `readDeviceStoreBatch`.
     *
     * REQUIRED (D870). An empty list means the store answered with no device;
     * a store that could not be asked THROWS.
     */
    listDeviceStoreIds(): Promise<readonly number[]>

    /**
     * Write a patch into the per-device store. Does NOT touch the
     * addon-level store. Keys preserved as in `writeAddonStore`.
     */
    writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>

    /**
     * Delete all keys for a device from the per-device store.
     * Use on device removal to guarantee no orphaned settings rows remain.
     */
    clearDeviceStore(deviceId: number): Promise<void>

    /**
     * Read a device's runtime-state blob — separate namespace from
     * `readDeviceStore` (which is the addon's config blob). Holds
     * mutable runtime signals discovered after boot (battery
     * snapshot, sleep flag, last-seen) that survive restart. Stored
     * under the kernel's reserved `__device-state` namespace so the
     * addon's config schema never sees it.
     */
    readDeviceRuntimeState(deviceId: number): Promise<Record<string, unknown>>

    /**
     * Replace the runtime-state blob for a device. The kernel's
     * `DeviceRuntimeState` always hands over the FULL persistent
     * slice — no shallow merge here, the latest blob wins.
     */
    writeDeviceRuntimeState(deviceId: number, data: Record<string, unknown>): Promise<void>

    /**
     * Delete the device's runtime-state blob. Use on device removal
     * so a recreated device with the same id starts clean instead
     * of inheriting stale runtime state from the previous lifetime.
     */
    clearDeviceRuntimeState(deviceId: number): Promise<void>

    /**
     * Read a cluster-wide yml-backed section (server, auth, ffmpeg,
     * logging, recording, retention — whatever
     * `ConfigManager.getSection` recognises). Returns the raw section
     * record with no schema merging. Used by the built-in
     * `system-config` addon to surface the legacy `config.yaml`
     * sections through its `getGlobalSettings()` method.
     */
    getSection(section: string): Promise<Record<string, unknown>>

    /**
     * Write a cluster-wide yml-backed section. Shallow-merges the patch
     * into the existing section so unrelated keys are preserved.
     * Hub-only — agents have no concept of yml sections and will
     * throw. Used by the `system-config` addon's
     * `updateGlobalSettings()` implementation.
     */
    setSection(section: string, patch: Record<string, unknown>): Promise<void>
  }

  /**
   * Full tRPC client — same API as the frontend.
   * Transport is transparent: direct caller (in-process), WSS (worker), or WSS (remote agent).
   * Use this for all server interactions: storage, events, devices, streaming, etc.
   */
  readonly api: import('../generated/addon-api.js').AddonApi

  /**
   * Binary / tool dependency manager. Addons call
   * `ctx.deps.ensureBinary(...)` / `ensureFfmpeg()` / `ensurePython()` to
   * materialise per-addon runtime deps under the shared `data/deps` tree.
   * Injected by the addon host so addons never import the concrete
   * implementation from `@camstack/system` directly.
   */
  readonly deps: IAddonDepsManager

  /**
   * Typed handle to the native provider of `cap` for `deviceId`. Bypasses the
   * currently-active wrapper — call this ONLY from the wrapper that owns
   * `cap`. Every other consumer should use `fetchDevice(id).<cap>.<method>()`
   * instead, which routes through the cap-router and respects the wrapper
   * chain.
   *
   * Wrapper-vs-consumer rule (memorise this):
   *   - "I am the wrapper for this cap and I need to delegate to the camera
   *     driver" → `getNativeProvider(cap, id)` (bypasses self, no recursion).
   *   - "I am consuming someone else's cap" → `fetchDevice(id).<cap>...`
   *     (uses the wrapper chain — cache, fallback, validation, etc.).
   *
   * Calling `fetchDevice` from inside the cap's own wrapper would re-enter
   * the wrapper and produce infinite recursion through the cap-router.
   *
   * Returns `null` when no addon has published a native provider for this
   * `(cap, deviceId)` — e.g. a camera driver that doesn't implement the cap
   * natively (RtspCamera without `snapshotUrl` does not register snapshot).
   * Wrappers use this to decide between native delegation and their own
   * fallback strategy; they MUST check for null.
   *
   * When the native is registered in this process, returns the local object
   * directly (zero serialization). When it lives in a forked worker, returns
   * a Moleculer-backed proxy constructed by the hub's native-cap fallback
   * (see `CapabilityRegistry.setNativeFallback`) — standard
   * `<addonId>.native-provider.<capName>.<method>` RPC path.
   */
  getNativeProvider<TCap extends CapabilityDefinition>(
    cap: TCap,
    deviceId: number,
  ): InferProvider<TCap> | null

  /**
   * Fetch a typed proxy for a device. THE canonical entry point for any
   * consumer that wants to read state, subscribe to changes, or dispatch
   * cap methods on a device — equivalent to `BackendClient.fetchDevice(id)`
   * on the client side.
   *
   * What you can do with the returned proxy:
   *   - Read live state slices: `dev.state.battery.value` (typed
   *     `BatteryStatus | undefined`, no provider call — reads the kernel's
   *     mirrored snapshot).
   *   - Subscribe to slice changes: `dev.state.battery.subscribe(cb)` —
   *     refcounted, auto-seeds the callback with the current value.
   *   - Invoke cap methods through the wrapper chain:
   *     `await dev.snapshot.getSnapshot({...})`. Methods are typed against
   *     each cap's definition; absent caps appear as `undefined`.
   *
   * Routing semantics: every method call on the returned proxy goes through
   * the tRPC cap-router → the active wrapper (if any) → the native provider.
   * That means a wrapper consuming its OWN cap via `fetchDevice` would
   * recurse — wrappers must use `getNativeProvider` instead. See the rule
   * documented on `getNativeProvider` above.
   *
   * Bindings are cached per-addon-context: the first call resolves bindings
   * via `deviceManager.getBindings.query`, subsequent calls reuse the cache.
   * The cache is invalidated implicitly when the device is removed.
   */
  fetchDevice(deviceId: number): Promise<import('../generated/device-proxy.js').DeviceProxy>

  /**
   * HTTP **data-plane** facility — serve files/streams/large payloads through the
   * hub's own port with the ADDON producing the bytes (real Node `req`/`res`); the
   * hub authenticates and reverse-proxies. Use for media (recording playback,
   * scrub frames, clip export) where the `addon-routes` control plane (small JSON
   * envelopes over the unary cap channel) is the wrong shape. See {@link AddonDataPlane}.
   *
   * Injected by the kernel; absent when the addon is loaded in isolation (tests,
   * tooling), which is why the field is optional.
   */
  readonly dataPlane?: AddonDataPlane

  /**
   * Addon→addon **byte transport** (D613) — how a consumer addon gets another
   * addon's bytes without either of them holding the payload whole.
   *
   * `dataPlane` lets an addon serve the HUB; this lets it serve a SIBLING. The
   * producer offers one body and gets a one-shot ticket it hands back through
   * the cap method it already gates; the consumer opens the ticket and streams.
   * Same host only — a ticket from another node is refused `cross-node` by
   * name, never dialled. See {@link AddonPeerBytes}.
   *
   * Use it instead of a base64 field on a unary cap method. That shape holds
   * the payload whole (~1.33×) in the producer AND in the caller and is why
   * every such method has had to carry a byte bound (D9/D18).
   *
   * Injected by the kernel; absent when the addon is loaded in isolation
   * (tests, tooling), which is why the field is optional.
   */
  readonly peerBytes?: AddonPeerBytes

  /**
   * This addon's keychain values (D787). The owner is the addon's own id,
   * closed over by the kernel; nothing passed to it can change that.
   * `BaseAddon` uses it for every secret field of its schema (a marker in the
   * blob, the value here) — reach for it directly only for values that are
   * not settings (a business collection's credentials, a minted token).
   *
   * Absent when the addon is loaded in isolation (tests, tooling) or on a
   * kernel that predates the keychain.
   */
  readonly secrets?: SecretsAccess

  /**
   * This addon's record kinds (D881): its own facts and documents - ledgers,
   * audit rows, config documents, mirrors - read by key, by device, by device
   * and time. The owner is the addon's own id, closed over by the kernel; a kind
   * is readable and writable by its owner only. A field marked
   * `.meta({ secret: true })` in a kind's schema is kept in the keychain
   * automatically. See `docs/architecture/records.md`.
   *
   * Absent when the addon is loaded in isolation (tests, tooling) or on a
   * kernel that predates records.
   */
  readonly records?: RecordsAccess

  /**
   * Runtime accessor for the capability registry — exposed to addons that
   * need to enumerate peers of a collection cap (e.g. `turn-provider`) or
   * grab the active singleton for a system cap. Injected by the kernel at
   * addon instantiation; absent when the addon is loaded in isolation
   * (tests, tooling), which is why the field is optional.
   */
  readonly capabilities?: CapabilitiesAccess

  /**
   * Returns a capability handle immediately (non-blocking). The handle tracks
   * ready/down state via the ReadinessRegistry and gates calls accordingly.
   * Repeated calls with the same `(capName, scope)` return the same cached instance.
   *
   * Use for runtime cap consumption where the cap may not be ready yet and
   * you want calls to block transparently via `handle.call(fn)`.
   */
  useCapability<T = unknown>(capName: string, scope?: ReadinessScope): ICapabilityHandle<T>

  /**
   * Blocks until the capability is ready, then returns the cached handle.
   * Throws `CapabilityUnavailableError` if the cap does not become ready
   * within `timeoutMs` (default 15 000ms).
   *
   * Use for boot sequencing where downstream work must not start until
   * the cap is confirmed available.
   */
  acquireCapability<T = unknown>(
    capName: string,
    scope?: ReadinessScope,
    opts?: { timeoutMs?: number },
  ): Promise<ICapabilityHandle<T>>

  /**
   * Subscribe to capability state changes (ready / down).
   * Returns an unsubscribe function. Thin wrapper over `ReadinessRegistry.onReadyState`.
   */
  onCapabilityStateChange(
    capName: string,
    scope: ReadinessScope,
    handler: (state: 'ready' | 'down') => void,
  ): () => void

  /**
   * Register a teardown callback that runs automatically when this
   * addon is shut down or restarted (e.g. by `restartAddon` after a
   * runtime update from the admin UI). Disposers run in LIFO order so
   * later registrations clean up before the resources they depend on.
   *
   * Use this for any side effect that survives across function calls
   * — `setInterval`, native socket listeners, watchers, file handles.
   * Capability/event subscriptions returned by `onCapabilityStateChange`
   * / `eventBus.subscribe` are unsubscribe functions you can pass
   * straight to `addDisposer`. Returns a manual unsubscribe so the
   * addon can drop the disposer early if needed.
   *
   *   const stopTimer = setInterval(...);
   *   ctx.addDisposer(() => clearInterval(stopTimer));
   *
   *   const unsub = ctx.eventBus.subscribe('motion', cb);
   *   ctx.addDisposer(unsub);
   *
   * The kernel calls each disposer once during `addon.shutdown()`. A
   * disposer that throws is logged and skipped — subsequent disposers
   * still run.
   */
  addDisposer(fn: () => void | Promise<void>): () => void
}

/**
 * Runtime-only capability registry surface — kept minimal on purpose.
 * `getCollection` returns every registered provider for a collection cap
 * (order-unstable); `get` returns the active provider for a singleton.
 * Both return `undefined` when the cap isn't declared or has no provider.
 */
export interface CapabilitiesAccess {
  /** All providers registered on a collection capability (by cap name). */
  getCollection<T = unknown>(name: string): readonly T[] | undefined
  /**
   * Like `getCollection` but returns `[addonId, provider]` tuples so
   * callers can attribute work back to the contributing addon. The
   * `addonId` for cap-routed remote providers is `<addonName>@<workerNodeId>`
   * (e.g. `decoder-nodeav@dev-agent-1/decoder-nodeav`); local providers
   * are just `<addonName>` (no `@`). Used by stream-broker to filter the
   * decoder collection to node-local providers (decode is always
   * co-located with its frame consumer).
   */
  getCollectionEntries<T = unknown>(name: string): readonly (readonly [string, T])[] | undefined
  /** The active provider of a singleton capability (by cap name). */
  get<T = unknown>(name: string): T | undefined
}

export interface ICamstackAddon {
  readonly id?: string
  /** Addon declaration — injected by the framework from package.json. Do not declare in addon class. */
  readonly manifest?: AddonDeclaration
  /**
   * Initialize the addon. Return capability provider bindings for the kernel
   * to register in the CapabilityRegistry. Returning `void` or an empty array
   * is valid for addons that don't provide capabilities (e.g. pure consumers).
   *
   * The kernel validates that every capability declared in `package.json`
   * has a corresponding entry in the returned array.
   *
   * @example
   * ```ts
   * async initialize(ctx: AddonContext): Promise<AddonInitResult> {
   *   this.detector = new WasmMotionDetector()
   *   await this.detector.load()
   *   return { providers: [{ capability: motionDetectionCapability, provider: this }] }
   * }
   * ```
   */
  initialize(context: AddonContext): Promise<ProviderRegistration[] | AddonInitResult | void>
  /**
   * Called by the isolated-process runner after `broker.start()`.
   * In-process addons never need this — the hub broker is already running
   * when `initialize()` fires. Forked children emit readiness inside
   * `initialize()` before the broker is live; this re-emits it once the
   * transport is ready so consumers actually receive the event.
   */
  postBrokerStart(): void
  /**
   * Optional hook. Fires on forked workers / remote agents once the
   * broker has started AND the hub node has been discovered via the
   * Moleculer `$node.connected` event — the moment at which
   * `ctx.api.*` calls to hub-provided capabilities become safe.
   *
   * Use this instead of `initialize()` for any bootstrap work that
   * needs to query the hub (e.g. restoring persisted state, reading
   * hub-owned settings). Calling `ctx.api.*` from `initialize()` on a
   * worker is a documented foot-gun: the broker is not connected yet
   * and requests either time out or throw "Service not found".
   *
   * On the hub itself this never fires (the hub is its own node; there
   * is no separate hub to wait for).
   */
  onHubReachable?(): Promise<void> | void
  shutdown(): Promise<void>

  // Cleanup: the legacy `getConfigSchema / getConfig / onConfigChange`
  // trio was removed. Every addon implements the three-level settings
  // API below and nothing on the server reads the legacy shape any
  // more — the adapter shim in `addon-registry.service.ts` and the
  // `addons.getConfigSchema / getConfig / updateConfig` tRPC endpoints
  // are gone.

  // -- Three-level settings API --
  //
  // An addon implements only the levels it needs. Each level has a
  // disjoint schema — field keys must not collide across levels. Each
  // getter returns a hydrated `ConfigUISchemaWithValues` (schema + values
  // inline) so the admin UI can render in one pass.
  //
  // Level 1 — addon settings: pipeline/context-specific fields, rendered
  //           by whatever page knows the addon belongs to it (e.g. the
  //           Pipeline page hardcodes PIPELINE_CAPABILITIES and iterates
  //           providers).
  // Level 2 — node-global settings: node-level fields shown in Cluster →
  //           NodeDetailPanel → Settings. Dynamic discovery: an addon
  //           that doesn't implement `getGlobalSettings` doesn't appear
  //           there.
  // Level 3 — device settings: per-camera fields shown in Device
  //           Overrides.
  //
  // All six methods are OPTIONAL. They will become the canonical way
  // addons expose settings once Phase 3 removes the deprecated trio
  // above. See docs/superpowers/specs/2026-04-11-settings-redesign-design.md.

  /** Level 1 — node-global settings (schema + values). Appears in
   *  Cluster → Settings tab. `overlay` is an optional preview merge
   *  consumed by override-mode UIs (benchmark) so cascade-aware
   *  addons can re-derive dependent options without touching the
   *  persisted store. */
  getGlobalSettings?(
    overlay?: Record<string, unknown>,
    cap?: string,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues | null>
  updateGlobalSettings?(patch: Record<string, unknown>, nodeId?: string): Promise<void>
  /**
   * The same write, made by the OPERATOR (D787): the kernel's settings
   * dispatch prefers it when the addon has it.
   */
  updateGlobalSettingsAsOperator?(patch: Record<string, unknown>, nodeId?: string): Promise<void>

  /**
   * Integration-level settings — the subset of the global schema the addon
   * declared as its INTEGRATION's configuration (`BaseAddon.
   * integrationSettingSections`). `null` ⇒ none declared, so the surface is
   * not offered.
   *
   * There is no matching updater on purpose: the payload is a subset of the
   * global schema, so `updateGlobalSettings` is the writer and the store key
   * stays the one bare key. See `addon-settings.cap.ts`.
   */
  getIntegrationSettings?(nodeId?: string): Promise<ConfigUISchemaWithValues | null>

  /**
   * The form of ONE integration instance (create wizard or edit page): the addon's per-instance
   * schema when it declares one, else its global schema. See `BaseAddon.getIntegrationFormSchema`.
   */
  getIntegrationFormSchema?(
    instance: IntegrationInstanceRef,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues | null>

  /**
   * Stale-data audit: the global-settings keys this addon still declares,
   * answered in its own process. See `BaseAddon.getDeclaredSettingsKeys`.
   */
  getDeclaredSettingsKeys?(): Promise<{ readonly keys: readonly string[] }>
  /** Stale-data audit: remove stored keys the addon no longer declares. */
  unsetStoredSettingsKeys?(keys: readonly string[]): Promise<{
    readonly removed: readonly string[]
    readonly refused: ReadonlyArray<{ readonly key: string; readonly reason: string }>
    readonly secretsCleared: number
  }>

  /** Level 2 — per-device settings (schema + values). Appears in
   *  Device Overrides. */
  getDeviceSettings?(deviceId: number): Promise<ConfigUISchemaWithValues>
  updateDeviceSettings?(deviceId: number, patch: Record<string, unknown>): Promise<void>

  /**
   * Called at boot after initialize() with all previously persisted devices.
   * The addon should re-instantiate device objects and register them via context.devices.register().
   */
  restoreDevices?(
    savedDevices: readonly import('../device/device-management.js').SavedDevice[],
  ): Promise<void>

  // -- Model catalog (optional — only for inference addons) --
  getModelCatalog?(): unknown[]
  // `getModelRequirements` and `configure` were removed — inference addons
  // now resolve their own config inside `initialize()` by calling
  // `ctx.api.platformProbe.resolveInferenceConfig.query({ requirements })`.

  // -- Inference methods (optional — only for detection/classification addons) --

  /** Load/prepare a model engine for a given modelId. Called before process()/classifyAudio(). */
  ensureEngine?(modelId: string): Promise<void>

  /** Unified vision inference — handles detection, cropping, classification, refinement.
   * Input is FrameInput (root) or CropInput (child node). Output shape determines slot. */
  process?(input: unknown): Promise<unknown>

  /** Audio classification — separate from vision pipeline */
  classifyAudio?(input: unknown): Promise<unknown>
}

/** Declaration of a UI page provided by an addon */
export interface AddonPageDeclaration {
  /** Unique page ID (scoped to addon) */
  readonly id: string
  /** Display label for sidebar */
  readonly label: string
  /** Lucide icon name for sidebar */
  readonly icon: string
  /** Route path (e.g., '/benchmark') */
  readonly path: string
  /**
   * Module Federation remote name — must match the `name` field on the
   * page addon's `federation()` plugin config. Used by admin-ui's
   * `<AddonPageLoader>` to call `loadRemote('<remoteName>/page')`.
   * Conventionally `addon_<id>_page` (snake_case; MF names cannot
   * contain hyphens).
   */
  readonly remoteName: string
  /**
   * Bundle filename inside the addon's `dist/` dir served at
   * `/api/addon-pages/<addonId>/<bundle>`. With Module Federation this
   * is always `'remoteEntry.js'`.
   */
  readonly bundle: string
  /**
   * Sidebar section this page docks into. Well-known ids: `'detection'`,
   * `'cluster'`, `'administration'` — the page renders inside that group.
   * Any OTHER string creates (or joins) a custom section rendered after
   * the built-in groups; label from `sectionLabel` (first declaration
   * wins), falling back to the id. Absent → the "Addon Pages" group.
   */
  readonly section?: string
  /** Display label for a CUSTOM `section` id (ignored for well-known ids). */
  readonly sectionLabel?: string
}

/** Provider interface for addons that expose UI pages */
export interface IAddonPageProvider {
  readonly id: string
  listPages(): readonly AddonPageDeclaration[]
}

/**
 * Provider interface for the admin UI shell (singleton capability).
 *
 * Aligned to the canonical `InferProvider<typeof adminUiCapability>`
 * shape — every method is `(input) => Promise<output>` where the output
 * is a Zod-validated object literal. Plain strings would diverge from
 * the cap def and break the auto-mount typecheck.
 */
export interface IAdminUI {
  getStaticDir(): Promise<{ readonly staticDir: string }>
  getVersion(): Promise<{ readonly version: string }>
}

/**
 * Full addon declaration — lives in package.json `camstack.addons[]`.
 * This is the SINGLE SOURCE OF TRUTH for addon identity and metadata.
 * Addon classes no longer declare a `manifest` property.
 */
/** The two blocks of the admin Integrations page. */
export type IntegrationSection = 'system' | 'providers'

export interface AddonDeclaration {
  // ── Identity ────────────────────────────────────────────────────────
  readonly id: string
  /** JS entry point relative to package root (e.g., "./dist/addon.js") */
  readonly entry?: string
  /**
   * Human-readable name — the label every addon list renders. Say what the
   * addon IS ("Admin UI", "Recorder"); no "CamStack " prefix, it carries no
   * information inside a CamStack install and eats list width.
   */
  readonly name?: string
  /** Semver version */
  readonly version?: string
  /** Short description */
  readonly description?: string

  // ── Display ────────────────────────────────────────────────────────
  /** Relative path to SVG icon asset within the addon package */
  readonly icon?: string
  /** Brand hex color for UI display (e.g., "#3b82f6") */
  readonly color?: string
  /**
   * Coarse grouping for the Cluster topology view. Free-form string;
   * see `category-resolver.ts` in `@camstack/addon-admin-ui` for the
   * recognised values + their colours. Absence → falls into the
   * `'system'` bucket. Optional; manifests can ignore this field
   * unless they want to be grouped explicitly.
   */
  readonly category?: string

  // ── Runtime ────────────────────────────────────────────────────────
  readonly slot?: PipelineSlot | null
  /** Instance mode: 'unique' or 'multiple'. Default: 'multiple' */
  readonly instanceMode?: 'unique' | 'multiple'
  /**
   * Integration `mode` — how the Add-Integration wizard behaves for this
   * addon (LOCKED MODEL, supersedes `instanceMode` for wizard routing):
   *   - `'standalone'` — NO integration-level config; picking creates the
   *     integration immediately (empty settings) and goes straight to
   *     adding/discovering the first device. No config step, no config
   *     button on the detail page. (Reolink/ONVIF/Ecowitt/Gree.)
   *   - `'account'` — account/connection config; wizard shows the config
   *     step, then `integrations.create` with those settings.
   *     (Dreo/Wyze/Dreame.)
   *   - `'broker'` — the shared-bus/session broker step. (HomeAssistant/MQTT.)
   * Optional/transitional: when absent, `getAvailableTypes` DERIVES the mode
   * (broker cap + brokerKind → broker; device-adoption → account; else →
   * standalone). `instanceMode` is kept for now.
   */
  readonly mode?: 'standalone' | 'account' | 'broker'
  /**
   * For `device-adoption` integration addons (Approach A): the broker
   * kind the integration wizard must create or link (e.g.
   * `'home-assistant'`). The integration record stores only `{ brokerId }`;
   * the broker (registered via the `broker` cap) holds the real connection
   * identity. Ignored by `device-provider` addons.
   */
  readonly brokerKind?: string
  /**
   * True when the integration's source system exposes locations (e.g. HA
   * areas) that the adoption flow can import. Drives the adopt modal's
   * "import locations" checkbox. Read by `getAvailableTypes` via
   * `d?.supportsLocationImport ?? m.supportsLocationImport`.
   */
  readonly supportsLocationImport?: boolean
  /** Whether this addon is protected (required by the system, cannot be uninstalled) */
  readonly protected?: boolean
  /**
   * Which block of the admin Integrations page this addon's integrations land in.
   * Declared per addon ENTRY (one package can host several addons). Absent: `system`
   * for an addon shipped in a framework package, `providers` otherwise.
   */
  readonly integrationSection?: IntegrationSection
  /**
   * Group-runner execution model.
   *
   * Every addon lives in a forked subprocess; the question is which one.
   *
   * The runner contract (base-layer D2):
   *   - An addon with NO declared `group` gets its OWN dedicated runner —
   *     the runner id IS the addon id, one process per addon.
   *   - Addons that declare the SAME `group` value share one runner +
   *     one Moleculer broker, so cap calls between them resolve
   *     in-process via `localProviderLink` (zero IPC). The runner id is
   *     the group name.
   *
   * Co-location via `group` is reserved for addons that pass live JS
   * objects across the cap surface (the media pipeline `pipeline` group:
   * `stream-broker` hands `pipeline-runner`/`pipeline-orchestrator` a
   * live `IStreamBroker` reference — an uncrossable process boundary).
   * Everything else runs one-addon-one-process for crash isolation.
   *
   * `placement` defaults to `'hub-only'` (addon does NOT deploy to
   * agents) when `execution` is omitted.
   *
   * Examples:
   *   ```jsonc
   *   // hub-only addon on its own runner (most common — omit `execution`)
   *
   *   // deployable to any node, still its own runner
   *   "execution": { "placement": "any-node" }
   *
   *   // co-locate with peers that share a live JS reference
   *   "execution": { "placement": "any-node", "group": "pipeline" }
   *
   *   // hardware-bound, only runs on agents (no hub instance)
   *   "execution": { "placement": "agent-only" }
   *   ```
   */
  readonly execution?: AddonExecution

  // ── Capabilities ───────────────────────────────────────────────────
  /** Capabilities this addon provides */
  readonly capabilities?: readonly CapabilityDeclaration[]
  /** UI pages provided by this addon */
  readonly pages?: readonly AddonPageDeclaration[]

  // ── Pipeline-specific ──────────────────────────────────────────────
  readonly requiredFeatures?: readonly string[]
  readonly inputClasses?: readonly string[]
  readonly outputClasses?: readonly string[]
  readonly requiredSteps?: readonly RequiredStep[]
  readonly supportsCustomModels?: boolean
  readonly mayRequirePython?: boolean
  /** Whether this addon performs active inference. Passive addons are excluded from inference pipeline. Default: true. */
  readonly passive?: boolean
  /**
   * Label output type for classifier/recognizer addons.
   *
   * `classification` — generic class name (e.g. `'bird'`, `'labrador'`)
   * `face`           — recognised face identity
   * `plate`          — recognised licence plate OCR
   * `recognition`    — generic recognition result (embedding gallery)
   */
  readonly labelOutputType?: 'classification' | 'face' | 'plate' | 'recognition'

  // ── Python (auto-managed deps) ─────────────────────────────────────
  /**
   * Optional Python runtime dependencies. Declares the pip requirements
   * file the kernel must install into the embedded portable Python
   * before this addon's `onInitialize()` runs. Resolved relative to the
   * addon's package root.
   *
   * Idempotent: install is keyed on (file basename + sha256 of contents)
   * via the marker dir under the python install — back-to-back boots
   * skip the pip subprocess after the first install.
   *
   * Example:
   *   ```jsonc
   *   "camstack": {
   *     "addons": [{
   *       "id": "detection-pipeline",
   *       "python": { "requirements": "./python/requirements.txt" }
   *     }]
   *   }
   *   ```
   *
   * Backend / feature-specific deps that depend on user settings should
   * NOT be listed here — addons install those lazily via
   * `ctx.deps.installPythonRequirements(absolutePath)`.
   */
  readonly python?: AddonPythonRequirements

  // ── System binaries (auto-managed deps) ────────────────────────────
  /**
   * Host binaries this addon needs on PATH. Same declaration site, same
   * lifecycle position and same idempotence contract as {@link python} —
   * the runner satisfies them BEFORE `onInitialize()` runs, so a capability
   * never advertises itself while the binary it wraps is missing.
   *
   * The declaration names WHAT is needed (a binary) plus the package name
   * each host package manager knows it by — a translation table, not a
   * procedure. HOW to install (`apt-get update && apt-get install -y …`,
   * `brew install …`) belongs to the framework, so the next addon that needs
   * a binary does not re-answer the question.
   *
   * Example:
   *   ```jsonc
   *   "camstack": {
   *     "addons": [{
   *       "id": "smb-storage",
   *       "systemDependencies": [
   *         { "binary": "smbclient", "packages": { "apt": "smbclient", "brew": "samba" } }
   *       ]
   *     }]
   *   }
   *   ```
   *
   * Failure is NOT fatal: the addon still loads and the capability that needs
   * the binary must refuse loudly on its own surface. A provider that cannot
   * run must never make its locations read as *empty* — `empty` is deletable
   * (D293).
   */
  readonly systemDependencies?: readonly AddonSystemDependency[]

  // ── Config ─────────────────────────────────────────────────────────
  /** Default configuration values */
  readonly defaultConfig?: Readonly<Record<string, unknown>>

  // ── Storage ────────────────────────────────────────────────────────
  /**
   * Storage locations this addon needs. The kernel aggregates these across
   * all installed addons; the orchestrator seeds one `<id>:default` per
   * declaration. Ids are global (shared across addons).
   */
  readonly storageLocations?: readonly StorageLocationDeclaration[]
}

/**
 * Manifest declaration for an addon's Python runtime dependencies.
 * See `AddonDeclaration.python`.
 */
export interface AddonPythonRequirements {
  /**
   * Path to the pip requirements file the kernel installs into the
   * embedded portable Python before `onInitialize()` runs. Resolved
   * relative to the addon package root.
   */
  readonly requirements: string
}

/**
 * One host binary an addon needs on PATH. See
 * `AddonDeclaration.systemDependencies`.
 *
 * Deliberately NOT a shell command. A manifest that carried
 * `"install": "apt-get install -y smbclient"` would be a per-addon script the
 * framework runs blind — unportable, unverifiable, and a second answer to a
 * question the Python mechanism already answered once.
 */
export interface AddonSystemDependency {
  /**
   * The executable that must resolve on PATH after the step completes. This
   * is both the presence check (cheap, and what makes the common path a
   * no-op) and the success check.
   */
  readonly binary: string
  /**
   * Package name per host package manager. A manager absent from this map
   * means "this addon has no way to install the binary on that host" — the
   * runner logs it and continues rather than guessing that the package shares
   * the binary's name.
   */
  readonly packages: AddonSystemDependencyPackages
  /** Operator-facing reason, surfaced in the log line when the install fails. */
  readonly reason?: string
}

/** Package name per supported host package manager. */
export interface AddonSystemDependencyPackages {
  /** Debian / Ubuntu (`apt-get`) — the container base. */
  readonly apt?: string
  /** Alpine (`apk`). */
  readonly apk?: string
  /** Fedora / RHEL (`dnf`). */
  readonly dnf?: string
  /** macOS Homebrew (`brew`) — the desktop build. */
  readonly brew?: string
}

export interface AddonPackageManifest {
  /**
   * Human-readable package name for UI display (e.g., "Pipeline", "Core").
   * No "CamStack " prefix — inside a CamStack install it carries no
   * information and only eats the width of every list that renders it.
   */
  readonly displayName?: string
  /**
   * Optional 1-2 sentence description shown on the package card.
   * Useful for system packages (types/kernel/core/sdk/ui-library) that
   * don't ship operator-facing addons but still appear in the admin UI's
   * System packages section.
   */
  readonly description?: string
  /**
   * Marks the package as a SYSTEM package — part of the hub runtime
   * (types, kernel, core, sdk, ui-library) rather than an installable
   * addon. The admin UI shows these in a separate "System packages"
   * section, disables uninstall, and warns the operator that updating
   * them requires a server restart. Framework packages are updated via
   * the node-root server-update flow (`applyServerUpdate`), not the
   * regular addon installer.
   *
   * Mutually-exclusive with `addons[]` in concept but not in code:
   * `@camstack/system` is both a system package AND ships builtin addons,
   * so both fields can coexist on it.
   */
  readonly system?: boolean
  readonly addons: readonly AddonDeclaration[]
  /**
   * Optional bundle metadata for npm packages that ship multiple addon
   * entries (e.g., `@camstack/addon-pipeline` with 7 entries,
   * `@camstack/addon-remote-storage` with 3 entries). When set, the
   * Addons admin UI renders the entries as collapsible children under a
   * single bundle card. The npm package boundary IS the install/update
   * unit — operator-facing actions (Install, Update, Uninstall) act on
   * the bundle, not on individual children. Per-child enable/disable +
   * settings are still surfaced individually.
   *
   * Single-entry packages omit this field; their UI stays a standalone
   * card. Multi-entry packages WITHOUT this field fall back to deriving
   * displayName from `package.json:name`.
   */
  readonly bundle?: AddonBundleManifest
  /**
   * Native node modules that the addon needs at runtime but cannot be
   * bundled (`.node` binary files require ABI-matched compilation).
   * Phase E of the bundles + builder modernization spec — mirror of
   * the Python `requirements.txt` pattern, but for native Node deps.
   *
   * Format: package name → semver range, exactly like
   * `package.json#dependencies`. NOT listed in the package's regular
   * `dependencies` field (so workspace `npm install` skips them), but
   * the addon installer reads this field at install time and runs:
   *
   *   npm install --prefix <addonDir> <name>@<range>
   *   electron-rebuild -m <addonDir> -w <name>   (for Electron host)
   *   npm rebuild --prefix <addonDir> <name>     (for plain Node host)
   *
   * The host's runtime ABI (Electron 35 = Node ABI 127, plain Node 22 =
   * ABI 133) is detected at install time. Both targets are first-class.
   *
   * Example:
   * ```jsonc
   * "camstack": {
   *   "nativeDependencies": {
   *     "better-sqlite3": "^12.8.0",
   *     "ssh2": "^1.16.0"
   *   }
   * }
   * ```
   *
   * Phase E will also produce prebuilt `.node` binaries for both ABIs
   * during `npm publish`, shipped in the tarball under
   * `dist/native-prebuilds/<runtime>-<abi>-<arch>/`. The installer
   * tries the matching prebuild first; falls back to source rebuild
   * only when no prebuild exists for the host triple.
   */
  readonly nativeDependencies?: Readonly<Record<string, string>>
}

export interface AddonBundleManifest {
  /** Display name shown on the bundle card header (e.g., "Pipeline"). */
  readonly displayName: string
  /** Optional 1-2 sentence description for the operator. */
  readonly description?: string
  /** Optional icon path relative to the package root. */
  readonly icon?: string
}

/**
 * Where an addon may be deployed. The kernel honours this when picking
 * which node hosts the group-runner that will load the addon.
 *
 * - `'hub-only'` — runs only on the hub process. Default.
 * - `'agent-only'` — runs only on remote agent processes.
 * - `'any-node'` — eligible to run on either hub or agents.
 */
export type AddonPlacement = 'hub-only' | 'agent-only' | 'any-node'

/**
 * Effective execution model for an addon. See `AddonDeclaration.execution`
 * for the full semantics.
 */
export interface AddonExecution {
  readonly placement?: AddonPlacement
  /**
   * Subprocess co-location group label. Addons that declare the SAME
   * value share one forked runner + one Moleculer broker.
   *
   * OMITTED (the common case) → the addon gets its own dedicated runner
   * whose id is the addon id. There is no catch-all bucket: leaving
   * `group` unset means one-addon-one-process, not "join a shared
   * default group".
   */
  readonly group?: string
  /**
   * Runtime heap profile — drives the V8 flags the addon's runner is spawned with (Block D memory).
   *
   * - `'light'` (DEFAULT when omitted): a mostly-idle control-plane runner (providers, auth,
   *   tunnels, storage, smtp, notifier, admin-ui). Its young generation is capped
   *   (`--max-semi-space-size`) to reclaim V8's over-reservation — a measured ~15 MB/runner.
   * - `'heavy'`: a media / ML / native runner (pipeline, decoder, benchmark, camera clients,
   *   embedding, model-studio, analytics) that allocates enough on the JS heap that a small young
   *   generation would add scavenge-GC churn — keeps V8's default young generation. It still gets
   *   an old-space CEILING (see {@link AddonExecution.maxOldSpaceMb}); "heavy" means "needs room",
   *   never "unbounded".
   *
   * A runner is treated as heavy if ANY co-located addon declares `'heavy'`. This replaces the
   * former hard-coded addon-name list in `process-service.ts`.
   */
  readonly heapProfile?: AddonHeapProfile
  /**
   * Per-runner-class V8 old-space ceiling in MB (`--max-old-space-size`).
   *
   * OMITTED (the common case) → the runner takes the default for its
   * {@link AddonExecution.heapProfile}. Declare it only when the addon's measured working set
   * does not fit that default: the number belongs next to the addon that knows its own working
   * set, not in a table inside the kernel.
   *
   * A runner's ceiling is the MAXIMUM declared by any co-located addon — co-location must never
   * silence the hungriest member.
   *
   * `0` means "no ceiling for this addon" and, being the maximum, lifts the whole runner's cap.
   */
  readonly maxOldSpaceMb?: number
  /**
   * V8 young-generation semi-space in MB (`--max-semi-space-size`), for a runner
   * whose allocation pattern V8's class default fits badly.
   *
   * OMITTED (the common case) → the class default: a light runner's 2 MB, a heavy
   * runner's V8 default (64 MB on a 64-bit host). Declare it from a MEASUREMENT of
   * the runner's GC log, never from taste. The case it exists for: a heavy runner
   * whose live old space is small while its allocation rate is high (`stream-broker`,
   * ~100 MB live against ~11 k RTP packets/s). V8 sizes a mark-compact's old-space
   * headroom from the live set (~0.5×), and when that headroom is BELOW the young
   * generation, every scavenge promotes enough to restart incremental marking —
   * measured on the hub as ~166 major GCs a minute and not one scavenge, 45–60 % of
   * a core. A semi-space the headroom can absorb lets V8 scavenge again
   * (`semiSpaceMb: 8` → 176 → 20.8 majors/min, CPU 60 → 21.7 %).
   *
   * Range: an integer in `[1, 256]`; anything else is ignored. A runner's value is
   * the MAXIMUM declared by any co-located addon (D2/D29): a smaller young
   * generation than a member asked for would hand that member the churn it
   * declared its way out of.
   */
  readonly semiSpaceMb?: number
  /**
   * V8 initial old-space size in MB (`--initial-old-space-size`): the old-space
   * headroom the runner STARTS with, so a heap that reaches its steady state in
   * seconds does not spend them in back-to-back mark-compacts while V8 grows the
   * limit from the live set.
   *
   * OMITTED (the common case) → V8's default (grown from the live set). Declare it
   * with {@link AddonExecution.semiSpaceMb} and from the same measurement; the two
   * flags are one remedy, and a semi-space V8 cannot fit under the old-space
   * headroom buys nothing. Range: an integer in `[16, 65536]`, ignored otherwise,
   * and clamped at spawn to the runner's old-space CEILING
   * ({@link AddonExecution.maxOldSpaceMb} or the class default) — an initial size
   * above the ceiling is a flag V8 refuses. A runner's value is the MAXIMUM any
   * co-located addon declares (D2/D29).
   */
  readonly initialOldSpaceMb?: number
  /**
   * Whole-process RSS budget in MB — the number the memory watchdog alarms on.
   *
   * This is NOT a second heap ceiling and it enforces nothing: it is the
   * footprint this addon's role considers legitimate, and crossing it emits one
   * WARN carrying the breakdown (`heapUsed` / `external` / native residue) so the
   * operator learns WHICH KIND of growth it is.
   *
   * It exists because every other bound is blind to most of a process.
   * {@link AddonExecution.maxOldSpaceMb} bounds V8's old space and nothing else,
   * and the watchdog's `stranded` metric subtracts `external` by construction.
   * `hub/pipeline-analytics` was OOM-killed at 11.4GB on 2026-08-27 with a
   * 1024MB old-space ceiling in force the entire time, holding a 536MB heap and
   * 4264MB of `external` — 96% of the growth was never V8's, and nothing warned.
   * RSS is what the host's OOM killer reads, so RSS is what needs a declared
   * ceiling.
   *
   * OMITTED (the common case) → this addon declares no budget. If NO co-located
   * addon declares one, the runner reports itself UNWATCHED once at boot; there
   * is deliberately no class default, because the legitimate footprint differs by
   * an order of magnitude by role (a recorder holding a 1.5GB segment index is
   * behaving correctly; analytics holding 1.5GB is not). Declare it from a
   * MEASURED peak RSS, never from a heap number.
   *
   * A runner's budget is the MAXIMUM declared by any co-located addon —
   * co-location must never silence the hungriest member (D2/D29).
   */
  readonly rssBudgetMb?: number
  /**
   * `@camstack/system` builtin ONLY: run this builtin in its OWN forked runner
   * instead of in-process on the hub root.
   *
   * The hub drops `@camstack/system` builtins from the runner plan because the
   * infrastructure ones (storage, settings, logging, device-manager) must be
   * resident in the process every runner depends on. That is a reason to keep
   * THOSE in-process — not a property of the package. A builtin that owns
   * capture, transcode and byte caches (`snapshot`) charges all of it to the
   * event loop that also answers the tRPC API.
   *
   * Declaring `isolate: true` opts a single builtin out of that blanket rule:
   * it is planned, spawned, restarted and route-mounted exactly like any other
   * forked addon, and `resolveRunnerId` still owns its runner id (D2 — one
   * addon, one process). Nothing else changes: the manifest entry keeps its
   * `entry` path inside the `@camstack/system` closure, and the runner loads it
   * from there.
   *
   * Ignored for non-system packages — they already fork.
   */
  readonly isolate?: boolean
}

export type AddonHeapProfile = 'light' | 'heavy'

export const DEFAULT_ADDON_PLACEMENT: AddonPlacement = 'hub-only'

/**
 * Effective execution model for an addon after defaults are applied —
 * the resolved return shape of `resolveAddonExecution`. `placement` is
 * always concrete; `group` is left as-declared (`undefined` when the
 * addon declares no co-location group → its own dedicated runner).
 */
export interface ResolvedAddonExecution {
  readonly placement: AddonPlacement
  readonly group: string | undefined
}

/**
 * Resolve the effective `AddonExecution` for an addon. `placement`
 * always resolves to a concrete value (defaults to `hub-only`).
 * `group` is left as-declared — `undefined` when the addon declares no
 * co-location group, which means it runs on its own dedicated runner.
 */
export function resolveAddonExecution(
  decl: Pick<AddonDeclaration, 'execution'>,
): ResolvedAddonExecution {
  return {
    placement: decl.execution?.placement ?? DEFAULT_ADDON_PLACEMENT,
    group: decl.execution?.group,
  }
}

/** True when the addon may run on a remote agent (deployable from hub). */
export function isDeployableToAgent(decl: Pick<AddonDeclaration, 'execution'>): boolean {
  const placement = resolveAddonExecution(decl).placement
  return placement === 'any-node' || placement === 'agent-only'
}

/** True when the addon is skipped on the hub (agent-only deployment). */
export function isAgentOnlyPlacement(decl: Pick<AddonDeclaration, 'execution'>): boolean {
  return resolveAddonExecution(decl).placement === 'agent-only'
}

/**
 * Convenience accessor — the declared co-location group label, or
 * `undefined` when the addon declares no group (→ its own dedicated
 * runner). Callers that need the runner id should use `resolveRunnerId`.
 */
export function resolveAddonGroup(decl: Pick<AddonDeclaration, 'execution'>): string | undefined {
  return resolveAddonExecution(decl).group
}

/**
 * Resolve the runner id an addon belongs to. This is the single
 * authority for the hub↔runner topology:
 *   - declared `group` present → the runner id is the group name
 *     (shared with every other addon declaring the same group);
 *   - no `group` declared → the runner id is the addon id itself
 *     (its own dedicated runner — one addon, one process).
 *
 * The runner's Moleculer nodeID is `${parentNodeId}/${runnerId}`.
 */
export function resolveRunnerId(
  decl: Pick<AddonDeclaration, 'execution'>,
  addonId: string,
): string {
  return decl.execution?.group ?? addonId
}

/** Convenience accessor — the resolved placement (defaults to `hub-only`). */
export function resolveAddonPlacement(decl: Pick<AddonDeclaration, 'execution'>): AddonPlacement {
  return resolveAddonExecution(decl).placement
}

/**
 * True when a `@camstack/system` builtin opted out of the in-process rule and
 * must be planned as a forked runner (`execution.isolate`).
 *
 * ONE predicate, because the hub asks this question in three places that must
 * agree: the runner plan (`buildAddonGroupPlan`), the "does this boot
 * in-process" filter, and `isForkedAddonEntry` (which decides route mounts,
 * data-plane mounts, restart and uninstall). They diverged once before for
 * `auth-oidc` and the addon's routes were mounted against an async UDS proxy.
 */
export function isIsolatedBuiltin(decl: Pick<AddonDeclaration, 'execution'>): boolean {
  return decl.execution?.isolate === true
}

/**
 * One entry of a `RunnerPlan` — an addon assigned to a runner, paired
 * with the on-disk directory the runner subprocess loads it from.
 */
export interface RunnerAddonPlacement {
  readonly addonId: string
  readonly addonDir: string
}

/**
 * The hub's runner topology: `runnerId → addons[]`.
 *
 * One key per forked runner subprocess. A runner id is either an addon
 * id (the addon runs on its own dedicated runner) or a co-location
 * group name (every addon under that key shares one runner). Computed
 * by `AddonRegistryService.buildAddonGroupPlan` and fed to
 * `initializeAddonGroup`. `@camstack/system` builtins are absent — they
 * stay in-process on the hub.
 */
export type RunnerPlan = ReadonlyMap<string, readonly RunnerAddonPlacement[]>

// ── Kernel-internal context ─────────────────────────────────────────────
/**
 * Extended AddonContext used exclusively by the kernel (hub + worker boot
 * sequences) to wire providers into the CapabilityRegistry after
 * `initialize()` returns. Addon code never sees this — it only receives
 * the public `AddonContext`.
 */
export interface InternalAddonContext extends AddonContext {
  /** Register a provider in the local capability registry. Kernel-only. */
  registerProvider(capabilityName: string, provider: unknown): void

  /** Resolve the preferred provider for a capability. Kernel-only. */
  resolveProvider<T = unknown>(capabilityName: string): T | null
}

/**
 * A three-way read of an addon's own store (D651). `missing` and `failed` are
 * distinct on purpose: folding them is how a failed read becomes "defaults".
 */
export type AddonStoreRead =
  | { readonly kind: 'value'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly error: string }

/** One stored key of an addon's own store, read three-way (D651). */
export type StoredKeyRead =
  /** The key was written; `value` is what is stored. */
  | { readonly kind: 'present'; readonly value: unknown }
  /** The store answered and the key was never written. */
  | { readonly kind: 'absent' }
  /** The store did not answer, or this node's settings view cannot say. */
  | {
      readonly kind: 'unreadable'
      readonly reason: 'store-read-failed' | 'three-way-read-unavailable'
      readonly error?: string
    }
