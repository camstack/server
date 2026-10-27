/**
 * The hub the feeder acceptance spec runs on (D663, Task 14) — REAL components
 * wired the way production wires them, fakes only at the true edges:
 *
 *   REAL: `DeviceManagerAddon` (its `DeviceStateMirror`, the field-claims index,
 *   the claimed-status overlay it installs on the registry at init, getBindings,
 *   getDeviceStatusAggregate, removeDevice) over a sqlite-backed row store; a
 *   `CapabilityRegistry` declaring every cap; the `SystemEventBus`;
 *   `ComposerAddon` itself (its SourceTracker ports, its `GraftHost` over a
 *   `createBrokerDeviceManagerApi` context, its event subscriptions); the HA
 *   side's `DeviceContext`s from the same kernel factory (`registerNativeCap` /
 *   `unregisterNativeCap` emit `device.bindings-changed` exactly as in
 *   production); `core-blocks`' `CoreBlockStore`, `BlockSupervisor` and
 *   composition API (server-derived name, one customization per device).
 *
 *   FAKE: the HA feed (which native slice each entity pushes, and the runner's
 *   own `getStatus`, which answers that native slice — the wrong answer for a
 *   claimed cap, which is the point), the settings doors under the stores, and
 *   the RPC hop — `hubApi` answers `ctx.api` calls by calling the real
 *   providers, with an injectable failure per slice read.
 *
 * Nothing here pre-seeds what production must fetch: every slice the composer
 * sees came through `deviceState.setCapSlice`, every binding through a
 * `registerNativeCap`.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ALL_CAPABILITY_DEFINITIONS,
  type AddonApi,
  type AddonContext,
  COMPOSER_ADDON_ID,
  type CompositionSourceRef,
  type DeviceContext,
  type DeviceManagerApi,
  DeviceType,
  type IComposerProvider,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { vi } from 'vitest'
import { SystemEventBus } from '../../../events/system-event-bus.js'
import { CapabilityRegistry } from '../../../kernel/capability-registry.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { createBrokerDeviceManagerApi } from '../../../kernel/moleculer/device-cap-proxy.js'
import { type BlockProcessHost, BlockSupervisor } from '../../core-blocks/block-supervisor.js'
import { buildCompositionApi, type CompositionApi } from '../../core-blocks/composition-api.js'
import { describeCompositionSources } from '../../core-blocks/composition-sources.js'
import { CoreBlockStore } from '../../core-blocks/core-block-store.js'
import { coreBlocksRecordKinds } from '../../core-blocks/record-kinds.js'
import {
  coreBlockRecordsHarness,
  exportCoreBlockKindRows,
  type FakeSettingsStore,
  fakeSettingsStore,
  seedCoreBlockKindRows,
} from '../../core-blocks/__tests__/fixtures.js'
import {
  type Harness,
  type HarnessSettings,
  setup,
  type Unreadable,
} from '../../device-manager/__tests__/device-manager-harness.js'
import type { FakeSettingsStore as DeviceRowsStore } from '../../device-manager/__tests__/settings-store-api.js'
import { ComposerAddon } from '../composer.addon.js'
import { LOOKUP_CAP } from './fixtures.js'
import {
  BATTERY_CAM,
  CHILD_TYPE,
  CONTAINER_TYPE,
  childRef,
  FEEDER,
  FEEDER_ENTITIES,
  firstPush,
  HA,
} from './feeder-fixture.js'

export const HUB = 'hub'
export const CALLER = { userId: 'admin', isAdmin: true }

/** One method of a provider as the registry and the RPC hop call it. */
export type ProviderMethod = (input: unknown) => Promise<unknown>
export type ProviderRecord = Record<string, ProviderMethod>

/** The persisted state a restarted hub boots from: the device-manager's doors and the core-blocks rows. */
export interface PersistedHub {
  readonly settings: HarnessSettings
  readonly settingsStore: DeviceRowsStore
  readonly addonStoreUnreadable: Unreadable
  readonly blockRows: FakeSettingsStore['rows']
  /** The HA devices a restarted HA runner re-registers, by stable id. */
  readonly haIds: ReadonlyMap<string, number>
}

function silentLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => l,
    withTags: () => l,
  }
  return l
}

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The HA runner, faked at its edge: which native slice each entity pushes (through
 * the REAL `setCapSlice` a `BaseDevice` writer reaches), and the runner's OWN
 * provider per (device, cap) — whose `getStatus` answers the NATIVE slice, as
 * `HaBinarySensorDevice.readSlice` / `HaContainerDevice` do.
 */
export class HaRunner {
  private readonly contexts = new Map<number, DeviceContext>()
  private readonly ids = new Map<string, number>()
  private readonly natives = new Map<string, Readonly<Record<string, unknown>>>()
  private readonly providers = new Map<string, ProviderRecord>()

  constructor(
    private readonly world: Pick<World, 'dm'>,
    readonly devices: DeviceManagerApi,
  ) {}

  id(ref: CompositionSourceRef): number {
    const id = this.ids.get(ref.stableId)
    if (id === undefined) throw new Error(`HA has not adopted ${ref.stableId}`)
    return id
  }

  knownIds(): ReadonlyMap<string, number> {
    return this.ids
  }

  /** Adoption: the row, exactly as a forked provider's `register` writes it over `ctx.api`. */
  async adopt(
    ref: CompositionSourceRef,
    type: DeviceType,
    parentDeviceId: number | null,
    knownId?: number,
  ): Promise<number> {
    const { dm } = this.world
    const id =
      knownId ?? (await dm.provider.allocateDeviceId({ addonId: HA, stableId: ref.stableId })).id
    // The HA runner is a FORKED child: its devices live in its own registry,
    // never the hub's — the hub knows them only by their row (`listAll`'s
    // persisted branch), so a removed row is gone for every reader.
    await dm.provider.registerDevice({
      addonId: HA,
      stableId: ref.stableId,
      id,
      type,
      name: ref.stableId,
      parentDeviceId,
      config: {},
    })
    this.ids.set(ref.stableId, id)
    this.contexts.set(id, this.devices.createContext(ref.stableId, id, parentDeviceId))
    return id
  }

  /** `registerNativeCap` on the HA device's context; `extra` are the runner's other methods (`wakeForStream`). */
  register(id: number, capName: string, extra: ProviderRecord = {}): void {
    const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === capName)
    const ctx = this.contexts.get(id)
    if (def === undefined || ctx === undefined) throw new Error(`cannot register ${capName}@${id}`)
    const provider: ProviderRecord = {
      ...extra,
      getStatus: async () => this.natives.get(`${id}#${capName}`) ?? null,
    }
    this.providers.set(`${id}#${capName}`, provider)
    ctx.registerNativeCap(def, provider)
  }

  unregister(id: number, capName: string): void {
    const ctx = this.contexts.get(id)
    if (ctx?.unregisterNativeCap === undefined) throw new Error(`no context for ${id}`)
    ctx.unregisterNativeCap(capName)
  }

  /** A state push: the runner's own slice, then the hub write every consumer reads. */
  async push(id: number, capName: string, slice: Readonly<Record<string, unknown>>): Promise<void> {
    this.natives.set(`${id}#${capName}`, slice)
    await this.world.dm.setCapSlice(id, capName, { ...slice })
  }

  /** The runner's own provider — what a route straight to the owning runner reaches. */
  runnerProvider(id: number, capName: string): ProviderRecord {
    const p = this.providers.get(`${id}#${capName}`)
    if (p === undefined) throw new Error(`HA serves no ${capName}@${id}`)
    return p
  }
}

/** A `ctx.api` call the composer (or anyone) made through the hop. */
export interface HubCall {
  readonly path: string
  readonly input: unknown
}

export interface World {
  readonly bus: SystemEventBus
  /** Every event, in emit order. */
  readonly events: SystemEvent[]
  readonly capabilities: CapabilityRegistry
  readonly dm: Harness
  readonly ha: HaRunner
  readonly hubCalls: HubCall[]
  /** `${deviceId}#${cap}` whose slice reads throw at the hop (the RPC edge). */
  readonly failingSliceReads: Set<string>
  readonly composer: IComposerProvider
  readonly composerAddon: ComposerAddon
  /** Contexts the composer's graft host created, by device id — their `unregisterNativeCap` is spied. */
  readonly graftContexts: Map<number, DeviceContext>
  readonly blocks: CoreBlockStore
  readonly blockSettings: FakeSettingsStore
  readonly supervisor: BlockSupervisor
  readonly compositions: CompositionApi
  /** A provider-side device API over this world's real hub RPC and registries. */
  createProviderApi(addonId: string): DeviceManagerApi
  persisted(): Promise<PersistedHub>
}

/** No code block exists here: the host is never asked to spawn. */
const IDLE_HOST: BlockProcessHost = {
  list: async () => [],
  spawn: async () => {
    throw new Error('unreachable: no code block is stored')
  },
  stop: async () => undefined,
}

function hubApiOver(dm: Harness, calls: HubCall[], failing: ReadonlySet<string>): AddonApi {
  const SLICE_READS = new Set(['getCapSlice', 'getNativeCapSlice'])
  const call = async (ns: string, method: string, input: unknown): Promise<unknown> => {
    calls.push({ path: `${ns}.${method}`, input })
    if (ns === 'deviceHistory' && method === 'query') {
      return { resolution: 'raw', series: [], truncated: false }
    }
    const target: unknown =
      ns === 'deviceManager' ? dm.provider : ns === 'deviceState' ? dm.deviceState : undefined
    if (!isRecordValue(target)) throw new Error(`hub hop: no provider for ${ns}`)
    if (ns === 'deviceState' && SLICE_READS.has(method) && isRecordValue(input)) {
      const slot = `${String(input['deviceId'])}#${String(input['capName'])}`
      if (failing.has(slot)) throw new Error(`hub unreachable reading ${slot}`)
    }
    const fn: unknown = Reflect.get(target, method)
    if (typeof fn !== 'function') throw new Error(`hub hop: ${ns}.${method} is not served`)
    return await fn.call(target, input)
  }
  const leaf = (ns: string, method: string) => {
    const run = (input: unknown): Promise<unknown> => call(ns, method, input)
    return { query: run, mutate: run }
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, ns) =>
      typeof ns !== 'string'
        ? undefined
        : new Proxy(
            {},
            { get: (_u, method) => (typeof method === 'string' ? leaf(ns, method) : undefined) },
          ),
  }
  // Documented type boundary: a test double at the AddonApi boundary, as
  // room-device.e2e.spec.ts — every call lands on the REAL provider.
  return new Proxy({}, handler) as unknown as AddonApi
}

export interface WorldOptions {
  /** Boot from a previous world's persisted state (a hub restart). */
  readonly from?: PersistedHub
  /** How many of the core_blocks store's first reads fail (it answers not-loaded until one succeeds). */
  readonly blockStoreReadFailures?: number
  /** Called after the device-manager is up and BEFORE the composer boots: the HA runner re-registers. */
  readonly beforeComposer?: (world: Pick<World, 'dm' | 'ha' | 'failingSliceReads'>) => Promise<void>
}

export async function buildWorld(opts: WorldOptions = {}): Promise<World> {
  const logger = silentLogger()
  const bus = new SystemEventBus()
  const events: SystemEvent[] = []
  bus.subscribe({}, (e) => {
    events.push(e)
  })
  const capabilities = new CapabilityRegistry(logger)
  for (const def of ALL_CAPABILITY_DEFINITIONS) capabilities.declareCapability(def)
  capabilities.ready()

  const dm = await setup({
    capabilityRegistry: capabilities,
    eventBus: bus,
    localNodeId: HUB,
    ...(opts.from !== undefined
      ? {
          persisted: {
            settings: opts.from.settings,
            settingsStore: opts.from.settingsStore,
            addonStoreUnreadable: opts.from.addonStoreUnreadable,
          },
        }
      : {}),
  })
  const hubCalls: HubCall[] = []
  const failingSliceReads = new Set<string>()
  const hubApi = hubApiOver(dm, hubCalls, failingSliceReads)
  const createProviderApi = (addonId: string): DeviceManagerApi =>
    createBrokerDeviceManagerApi({
      api: hubApi,
      addonId,
      nodeId: `${HUB}/${addonId}`,
      logger,
      eventBus: bus,
      registry: new DeviceRegistry(),
      capabilityRegistry: capabilities,
    })

  const ha = new HaRunner({ dm }, createProviderApi(HA))
  await opts.beforeComposer?.({ dm, ha, failingSliceReads })

  const composerDevices = createBrokerDeviceManagerApi({
    api: hubApi,
    addonId: COMPOSER_ADDON_ID,
    nodeId: `${HUB}/${COMPOSER_ADDON_ID}`,
    logger,
    eventBus: bus,
    registry: new DeviceRegistry(),
    capabilityRegistry: capabilities,
  })
  const graftContexts = new Map<number, DeviceContext>()
  const kernelDevices: DeviceManagerApi = {
    ...composerDevices,
    createContext: (stableId, id, parentDeviceId, persistedConfig) => {
      const ctx = composerDevices.createContext(stableId, id, parentDeviceId, persistedConfig)
      vi.spyOn(ctx, 'unregisterNativeCap')
      graftContexts.set(id, ctx)
      return ctx
    },
  }
  const composerAddon = new ComposerAddon()
  const init = await composerAddon.initialize(
    // Documented type boundary: the composer reads `api`, `logger`, `eventBus`
    // and `kernel.devices` / `kernel.localNodeId` of its context — the same
    // partial-context boundary `device-manager-harness.ts` uses.
    {
      id: COMPOSER_ADDON_ID,
      logger,
      eventBus: bus,
      api: hubApi,
      addonConfig: {},
      dataDir: os.tmpdir(),
      kernel: { devices: kernelDevices, localNodeId: HUB },
    } as unknown as AddonContext,
  )
  const registrations = Array.isArray(init) ? init : init?.providers
  const registration = registrations?.[0]
  const provider: unknown = registration?.provider
  if (!isRecordValue(provider) || typeof provider['applyBlocks'] !== 'function')
    throw new Error('the composer registered no composer provider')
  // Same boundary: the registration's provider is untyped at the `ProviderRegistration` seam.
  const composer = provider as unknown as IComposerProvider

  const blockSettings = fakeSettingsStore()
  let nextBlock = (opts.from?.blockRows.size ?? 0) + 1
  const blockHarness = await coreBlockRecordsHarness(logger, {
    newId: () => `blk-${nextBlock++}`,
  })
  if (opts.from?.blockRows !== undefined) {
    await seedCoreBlockKindRows(blockHarness.records, opts.from.blockRows)
  }
  let blocks: CoreBlockStore = blockHarness.store
  const failures = opts.blockStoreReadFailures ?? 0
  if (failures > 0) {
    const inner = blockHarness.records.kind(coreBlocksRecordKinds.blocks)
    let left = failures
    const flaky = {
      ...inner,
      query: async (q: Parameters<typeof inner.query>[0]): ReturnType<typeof inner.query> => {
        if (left > 0) {
          left -= 1
          throw new Error('SQLITE_BUSY')
        }
        return inner.query(q)
      },
    }
    blocks = new CoreBlockStore({ blocks: flaky, logger, newId: () => `blk-${nextBlock++}` })
  }
  const supervisor = new BlockSupervisor({
    nodeId: HUB,
    root: path.join(os.tmpdir(), 'camstack-feeder-e2e-unused'),
    store: blocks,
    host: IDLE_HOST,
    compile: async () => ({ ok: false, error: 'unreachable: no code block is stored' }),
    logger,
    composer: { apply: (input) => composer.applyBlocks(input) },
    integrationId: () => 'int_blocks',
    storeLoaded: () => blocks.isLoaded(),
    loadStore: () => blocks.load(),
  })
  const compositions = buildCompositionApi({
    store: blocks,
    describe: (sources, targets) =>
      describeCompositionSources(
        {
          listByAddon: async (addonId) => dm.provider.listAll({ addonId, projection: 'slim' }),
          bindings: async (deviceId) => (await dm.provider.getBindings({ deviceId })).entries,
        },
        sources,
        targets,
      ),
    lookupCap: LOOKUP_CAP,
    composerStates: async (blockIds) =>
      (await composer.getStates({ blockIds: [...blockIds] })).states,
    convergeSoon: () => undefined,
    convergeForClaims: async () => [],
    logger,
    capabilityDefinitions: ALL_CAPABILITY_DEFINITIONS,
  })

  return {
    bus,
    events,
    capabilities,
    dm,
    ha,
    hubCalls,
    failingSliceReads,
    composer,
    composerAddon,
    graftContexts,
    blocks,
    blockSettings,
    supervisor,
    compositions,
    createProviderApi,
    persisted: async () => ({
      settings: dm.settings,
      settingsStore: dm.settingsStore,
      addonStoreUnreadable: dm.addonStoreUnreadable,
      blockRows: await exportCoreBlockKindRows(blockHarness.records),
      haIds: ha.knownIds(),
    }),
  }
}

/**
 * Adopt the feeder (container + all 27 children, each registering the cap the
 * HA mapping gives it and pushing its first state) and the synthetic battery
 * camera. `knownIds` re-registers under the ids a previous boot allocated.
 */
export async function adoptHa(
  ha: HaRunner,
  at: number,
  knownIds: ReadonlyMap<string, number> = new Map(),
): Promise<void> {
  const feederId = await ha.adopt(FEEDER, CONTAINER_TYPE, null, knownIds.get(FEEDER.stableId))
  ha.register(feederId, 'device-status')
  await ha.push(feederId, 'device-status', { online: true, lastChangedAt: at })
  for (const entity of FEEDER_ENTITIES) {
    const ref = childRef(entity.entityId)
    const id = await ha.adopt(ref, CHILD_TYPE, feederId, knownIds.get(ref.stableId))
    ha.register(id, entity.cap)
    const slice = firstPush(entity, at)
    if (slice !== null) await ha.push(id, entity.cap, slice)
  }
  const camId = await ha.adopt(
    BATTERY_CAM,
    DeviceType.Container,
    null,
    knownIds.get(BATTERY_CAM.stableId),
  )
  // `HaContainerDevice`'s native battery: an HA entity has no wake path.
  ha.register(camId, 'battery', {
    wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
  })
  await ha.push(camId, 'battery', {
    level: 80,
    charging: 'none',
    sleeping: false,
    lastUpdated: at,
  })
}
