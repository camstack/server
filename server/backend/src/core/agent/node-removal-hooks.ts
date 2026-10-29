/**
 * The hub's side of `node-removal-hook`: when the operator FORGETS a node, tell
 * every owner of node-scoped data so it removes or re-points what it keeps for
 * that node (#265). The node-scoped twin of the `device-removal-hook` (D865).
 *
 * **An implementer is told only on a recorded forget (a tombstone), never
 * because a node is absent from a read** (D49). The tombstone is written BEFORE
 * anyone is called; each acknowledgement shrinks its `pending` set; the row is
 * deleted when the set is empty. An implementer that was down is told by
 * {@link NodeRemovalDispatcher.redrive}, which the hub runs once the addons are
 * ready.
 *
 * Two owners are hub-resident and handled without the hook:
 * {@link clearSingletonNodeOverrides} (the per-node singleton overrides live in
 * the hub's capability registry and settings).
 */
import type { CapabilityRegistry } from '@camstack/system'
import {
  ClusterNodeTombstoneBodySchema,
  readAllRows,
  type ClusterNodeTombstoneBody,
} from '@camstack/system'
import { errMsg } from '@camstack/types'
import type {
  INodeRemovalHookProvider,
  IScopedLogger,
  NodeRemovedInput,
  NodeRemovedResult,
  RecordKindHandle,
} from '@camstack/types'
import type { ConfigService } from '../config/config.service'
import { singletonPreferenceKey } from '../../api/core/capability-preference-writes'

type TombstoneKind = RecordKindHandle<ClusterNodeTombstoneBody>

/** A recorded forget that at least one implementer has not acknowledged. */
export interface NodeTombstone {
  readonly nodeId: string
  readonly removedAt: number
  readonly pending: readonly string[]
}

/** Durable tombstones over the `cluster-agent` `node-tombstones` records kind. */
export class NodeTombstoneStore {
  constructor(
    private readonly logger: IScopedLogger,
    private resolveKind: () => TombstoneKind | null = () => null,
  ) {}

  /** Hub wiring once the records provider is up. */
  bindRecordsKind(resolver: () => TombstoneKind | null): void {
    this.resolveKind = resolver
  }

  /** Record the forget. `false` = not persisted (kind unbound, or the write failed). */
  async record(nodeId: string, removedAt: number, pending: readonly string[]): Promise<boolean> {
    const kind = this.resolveKind()
    if (kind === null) return false
    try {
      await kind.put({ id: nodeId, at: removedAt, data: { removedAt, pending } })
      return true
    } catch (err: unknown) {
      this.logger.warn('could not record node tombstone', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
      return false
    }
  }

  /** One implementer acknowledged: drop it from `pending`; delete the row when none is left. */
  async acknowledge(nodeId: string, addonId: string): Promise<void> {
    const kind = this.resolveKind()
    if (kind === null) return
    try {
      const row = await kind.get(nodeId)
      if (row === null) return
      const pending = row.data.pending.filter((id) => id !== addonId)
      if (pending.length === 0) await kind.delete(nodeId)
      else await kind.put({ id: nodeId, at: row.data.removedAt, data: { ...row.data, pending } })
    } catch (err: unknown) {
      this.logger.warn('could not acknowledge node tombstone', {
        tags: { nodeId },
        meta: { addonId, error: errMsg(err) },
      })
    }
  }

  /** Tombstones with an unacknowledged implementer. Unanswered read = none (a retry, never a delete). */
  async listPending(): Promise<readonly NodeTombstone[]> {
    const kind = this.resolveKind()
    if (kind === null) return []
    try {
      const out: NodeTombstone[] = []
      for (const row of await readAllRows(kind)) {
        const parsed = ClusterNodeTombstoneBodySchema.safeParse(row.data)
        if (parsed.success && parsed.data.pending.length > 0) {
          out.push({ nodeId: row.id, removedAt: parsed.data.removedAt, pending: parsed.data.pending })
        }
      }
      return out
    } catch (err: unknown) {
      this.logger.warn('could not list node tombstones', { meta: { error: errMsg(err) } })
      return []
    }
  }
}

/** What the dispatcher needs from the capability layer. */
export interface NodeRemovalHooks {
  /** Addon ids currently providing `node-removal-hook`. */
  implementers(): readonly string[]
  /** Call ONE implementer. Rejects when it cannot be reached or throws. */
  call(addonId: string, input: NodeRemovedInput): Promise<NodeRemovedResult>
}

export interface NodeRemovalDispatcherDeps {
  readonly hooks: NodeRemovalHooks
  readonly store: NodeTombstoneStore
  readonly logger: IScopedLogger
  /** Calls per implementer before it is left pending. Default 3. */
  readonly maxAttempts?: number
}

const DEFAULT_ATTEMPTS = 3

/** What a dispatch did, per implementer. */
export interface NodeRemovalReport {
  readonly acknowledged: readonly string[]
  readonly pending: readonly string[]
}

export class NodeRemovalDispatcher {
  constructor(private readonly deps: NodeRemovalDispatcherDeps) {}

  /** A node was forgotten: record the tombstone, then tell every implementer. */
  async nodeForgotten(nodeId: string, removedAt: number): Promise<NodeRemovalReport> {
    const implementers = this.deps.hooks.implementers()
    if (implementers.length === 0) return { acknowledged: [], pending: [] }
    const persisted = await this.deps.store.record(nodeId, removedAt, implementers)
    if (!persisted) {
      this.deps.logger.warn(
        'node tombstone not persisted — implementers are told now but cannot be re-driven',
        { tags: { nodeId } },
      )
    }
    return this.drive({ nodeId, removedAt, pending: implementers })
  }

  /** Re-drive every tombstone that still has a registered, unacknowledged implementer. */
  async redrive(): Promise<void> {
    for (const tombstone of await this.deps.store.listPending()) {
      await this.drive(tombstone)
    }
  }

  private async drive(tombstone: NodeTombstone): Promise<NodeRemovalReport> {
    const { nodeId, removedAt } = tombstone
    const registered = new Set(this.deps.hooks.implementers())
    const attempts = this.deps.maxAttempts ?? DEFAULT_ATTEMPTS
    const acknowledged: string[] = []
    const pending: string[] = []
    for (const addonId of tombstone.pending) {
      if (!registered.has(addonId)) {
        pending.push(addonId)
        continue
      }
      const done = await this.callWithRetries(addonId, { nodeId, removedAt }, attempts)
      if (done) {
        acknowledged.push(addonId)
        await this.deps.store.acknowledge(nodeId, addonId)
      } else {
        pending.push(addonId)
      }
    }
    return { acknowledged, pending }
  }

  private async callWithRetries(
    addonId: string,
    input: NodeRemovedInput,
    attempts: number,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await this.deps.hooks.call(addonId, input)
        this.deps.logger.info('node removal hook done', {
          tags: { nodeId: input.nodeId },
          meta: { addonId, counts: result.counts },
        })
        return true
      } catch (err: unknown) {
        this.deps.logger.warn('node removal hook failed', {
          tags: { nodeId: input.nodeId },
          meta: { addonId, attempt, attempts, error: errMsg(err) },
        })
      }
    }
    return false
  }
}

/** The registry surface the hook implementers are found and called through. */
export type NodeRemovalHookRegistry = Pick<
  CapabilityRegistry,
  'getProviderAddonIds' | 'getProviderByAddonId'
>

const NODE_REMOVAL_HOOK_CAP = 'node-removal-hook'

function isNodeRemovalHook(value: unknown): value is INodeRemovalHookProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'onNodeRemoved') === 'function'
  )
}

/** {@link NodeRemovalHooks} over the capability registry (keys include `addon@node`). */
export function registryNodeRemovalHooks(registry: NodeRemovalHookRegistry): NodeRemovalHooks {
  return {
    implementers: () => registry.getProviderAddonIds(NODE_REMOVAL_HOOK_CAP),
    call: async (addonId, input) => {
      const provider = registry.getProviderByAddonId(NODE_REMOVAL_HOOK_CAP, addonId)
      if (!isNodeRemovalHook(provider)) {
        throw new Error(`"${addonId}" no longer provides ${NODE_REMOVAL_HOOK_CAP}`)
      }
      return provider.onNodeRemoved(input)
    },
  }
}

/** The registry/settings surface the per-node singleton overrides live on. */
export type SingletonOverrideRegistry = Pick<
  CapabilityRegistry,
  'listCapabilities' | 'getSingletonNodeOverrides' | 'clearSingletonNodeOverride'
>

/**
 * A forgotten node leaves no per-node singleton override behind: for every
 * singleton capability, the persisted preference is cleared FIRST, then the
 * live override (the order `capabilities.clearSingletonNodeOverride` uses).
 * Returns how many overrides were cleared. A failed write leaves that override
 * in place and the error propagates — the caller reports it, nothing is hidden.
 */
export async function clearSingletonNodeOverrides(
  nodeId: string,
  registry: SingletonOverrideRegistry,
  config: Pick<ConfigService, 'set'>,
): Promise<number> {
  let cleared = 0
  for (const cap of registry.listCapabilities()) {
    if (cap.mode !== 'singleton') continue
    if (!registry.getSingletonNodeOverrides(cap.name).has(nodeId)) continue
    await config.set(singletonPreferenceKey(cap.name, nodeId), null)
    registry.clearSingletonNodeOverride(cap.name, nodeId)
    cleared += 1
  }
  return cleared
}
