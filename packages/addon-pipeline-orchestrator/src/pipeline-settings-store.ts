/**
 * `PipelineSettingsStore` — the 3-level pipeline settings store (C11):
 * agent settings, camera settings and the pipeline-executor catalog cache.
 * Also owns the (unrelated-in-concept but co-declared)
 * `nodeBindings` capability-binding map and the one-shot bindings-migration
 * guard flag, because all five durable-state handles were declared in the
 * same lazy-getter block in `index.ts` and are extracted together.
 *
 * Extracted verbatim from `index.ts` (S4 refactor slice) — method bodies
 * are unchanged except:
 *   - `this.ctx.*` / `this.<cachedField>` accesses become `this.deps.*`.
 *   - `this.assignments.get(deviceId)?.agentNodeId ?? this.localNodeId`
 *     (only used by `resolvePipelineForDevice`) becomes the injected
 *     `deps.getAssignmentNode(deviceId)` closure, so the store never holds
 *     a reference to the placement ledger.
 *   - `isCapActiveForDevice('detection-pipeline')` is duplicated locally
 *     as `isDetectionPipelineActive` (same body, hardcoded capName) rather
 *     than adding an eventBus/deviceManager dependency beyond the fixed
 *     `{ state, api, acquireCapability, getAssignmentNode, logger }` deps
 *     contract — `getCapabilityBindings`/`setCapabilityBinding`'s eventBus
 *     emit + "capability binding set" log line stay on the addon class for
 *     the same reason (the store has no eventBus dependency).
 *   - `waitForAgentAndCatalog`'s `while (true)` gains a `disposed` guard
 *     (smell #20) — see {@link PipelineSettingsStore.dispose}.
 *
 * The catalog-cache invalidation logic (previously split across 3 sites —
 * populate in `getCatalogForAgent`, a prefix-delete in
 * `handleDetectionPipelineReadiness`, and a full clear in
 * `setAgentAddonDefaults`) is consolidated into one {@link invalidateCatalog}
 * method (smell #21). The `${nodeId}::*` cache-key SHAPE is unchanged.
 */
import type {
  AddonApi,
  AddonContext,
  AgentPipelineSettings,
  CameraPipelineConfig,
  CameraPipelineSettings,
  DeviceStepConfig,
  DurableState,
  IScopedLogger,
  PipelineSchema,
} from '@camstack/types'
import { cameraScopedStepSettings, errMsg, sleep } from '@camstack/types'
import type { ZodType } from 'zod'
import { z } from 'zod'
import type { CameraStepLayer } from './apply-device-provisioning.js'
import { applyPackageZoneActivation, resolvePipelineWithSkips } from './pipeline-resolver.js'
import { parseDeviceKey } from './inference-device-model.js'
import { nodeDeviceBase } from './node-step-settings.js'
import { KeyedAsyncLock } from './keyed-async-lock.js'
import {
  type IsRegisteredCustomModel,
  type ResetModelPin,
  sweepAgentSettingsPins,
} from './removed-model-pin-reset.js'
import {
  type AgentSettingsMapBlob,
  AgentSettingsMapSchema,
  type CameraSettingsMapBlob,
  CameraSettingsMapSchema,
  type NodeBindingsBlob,
  NodeBindingsSchema,
} from './orchestrator-store-schemas.js'

/** How a resolve reads the node's catalog: wait for the executor, or the cache only. */
type CatalogRead = { readonly kind: 'await' } | { readonly kind: 'cached' }

/**
 * A resolve that may find no catalog to resolve against (cache-only read).
 * `catalog-unavailable` names the node whose executor has not answered.
 */
export type CatalogGatedPipeline =
  | {
      readonly kind: 'resolved'
      readonly config: CameraPipelineConfig
      /** Gated-on roots the elected device cannot run — see `ResolvedPipeline.droppedRoots`. */
      readonly droppedRoots: readonly string[]
    }
  | { readonly kind: 'catalog-unavailable'; readonly nodeId: string }

/** One device's provisioning inputs for one camera — see `readDeviceProvisioning`. */
export interface DeviceProvisioningSource {
  readonly base: Readonly<Record<string, DeviceStepConfig>>
  readonly override: Readonly<Record<string, CameraStepLayer>>
}

/** Injected dependencies for {@link PipelineSettingsStore}. */
export interface PipelineSettingsStoreDeps {
  /** Same lazy-durable-state factory `BaseAddon.state<T>()` exposes — pass `this.state.bind(this)`. */
  readonly state: <T>(key: string, schema: ZodType<T>, fallback: T) => DurableState<T>
  /**
   * Live api accessor. Backed by `this.ctxIfReady?.api ?? null` (NOT the
   * throwing `this.ctx.api` getter) so a call that lands after `dispose()`
   * degrades gracefully instead of throwing through a nulled ctx.
   */
  readonly api: () => AddonApi | null
  /** `ctx.acquireCapability`, typed off `AddonContext` so the signature can't drift. */
  readonly acquireCapability: AddonContext['acquireCapability']
  /**
   * Resolves a device's current dispatch node WITHOUT the store holding a
   * reference to the placement ledger (`assignments`). Already folds in
   * the `?? localNodeId` fallback the class applied inline, so for a
   * fully-initialized addon it always resolves to a concrete string.
   */
  readonly getAssignmentNode: (deviceId: number) => string | null
  /**
   * Whether the device has ≥1 package zone (an enabled `package`-stage zone
   * rule referencing geometry). Drives zone-driven activation of the
   * toggle-less `package-detection` step in {@link
   * PipelineSettingsStore.resolvePipelineForDevice}. Injected so the store
   * needs no reference to the zone-rules provider; a read failure resolves to
   * `false` (step off), never throws.
   */
  readonly hasPackageZone: (deviceId: number) => Promise<boolean>
  readonly logger: IScopedLogger
}

const PIPELINE_EXECUTOR_CAP = 'pipeline-executor'

export class PipelineSettingsStore {
  private static readonly CATALOG_CACHE_TTL_MS = 30_000

  /**
   * One reconcile round for {@link awaitExecutorCatalog}: the BOUNDED
   * registry wait between two authoritative provider probes. Matches the
   * registry's own "still awaiting" diagnostic cadence.
   */
  private static readonly EXECUTOR_RECONCILE_ROUND_MS = 30_000

  /**
   * Pacing between provider probes when the registry claims `ready` but
   * the provider is not answering yet (stale registry record) — without
   * it that combination would spin hot.
   */
  private static readonly EXECUTOR_READY_PROBE_PACE_MS = 2_000

  /**
   * Round bound for {@link seedAgentSettingsFromCatalog}: seeding is
   * invoked from event handlers (`handleDetectionPipelineReadiness`) that
   * must not accumulate unbounded loops across provider flaps — on
   * exhaustion it returns `null` and the periodic pending-retry sweep /
   * the next readiness epoch retries. `waitForAgentAndCatalog` keeps the
   * UNBOUNDED reconcile (cameras are never dispatched with empty steps).
   */
  private static readonly SEED_MAX_RECONCILE_ROUNDS = 4

  constructor(private readonly deps: PipelineSettingsStoreDeps) {}

  // ── Disposal (smell #20) ──────────────────────────────────────────────
  //
  // `waitForAgentAndCatalog`'s retry loop otherwise runs `while (true)`
  // with 2s sleeps and no exit: a device resolve in flight at addon
  // shutdown would keep looping forever against a torn-down ctx. The
  // addon calls `dispose()` from `onShutdown()`; the loop's own condition
  // check (re-evaluated every iteration, including right after a `sleep`)
  // is the abort point — no other method needs the flag because every
  // other call in this store is single-shot, not a retry loop.

  private disposed = false

  /** Whether `dispose()` has run — a `null` catalog from a bounded wait means "not answered" only while this is false. */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Called once from the addon's `onShutdown()`. Idempotent. */
  dispose(): void {
    this.disposed = true
  }

  // ── Blob write serialization ──────────────────────────────────────────
  //
  // `writeAgentSettings`/`removeAgentSettings` are read-modify-write over
  // the WHOLE `agentSettings` blob with an async boundary between the read
  // and the `set()`. Two concurrent writers (e.g. the admin-ui weight
  // slider committing several nodes while a `reachableHost` save lands)
  // would otherwise interleave those sections and the second `set()` would
  // silently drop the first writer's node entry. Every agent-settings
  // read-modify-write therefore runs under this per-blob `KeyedAsyncLock`
  // (keyed on the blob name so a future blob can join without serializing
  // against `agentSettings`). Shutdown semantics mirror the audio/session
  // locks: once `dispose()` has run, queued/new sections become no-ops.

  private readonly blobWriteLock = new KeyedAsyncLock<string>({
    isShuttingDown: () => this.disposed,
  })

  private static readonly AGENT_SETTINGS_LOCK_KEY = 'agentSettings'

  // ── Durable whole-blob store handles ─────────────────────────────────
  //
  // Each routes BOTH the boot read and every write for one addon-store key
  // through a single Zod-validated handle (`deps.state(KEY, Schema, {})`).
  // The WHOLE value round-trips on every read/write — no hand-listed field
  // set can silently drop a key on persist. Built lazily (needs the
  // addon's ctx, indirectly via `deps.state`) and memoised so the
  // read-modify-write paths share one handle.

  private _nodeBindingsState: DurableState<NodeBindingsBlob> | null = null
  private _agentSettingsState: DurableState<AgentSettingsMapBlob> | null = null
  private _cameraSettingsState: DurableState<CameraSettingsMapBlob> | null = null
  private _bindingsMigrationDoneState: DurableState<boolean> | null = null

  private get nodeBindingsState(): DurableState<NodeBindingsBlob> {
    if (!this._nodeBindingsState) {
      this._nodeBindingsState = this.deps.state<NodeBindingsBlob>(
        'nodeBindings',
        NodeBindingsSchema,
        {},
      )
    }
    return this._nodeBindingsState
  }

  private get agentSettingsState(): DurableState<AgentSettingsMapBlob> {
    if (!this._agentSettingsState) {
      this._agentSettingsState = this.deps.state<AgentSettingsMapBlob>(
        'agentSettings',
        AgentSettingsMapSchema,
        {},
      )
    }
    return this._agentSettingsState
  }

  private get cameraSettingsState(): DurableState<CameraSettingsMapBlob> {
    if (!this._cameraSettingsState) {
      this._cameraSettingsState = this.deps.state<CameraSettingsMapBlob>(
        'cameraSettings',
        CameraSettingsMapSchema,
        {},
      )
    }
    return this._cameraSettingsState
  }

  /**
   * One-shot `migrateLegacyFlagsToBindings` guard flag. Exposed as a public
   * getter (not wrapped) because `migrateLegacyFlagsToBindings` takes the
   * raw `DurableState<boolean>` handle directly as its `doneFlag` dep.
   */
  get bindingsMigrationDoneState(): DurableState<boolean> {
    if (!this._bindingsMigrationDoneState) {
      this._bindingsMigrationDoneState = this.deps.state<boolean>(
        'bindingsMigration_v1_done',
        z.boolean(),
        false,
      )
    }
    return this._bindingsMigrationDoneState
  }

  // ── Capability bindings (nodeBindings) ────────────────────────────────
  //
  // Not conceptually part of the 3-level pipeline settings model, but
  // co-located here because `nodeBindingsState` is one of the four
  // durable-state handles declared (and now extracted) together. The
  // addon's cap methods keep the eventBus emit + info log on the class
  // side (this store has no eventBus dependency).

  async getCapabilityBindings(nodeId: string): Promise<Readonly<Record<string, string>>> {
    const bindings = await this.nodeBindingsState.get().catch((): NodeBindingsBlob => ({}))
    const perNodeRaw = bindings[nodeId]
    if (!perNodeRaw || typeof perNodeRaw !== 'object') return {}
    const perNode: Record<string, unknown> = { ...perNodeRaw }
    const out: Record<string, string> = {}
    for (const [capName, addonId] of Object.entries(perNode)) {
      if (typeof addonId === 'string' && addonId.length > 0) out[capName] = addonId
    }
    return out
  }

  /** Read-modify-write the WHOLE `nodeBindings` blob so a concurrent binding for another node/cap can't be dropped. */
  async setCapabilityBinding(nodeId: string, capName: string, addonId: string): Promise<void> {
    await this.nodeBindingsState.update((prev) => {
      const prevBindings: NodeBindingsBlob = {}
      for (const [nodeKey, nodeVal] of Object.entries(prev)) {
        if (!nodeVal || typeof nodeVal !== 'object') continue
        const nodeAsRecord: Record<string, unknown> = { ...nodeVal }
        const nodeBinding: Record<string, string> = {}
        for (const [cn, aid] of Object.entries(nodeAsRecord)) {
          if (typeof aid === 'string') nodeBinding[cn] = aid
        }
        prevBindings[nodeKey] = nodeBinding
      }
      const nodeBindings: Record<string, string> = {
        ...prevBindings[nodeId],
      }
      nodeBindings[capName] = addonId
      return {
        ...prevBindings,
        [nodeId]: nodeBindings,
      }
    })
  }

  // ── 3-level pipeline settings store (agent + camera maps) ────────────

  /** Read the `agentSettings` map (keyed on `nodeId`) via the durable handle. */
  async readAgentSettingsMap(): Promise<AgentSettingsMapBlob> {
    // `get()` returns a fresh object each call, so callers may safely
    // mutate the returned copy.
    return { ...(await this.agentSettingsState.get()) }
  }

  /**
   * Drop every per-(node, device) `modelId` pin that names a model deleted
   * from its step's catalog and owned by no registered custom model (D725,
   * `removed-model-pin-reset.ts`). The agent map is rewritten under
   * {@link blobWriteLock} (the lock `writeAgentSettings` takes), only when the
   * sweep found a pin, so a clean store is never written. Returns the pins it
   * cleared.
   */
  async resetRemovedModelPins(
    isCustom: IsRegisteredCustomModel,
  ): Promise<readonly ResetModelPin[]> {
    const cleared: ResetModelPin[] = []
    await this.blobWriteLock.run(PipelineSettingsStore.AGENT_SETTINGS_LOCK_KEY, async () => {
      const swept = sweepAgentSettingsPins(await this.agentSettingsState.get(), isCustom)
      if (swept.cleared.length === 0) return
      await this.agentSettingsState.set(swept.next)
      cleared.push(...swept.cleared)
    })
    return cleared
  }

  /**
   * Overwrite one agent's settings. Does NOT touch other agents' entries.
   * The read-modify-write runs under {@link blobWriteLock}, so a concurrent
   * write for a DIFFERENT node can never be dropped (both re-read the fresh
   * blob when their turn comes and only overlay their own node's entry).
   */
  async writeAgentSettings(nodeId: string, settings: AgentPipelineSettings): Promise<void> {
    // Reject malformed node ids so the persisted map never accumulates
    // ghost entries (root cause of the "undefined" ghost in the agent
    // dropdown).
    if (
      typeof nodeId !== 'string' ||
      nodeId.length === 0 ||
      nodeId === 'undefined' ||
      nodeId === 'null'
    ) {
      this.deps.logger.warn('writeAgentSettings: refusing to persist malformed nodeId', {
        meta: { nodeId },
      })
      return
    }
    await this.blobWriteLock.run(PipelineSettingsStore.AGENT_SETTINGS_LOCK_KEY, async () => {
      const all = await this.readAgentSettingsMap()
      // Overlay the caller's settings on top of any persisted entry: fields the
      // caller omits (key absent) are preserved from `existing`, while fields the
      // caller sets — INCLUDING an explicit `undefined` to reset a capability
      // flag to its node default — override.
      const existing = all[nodeId]
      const merged: AgentSettingsMapBlob[string] = {
        ...existing,
        ...settings,
        // Normalise maxCameras: an explicit value (incl. 0) wins; an omitted key
        // preserves the persisted cap; both undefined → null (unlimited).
        maxCameras:
          settings.maxCameras !== undefined
            ? (settings.maxCameras ?? null)
            : (existing?.maxCameras ?? null),
      }
      await this.agentSettingsState.set({ ...all, [nodeId]: merged })
    })
  }

  /**
   * Rewrite the whole agent-settings map in ONE read-modify-write under
   * {@link blobWriteLock} — atomic across every node of the blob (Best
   * settings, D745, writes several nodes' devices at once). `transform` must
   * be pure: it may run on a fresh read.
   */
  async rewriteAgentSettingsMap(
    transform: (prev: AgentSettingsMapBlob) => AgentSettingsMapBlob,
  ): Promise<void> {
    await this.blobWriteLock.run(PipelineSettingsStore.AGENT_SETTINGS_LOCK_KEY, async () => {
      await this.agentSettingsState.set(transform(await this.readAgentSettingsMap()))
    })
  }

  /**
   * Drop one agent's persisted settings entry. Returns whether an entry
   * existed (`false` also when the store is already disposed — the locked
   * section becomes a no-op then). Serialized via {@link blobWriteLock} for
   * the same lost-write reason as {@link writeAgentSettings}.
   */
  async removeAgentSettings(nodeId: string): Promise<boolean> {
    let removed = false
    await this.blobWriteLock.run(PipelineSettingsStore.AGENT_SETTINGS_LOCK_KEY, async () => {
      const all = await this.readAgentSettingsMap()
      if (!(nodeId in all)) return
      const { [nodeId]: _drop, ...rest } = all
      await this.agentSettingsState.set(rest)
      removed = true
    })
    return removed
  }

  /** Read the `cameraSettings` map (keyed on `deviceId` as string) via the durable handle. */
  async readCameraSettingsMap(): Promise<Record<string, CameraPipelineSettings>> {
    // Fresh object per `get()`, so callers may safely mutate it.
    return { ...(await this.cameraSettingsState.get()) }
  }

  /** Overwrite one camera's settings. */
  async writeCameraSettings(deviceId: number, settings: CameraPipelineSettings): Promise<void> {
    const all = await this.readCameraSettingsMap()
    all[String(deviceId)] = settings
    await this.cameraSettingsState.set(all)
  }

  /**
   * Write or clear one camera's CAMERA-WIDE settings for `addonId` (D754): the
   * field-level bag merged over the node base on every accelerator. `null` or
   * an empty bag deletes the step's entry; an empty layer is pruned.
   * Read-patch-write, immutable. The caller refuses a model-scoped key (D927).
   */
  async writeCameraStepSettings(
    deviceId: number,
    addonId: string,
    settings: Readonly<Record<string, unknown>> | null,
  ): Promise<void> {
    await this.cameraSettingsState.update((prev) => {
      const key = String(deviceId)
      const camera = prev[key] ?? {}
      const nextLayer: Record<string, Readonly<Record<string, unknown>>> = {
        ...camera.stepSettings,
      }
      if (settings === null || Object.keys(settings).length === 0) delete nextLayer[addonId]
      else nextLayer[addonId] = { ...settings }
      const { stepSettings: _drop, ...rest } = camera
      const nextCamera: CameraPipelineSettings = {
        ...rest,
        ...(Object.keys(nextLayer).length > 0 ? { stepSettings: nextLayer } : {}),
      }
      return { ...prev, [key]: nextCamera }
    })
  }

  /**
   * Write or clear one step's NODE-wide settings (D927) under the agent-blob
   * lock. `null` or `{}` deletes the step; an empty layer is pruned. Creates
   * the node's entry when absent. The caller refuses a model-scoped key.
   */
  async writeNodeStepSettings(
    nodeId: string,
    addonId: string,
    settings: Readonly<Record<string, unknown>> | null,
  ): Promise<void> {
    await this.blobWriteLock.run(PipelineSettingsStore.AGENT_SETTINGS_LOCK_KEY, async () => {
      const all = await this.readAgentSettingsMap()
      const existing = all[nodeId] ?? { maxCameras: null }
      const layer: Record<string, Readonly<Record<string, unknown>>> = { ...existing.stepSettings }
      if (settings === null || Object.keys(settings).length === 0) delete layer[addonId]
      else layer[addonId] = { ...settings }
      const { stepSettings: _drop, ...rest } = existing
      await this.agentSettingsState.set({
        ...all,
        [nodeId]: { ...rest, ...(Object.keys(layer).length > 0 ? { stepSettings: layer } : {}) },
      })
    })
  }

  /** Purge one device's entry through the durable handle (whole-blob round-trip). */
  async deleteCameraSettings(deviceId: number): Promise<void> {
    await this.cameraSettingsState.update((prev) => {
      const { [String(deviceId)]: _c, ...rest } = prev
      return rest
    })
  }

  // ── Pipeline-executor catalog cache ──────────────────────────────────
  //
  // Cached `PipelineSchema` per node (`${nodeId}::*` key — the `::*`
  // suffix is kept even though there's no longer a per-engine variant, so
  // {@link invalidateCatalog}'s prefix-match keeps working unchanged).
  // Populated on demand by `getCatalogForAgent`; invalidated via
  // `invalidateCatalog` (smell #21 — the 3-site invalidation is now this
  // ONE method: full clear when called with no `nodeId`, prefix-delete
  // when called with one). TTL is a soft guard only — invalidation is the
  // main signal.

  private catalogCache = new Map<string, { schema: PipelineSchema; at: number }>()

  /**
   * A node's `PipelineSchema`: the cached answer when fresh, else ONE live
   * `getSchema` RPC (bounded by the transport's request timeout, not by this
   * store). `null` when that read fails. Unlike {@link waitForAgentAndCatalog}
   * it does not retry; unlike {@link peekCatalogForAgent} it DOES wait for the
   * node — use the peek on any path that must never wait.
   */
  async getCatalogForNode(nodeId: string): Promise<PipelineSchema | null> {
    return this.getCatalogForAgent(nodeId)
  }

  /**
   * The node's catalog for a LIVE eligibility read, in one of two explicit
   * modes (D650 round 3, bounded in the pre-ship review):
   *  - `unbounded` — WAIT until the node's executor answers, the same
   *    loss-proof reconcile the resolve uses ({@link awaitExecutorCatalog}).
   *    For a FIRST placement, which will wait for this catalog to resolve its
   *    pipeline anyway: electing against it too keeps the root guard from
   *    failing open. `null` only when the store is disposed mid-wait.
   *  - `one-round` — ONE reconcile round (one `getSchema`, no acquire wait).
   *    `null` means "not answered". For a read nothing waits on — a background
   *    refresher — where the unbounded form is a loop that outlives the node
   *    it is asking (D3): a `getSchema` plus a 30 s acquire per round and a
   *    WARN every round, for as long as the key is held.
   */
  async awaitCatalogForNode(
    nodeId: string,
    wait: 'unbounded' | 'one-round',
  ): Promise<PipelineSchema | null> {
    return this.awaitExecutorCatalog(nodeId, wait === 'one-round' ? { maxRounds: 1 } : {})
  }

  /**
   * Per-node catalog generation. {@link invalidateCatalog} bumps it; a
   * refresh records its answer only if the generation it started under is
   * still current, so a read that began BEFORE an invalidation can never
   * re-install the catalog the invalidation just removed.
   */
  private readonly catalogGeneration = new Map<string, number>()
  /** Bumped by a full {@link invalidateCatalog}; part of every node's generation. */
  private catalogEpoch = 0

  private catalogGenerationOf(nodeId: string): string {
    return `${this.catalogEpoch}:${this.catalogGeneration.get(nodeId) ?? 0}`
  }

  /** Nodes whose last catalog read FAILED — the warn fires once per failing stretch. */
  private readonly catalogReadFailing = new Set<string>()
  /** Nodes being served a catalog past its TTL — the warn fires once per stale stretch. */
  private readonly catalogServedStale = new Set<string>()

  /** Nodes with a background catalog refresh in flight (single-flight per node). */
  private readonly catalogRefreshInFlight = new Set<string>()

  /**
   * A catalog served this far past its TTL is WORTH a warn: its background
   * refresh has not landed in ten refresh windows. Below this, serving past
   * the TTL is by construction — the re-place sweep runs every 60 s against a
   * 30 s TTL, so every round finds the entry expired and refreshes it behind
   * the read — and a line per round said nothing (pre-ship review, M5).
   */
  private static readonly CATALOG_STALE_WARN_MS = 5 * 60_000

  /**
   * Cache-only catalog read — NEVER awaits the node (D650 round 2). Serves
   * the last answer the node gave, even past its TTL (a stale catalog is a
   * structure that was true a minute ago; its absence is a camera left
   * pending), and starts ONE background {@link getCatalogForAgent} when the
   * entry is missing or expired, so the next caller sees a fresh answer.
   * Returns `null` only when the node has never answered.
   */
  peekCatalogForAgent(nodeId: string): PipelineSchema | null {
    const hit = this.catalogCache.get(`${nodeId}::*`)
    const ageMs = hit === undefined ? null : Date.now() - hit.at
    const fresh = ageMs !== null && ageMs < PipelineSettingsStore.CATALOG_CACHE_TTL_MS
    if (fresh) {
      this.catalogServedStale.delete(nodeId)
    } else if (
      ageMs !== null &&
      ageMs >= PipelineSettingsStore.CATALOG_STALE_WARN_MS &&
      !this.catalogServedStale.has(nodeId)
    ) {
      this.catalogServedStale.add(nodeId)
      this.deps.logger.warn(
        'serving a node catalog long past its TTL — its refresh has not landed',
        {
          tags: { nodeId },
          meta: {
            ageMs,
            ttlMs: PipelineSettingsStore.CATALOG_CACHE_TTL_MS,
            warnAfterMs: PipelineSettingsStore.CATALOG_STALE_WARN_MS,
          },
        },
      )
    }
    if (!fresh && !this.catalogRefreshInFlight.has(nodeId)) {
      this.catalogRefreshInFlight.add(nodeId)
      void this.getCatalogForAgent(nodeId).finally(() => {
        this.catalogRefreshInFlight.delete(nodeId)
      })
    }
    return hit?.schema ?? null
  }

  /**
   * How many times one {@link getCatalogForAgent} call re-reads after its
   * answer was fenced out by an invalidation, before it gives up (`null`, which
   * the callers treat as "not answered"). Invalidations come from readiness
   * epochs and operator resets — a bound, not a budget.
   */
  private static readonly CATALOG_FENCE_REREADS = 3

  /** The node's catalog, read through the cache (awaits the node when cold). */
  async readCatalogForNode(nodeId: string): Promise<PipelineSchema | null> {
    return this.getCatalogForAgent(nodeId)
  }

  private async getCatalogForAgent(nodeId: string): Promise<PipelineSchema | null> {
    const api = this.deps.api()
    if (!api) return null
    const engineKey = `${nodeId}::*`
    for (let reread = 0; !this.disposed; reread++) {
      const now = Date.now()
      const hit = this.catalogCache.get(engineKey)
      if (hit && now - hit.at < PipelineSettingsStore.CATALOG_CACHE_TTL_MS) {
        return hit.schema
      }
      const generation = this.catalogGenerationOf(nodeId)
      let schema: PipelineSchema
      try {
        schema = (await api.pipelineExecutor.getSchema.query({ nodeId })) as PipelineSchema
      } catch (err) {
        if (!this.catalogReadFailing.has(nodeId)) {
          this.catalogReadFailing.add(nodeId)
          this.deps.logger.warn(
            'node catalog read failed — placements on it wait or stay pending',
            {
              tags: { nodeId },
              meta: { error: errMsg(err) },
            },
          )
        }
        return null
      }
      if (this.catalogReadFailing.delete(nodeId)) {
        this.deps.logger.info('node catalog read recovered', { tags: { nodeId } })
      }
      if (this.catalogGenerationOf(nodeId) === generation) {
        this.catalogCache.set(engineKey, { schema, at: now })
        return schema
      }
      // Fenced: an invalidation landed while this read was in flight, so the
      // answer describes a catalog that no longer exists. It is never cached —
      // and never RETURNED either (D650 round 4): the caller awaiting it is a
      // first placement, and it would have resolved its pipeline against the
      // pre-invalidation catalog. Read again, under the new generation.
      if (reread >= PipelineSettingsStore.CATALOG_FENCE_REREADS) {
        this.deps.logger.warn('node catalog read fenced repeatedly — giving up this read', {
          tags: { nodeId },
          meta: { rereads: reread },
        })
        return null
      }
      this.deps.logger.info('node catalog read fenced by an invalidation — re-reading', {
        tags: { nodeId },
        meta: { reread: reread + 1 },
      })
    }
    return null
  }

  /**
   * Consolidated catalog-cache invalidation (smell #21). Omit `nodeId` for
   * a full clear (the old `setAgentAddonDefaults` site); pass a `nodeId`
   * for a prefix-delete of just that node's cache entries (the old
   * `handleDetectionPipelineReadiness` site) — matches `${nodeId}::*`
   * (and any per-engine variant that ever existed) without touching other
   * nodes' cached schemas.
   */
  invalidateCatalog(nodeId?: string): void {
    if (nodeId === undefined) {
      this.catalogEpoch++
      this.catalogCache.clear()
      return
    }
    this.catalogGeneration.set(nodeId, (this.catalogGeneration.get(nodeId) ?? 0) + 1)
    for (const key of Array.from(this.catalogCache.keys())) {
      if (key.startsWith(`${nodeId}::`)) this.catalogCache.delete(key)
    }
  }

  /**
   * Ensure `agentSettings[nodeId]` exists. Triggered on orchestrator init (for
   * the hub) and on every `$node.connected` for remote runners.
   *
   * The per-node model layer is gone (per-(node,device) config): there is
   * nothing catalog-derived to seed onto the node anymore — model/settings live
   * under `inferenceDevices[deviceKey].steps`. This method now just guarantees a
   * bare settings entry exists (so placement/caps reads resolve) once the node's
   * executor is answering.
   *
   * The executor gate (D8) still reconciles against the provider itself instead
   * of waiting solely on a (lossy) readiness event. Bounded rounds — see
   * SEED_MAX_RECONCILE_ROUNDS; `null` on exhaustion keeps the historical "skip
   * for now, a later signal retries" contract.
   */
  async seedAgentSettingsFromCatalog(nodeId: string): Promise<AgentPipelineSettings | null> {
    const catalog = await this.awaitExecutorCatalog(nodeId, {
      maxRounds: PipelineSettingsStore.SEED_MAX_RECONCILE_ROUNDS,
    })
    if (!catalog) return null
    const existing = (await this.readAgentSettingsMap())[nodeId]
    if (existing) return existing
    const next: AgentPipelineSettings = { maxCameras: null }
    await this.writeAgentSettings(nodeId, next)
    this.deps.logger.info('agentSettings entry created', { tags: { nodeId } })
    return next
  }

  // ── Pipeline resolution ───────────────────────────────────────────────

  /**
   * True when `capName` is bound (`kind:'wrapped'`) for `deviceId` via
   * `device-manager.getBindings`. Local duplicate of the addon's own
   * `isCapActiveForDevice('detection-pipeline')` — kept here (rather than
   * added to the deps contract) so the store's deps stay exactly
   * `{ state, api, acquireCapability, getAssignmentNode, logger }`.
   * Failures log-and-return `true` — same safe default as the class's
   * version ("cap on" unless explicitly toggled off).
   */
  private async isDetectionPipelineActive(deviceId: number): Promise<boolean> {
    const api = this.deps.api()
    if (!api) return true
    try {
      const bindings = await api.deviceManager.getBindings.query({ deviceId })
      return bindings.entries.some(
        (e) => e.capName === 'detection-pipeline' && e.kind === 'wrapped',
      )
    } catch (err: unknown) {
      this.deps.logger.warn('binding lookup failed — defaulting cap:active', {
        tags: { deviceId },
        meta: { capName: 'detection-pipeline', error: errMsg(err) },
      })
      return true
    }
  }

  /**
   * Resolve the pipeline for a device. NEVER returns an empty/fallback
   * config: if the catalog or agent settings aren't available yet, this
   * blocks (with backoff) until the detection-pipeline cap is registered
   * and a non-null catalog comes back. Cameras must never be dispatched
   * with `steps=[]` because the runner then attaches the camera with no
   * steps and silently never recovers.
   *
   * Data only: the returned config never carries an engine — model
   * selection is data only, and the executing node resolves its own
   * format default at runtime when a step's `modelId` is absent.
   *
   * One legitimate exception to "never empty": the device's
   * `detection-pipeline` binding is INACTIVE — the operator explicitly turned
   * inference off for this camera.
   *
   * Everything else (boot ordering, catalog cold-start, transient cap
   * registration delay) loops with backoff until the catalog responds.
   *
   * `jumpDeviceKeys` (D650) are the node's OTHER enabled devices the runner
   * may jump a detail step to — `jumpTargetKeys(roster)` of the SAME roster the
   * attach carries. A detail step the elected device cannot run is kept when
   * one of them can; empty ⇒ the elected format alone decides.
   */
  async resolvePipelineForDevice(
    deviceId: number,
    agentNodeIdOverride?: string,
    deviceKey?: string,
    jumpDeviceKeys: readonly string[] = [],
  ): Promise<CameraPipelineConfig> {
    const outcome = await this.resolvePipelineWithCatalog(
      deviceId,
      agentNodeIdOverride,
      deviceKey,
      jumpDeviceKeys,
      { kind: 'await' },
    )
    if (outcome.kind === 'resolved') return outcome.config
    // `await` never answers unavailable — it waits (or throws on dispose).
    throw new Error(
      `PipelineSettingsStore.resolvePipelineForDevice: catalog unavailable for "${outcome.nodeId}"`,
    )
  }

  /**
   * {@link resolvePipelineForDevice} with the gated-on roots the elected device
   * cannot run (D650 round 3) — what an attach needs to refuse a camera whose
   * own detector would not run. Waits for the catalog exactly as it does.
   */
  async resolvePipelineForDeviceWithRoots(
    deviceId: number,
    agentNodeId: string,
    deviceKey: string | undefined,
    jumpDeviceKeys: readonly string[],
  ): Promise<{ readonly config: CameraPipelineConfig; readonly droppedRoots: readonly string[] }> {
    const outcome = await this.resolvePipelineWithCatalog(
      deviceId,
      agentNodeId,
      deviceKey,
      jumpDeviceKeys,
      { kind: 'await' },
    )
    if (outcome.kind === 'resolved') return outcome
    throw new Error(
      `PipelineSettingsStore.resolvePipelineForDeviceWithRoots: catalog unavailable for "${outcome.nodeId}"`,
    )
  }

  /**
   * The NON-BLOCKING sibling of {@link resolvePipelineForDevice} (D650 round
   * 2): the same resolution, but the node's catalog is read from the cache
   * only ({@link peekCatalogForAgent}). A cold or unanswering node yields
   * `catalog-unavailable` instead of a wait — the RETRY / re-place paths call
   * this, so one wedged executor can never hold a sweep (D3: no waiting for a
   * node; D49: never gate on a fallible read). A cold cache also starts one
   * background refresh, so the next retry round finds the catalog.
   */
  async resolvePipelineForDeviceIfCatalogCached(
    deviceId: number,
    agentNodeId: string,
    deviceKey: string | undefined,
    jumpDeviceKeys: readonly string[],
  ): Promise<CatalogGatedPipeline> {
    return this.resolvePipelineWithCatalog(deviceId, agentNodeId, deviceKey, jumpDeviceKeys, {
      kind: 'cached',
    })
  }

  private async resolvePipelineWithCatalog(
    deviceId: number,
    agentNodeIdOverride: string | undefined,
    deviceKey: string | undefined,
    jumpDeviceKeys: readonly string[],
    catalogRead: CatalogRead,
  ): Promise<CatalogGatedPipeline> {
    const agentNodeId = agentNodeIdOverride ?? this.deps.getAssignmentNode(deviceId)
    if (!agentNodeId) {
      // Defensive only: `getAssignmentNode` always resolves to a concrete
      // node (it folds in the addon's `localNodeId` fallback) for a
      // fully-initialized addon — this branch guards against a
      // misconfigured deps wiring rather than any real runtime path.
      throw new Error(
        `PipelineSettingsStore.resolvePipelineForDevice: no node resolvable for device ${deviceId}`,
      )
    }

    // ── Operator-intent short-circuit: binding inactive ──
    if (!(await this.isDetectionPipelineActive(deviceId))) {
      this.deps.logger.info('resolvePipelineForDevice → empty (binding inactive)', {
        tags: { deviceId, nodeId: agentNodeId },
        meta: { reason: 'detection-pipeline binding inactive' },
      })
      return { kind: 'resolved', config: { steps: [], audio: null }, droppedRoots: [] }
    }

    // Zone-driven activation of the toggle-less `package-detection` step:
    // resolved once here and applied to every non-empty return path below.
    const hasPackageZone = await this.deps.hasPackageZone(deviceId)

    const cameraMap = await this.readCameraSettingsMap()
    const cam: CameraPipelineSettings | null = cameraMap[String(deviceId)] ?? null

    // ── Catalog path — block until the node's executor is answering ──
    // (`waitForAgentAndCatalog` also guarantees a bare agentSettings entry.)
    let catalog: PipelineSchema
    if (catalogRead.kind === 'await') {
      catalog = (await this.waitForAgentAndCatalog(agentNodeId)).catalog
    } else {
      const cached = this.peekCatalogForAgent(agentNodeId)
      if (!cached) return { kind: 'catalog-unavailable', nodeId: agentNodeId }
      catalog = cached
    }
    // Per-DEVICE skip check: use the chosen accelerator's model format when the
    // caller has already balanced onto one; else fall back to the node's single
    // selected-engine format (node-level resolve / preview).
    const deviceFormat = deviceKey
      ? parseDeviceKey(deviceKey).format
      : catalog.selectedEngine.format
    // D650: the formats of the node's OTHER enabled devices the runner may
    // jump a detail step to — the SAME roster the attach carries (built by
    // `buildJumpRoster`). Empty ⇒ the gate is the elected format alone.
    const jumpFormats = [...new Set(jumpDeviceKeys.map((k) => parseDeviceKey(k).format))]
    const {
      config: resolvedBase,
      skipped,
      droppedRoots,
    } = resolvePipelineWithSkips(cam, deviceFormat, catalog, jumpFormats)
    // D2 SKIP status — surfaced ONLY here, at dispatch/resolve time for the
    // node the camera is ACTUALLY assigned to (this method is the dispatch
    // path). An idle on-motion camera with no standing placement never reaches
    // this log until it dispatches, so we don't spam "no model on node" for
    // cameras that aren't running. Gated ON for the camera but NO device of
    // the node it may run on has a build (D650) → dropped and reported here,
    // naming what was asked: the elected device and the jump roster.
    if (skipped.length > 0) {
      this.deps.logger.warn('pipeline steps gated on but not provisioned on this node — skipped', {
        tags: { deviceId, nodeId: agentNodeId },
        meta: {
          skipped: skipped.map((s) => `${s.addonId}:${s.reason}`).join(','),
          electedDeviceKey: deviceKey ?? null,
          electedFormat: deviceFormat,
          jumpDeviceKeys: jumpDeviceKeys.join(','),
          why: 'no enabled device of this node the step may run on ships a build for it (a root must run on the elected device; a detail step on the elected device or a jump-roster device)',
        },
      })
    }
    const resolved: CameraPipelineConfig = {
      ...resolvedBase,
      steps: applyPackageZoneActivation(resolvedBase.steps, hasPackageZone),
    }
    if (resolved.steps.length === 0) {
      // Tree built from the catalog + per-camera stepToggles returned 0 steps =
      // operator gated every step off (or none has a model for this device's
      // format). Honour intent.
      this.deps.logger.info(
        'resolvePipelineForDevice → empty (all steps gated off/unprovisioned)',
        {
          tags: { deviceId, nodeId: agentNodeId },
          meta: {
            deviceFormat,
            skipped: skipped.map((s) => s.addonId).join(','),
            catalogSlotCount: catalog.slots?.length ?? 0,
          },
        },
      )
    }
    return { kind: 'resolved', config: resolved, droppedRoots }
  }

  /**
   * Loss-proof `pipeline-executor` gate (D8 — reconcile against the
   * authority, never wait solely on an event).
   *
   * Readiness events are telemetry and MAY be lost across process/node
   * hops (2026-07-17 incident: the agent's executor came back callable
   * after an update, its `ready` delta never reached the hub registry,
   * and the former `acquireCapability(…, Infinity)` gate wedged every
   * dispatch forever). Each round of this loop therefore:
   *
   *  1. Probes the PROVIDER itself — `getCatalogForAgent` is a live
   *     `pipelineExecutor.getSchema` RPC routed to `nodeId` (30s success
   *     cache). The provider answering IS readiness, whatever the local
   *     registry believes.
   *  2. On a miss, falls back to a BOUNDED registry wait
   *     (`EXECUTOR_RECONCILE_ROUND_MS`) — the event-driven fast path that
   *     keeps the healthy cold-boot case latency-free (the wait resolves
   *     the instant the `ready` delta lands). A lost event costs at most
   *     one round, never forever.
   *
   * If the registry claims `ready` but the probe still misses (stale
   * record for a dead provider), rounds pace at
   * `EXECUTOR_READY_PROBE_PACE_MS` instead of spinning hot.
   *
   * Returns `null` only when `maxRounds` is exhausted (bounded callers)
   * or the store was disposed mid-wait.
   */
  private async awaitExecutorCatalog(
    nodeId: string,
    opts: { readonly maxRounds?: number } = {},
  ): Promise<PipelineSchema | null> {
    const maxRounds = opts.maxRounds ?? Number.POSITIVE_INFINITY
    const startedAt = Date.now()
    for (let round = 1; !this.disposed; round++) {
      const catalog = await this.getCatalogForAgent(nodeId)
      if (catalog) return catalog
      if (round >= maxRounds) return null
      if (round > 1) {
        this.deps.logger.warn(
          'executor reconcile: provider not answering yet — waiting one more round',
          { tags: { nodeId }, meta: { round, elapsedMs: Date.now() - startedAt } },
        )
      }
      const readyPerRegistry = await this.deps
        .acquireCapability(
          PIPELINE_EXECUTOR_CAP,
          { type: 'node', nodeId },
          { timeoutMs: PipelineSettingsStore.EXECUTOR_RECONCILE_ROUND_MS },
        )
        .then(
          () => true,
          () => false,
        )
      if (this.disposed) break
      if (readyPerRegistry) {
        await sleep(PipelineSettingsStore.EXECUTOR_READY_PROBE_PACE_MS)
      }
    }
    return null
  }

  /**
   * Block until `pipeline-executor` answers on `nodeId` AND
   * `getCatalogForAgent` returns a non-null catalog AND `agentSettings`
   * for that node exists (a bare entry is seeded if absent).
   *
   * The executor gate is {@link awaitExecutorCatalog} — reconcile-driven
   * and UNBOUNDED here (cameras must never be dispatched with empty
   * steps), but it converges as soon as the provider answers even when
   * every readiness event was lost.
   *
   * Smell #20 fix: the retry loop used to be `while (true)` with no exit
   * — a resolve in flight at addon shutdown would spin against a torn-
   * down ctx forever. It now re-checks `this.disposed` every iteration
   * (including right after each `sleep`) and throws a clean abort error
   * once `dispose()` has been called, instead of looping. Normal-path
   * timing (2s backoff, same retry conditions) is unchanged.
   */
  private async waitForAgentAndCatalog(nodeId: string): Promise<{
    agent: AgentSettingsMapBlob[string]
    catalog: PipelineSchema
  }> {
    while (!this.disposed) {
      const catalog = await this.awaitExecutorCatalog(nodeId)
      if (!catalog) break // disposed mid-wait — fall through to the abort throw
      let agent = (await this.readAgentSettingsMap())[nodeId]
      if (!agent) {
        const seeded = await this.seedAgentSettingsFromCatalog(nodeId)
        if (!seeded) {
          await sleep(2_000)
          continue
        }
        // Re-read after seeding so `agent` carries the full persisted blob.
        agent = (await this.readAgentSettingsMap())[nodeId]
      }
      if (!agent) {
        await sleep(2_000)
        continue
      }
      return { agent, catalog }
    }
    throw new Error(
      `PipelineSettingsStore.waitForAgentAndCatalog: aborted for node "${nodeId}" — store disposed during shutdown`,
    )
  }

  // ── Node caps / weights (balancer inputs) ─────────────────────────────

  /**
   * Build a per-node camera cap map from the persisted agent settings.
   * Returns `null` for nodes where `maxCameras` is null (unlimited).
   * Used by every `balance()` call so the balancer can honour operator-set
   * per-node maximums without polling the store on each decision.
   */
  async buildNodeCaps(): Promise<Record<string, number | null>> {
    const blob = await this.agentSettingsState.get()
    const caps: Record<string, number | null> = {}
    for (const [nodeId, settings] of Object.entries(blob)) {
      caps[nodeId] = settings.maxCameras ?? null
    }
    return caps
  }

  /**
   * Build a per-node detection WEIGHT map from the persisted agent settings —
   * the sibling of {@link buildNodeCaps}. Nodes without a stored `detectWeight`
   * are simply absent (the balancer treats absent as weight 1). Passed to every
   * `balance()` call so unpinned cameras distribute proportionally to weight.
   */
  async buildNodeWeights(): Promise<Record<string, number>> {
    if (this.effectiveNodeWeights !== null) return this.effectiveNodeWeights()
    return this.buildStoredNodeWeights()
  }

  /**
   * The operator's stored node sliders, whatever the share source — what
   * `manual` applies and what `auto` falls back to before its first answer.
   */
  async buildStoredNodeWeights(): Promise<Record<string, number>> {
    const blob = await this.agentSettingsState.get()
    const weights: Record<string, number> = {}
    for (const [nodeId, settings] of Object.entries(blob)) {
      if (typeof settings.detectWeight === 'number' && settings.detectWeight > 0) {
        weights[nodeId] = settings.detectWeight
      }
    }
    return weights
  }

  /**
   * Where {@link buildNodeWeights} reads from once the share source is wired
   * (D750): the effective shares (automatic or manual). Every balancer, the
   * share election and the stress failover read through it, so they can never
   * disagree on what a node's share is. Unset (tests, early boot) ⇒ stored.
   */
  private effectiveNodeWeights: (() => Promise<Record<string, number>>) | null = null

  setEffectiveNodeWeights(read: () => Promise<Record<string, number>>): void {
    this.effectiveNodeWeights = read
  }

  /**
   * The per-(node,device) BASE provisioning (C7.2/C7.4) for one `(node,
   * deviceKey)` — the effective `stepId → {modelId?, settings?}` map the
   * dispatch provisioning stage attaches onto the resolved step tree before
   * attach. `modelId` / `jumpDeviceKey` come strictly from THIS deviceKey's
   * stored entry (hardware concerns — formats differ across a node's
   * accelerators); step `settings` are the node-wide layer
   * (`agentSettings[node].stepSettings`) under this device's own entry, via
   * {@link nodeDeviceBase} (D927) — a sibling entry is never read.
   * Read-only: a fresh copy so callers can't mutate the persisted blob. A
   * stepId absent from the result ⇒ that step uses its device format default
   * (no attach).
   */
  async buildNodeInferenceDeviceSteps(
    nodeId: string,
    deviceKey: string,
  ): Promise<Record<string, DeviceStepConfig>> {
    const blob = await this.agentSettingsState.get()
    return nodeDeviceBase(blob[nodeId], deviceKey)
  }

  /**
   * The provisioning SOURCES of every device an attach may run a step on
   * (D650): for each requested `deviceKey`, its per-(node,device) base (the
   * same fold as {@link buildNodeInferenceDeviceSteps}) and the camera's
   * camera-semantic settings layer — the same on every device, and never a
   * model (D927). ONE read of each blob for the whole set — the elected
   * device and every jump target. `''` is the default pool: its base is the
   * node's folded settings.
   */
  async readDeviceProvisioning(
    deviceId: number,
    nodeId: string,
    deviceKeys: readonly string[],
  ): Promise<ReadonlyMap<string, DeviceProvisioningSource>> {
    const [agentBlob, cameraMap] = await Promise.all([
      this.agentSettingsState.get(),
      this.readCameraSettingsMap(),
    ])
    const node = agentBlob[nodeId]
    const cameraLayer = layerCameraStepSettings(cameraMap[String(deviceId)]?.stepSettings)
    const out = new Map<string, DeviceProvisioningSource>()
    for (const deviceKey of deviceKeys) {
      out.set(deviceKey, {
        base: nodeDeviceBase(node, deviceKey),
        override: cameraLayer,
      })
    }
    return out
  }

  // ── Structural guards ──────────────────────────────────────────────

  /**
   * Structural runtime check for `CameraPipelineConfig`. Persisted JSON
   * may be stale or partial across upgrades, so we gate reads on shape
   * rather than trusting the raw object. False = silently ignore that
   * entry and fall back to defaults — the orchestrator's job is to
   * never crash on corrupt store state.
   *
   * Data only: `engine` is no longer required — a persisted config may
   * still carry a vestigial `engine` from before the data-only refactor;
   * it is simply ignored.
   */
  isCameraPipelineConfig(value: unknown): value is CameraPipelineConfig {
    if (!value || typeof value !== 'object') return false
    const v = value as Record<string, unknown>
    return Array.isArray(v['steps'])
  }
}

/**
 * The camera's CAMERA-WIDE settings (D754) as the provisioning override every
 * accelerator merges over its base: per step, `settings` only — a camera
 * carries no model (D927), and a model-scoped key a legacy row may still hold
 * (a model binding, a `minConfidence*` floor) is dropped here, never applied:
 * it belongs to the accelerator that runs the model. The full order is
 * node ⊕ camera. Fresh objects; a camera with no layer yields `{}`.
 */
export function layerCameraStepSettings(
  cameraWide: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Record<string, CameraStepLayer> {
  const out: Record<string, CameraStepLayer> = {}
  for (const [stepId, settings] of Object.entries(cameraWide ?? {})) {
    const scoped = cameraScopedStepSettings(settings)
    if (Object.keys(scoped).length === 0) continue
    out[stepId] = { settings: scoped }
  }
  return out
}
