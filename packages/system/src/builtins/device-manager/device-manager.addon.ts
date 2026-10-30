/**
 * Device Manager addon — hub-side singleton that unifies device persistence,
 * live registry queries, and all management operations into a single
 * tRPC-routable capability.
 *
 * Persistence strategy: all device data is stored via `ctx.settings`, the same
 * settings API every other addon uses. No raw SQLite access.
 *
 *   Addon store layout:
 *     deviceIndex  → Record<addonId, stableId[]>          (which devices exist per addon)
 *     deviceMeta   → Record<numericId, DeviceMeta>        (keyed by numeric device id;
 *                                                          addonId + stableId are FIELDS on the record)
 *
 *   Device store (per-device config):
 *     readDeviceStore(numericDeviceId)  → config blob
 *     writeDeviceStore(numericDeviceId, patch)
 *
 * Live registry: resolved from the kernel capability registry after Phase 2.
 * This gives direct access to in-memory IDevice instances registered by provider addons.
 * The DeviceManagerAddon is the single owner of the live device operations API.
 *
 * Replaces:
 *   - `device-persistence` capability (absorbed here)
 *   - live operations previously served by `device-management.router.ts`
 */

import type {
  DeviceBindingEntry,
  ICapabilityRegistry,
  IDeviceAdoptionProvider,
  IDeviceOpsProvider,
  InferProvider,
} from '@camstack/types'
import {
  BaseAddon,
  deviceManagerCapability,
  deviceProviderCapability,
  deviceExtensionCapability,
  deviceStateCapability,
  errMsg,
  ProviderRegistration,
  SECRET_CLEAR,
} from '@camstack/types'
import { purgeRetiredSettingsRows } from '../sqlite-storage/retired-settings-keys.js'
import { AdoptionJobEngine } from './adoption-job-engine.js'
import { installClaimedStatusOverlay } from './claimed-status-overlay.js'
import {
  type AggregationDeps,
  type DeviceFormSecretsDeps,
  dispatchDeviceAction,
  getDeviceAggregate,
  getDeviceStatusAggregate,
  getDeviceStatusAggregateBatch,
  getWireableFields,
  listBindableCapsForDeviceType,
  listWrappersForCap,
  updateDeviceField,
  updateDeviceFieldsBatch,
} from './device-aggregation.js'
import { mergeAggregates } from './device-aggregation-merge.js'
import { type DiscoveryOrchestratorDeps, discoverProviders } from './discovery-orchestrator.js'
import {
  readWrapperActivation,
  setWrapperActive,
  type WrapperActivationDeps,
} from './device-source-activation.js'
import {
  type BindingsDeps,
  getAllBindings,
  getBindings,
  getBindingsBatch,
  type ListDeviceIdsByCapsInput,
  listDeviceIdsByCaps,
  readBindingsStore,
  wireRemoteNativeCapSync,
} from './device-bindings-store.js'
import { StaleWrapperActivations } from './stale-wrapper-activations.js'
import { DeviceEventPropagator } from './device-event-propagator.js'
import { createDeviceManagerExtensionProvider } from './device-extension-linked-slot.js'
import { getLinkedDevices, getLinkedDevicesBatch } from './device-linked-devices.js'
import * as metaActions from './device-meta-actions.js'
import { runLocationBackfillAtBoot } from './location-alignment.js'
import { runLinkedDevicesManualBackfillAtBoot } from './linked-devices-manual-backfill.js'
import { DeviceMetaStore } from './device-meta-store.js'
import type { ContributionShape } from './device-meta-types.js'
import type { ProviderContext, ProviderHost } from './device-provider-context.js'
import * as queries from './device-queries.js'
import { cleanupDeletedDevicesData, settingsScopes } from './device-removal-hooks.js'
import { DeviceTombstoneStore } from './device-tombstone-store.js'
import { deviceManagerRecordKinds } from './record-kinds.js'
import { DeviceRowStore, deviceRowBackendOf } from './device-row-store.js'
import { createDeviceStateClaimMethods } from './device-state-claims.js'
import { DeviceStateMirror } from './device-state-mirror.js'
import { FieldClaimsIndex } from './field-claims-index.js'
import * as syncResolvers from './device-sync-resolvers.js'
import { createMigrationGuard } from './migrate-guard.js'
import { createRemovalCleanup, type RemovalCleanup } from './removal-cleanup.js'
import { createRemovalFence, type RemovalFence } from './removal-fence.js'
import { createSecretConfigPathRegistry } from './secret-config-paths.js'
import { createWriteLock, type WriteLock } from './write-lock.js'

type IDeviceManagerProvider = InferProvider<typeof deviceManagerCapability>
type IDeviceProviderCap = InferProvider<typeof deviceProviderCapability>

// Re-export the pure aggregator-merge helper so existing importers
// (`import { mergeAggregates } from '…/device-manager.addon.js'`, e.g. the
// device-aggregate spec) keep resolving it from this module after the
// implementation moved to `device-aggregation-merge.ts`.
export { mergeAggregates }

export class DeviceManagerAddon extends BaseAddon {
  constructor() {
    super({})
  }

  /** Shorthand for the kernel-injected capability registry. */
  private get capabilityRegistry(): ICapabilityRegistry | undefined {
    return this.ctx.kernel.capabilityRegistry
  }

  /**
   * Parent-chain event propagator. Started in `onInitialize` once the
   * hub's `deviceRegistry` is available; listens to every device-sourced
   * event and re-emits a copy on each ancestor scope with `via[]`
   * populated. Stopped in `onShutdown`.
   */
  private propagator: DeviceEventPropagator | null = null
  /**
   * Hub-side mirror of every device's cap-keyed runtime state.
   * Populated whenever any caller writes via `deviceState.setCapSlice`
   * (the canonical cross-layer write entrypoint) and on first load
   * via `loadRuntimeState`. Cross-process consumers reach the mirror
   * through the `deviceState` cap router; per-cap event subscribers
   * (e.g. `battery.onStatusChanged`) get the same data via
   * cap-specific events still emitted by the owning device.
   *
   * Key: deviceId. Value: per-cap slice map. Empty by default.
   *
   * The mirror + its debounced disk-writer + the cross-device link overlay
   * live in `DeviceStateMirror`. Constructed once in `onInitialize` (needs
   * `ctx`); `null` before initialise / when `ctx.settings` is absent.
   */
  private stateMirrorImpl: DeviceStateMirror | null = null

  /**
   * Removes the claimed-status overlay this addon installed on the capability
   * registry (D663, S3): `getStatus` of a claimed cap answers the mirror for
   * every caller while it is installed. Run in `onShutdown`; `null` before
   * init or when the kernel handed the addon no registry.
   */
  private uninstallStatusOverlay: (() => void) | null = null

  /**
   * Cross-process native-provider cache: deviceId (numeric) → capName → { addonId, nodeId }.
   * Kept in sync with `DeviceBindingsChanged` push events emitted by forked
   * workers on `ctx.registerNativeCap` / device removal. Union'd into
   * `getBindings` so hub-side consumers see every native cap regardless of
   * which process owns the IDevice.
   *
   * No persistence — entries re-populate when the worker re-handshakes or
   * re-emits its native-cap registrations after restart. Entries that were
   * lost in the Moleculer transport handshake window are recovered lazily:
   * `resolveNativeCapOwnerSync` and `getBindings` fall through to
   * `ctx.kernel.listClusterNativeCaps()` (the handshake-fed
   * `HubNodeRegistry`) when the push-based cache misses.
   *
   * The previous pull-based recovery (`syncWorkerNativeCaps`, driven by
   * `$node.connected` + `addon.restarted`) has been removed in Task 13 —
   * the D3 re-handshake after device restore is the reliable replacement.
   */
  private remoteNativeCaps: Map<number, Map<string, { addonId: string; nodeId: string }>> =
    new Map()

  /** Background adoption jobs — lazily constructed (needs `ctx.logger`). */
  private adoptionJobEngine: AdoptionJobEngine | null = null
  /**
   * ONE removal fence for this process, shared by the provider context and the
   * adoption-job engine.
   *
   * It used to be constructed inline into the context, so the job engine had
   * no way to reach it and an operator re-adopting hardware they had just
   * deleted was refused for the whole 5-minute TTL — their own action, denied.
   * Two fences would be worse than one: the engine would suspend a fence that
   * `allocateDeviceId` never consults.
   */
  private readonly removalFence: RemovalFence = createRemovalFence()
  /** Store-by-store clean-up of a removed device, with a bounded retry (D864). */
  private removalCleanupImpl: RemovalCleanup | null = null
  private removalHooksCleanupImpl: RemovalCleanup | null = null
  /** Declared secret config paths per device, as last registered (D783). */
  private readonly secretConfigPaths = createSecretConfigPathRegistry()
  /** The keychain side of driver device forms (D789), wired in onInitialize. */
  private deviceFormSecrets: DeviceFormSecretsDeps | undefined

  /** The runtime-state mirror, asserted present (constructed in onInitialize). */
  private get stateMirror(): DeviceStateMirror {
    if (!this.stateMirrorImpl) {
      throw new Error('DeviceManagerAddon: state mirror accessed before onInitialize')
    }
    return this.stateMirrorImpl
  }

  /**
   * The per-field claims index (D663): which devices carry a claim, for the
   * seed and for `listClaims`. Constructed at init and loaded before the first
   * provider method can run; a load that fails leaves it `not-loaded`, and
   * every seed reads its row until a later call loads it.
   */
  private fieldClaimsImpl: FieldClaimsIndex | null = null

  /** The claims index, asserted present (constructed in onInitialize). */
  private get fieldClaims(): FieldClaimsIndex {
    if (!this.fieldClaimsImpl) {
      throw new Error('DeviceManagerAddon: claims index accessed before onInitialize')
    }
    return this.fieldClaimsImpl
  }

  /** Build the `ProviderHost` the extracted provider-method modules
   *  (`device-meta-actions`, `device-queries`) reach — exposes the addon's
   *  private state/methods they need without leaking the class internals.
   *
   *  `remoteNativeCaps` is mutated in place (never reassigned) so a direct
   *  reference preserves the live semantics. */
  private get providerHost(): ProviderHost {
    const capabilityRegistry = (): ICapabilityRegistry | undefined => this.capabilityRegistry
    const fieldClaims = (): FieldClaimsIndex => this.fieldClaims
    return {
      ctx: this.ctx,
      get capabilityRegistry(): ICapabilityRegistry | undefined {
        return capabilityRegistry()
      },
      remoteNativeCaps: this.remoteNativeCaps,
      seedMirror: (deviceId, blob, mode) => this.stateMirror.seedMirror(deviceId, blob, mode),
      withResetSessionProbe: (blob) => this.stateMirror.withResetSessionProbe(blob),
      get fieldClaims(): FieldClaimsIndex {
        return fieldClaims()
      },
      holdMirrorWrites: (deviceIds, settings) =>
        this.stateMirror.holdDiskWrites(deviceIds, settings),
      mirrorOwnedCaps: (deviceId) => this.stateMirror.ownedCaps(deviceId),
      forgetMirrorDevice: (deviceId) => this.stateMirror.forgetDevice(deviceId),
      resolveDeviceOnline: (deviceId, fallbackOnline) =>
        this.stateMirror.resolveDeviceOnline(deviceId, fallbackOnline),
      resolveDeviceProbed: (deviceId) => this.stateMirror.resolveDeviceProbed(deviceId),
      waitDeviceProvider: (addonId, timeoutMs) => this.waitDeviceProvider(addonId, timeoutMs),
      requireDeviceProvider: (addonId) => this.requireDeviceProvider(addonId),
      requireDeviceAdoptionProvider: (addonId) => this.requireDeviceAdoptionProvider(addonId),
      adoptionJobs: this.adoptionJobsImpl,
    }
  }

  /**
   * Background adoption jobs. In-RAM and process-lifetime: a restart forgets
   * them, which is safe because adoption is keyed by a stable id — re-running a
   * job re-adopts nothing (see `AdoptionJobEngine`).
   */
  private get adoptionJobsImpl(): AdoptionJobEngine {
    if (!this.adoptionJobEngine) {
      this.adoptionJobEngine = new AdoptionJobEngine({
        resolveProvider: async (addonId) => this.requireDeviceAdoptionProvider(addonId),
        logger: this.ctx.logger,
        // The SAME fence `allocateDeviceId` consults — a job is the operator's
        // own action and must not be refused by it.
        removalFence: this.removalFence,
      })
    }
    return this.adoptionJobEngine
  }

  /** Wait for a device-provider by addonId, returning null on timeout. */
  private async waitDeviceProvider(
    addonId: string,
    timeoutMs = 5_000,
  ): Promise<IDeviceProviderCap | null> {
    const provider = await this.capabilityRegistry?.waitForProvider(
      'device-provider',
      addonId,
      timeoutMs,
    )
    return provider ? (provider as IDeviceProviderCap) : null
  }

  /** Require a device-provider by addonId — throws if not found. */
  private async requireDeviceProvider(addonId: string): Promise<IDeviceProviderCap> {
    const dp = await this.waitDeviceProvider(addonId)
    if (!dp) {
      throw new Error(`Device provider "${addonId}" not found or not registered`)
    }
    return dp
  }

  /** Require a device-adoption provider by addonId — throws if not found. */
  private async requireDeviceAdoptionProvider(addonId: string): Promise<IDeviceAdoptionProvider> {
    const provider = await this.capabilityRegistry?.waitForProvider(
      'device-adoption',
      addonId,
      5_000,
    )
    if (!provider) {
      throw new Error(`Device-adoption provider "${addonId}" not found or not registered`)
    }
    return provider
  }

  // ── Aggregated network discovery coordinator ───────────────────────────────
  // Thin fan-out over the EXISTING `device-provider.discoverDevices` surface
  // (same one ONVIF + the wizard's per-provider DeviceDiscoveryStep use). No new
  // cap — the coordinator just enumerates discovery-capable providers and merges.

  /** Addon ids that currently register a `device-provider`. */
  private listDeviceProviderIds(): readonly string[] {
    const entry = this.capabilityRegistry
      ?.listCapabilities()
      .find((c) => c.name === 'device-provider')
    return entry?.providers ?? []
  }

  /** "provider-gree" → "Gree" — a human label for the discovery modal. */
  private discoveryProviderLabel(addonId: string): string {
    const base = addonId.replace(/^addon-(provider-)?/, '').replace(/^provider-/, '')
    return base.length > 0 ? base.charAt(0).toUpperCase() + base.slice(1) : addonId
  }

  /** What {@link discoverProviders} needs: provider lookup, the engine, a logger. */
  private discoveryDeps(): DiscoveryOrchestratorDeps {
    return {
      requireProvider: (addonId) => this.requireDeviceProvider(addonId),
      scanNetwork: async (input) => {
        const localNetwork = this.ctx.api?.localNetwork
        if (!localNetwork) throw new Error('local-network is not available on this hub')
        return localNetwork.scanNetwork.mutate({
          requests: [...input.requests],
          ...(input.subnets !== undefined ? { subnets: [...input.subnets] } : {}),
        })
      },
      logger: this.ctx.logger,
    }
  }

  /** Provider ids that report `supportsDiscovery() === true` (probed in parallel). */
  private async listDiscoveryCapableProviderIds(): Promise<readonly string[]> {
    const ids = this.listDeviceProviderIds()
    const flags = await Promise.all(
      ids.map(async (addonId) => {
        try {
          const provider = await this.requireDeviceProvider(addonId)
          return (await provider.supportsDiscovery({})) ? addonId : null
        } catch {
          return null
        }
      }),
    )
    return flags.filter((id): id is string => id !== null)
  }

  // ── Binding store (persisted wrapper activation) ───────────────────────────
  //
  // The implementation lives in `device-bindings-store.ts` as free functions
  // that take a `BindingsDeps` context (DI). The methods below are thin
  // delegators that assemble that context from this addon's state so the
  // device-manager capability router (and internal callers) keep an unchanged
  // call surface. `getBindings` / `getAllBindings` / `setWrapperActive` /
  // `listWrappersForCap` / `listBindableCapsForDeviceType` stay public so the
  // cap router can expose them as cap methods.

  /**
   * Row access for `device-manager:devices`. Built once in `onInitialize`
   * (which is also where the collection is declared) — every consumer reaches
   * it through {@link bindingsDeps} or the `ProviderContext`.
   */
  private deviceRows: DeviceRowStore | null = null

  /**
   * The ONE lock ordering every read-modify-write of this addon's
   * `addon-settings` key range (`deviceBindings`, `locations`, `nextDeviceId`,
   * `roleDisplayDefaults`).
   *
   * It lives on the addon rather than on `DeviceMetaStore` because the writers
   * do not all go through that class — `setWrapperActive` and `removeDevice`'s
   * bindings purge reach the store through `BindingsDeps` — and two locks over
   * one key range is the same defect one level up. Handed to both.
   */
  private readonly addonStoreWriteLock: WriteLock = createWriteLock()

  /** Stored activations of RETIRED wrappers, said once per process (task 17 review M1). */
  private staleWrapperActivationsImpl: StaleWrapperActivations | null = null

  private get staleWrapperActivations(): StaleWrapperActivations {
    this.staleWrapperActivationsImpl ??= new StaleWrapperActivations(this.ctx.logger)
    return this.staleWrapperActivationsImpl
  }

  /** Build the dependency context the extracted binding resolvers consume. */
  private get bindingsDeps(): BindingsDeps {
    const rows = this.deviceRows
    if (rows === null) {
      // Reached only if a cap method runs before `onInitialize` finished. That
      // is a wiring fault, not a transient one, and answering with an empty
      // fleet would report every device as gone — which `getBindings` turns
      // into "unbind everything" (D49).
      throw new Error('[device-manager] device row store not initialized')
    }
    return {
      ctx: this.ctx,
      capabilityRegistry: this.capabilityRegistry,
      remoteNativeCaps: this.remoteNativeCaps,
      rows,
      withAddonStoreWriteLock: this.addonStoreWriteLock,
      staleWrapperActivations: this.staleWrapperActivations,
    }
  }

  async getBindings(input: {
    deviceId: number
  }): Promise<{ deviceId: number; entries: DeviceBindingEntry[] }> {
    return getBindings(this.bindingsDeps, input)
  }

  async getBindingsBatch(input: {
    deviceIds: readonly number[]
  }): Promise<Array<{ deviceId: number; entries: DeviceBindingEntry[] }>> {
    return getBindingsBatch(this.bindingsDeps, input)
  }

  async getAllBindings(): Promise<Array<{ deviceId: number; entries: DeviceBindingEntry[] }>> {
    return getAllBindings(this.bindingsDeps)
  }

  async listDeviceIdsByCaps(input: ListDeviceIdsByCapsInput): Promise<number[]> {
    return listDeviceIdsByCaps(this.bindingsDeps, input)
  }

  // ── Device-details aggregator + field-update routing ───────────────────────
  //
  // Walks the bindings for `deviceId` (native + wrapped), picks every
  // provider whose cap declares `exposesDeviceSettings: true`, and asks
  // each for its per-device contribution. Contributions are concatenated
  // into a single `ConfigUISchemaWithValues`; editable fields are tagged
  // with `writerCapName` + `writerAddonId` so `updateDeviceField` can
  // route the mutation back to the exact provider that produced them.
  //
  // `kind` selects settings vs live-info. The two aggregators share the
  // enumeration + tagging pipeline; only the method invoked on each
  // contributing provider differs.
  // ── Device-details aggregator + field-update routing ───────────────────────
  //
  // The implementations live in `device-aggregation.ts` as free functions
  // taking an `AggregationDeps` context (DI). The methods below are thin
  // delegators that assemble that context from this addon's state, so every
  // cap-router and internal call site keeps an unchanged surface. Sibling
  // aggregator helpers (collectSystemDeviceContributions, buildBaseDeviceSection,
  // resolveNativeDeviceOwner, resolveDriverConfigSchema, deriveDeviceConfig-
  // Contribution, resolveContributionProvider, applyGroupPatch) are
  // module-internal and have no delegator — they are only reached through the
  // exported entrypoints below.

  /** Build the dependency context the extracted aggregation functions consume. */
  private get aggregationDeps(): AggregationDeps {
    return {
      ctx: this.ctx,
      capabilityRegistry: this.capabilityRegistry,
      remoteNativeCaps: this.remoteNativeCaps,
      bindingsDeps: this.bindingsDeps,
      ...(this.deviceFormSecrets ? { deviceFormSecrets: this.deviceFormSecrets } : {}),
    }
  }

  async getDeviceAggregate(
    deviceId: number,
    kind: 'settings' | 'live',
  ): Promise<ContributionShape | null> {
    return getDeviceAggregate(this.aggregationDeps, deviceId, kind)
  }

  private async getDeviceStatusAggregate(input: {
    readonly deviceId: number
    readonly caps?: readonly string[]
  }): Promise<Record<string, unknown | null>> {
    return getDeviceStatusAggregate(this.aggregationDeps, input)
  }

  async updateDeviceField(input: {
    deviceId: number
    writerCapName: string
    writerAddonId: string
    key: string
    value: unknown
  }): Promise<{ success: true }> {
    return updateDeviceField(this.aggregationDeps, input)
  }

  async updateDeviceFieldsBatch(input: {
    deviceId: number
    changes: ReadonlyArray<{
      writerCapName: string
      writerAddonId: string
      key: string
      value: unknown
    }>
  }): Promise<{
    success: true
    failures: { writerCapName: string; writerAddonId: string; error: string }[]
  }> {
    return updateDeviceFieldsBatch(this.aggregationDeps, input)
  }

  private async dispatchDeviceAction(
    deviceId: number,
    action: string,
    input: unknown,
  ): Promise<unknown> {
    return dispatchDeviceAction(this.aggregationDeps, deviceId, action, input)
  }

  async listWrappersForCap(input: { capName: string }): Promise<string[]> {
    return listWrappersForCap(this.aggregationDeps, input)
  }

  async listBindableCapsForDeviceType(input: {
    deviceType: string
  }): Promise<Array<{ capName: string; wrappers: string[] }>> {
    return listBindableCapsForDeviceType(this.aggregationDeps, input)
  }

  async setWrapperActive(input: {
    deviceId: number
    capName: string
    wrapperAddonId: string
    active: boolean
  }): Promise<void> {
    return setWrapperActive(this.wrapperActivationDeps, input)
  }

  /** The narrow dependency bag the activation verb needs (D556). */
  private get wrapperActivationDeps(): WrapperActivationDeps {
    return {
      ctx: this.ctx,
      capabilityRegistry: this.capabilityRegistry,
      withAddonStoreWriteLock: this.addonStoreWriteLock,
    }
  }

  protected async onInitialize(): Promise<ProviderRegistration[] | void> {
    const settings = this.ctx.settings
    if (!settings) {
      this.ctx.logger.warn('ctx.settings not available — device persistence unavailable')
      return
    }

    const registry = this.ctx.kernel.deviceRegistry ?? null

    if (!registry) {
      this.ctx.logger.warn(
        'device-registry not available — live operations will use persisted data only',
      )
    }

    // Cross-process device-ops dispatch. Forked-worker addons (e.g.
    // provider-rtsp) register devices whose live IDevice instance lives in
    // the worker's own DeviceRegistry — invisible to this hub-side
    // `registry`. Instead of a bespoke Moleculer bridge, every worker
    // auto-registers a `device-ops` NATIVE capability provider per device
    // (see createBrokerDeviceManagerApi.register). Hub consumers reach it
    // via `capabilityRegistry.getNativeProvider('device-ops', deviceId)`:
    // the CapabilityRegistry's native-fallback builds a typed proxy that
    // routes the call to the owning worker through the standard native-cap
    // bridge — same plumbing every other per-device cap (snapshot, events,
    // ptz, …) already uses.

    // Cross-process native-cap discovery (push path) + node-disconnect cleanup.
    // Mirrors forked-worker `DeviceBindingsChanged` events into `remoteNativeCaps`
    // so `getBindings` returns the full cluster view. See device-bindings-store.ts.
    wireRemoteNativeCapSync(this.ctx, this.remoteNativeCaps)

    // Resolve the per-device `device-ops` native provider. Works hub-local
    // (direct CapabilityRegistry lookup) and cross-process (the native-cap
    // fallback builds a proxy that routes to the owning worker). Consumers
    // that previously spoke the `<addonId>.device-ops.device.<method>`
    // Moleculer action go through this path instead — no bridge, no
    // parallel transport, just the standard native-cap dispatch.
    const requireDeviceOps = (deviceId: number): IDeviceOpsProvider => {
      const ops = this.capabilityRegistry?.getNativeProvider<IDeviceOpsProvider>(
        'device-ops',
        deviceId,
      )
      if (!ops) {
        throw new Error(`[device-manager] device-ops native provider not found for '${deviceId}'`)
      }
      return ops
    }

    // ── Meta persistence layer ─────────────────────────────────────────────────
    //
    // The read/modify/write helpers (settings reads, the single-writer mutex,
    // id allocation, ownership/child/link-source resolution, link reverse-index
    // rebuild) live in `DeviceMetaStore`. Local `const` aliases below preserve
    // the prior closure call surface used throughout the provider literal so no
    // method body changes — only the helpers' home moved.
    // The device ledger. `settings-store` is a hub singleton served by the
    // `sqlite-settings` builtin, which boots before this one — the same door
    // `core-blocks` awaits in its own `onInitialize`. Refusing here rather
    // than degrading: a device-manager that cannot persist would report an
    // empty fleet, and an empty fleet unbinds every camera (D49).
    const settingsStoreApi = this.ctx.api?.settingsStore
    if (!settingsStoreApi) {
      throw new Error(
        '[device-manager] settings-store API not available — refusing to serve a fleet it cannot persist',
      )
    }
    const deviceRows = new DeviceRowStore(
      deviceRowBackendOf(settingsStoreApi),
      this.ctx.logger.child('rows'),
    )
    await deviceRows.declare()
    this.deviceRows = deviceRows
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('[device-manager] ctx.records is required on the hub')
    }
    await records.declare(deviceManagerRecordKinds)
    const tombstones = DeviceTombstoneStore.of(records, this.ctx.logger.child('tombstones'))

    // Once per process, read-only: name every stored activation of a RETIRED
    // wrapper, even on a device nobody asks about (task 17 review M1). Not
    // awaited — a slow settings door must not hold the boot; a failed read is
    // said and the first answered bindings pass checks instead.
    void this.staleWrapperActivations.checkOnce(() => readBindingsStore(this.bindingsDeps))

    // No per-device SOURCE deactivations to replay any more: a collection
    // capability's providers are a DERIVED set (`device-bindings-store.ts`
    // step 0), persisted nowhere, so a hub restart cannot lose an operator
    // decision that no longer exists. The replay this replaced was the read
    // side of a store `getBindings` did not consult (D556 closed fourth).

    // Retire the three fleet blobs this collection replaced — but ONLY once it
    // holds rows. The migration that fills it (`scripts/migrate-device-manager-
    // blobs.mjs`) is an offline step an operator runs, so a hub that boots this
    // build before being migrated must find its blobs INTACT: the purge says so
    // and skips, and the next boot after the migration cleans up.
    try {
      await purgeRetiredSettingsRows(
        deviceRows.retiredRowStore(),
        this.ctx.logger.child('RetiredRows'),
      )
    } catch (err) {
      // Housekeeping never blocks the fleet coming up.
      this.ctx.logger.warn('retired-row purge failed', { meta: { error: errMsg(err) } })
    }

    const metaStore = new DeviceMetaStore(settings, registry, deviceRows, this.addonStoreWriteLock)
    // Runtime-state mirror + debounced disk writer.
    this.stateMirrorImpl = new DeviceStateMirror(this.ctx)
    const stateMirror = this.stateMirrorImpl
    // The claims index, BEFORE any provider method can seed a device (S6): a
    // loaded index lets an unclaimed device's status read and native write
    // skip the row read. It never lets a ROW WRITE skip it — the writer reads
    // first (D677). A failed load is logged by the index and answered
    // `not-loaded`, never [].
    this.fieldClaimsImpl = new FieldClaimsIndex({
      logger: this.ctx.logger.child('claims-index'),
      withAddonStoreWriteLock: this.addonStoreWriteLock,
    })
    const fieldClaims = this.fieldClaimsImpl
    await fieldClaims.load(settings)
    // The D13 overlay (S3): from here on, `getStatus` of a CLAIMED cap resolved
    // through the registry — tRPC, the status aggregate, a wrapper's native
    // call, a forked child's cross-addon call — answers the mirror's merge, and
    // a device whose claims are not yet known has them resolved (index, then
    // row) before anything is answered (D315). Installed AFTER the index exists:
    // the overlay reads its live view.
    const registryForOverlay = this.capabilityRegistry
    this.uninstallStatusOverlay =
      registryForOverlay !== undefined
        ? installClaimedStatusOverlay(registryForOverlay, {
            mirror: stateMirror,
            claimsIndex: () => fieldClaims.view(),
            settings: () => settings,
            logger: this.ctx.logger.child('claimed-status'),
          })
        : null
    const resolvePersistedById = metaStore.resolvePersistedById
    const idToAddonId = metaStore.idToAddonId

    // ── Provider implementation ───────────────────────────────────────────────

    // Warm the synchronous ownership cache from persistence on boot.
    // `idToAddonId` is kept in sync with every registerDevice/removeDevice the
    // provider serves; the persisted meta store is authoritative but reads are
    // async, and hub-side callers (e.g. `CapabilityRegistry.getNativeProvider`
    // fallback) need ownership without awaiting.
    // `bootRows` is reused below by the location backfill's detection pass so
    // a clean boot pays exactly this one fleet listing, same as before.
    const bootRows = await deviceRows.listAll()
    for (const row of bootRows) idToAddonId.set(row.meta.id, row.meta.addonId)

    // D3 note: The previous pull-based recovery triggers (`$node.connected` →
    // `syncWorkerNativeCaps` and `AddonRestarted` → `syncWorkerNativeCaps`)
    // have been removed in Task 13. Native caps lost in the Moleculer
    // transport handshake window are recovered lazily: when
    // `resolveNativeCapOwnerSync` / `getBindings` step 4 miss in
    // `remoteNativeCaps`, they fall through to `ctx.kernel.listClusterNativeCaps()`
    // which reads the handshake-fed `HubNodeRegistry` (populated by the D3
    // re-handshake that fires after each worker's device restore completes).

    // Shared integration-id stamp (implementation in device-meta-actions.ts),
    // used by the `setIntegrationId` cap handler AND the create/adopt forwarders.
    const stampIntegrationId = (deviceId: number, integrationId: string): Promise<void> =>
      metaActions.stampIntegrationId(metaStore, this.ctx, deviceId, integrationId)

    // Dependency context the extracted provider-method modules
    // (`device-meta-actions`, `device-queries`) consume. Bundles the meta store,
    // settings surface, hub registry, bindings deps, and the two shared closures
    // (`requireDeviceOps`, `stampIntegrationId`) with the addon's `providerHost`.
    // `provider` is a lazy getter over the `provider` const declared just below
    // so the query methods that self-call sibling cap methods resolve the live
    // implementation (the getter runs only when a cap method is invoked, well
    // after `provider` is assigned — no TDZ hit).
    const pctx: ProviderContext = {
      host: this.providerHost,
      metaStore,
      settings,
      registry,
      bindingsDeps: this.bindingsDeps,
      migrationGuard: createMigrationGuard(),
      removalFence: this.removalFence,
      removalCleanup: this.removalCleanup,
      tombstones,
      removalHooks: {
        api: this.ctx.api,
        logger: this.ctx.logger,
        cleanup: this.removalHooksCleanup,
      },
      secretConfigPaths: this.secretConfigPaths,
      requireDeviceOps,
      stampIntegrationId,
      get provider(): IDeviceManagerProvider {
        return provider
      },
    }

    // A driver's device form shows the stored MARKER's view and clears at the
    // door (D789): the stored blob is read raw — never through loadConfig — and
    // a clear is the operator's write of `{ $secretClear: true }`.
    this.deviceFormSecrets = {
      readStored: (deviceId) => settings.readDeviceStore(deviceId),
      declaredPaths: (deviceId) => this.secretConfigPaths.get(deviceId) ?? [],
      clear: (deviceId, keys) =>
        metaActions.persistConfig(pctx, {
          deviceId,
          data: Object.fromEntries(keys.map((key) => [key, SECRET_CLEAR])),
          secretConfigPaths: [
            ...new Set([...(this.secretConfigPaths.get(deviceId) ?? []), ...keys]),
          ],
        }),
    }

    // Location alignment (D352): the ONE-SHOT backfill that repairs containers
    // whose location predates `setLocation`'s cascade (their descendants sit at
    // `location: null`, invisible to the picker's same-location suggestions), plus the every-boot detection
    // that WARNS about any residual misalignment. Housekeeping never blocks the
    // fleet coming up — same posture as the retired-row purge above.
    try {
      await runLocationBackfillAtBoot(pctx, bootRows)
    } catch (err) {
      this.ctx.logger.warn('location backfill failed — fleet boots without it', {
        meta: { error: errMsg(err) },
      })
    }
    try {
      await runLinkedDevicesManualBackfillAtBoot(pctx)
    } catch (err) {
      this.ctx.logger.warn(
        'linked-devices manual backfill failed — auto links are NOT materialised',
        {
          meta: { error: errMsg(err) },
        },
      )
    }

    const provider: IDeviceManagerProvider & {
      resolveDeviceOwnerSync: (deviceId: number) => string | null
      resolveNativeCapOwnerSync: (
        capName: string,
        deviceId: number,
      ) => { addonId: string; nodeId: string } | null
    } = {
      // ── Sync ownership + native-cap resolvers ───────────────────────────────
      // Thin delegators over device-sync-resolvers.ts (see there for the full
      // resolution-order docs). These back CapabilityRegistry's native fallback.
      resolveDeviceOwnerSync: (deviceId: number): string | null =>
        syncResolvers.resolveDeviceOwnerSync(pctx, deviceId),
      resolveNativeCapOwnerSync: (
        capName: string,
        deviceId: number,
      ): { addonId: string; nodeId: string } | null =>
        syncResolvers.resolveNativeCapOwnerSync(pctx, capName, deviceId),

      // ── Persistence + meta actions (see device-meta-actions.ts) ─────────────
      // Thin delegators over the extracted meta-action functions; `pctx` carries
      // the meta store + settings + host state they read/write.
      allocateDeviceId: (input) => metaActions.allocateDeviceId(pctx, input),
      migrateDevice: (input) => metaActions.migrateDevice(pctx, input),
      registerDevice: (input) => metaActions.registerDevice(pctx, input),
      removeDevice: (input) => metaActions.removeDevice(pctx, input),
      listDeletedSince: ({ sinceMs }) => tombstones.listSince(sinceMs),
      cleanupDeletedDevicesData: (input) =>
        cleanupDeletedDevicesData(
          {
            api: this.ctx.api,
            logger: this.ctx.logger,
            settings: settingsScopes(this.ctx.api?.settingsStore),
            reads: {
              readFleet: async () => {
                const rows = await deviceRows.listAll()
                return { ids: rows.map((r) => r.meta.id), rowCount: await deviceRows.count() }
              },
            },
          },
          input,
        ),
      persistConfig: (input) => metaActions.persistConfig(pctx, input),
      loadConfig: (input) => metaActions.loadConfig(pctx, input),
      loadMeta: (input) => metaActions.loadMeta(pctx, input),
      setName: (input) => metaActions.setName(pctx, input),
      setLocation: (input) => metaActions.setLocation(pctx, input),
      setType: (input) => metaActions.setType(pctx, input),
      setIntegrationId: (input) => metaActions.setIntegrationId(pctx, input),
      setLinkDeviceId: (input) => metaActions.setLinkDeviceId(pctx, input),
      setPrimaryChildEntityId: (input) => metaActions.setPrimaryChildEntityId(pctx, input),
      setChildLayout: (input) => metaActions.setChildLayout(pctx, input),
      setRole: (input) => metaActions.setRole(pctx, input),
      setDisplay: (input) => metaActions.setDisplay(pctx, input),
      getRoleDisplayDefaults: (input) => metaActions.getRoleDisplayDefaults(pctx, input),
      setRoleDisplayDefaults: (input) => metaActions.setRoleDisplayDefaults(pctx, input),
      applyInitialMeta: (input) => metaActions.applyInitialMeta(pctx, input),
      setMetadata: (input) => metaActions.setMetadata(pctx, input),
      setDisabled: (input) => metaActions.setDisabled(pctx, input),
      loadRuntimeState: (input) => metaActions.loadRuntimeState(pctx, input),
      listLocations: () => metaActions.listLocations(pctx),
      addLocation: (input) => metaActions.addLocation(pctx, input),
      removeLocation: (input) => metaActions.removeLocation(pctx, input),
      renameLocation: (input) => metaActions.renameLocation(pctx, input),
      listLocationIcons: () => metaActions.listLocationIcons(pctx),
      setLocationIcon: (input) => metaActions.setLocationIcon(pctx, input),
      listLocationDescriptions: () => metaActions.listLocationDescriptions(pctx),
      setLocationDescription: (input) => metaActions.setLocationDescription(pctx, input),
      listSiteZones: () => metaActions.listSiteZones(pctx),
      setSiteZone: (input) => metaActions.setSiteZone(pctx, input),
      removeSiteZone: (input) => metaActions.removeSiteZone(pctx, input),
      renameSiteZone: (input) => metaActions.renameSiteZone(pctx, input),
      setLocationZone: (input) => metaActions.setLocationZone(pctx, input),

      // ── Queries + live runtime + provider/adoption ops (see device-queries.ts) ─
      // Thin delegators over the extracted query/live functions.
      listPersistedByAddon: (input) => queries.listPersistedByAddon(pctx, input),
      listAll: (input) => queries.listAll(pctx, input),
      getDevice: (input) => queries.getDevice(pctx, input),
      getChildren: (input) => queries.getChildren(pctx, input),
      getChildrenBatch: (input) => queries.getChildrenBatch(pctx, input),

      // ── Linked devices (see device-linked-devices.ts) ─────────────────────
      // Single read surface; configuration is the `linked-devices` extension
      // slot (device-extension-linked-slot.ts, D648/D655).
      getLinkedDevices: (input) => getLinkedDevices(pctx, input),
      getLinkedDevicesBatch: (input) => getLinkedDevicesBatch(pctx, input),
      getStreamSources: (input) => queries.getStreamSources(pctx, input),
      getConfigSchema: (input) => queries.getConfigSchema(pctx, input),
      getSettingsSchema: (input) => queries.getSettingsSchema(pctx, input),
      updateConfig: (input) => queries.updateConfig(pctx, input),
      enable: (input) => queries.enable(pctx, input),
      disable: (input) => queries.disable(pctx, input),
      remove: (input) => queries.remove(pctx, input),
      removeByIntegration: (input) => queries.removeByIntegration(pctx, input),
      getStreamProfileMap: (input) => queries.getStreamProfileMap(pctx, input),
      setStreamProfileMap: (input) => queries.setStreamProfileMap(pctx, input),
      probeStreams: (input) => queries.probeStreams(pctx, input),
      discoverDevices: (input) => queries.discoverDevices(pctx, input),
      adoptDevice: (input) => queries.adoptDevice(pctx, input),
      getCreationSchema: (input) => queries.getCreationSchema(pctx, input),
      createDevice: (input) => queries.createDevice(pctx, input),
      testCreationField: (input) => queries.testCreationField(pctx, input),
      adoptionListCandidateFilters: async (input) => {
        const provider = await this.requireDeviceAdoptionProvider(input.addonId)
        return provider.listCandidateFilters({ integrationId: input.integrationId })
      },
      adoptionListCandidates: (input) => queries.adoptionListCandidates(pctx, input),
      adoptionRefresh: (input) => queries.adoptionRefresh(pctx, input),
      adoptionAdopt: (input) => queries.adoptionAdopt(pctx, input),
      adoptionRelease: (input) => queries.adoptionRelease(pctx, input),
      adoptionStartJob: (input) => queries.adoptionStartJob(pctx, input),
      adoptionListJobs: (input) => queries.adoptionListJobs(pctx, input),
      adoptionCancelJob: (input) => queries.adoptionCancelJob(pctx, input),
      adoptionResync: (input) => queries.adoptionResync(pctx, input),

      // ── Aggregated network discovery coordinator ─────────────────────────
      discoveryProviders: async () => {
        const ids = await this.listDiscoveryCapableProviderIds()
        return {
          providers: ids.map((addonId) => ({
            addonId,
            label: this.discoveryProviderLabel(addonId),
          })),
        }
      },
      discoverAllProviders: async (input) => {
        const ids = await this.listDiscoveryCapableProviderIds()
        const outcomes = await discoverProviders(this.discoveryDeps(), {
          addonIds: ids,
          ...(input.subnets !== undefined ? { subnets: input.subnets } : {}),
        })
        return {
          groups: outcomes.map((o) => ({
            addonId: o.addonId,
            label: this.discoveryProviderLabel(o.addonId),
            candidates: o.candidates,
            error: o.error,
          })),
        }
      },
      discoverProvider: async (input) => {
        const [outcome] = await discoverProviders(this.discoveryDeps(), {
          addonIds: [input.addonId],
          ...(input.params !== undefined ? { params: input.params } : {}),
          ...(input.subnets !== undefined ? { subnets: input.subnets } : {}),
        })
        if (outcome?.error) throw new Error(outcome.error)
        return { candidates: outcome?.candidates ?? [] }
      },
      providerCreationType: async (input) => {
        const provider = await this.requireDeviceProvider(input.addonId)
        return provider.getManualCreationType({})
      },
      providerDiscoveryParamsSchema: async (input) => {
        const provider = await this.requireDeviceProvider(input.addonId)
        return provider.getDiscoveryParamsSchema({})
      },

      testField: (input) => queries.testField(pctx, input),
      getBindings: async (input) => {
        const result = await this.getBindings({ deviceId: input.deviceId })
        return { deviceId: input.deviceId, entries: result.entries }
      },
      getBindingsBatch: (input) => this.getBindingsBatch({ deviceIds: input.deviceIds }),
      getAllBindings: async () => {
        return this.getAllBindings()
      },
      listDeviceIdsByCaps: (input) => this.listDeviceIdsByCaps({ capNames: input.capNames }),
      setWrapperActive: async (input) => {
        return this.setWrapperActive({
          deviceId: input.deviceId,
          capName: input.capName,
          wrapperAddonId: input.wrapperAddonId,
          active: input.active,
        })
      },
      getWrapperActivation: (input) =>
        readWrapperActivation(this.wrapperActivationDeps, {
          deviceId: input.deviceId,
          capName: input.capName,
        }),
      listWrappersForCap: async (input) => this.listWrappersForCap(input),
      listBindableCapsForDeviceType: async (input) => this.listBindableCapsForDeviceType(input),

      // ── Device-details aggregators ──────────────────────────────────────

      getDeviceSettingsAggregate: async (input) => {
        return this.getDeviceAggregate(input.deviceId, 'settings')
      },
      getDeviceLiveInfoAggregate: async (input) => {
        return this.getDeviceAggregate(input.deviceId, 'live')
      },
      getDeviceAggregate: async (input) => {
        // Run both aggregations in parallel — the live + settings passes
        // enumerate the same provider set but call different methods, so
        // there's no overlap to serialize.
        const [settingsAggregate, live] = await Promise.all([
          this.getDeviceAggregate(input.deviceId, 'settings'),
          this.getDeviceAggregate(input.deviceId, 'live'),
        ])
        return { settings: settingsAggregate, live }
      },
      runDeviceAction: async (input: { deviceId: number; action: string; input: unknown }) => {
        return this.dispatchDeviceAction(input.deviceId, input.action, input.input)
      },
      updateDeviceField: async (input) => {
        return this.updateDeviceField({
          deviceId: input.deviceId,
          writerCapName: input.writerCapName,
          writerAddonId: input.writerAddonId,
          key: input.key,
          value: input.value,
        })
      },
      updateDeviceFieldsBatch: async (input) => {
        return this.updateDeviceFieldsBatch({ deviceId: input.deviceId, changes: input.changes })
      },
      getDeviceStatusAggregate: async (input) => this.getDeviceStatusAggregate(input),
      getDeviceStatusAggregateBatch: async (input) =>
        getDeviceStatusAggregateBatch(this.aggregationDeps, input),
      getWireableFields: (input) => getWireableFields(this.aggregationDeps, input),
    }

    this.ctx.logger.info('registered device-manager capability', {
      meta: { liveRegistry: registry !== null },
    })

    // Fan-out device events to ancestor scopes. Runs only when a live
    // registry is available on this node — forked workers that don't
    // own the registry rely on the hub's propagator (events cross the
    // Moleculer bridge already, propagation is idempotent with the
    // `via` guard so emitting on both sides is safe).
    if (registry) {
      this.propagator = new DeviceEventPropagator({
        eventBus: this.ctx.eventBus,
        getParentOf: (id) => registry.getById(id)?.parentDeviceId ?? null,
        logger: {
          warn: (msg, meta) => this.ctx.logger.warn(msg, meta ?? {}),
          debug: (msg, meta) => this.ctx.logger.debug(msg, meta ?? {}),
        },
      })
      this.propagator.start()
      this.ctx.logger.info('device-event-propagator started')
    }

    // `deviceState` cap — generic cross-process surface over the
    // hub mirror. Drivers don't implement this directly; we mount
    // the singleton here so any addon / UI can read any cap's
    // runtime-state slice without the cap having to define its own
    // getStatus / onChanged.
    const deviceStateProvider = {
      getSnapshot: async (input: {
        deviceId: number
      }): Promise<Record<string, Record<string, unknown>>> => {
        return stateMirror.snapshotForDevice(input.deviceId)
      },
      // The EFFECTIVE slice: the merge every consumer sees (D663).
      getCapSlice: async (input: {
        deviceId: number
        capName: string
      }): Promise<Record<string, unknown> | null> => {
        return stateMirror.capSlice(input.deviceId, input.capName)
      },
      // The NATIVE slice — the shadow under a `replace` claim, for the owner's
      // derived reads. Admin-only at the cap (D224): the public event channel
      // refuses the shadow to everyone but the composer, and so does this.
      getNativeCapSlice: async (input: {
        deviceId: number
        capName: string
      }): Promise<Record<string, unknown> | null> => {
        return stateMirror.nativeSlice(input.deviceId, input.capName)
      },
      // Whole-system warm-boot dump. Iterates the mirror once and
      // returns a deeply-cloned `{[deviceId]: {[capName]: slice}}`
      // payload so callers (SystemManager, dashboards) seed their
      // local mirror with one round-trip instead of N per-device
      // calls. Empty inner record for devices with no slices yet.
      getAllSnapshots: async (): Promise<
        Record<string, Record<string, Record<string, unknown>>>
      > => {
        return stateMirror.allSnapshots()
      },
      // Canonical cross-layer write — the single entrypoint every
      // caller funnels through. In-process providers reach it via
      // `BaseDevice.runtimeState.setCapState` (which delegates here);
      // system-scope addons (e.g. the orchestrator writing a camera's
      // effective motion slice, D696) call this cap method directly
      // through `ctx.api.deviceState.setCapSlice.mutate(...)`.
      setCapSlice: async (input: {
        deviceId: number
        capName: string
        slice: Record<string, unknown>
      }): Promise<void> => {
        const { deviceId, capName, slice } = input
        const persisted = await resolvePersistedById(deviceId)
        if (!persisted)
          throw new Error(`[device-manager] setCapSlice: unknown device id=${deviceId}`)
        // A native write is never applied without knowing whether a claim
        // governs it (D49, D663): index first, single-flight (ruling S6). A
        // loaded index that does not name the device answers with no read,
        // so a transient row-read failure never costs the live slice and its
        // event. That is ALL the index vouches for: the device's row is still
        // unread, and the WRITER reads it before the first byte reaches disk
        // (D677) — the boot-time `zones` write that once replaced a camera's
        // whole row with one slice now merges into it. A read the index cannot
        // spare that fails REFUSES the write: the throw propagates to the
        // worker, which logs it and re-sends (D391). A device already seeded
        // (every device `loadRuntimeState` booted) pays nothing here.
        if (!stateMirror.isSeeded(deviceId)) {
          await stateMirror.ensureSeeded(deviceId, settings, fieldClaims.view())
        }
        // Mirror update + onChanged event are synchronous and ordered;
        // disk write is debounced so frequent writes (motion phase
        // transitions, battery pushes) collapse to one fsync per
        // RUNTIME_STATE_DEBOUNCE_MS window.
        //
        // Only a slice that actually CHANGED reaches the disk. Polled
        // providers re-push the value they last read on every tick, and the
        // blob written for an unchanged mirror is byte-identical to the one
        // already stored — so the write is pure cost, and the cost is a
        // synchronous better-sqlite3 transaction that blocks hub-main's event
        // loop for as long as the filesystem takes to answer (measured on the
        // live hub: 1.9-18.3 s stalls, main thread in state D). Nothing is
        // dropped by skipping it: the mirror is the authority, and the write
        // that persisted this exact content already happened.
        //
        // What reaches disk is narrower still: only a cap that declared
        // `durability: 'restored'` arms the writer, and only a blob that
        // differs from what is on disk in a NON-clock field is written. Both
        // gates live in `scheduleRuntimeStateDiskWrite`; the mirror and the
        // `DeviceStateChanged` event above are unaffected by either, because a
        // refresh is detected by a clock advancing and suppressing that would
        // make a successful poll look like a failed one.
        const changed = stateMirror.applySingleCapUpdate(deviceId, capName, slice)
        if (changed) stateMirror.scheduleRuntimeStateDiskWrite(deviceId, settings, capName)
      },
      // Per-field claims (D663), admin-only: index first on a claim, row first
      // on a release; a device under migration is refused by name.
      ...createDeviceStateClaimMethods({
        mirror: stateMirror,
        index: fieldClaims,
        settings,
        logger: this.ctx.logger.child('claims'),
        deviceExists: async (deviceId) => (await resolvePersistedById(deviceId)) !== null,
        migrationInFlight: (deviceId) => pctx.migrationGuard.isInFlight(deviceId),
      }),
    }

    return [
      { capability: deviceManagerCapability, provider },
      { capability: deviceStateCapability, provider: deviceStateProvider },
      // The `linked-devices` extension slot (D648), over `_linkedDeviceIds`.
      {
        capability: deviceExtensionCapability,
        provider: createDeviceManagerExtensionProvider(pctx),
      },
    ]
  }

  private get removalCleanup(): RemovalCleanup {
    if (this.removalCleanupImpl === null) {
      this.removalCleanupImpl = createRemovalCleanup({ logger: this.ctx.logger })
    }
    return this.removalCleanupImpl
  }

  private get removalHooksCleanup(): RemovalCleanup {
    if (this.removalHooksCleanupImpl === null) {
      this.removalHooksCleanupImpl = createRemovalCleanup({
        logger: this.ctx.logger,
        label: 'device removal hooks',
      })
    }
    return this.removalHooksCleanupImpl
  }

  protected async onShutdown(): Promise<void> {
    this.removalCleanupImpl?.dispose()
    this.removalCleanupImpl = null
    this.removalHooksCleanupImpl?.dispose()
    this.removalHooksCleanupImpl = null
    this.propagator?.stop()
    this.propagator = null
    this.uninstallStatusOverlay?.()
    this.uninstallStatusOverlay = null
    // Flush any pending debounced runtime-state disk writes so a
    // graceful shutdown doesn't drop the latest mirror state.
    await this.stateMirrorImpl?.flushPendingWrites(this.ctx.settings)
  }
}

export default DeviceManagerAddon
