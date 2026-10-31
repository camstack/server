/**
 * The `core-blocks` provider — CRUD over user-authored TypeScript, with the
 * compile gate in front of every write, and the supervisor that turns a stored
 * block into a running process.
 *
 * A builtin because a block belongs to the kernel, not to an addon: it is user
 * code the node runs, and it must exist on every install with no opt-in step.
 *
 * **Execution is HUB-ONLY for now**, and that limit is loud rather than
 * implied: a block placed on any other node is reported `failed` with a message
 * naming the node, because an enabled block nothing runs must never look like
 * an idle one. The supervisor is already written per-node (`converge()` only
 * ever considers blocks placed on `nodeId`), so the agent case is an
 * implementation of `BlockProcessHost` plus a way to reach the hub's store —
 * not a redesign.
 */

import * as path from 'node:path'
import {
  type AddonApi,
  ALL_CAPABILITY_DEFINITIONS,
  BaseAddon,
  buildCapabilityLookup,
  type ConfigUISchema,
  CORE_BLOCKS_ADDON_ID,
  type CoreBlock,
  type CoreBlockCompileInput,
  type CoreBlockInput,
  coreBlockComposition,
  coreBlocksCapability,
  actionsCapability,
  hydrateSchema,
  type IClusterBroker,
  type ICoreBlocksProvider,
  type IScopedLogger,
  normalizeCoreBlockWrite,
  type ProviderRegistration,
  remoteCapability,
  remoteLayoutComponentsCapability,
  templateCapability,
} from '@camstack/types'
import {
  type BlockProcessHost,
  type BlockRunnerSnapshot,
  BlockSupervisor,
} from './block-supervisor.js'
import { type ActionsRuntime, buildActionsRuntime } from './actions-wiring.js'
import { actionOwner, automationOwner } from './runs-ledger.js'
import { RemoteComponentsService } from './remote-components-service.js'
import { remoteCallRedirect } from './remote-call-redirect.js'
import { buildRemoteRuntime, type RemoteRuntime } from './remote-wiring.js'
import { BlockSettingsStore } from './block-settings-store.js'
import { type BlockTypeLib, loadBlockTypeDefs } from './block-type-defs.js'
import { armBlocksIntegration, reconcileBlocksIntegration } from './blocks-integration.js'
import { type BlockTranspiler, compileBlock } from './compile-block.js'
import { buildCompositionApi, type CompositionApi } from './composition-api.js'
import { describeCompositionSources } from './composition-sources.js'
import { CoreBlockStore } from './core-block-store.js'
import { coreBlocksRecordKinds } from './record-kinds.js'
import { extractSettingsSchema } from './extract-settings-schema.js'

/**
 * How often the supervisor re-reads the world.
 *
 * It is not the primary trigger — every write converges immediately — but the
 * one that catches what a write cannot: a runner that crashed, a breaker that
 * tripped, a spawn that never landed. D8: events may be dropped, so the
 * reconcile is what makes the outcome eventually true.
 */
const CONVERGE_INTERVAL_MS = 15_000

/** Where block packages are materialised, under this node's data root. */
const BLOCK_PACKAGE_DIRNAME = 'core-blocks'

export class CoreBlocksAddon extends BaseAddon {
  /**
   * `super({})` is NOT optional, and its absence is invisible until runtime:
   * `BaseAddon.resolveConfig` does `Object.keys(this.defaults)`, so an addon
   * that skips it dies at init with "Cannot convert undefined or null to
   * object" — while the build stays green, the tests pass, and the addon still
   * reports as `running`. Found in production, not here.
   */
  constructor() {
    super({})
  }

  private store: CoreBlockStore | null = null
  private prefs: BlockSettingsStore | null = null
  private transpiler: BlockTranspiler | null = null
  private typeDefs: readonly BlockTypeLib[] | null = null
  private supervisor: BlockSupervisor | null = null
  /** The actions surface and the runs ledger — built with the store, gone with it. */
  private actions: ActionsRuntime | null = null
  /** The templates engine and the remote — needs the per-device settings store, so absent without one. */
  private remoteRuntime: RemoteRuntime | null = null
  /** The shared integration, or null when this node does not own it. */
  private blocksIntegrationId: string | null = null

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const settingsStore = this.ctx.api?.settingsStore
    if (!settingsStore) {
      // Same discipline as local-auth: registering a cap that cannot persist
      // would be a lie the operator only discovers when their code vanishes.
      throw new Error(
        'core-blocks: settings-store API not available — refusing to register the cap',
      )
    }
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('core-blocks needs ctx.records on the hub')
    }
    await records.declare(coreBlocksRecordKinds)
    this.store = CoreBlockStore.of(records, this.ctx.logger.child('store'))
    this.prefs = new BlockSettingsStore({
      store: settingsStore,
      legacySettings: BlockSettingsStore.legacyKindOf(records),
      keychainFor: (owner) => this.ctx.secrets?.forOwner?.(owner) ?? null,
      onOrphaned: (blockId, refs) =>
        this.ctx.logger.warn('core block settings: dropped keychain refs could not be deleted', {
          meta: { blockId, refs: [...refs] },
        }),
    })
    await this.store.load()
    this.actions = buildActionsRuntime({
      records,
      api: () => this.ctx.api,
      eventBus: this.ctx.eventBus,
      logger: this.ctx.logger,
    })
    void this.sweepRunsLedger()
    void this.migrateActionTargets()
    this.remoteRuntime = this.buildRemote(records)

    // esbuild is imported lazily and ONCE: it is a real dependency, and a
    // failure to load it must degrade the compile gate rather than the node.
    this.transpiler = await loadTranspiler(this.ctx.logger)

    // The integration blocks' devices hang from — owned HERE, because a block
    // cannot own one (see `blocks-integration.ts`). ARMED, never awaited: it
    // reads a hub-CORE cap, and `$core-caps` is registered only after
    // `app.init()` returns — which is where this whole boot runs. Awaiting it
    // burned the full 30 s discovery deadline on the hub's serial builtin loop
    // and held `device-manager`, and with it every provider runner and every
    // camera (D167).
    armBlocksIntegration({
      logger: this.ctx.logger,
      reconcile: () => this.declareBlocksIntegration(),
      onLanded: (integrationId) => {
        this.blocksIntegrationId = integrationId
      },
    })

    this.supervisor = this.buildSupervisor()
    this.supervisor?.start(CONVERGE_INTERVAL_MS)

    this.ctx.logger.info('core-blocks ready', {
      meta: {
        blocks: this.store.list().length,
        compile: this.transpiler !== null,
        supervising: this.supervisor !== null,
        integrationId: this.blocksIntegrationId,
      },
    })
    return [
      { capability: coreBlocksCapability, provider: this.buildProvider() },
      { capability: actionsCapability, provider: this.requireActions().service },
      // The built-in palette needs no store: it is served even when the remote is not.
      { capability: remoteLayoutComponentsCapability, provider: new RemoteComponentsService() },
      ...this.remoteRegistrations(),
    ]
  }

  private buildRemote(records: NonNullable<typeof this.ctx.records>): RemoteRuntime | null {
    const settings = this.ctx.settings
    if (settings === undefined) {
      this.ctx.logger.warn(
        'core-blocks: no settings store — the remote and templates are not registered',
      )
      return null
    }
    const runtime = buildRemoteRuntime({
      records,
      settings,
      api: () => this.ctx.api,
      logger: this.ctx.logger,
    })
    // Precedence at DISPATCH (D963): the redirect lives in the registry, so it holds for every caller.
    const registry = this.ctx.kernel?.capabilityRegistry
    registry?.setDeviceCallRedirect(
      remoteCallRedirect({
        remote: runtime.remote,
        hasNative: (deviceId) => registry.getProviderForDevice('media-player', deviceId) !== null,
        logger: this.ctx.logger.child('remote'),
      }),
    )
    return runtime
  }

  private remoteRegistrations(): ProviderRegistration[] {
    const runtime = this.remoteRuntime
    if (runtime === null) return []
    return [
      { capability: templateCapability, provider: runtime.templates },
      { capability: remoteCapability, provider: runtime.remote },
    ]
  }

  protected async onShutdown(): Promise<void> {
    this.ctx.kernel?.capabilityRegistry?.setDeviceCallRedirect(null)
    this.remoteRuntime = null
    this.supervisor?.stop()
    this.supervisor = null
    this.store = null
    this.actions?.dispose()
    this.actions = null
    this.prefs = null
    this.transpiler = null
    this.typeDefs = null
  }

  /**
   * Build the supervisor, or explain in one line why this node runs no blocks.
   *
   * Two ways to end up with none, and both are logged rather than inferred:
   * this is not the hub (execution is hub-only for now), or the kernel exposed
   * no cluster broker, which is the only door to `$process.*`.
   */
  private buildSupervisor(): BlockSupervisor | null {
    // `localNodeId` on a FORKED child carries a `<node>/<addon>` suffix, so
    // comparing it raw skips every node — including the one meant to act. The
    // alarm panel lost a day to exactly this.
    const rawNodeId = this.ctx.kernel.localNodeId ?? 'hub'
    const nodeId = rawNodeId.includes('/') ? (rawNodeId.split('/')[0] ?? 'hub') : rawNodeId
    if (nodeId !== 'hub') {
      this.ctx.logger.info('core-blocks execution is hub-only — no blocks will run on this node', {
        meta: { nodeId, rawNodeId },
      })
      return null
    }
    const broker = this.ctx.kernel.cluster?.broker
    if (!broker) {
      this.ctx.logger.warn(
        'core-blocks: no cluster broker — blocks can be stored and compiled, but nothing can run them',
      )
      return null
    }
    const store = this.requireStore()
    return new BlockSupervisor({
      nodeId,
      root: path.join(this.ctx.nodeDataDir, BLOCK_PACKAGE_DIRNAME),
      store: {
        list: () => store.list(),
        get: (blockId) => store.get(blockId),
        unreadableCompositions: () => store.unreadableCompositions(),
        setStatus: (blockId, status, error) => store.setStatus(blockId, status, error),
      },
      host: createBrokerProcessHost(broker),
      compile: async (source) => {
        if (this.transpiler === null) {
          return { ok: false, error: 'the compiler is unavailable on this node' }
        }
        const input =
          source.files !== undefined
            ? { files: { ...source.files }, entry: source.entry }
            : source.code
        return compileBlock(this.transpiler, input)
      },
      logger: this.ctx.logger.child('supervisor'),
      // Compositions run in the shared `composer` builtin, never in a block
      // runner (D659). A composer that is not up yet throws here, and the
      // supervisor keeps each composition's last status (D49).
      composer: {
        apply: async (input) => {
          const api = this.ctx.api
          if (!api) throw new Error('no ctx.api on this node — the composer cannot be reached')
          return api.composer.applyBlocks.mutate(input)
        },
      },
      integrationId: () => this.blocksIntegrationId,
      storeLoaded: () => store.isLoaded(),
      loadStore: () => store.load(),
    })
  }

  /**
   * Own the integration blocks hang their devices from.
   *
   * A block cannot: every integration read is gated on the installed-addon set
   * and `core-block-<uuid>` is never in it, so a block's get-or-create minted a
   * fresh invisible row on every start. `core-blocks` IS installed, so it does
   * this once here and a block names the result by id.
   *
   * Failure is a feature missing, not a boot failure — blocks that declare no
   * devices are unaffected, and the next boot converges.
   */
  private async declareBlocksIntegration(): Promise<string | null> {
    const api = this.ctx.api
    if (!api?.integrations || !api?.deviceManager) {
      this.ctx.logger.warn(
        'core-blocks: no integrations API — a block that declares a device will have nowhere to hang it',
      )
      return null
    }
    // Deliberately NOT caught here: `armBlocksIntegration` owns the retry, and
    // the failure this sees during boot is the transient one (`$core-caps` not
    // registered yet). Swallowing it into `null` would make the first, doomed
    // attempt look like a final answer.
    return reconcileBlocksIntegration({
      logger: this.ctx.logger.child('integration'),
      devices: this.ctx.kernel.devices,
      localNodeId: this.ctx.kernel.localNodeId,
      getIntegration: async (addonId) => api.integrations.getByAddonId.query({ addonId }),
      createIntegration: async (input) => api.integrations.create.mutate(input),
      updateIntegration: async ({ id, info }) => {
        await api.integrations.update.mutate({ id, info, skipRestart: true })
      },
      // THE OWNER FILTER IS LOAD-BEARING. `core-blocks` declares no devices,
      // so every row this returns under the shared integration is a
      // withdrawal candidate — omit the filter and the sweep would delete
      // every block-declared device on the cluster.
      listOwnDevices: async () =>
        api.deviceManager.listAll.query({ addonId: CORE_BLOCKS_ADDON_ID }),
    })
  }

  /**
   * Reconcile now, after a write.
   *
   * The timer would get there on its own, but an operator who presses Save and
   * watches a block sit at `stopped` for fifteen seconds has been told nothing
   * happened. Deliberately NOT awaited by the cap method: converging forks a
   * process, and the write is already durable.
   */
  private convergeSoon(): void {
    void this.supervisor?.converge()
  }

  private requireActions(): ActionsRuntime {
    if (this.actions === null) throw new Error('core-blocks: not initialized')
    return this.actions
  }

  /**
   * Remove the ledger rows whose block is gone. Armed, not awaited: it is
   * housekeeping and a failure leaves orphans, which the next boot retries —
   * the failure is on the record, never a boot failure.
   */
  private async sweepRunsLedger(): Promise<void> {
    const actions = this.actions
    const store = this.store
    if (actions === null || store === null) return
    try {
      await actions.ledger.sweep(async () => {
        const live = new Set<string>()
        for (const block of store.list()) live.add(automationOwner(block.id))
        for (const entry of await actions.service.listInternal()) live.add(actionOwner(entry.id))
        return live
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('runs ledger sweep failed — orphan rows stay until the next start', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async migrateActionTargets(): Promise<void> {
    try {
      await this.actions?.service.migrateTargets()
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'internal actions could not be rewritten to the target shape — they are still read as it',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
    }
  }

  private requireStore(): CoreBlockStore {
    if (this.store === null) throw new Error('core-blocks: not initialized')
    return this.store
  }

  /**
   * Compile, or explain why not. Returns the emitted JS so a successful gate
   * can also extract `settingsSchema` without compiling twice.
   *
   * A missing transpiler REFUSES the write rather than waving it through: code
   * that reached disk uncompiled is code the runner will fail on, far from the
   * person who wrote it.
   */
  private async gate(input: Pick<CoreBlockInput, 'code' | 'files' | 'entry'>): Promise<string> {
    if (this.transpiler === null) {
      throw new Error('core-blocks: the compiler is unavailable — refusing to store unchecked code')
    }
    const normalized = normalizeCoreBlockWrite(input)
    const source =
      normalized.files !== undefined
        ? { files: normalized.files, entry: normalized.entry }
        : normalized.code
    const result = await compileBlock(this.transpiler, source)
    if (!result.ok || result.js === undefined) {
      const where = result.line !== undefined ? ` (line ${result.line})` : ''
      throw new Error(
        `core-blocks: the code does not compile${where}: ${result.error ?? 'unknown'}`,
      )
    }
    return result.js
  }

  private requirePrefs(): BlockSettingsStore {
    if (this.prefs === null) throw new Error('core-blocks: not initialized')
    return this.prefs
  }

  /**
   * After a successful compile, cache the entry's `settingsSchema` export on
   * the block when the author did not set one by hand. Never overwrites an
   * explicit schema the editor already stored.
   */
  private async maybeCacheSettingsSchema(
    blockId: string,
    js: string,
    existingSchema: ConfigUISchema | undefined,
  ): Promise<CoreBlock | null> {
    if (existingSchema !== undefined) return null
    const schema = await extractSettingsSchema(js)
    if (schema === null) return null
    return this.requireStore().update(blockId, { settingsSchema: schema })
  }

  private buildProvider(): ICoreBlocksProvider {
    return {
      list: async () => ({ blocks: [...this.requireStore().list()] }),
      get: async ({ blockId }) => ({ block: this.requireStore().get(blockId) }),

      create: async ({ block, caller }) => {
        const js = await this.gate(block)
        let created = await this.requireStore().create(block, caller.userId)
        const withSchema = await this.maybeCacheSettingsSchema(
          created.id,
          js,
          created.settingsSchema,
        )
        if (withSchema !== null) created = withSchema
        this.ctx.logger.info('core block created', {
          meta: { blockId: created.id, name: created.name, by: caller.userId },
        })
        this.convergeSoon()
        return { block: created }
      },

      update: async ({ blockId, block, caller }) => {
        // Only when the SOURCE changed: re-compiling on a rename would fail a
        // rename because of a pre-existing error, which is not the operator's
        // problem at that moment.
        const sourceChanged =
          block.code !== undefined || block.files !== undefined || block.entry !== undefined
        let js: string | null = null
        if (sourceChanged) {
          const existing = this.requireStore().get(blockId)
          js = await this.gate({
            code: block.code ?? existing?.code,
            files: block.files ?? existing?.files,
            entry: block.entry ?? existing?.entry,
          })
        }
        let updated = await this.requireStore().update(blockId, block)
        if (js !== null && block.settingsSchema === undefined) {
          const withSchema = await this.maybeCacheSettingsSchema(
            blockId,
            js,
            // Re-extract when source changed even if an old schema was cached —
            // the export may have changed with the code.
            undefined,
          )
          if (withSchema !== null) updated = withSchema
        }
        this.ctx.logger.info('core block updated', {
          meta: { blockId, by: caller.userId },
        })
        this.convergeSoon()
        return { block: updated }
      },

      delete: async ({ blockId }) => {
        const existing = this.requireStore().get(blockId)
        const composition = existing !== null && coreBlockComposition(existing) !== null
        await this.requireStore().delete(blockId)
        await this.requirePrefs().delete(blockId)
        await this.requireActions().ledger.delete(automationOwner(blockId))
        // A composition's claims must be gone before this returns: the next
        // create for the same device would otherwise be refused for good.
        // A code block's runner is stopped by the converge, which forks nothing
        // the caller has to wait on.
        if (composition && this.supervisor === null) {
          this.ctx.logger.error('composition deleted but no supervisor can release its claims', {
            meta: { blockId },
          })
          throw new Error(
            `core-blocks: "${blockId}" was deleted but no supervisor runs here — its claims were not released`,
          )
        }
        if (composition && this.supervisor !== null) {
          const unreleased = await this.supervisor.retireComposition(blockId)
          if (unreleased.length > 0) {
            for (const claim of unreleased) {
              this.ctx.logger.error('composition deleted but its claim was not released', {
                tags: { deviceId: claim.deviceId },
                meta: { blockId, cap: claim.capName, owner: claim.owner, error: claim.error },
              })
            }
            const detail = unreleased
              .map((claim) => `${claim.capName} on device ${claim.deviceId}: ${claim.error}`)
              .join('; ')
            throw new Error(
              `core-blocks: "${blockId}" was deleted but its claims were not released — ${detail}`,
            )
          }
        } else {
          this.convergeSoon()
        }
        return { success: true }
      },

      setEnabled: async ({ blockId, enabled }) => {
        const updated = await this.requireStore().update(blockId, { enabled })
        this.convergeSoon()
        return { block: updated }
      },

      /**
       * Awaited, like a composition delete.
       *
       * `create`/`update` of a code block deliberately do not wait — the write is already
       * durable and converging forks a process. A restart has no durable half:
       * the whole thing IS the converge, so returning before it ran would hand
       * the operator the old status and read as "nothing happened".
       */
      restart: async ({ blockId }) => {
        const store = this.requireStore()
        const block = store.get(blockId)
        if (block === null) throw new Error(`core-blocks: no block "${blockId}"`)
        if (!block.enabled) {
          // Restarting a disabled block would stop nothing and start nothing.
          // Saying so beats a button that appears to work.
          throw new Error(
            `core-blocks: "${block.name}" is disabled — enable it instead of restarting it`,
          )
        }
        if (this.supervisor === null) {
          throw new Error(
            'core-blocks: no block supervisor runs on this node — nothing here can restart a block',
          )
        }
        this.ctx.logger.info('core block restart requested', {
          meta: { blockId, name: block.name },
        })
        await this.supervisor.restart(blockId)
        return { block: store.get(blockId) ?? block }
      },

      compile: async (input: CoreBlockCompileInput) => {
        if (this.transpiler === null) {
          return { ok: false, error: 'the compiler is unavailable on this node' }
        }
        const source =
          input.files !== undefined
            ? { files: input.files, entry: input.entry }
            : (input.code ?? '')
        const { js: _js, ...verdict } = await compileBlock(this.transpiler, source)
        return verdict
      },

      getBlockSettings: async ({ blockId }) => {
        const block = this.requireStore().get(blockId)
        if (block === null) return null
        const schema = block.settingsSchema
        if (schema === undefined) return null
        // Markers, never values: a password reads as a "set" view (D789).
        const stored = await this.requirePrefs().readStored(blockId)
        return hydrateSchema(schema, stored, { inlineSecretsAsViews: true })
      },

      updateBlockSettings: async ({ blockId, patch }) => {
        const block = this.requireStore().get(blockId)
        if (block === null) throw new Error(`core-blocks: no block "${blockId}"`)
        await this.requirePrefs().mergeValues(blockId, block.settingsSchema, patch)
        return { success: true as const }
      },

      migrateRawSecrets: async ({ apply }) =>
        this.requirePrefs().migrateRawSecrets(
          this.requireStore()
            .list()
            .map((b) => ({ id: b.id, settingsSchema: b.settingsSchema })),
          apply,
        ),

      getTypeDefs: async () => {
        // Read once and held: 344 files off disk per keystroke would be absurd,
        // and they cannot change without the process restarting.
        this.typeDefs ??= await loadBlockTypeDefs(this.ctx.logger)
        return { libs: this.typeDefs.map((l) => ({ filePath: l.filePath, content: l.content })) }
      },

      ...this.requireActions().runsApi,

      ...this.buildCompositionApi(),
    }
  }

  /**
   * The composition methods (D659), flat. Sources and existing targets are read
   * over `ctx.api` at SAVE time — one slim listing per owning addon, one binding
   * read per found device — and a read that fails refuses the save rather than
   * skipping it.
   */
  private buildCompositionApi(): CompositionApi {
    const requireApi = (): AddonApi => {
      const api = this.ctx.api
      if (!api)
        throw new Error('core-blocks: no ctx.api on this node — compositions cannot be read')
      return api
    }
    return buildCompositionApi({
      store: this.requireStore(),
      describe: (sources, targets) =>
        describeCompositionSources(
          {
            listByAddon: async (addonId) => {
              const rows = await requireApi().deviceManager.listAll.query({
                addonId,
                projection: 'slim',
              })
              return rows.map((row) => ({
                id: row.id,
                stableId: row.stableId,
                type: row.type,
                ...(row.sourceInfo?.quantity === undefined
                  ? {}
                  : { quantity: row.sourceInfo.quantity }),
              }))
            },
            bindings: async (deviceId) =>
              (await requireApi().deviceManager.getBindings.query({ deviceId })).entries,
          },
          sources,
          targets,
        ),
      lookupCap: buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS),
      composerStates: async (blockIds) =>
        (await requireApi().composer.getStates.query({ blockIds: [...blockIds] })).states,
      convergeSoon: () => this.convergeSoon(),
      convergeForClaims: () => {
        if (this.supervisor === null) {
          return Promise.reject(
            new Error(
              'core-blocks: no block supervisor runs on this node — claims cannot be released',
            ),
          )
        }
        return this.supervisor.convergeForClaims()
      },
      logger: this.ctx.logger.child('compositions'),
      capabilityDefinitions: ALL_CAPABILITY_DEFINITIONS,
    })
  }
}

/**
 * The process plane, over the kernel's cluster broker.
 *
 * `$process.*` is the SAME infrastructure every addon runner uses — no new
 * Moleculer action, no second spawner, no parallel supervisor. That is the
 * whole point: a block gets fork, the UDS `ctx`, `CrashSupervisor` (D6) and
 * `execution.placement` because it is spawned exactly like an addon.
 */
function createBrokerProcessHost(broker: IClusterBroker): BlockProcessHost {
  return {
    list: async () => {
      const procs = await broker.call<undefined, readonly { name: string; state: string }[]>(
        '$process.list',
      )
      // `$process.list` is an untyped infra boundary; `state` is narrowed by
      // the supervisor's own state map, which treats an unknown value as
      // "not a state I act on".
      return procs as readonly BlockRunnerSnapshot[]
    },
    spawn: async ({ runnerId, addonId, addonDir }) => {
      await broker.call('$process.spawnRunner', {
        runnerId,
        addons: [{ addonId, addonDir }],
      })
    },
    stop: async (runnerId) => {
      await broker.call('$process.stop', { name: runnerId })
    },
  }
}

/**
 * Load esbuild lazily, and PROVE IT WORKS before trusting it.
 *
 * Returns null — never throws — so a node without a usable compiler still
 * boots, with the compile gate refusing writes rather than the node refusing
 * to start.
 *
 * The probe is not defensive decoration. On the live hub, 2026-08-08, the
 * import succeeded and `transform()` threw *"The esbuild JavaScript API cannot
 * be bundled"* (it had been inlined into `@camstack/system`'s dist, so it could
 * no longer find its own native binary). Importing successfully was therefore
 * NOT evidence the compiler worked — and because the failure arrived at
 * transform time, every save came back as
 * `core-blocks: the code does not compile: …`, which blames the author for a
 * broken node. Nobody could have written source that passed. One transform at
 * boot converts that into the honest answer the rest of this file already
 * gives: the compiler is unavailable here.
 */
async function loadTranspiler(logger: IScopedLogger): Promise<BlockTranspiler | null> {
  try {
    const mod: unknown = await import('esbuild')
    const transform = (mod as { transform?: unknown }).transform
    const build = (mod as { build?: unknown }).build
    if (typeof transform !== 'function') return null
    const transpiler: BlockTranspiler = {
      transform: transform as BlockTranspiler['transform'],
      ...(typeof build === 'function'
        ? {
            build: async (options) => {
              const result = (await (
                build as (o: typeof options) => Promise<{
                  errors: readonly {
                    text: string
                    location?: { line: number; column: number } | null
                  }[]
                }>
              )(options)) as {
                errors: readonly {
                  text: string
                  location?: { line: number; column: number } | null
                }[]
              }
              return { errors: result.errors }
            },
          }
        : {}),
    }
    await transpiler.transform('export default 0', {
      loader: 'ts',
      format: 'esm',
      target: 'node22',
    })
    return transpiler
  } catch (err) {
    logger.warn('core-blocks: esbuild unusable — code cannot be compiled on this node', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}

export type { CoreBlock }
