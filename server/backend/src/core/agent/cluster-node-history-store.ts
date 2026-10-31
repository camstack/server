import {
  ClusterNodeHistoryBodySchema,
  readAllRows,
  type ClusterNodeHistoryBody,
} from '@camstack/system'
import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import { z } from 'zod'
import { errMsg } from '@camstack/types'
import type { NodePackageEntry } from './agent-addon-backfill.js'
type ClusterNodeHistoryKind = RecordKindHandle<ClusterNodeHistoryBody>

/**
 * ClusterNodeHistoryStore — durable, routing-blind history of every cluster
 * node the hub has ever seen online.
 *
 * WHY THIS EXISTS (and why it is NOT a shadow registry):
 * `HubNodeRegistry` (`packages/system/.../node-registry.ts`) is the single
 * capability-routing authority and is deliberately EPHEMERAL — it holds only
 * the union of live `$hub.registerNode` manifests and drops a node the moment
 * it disconnects (CLAUDE.md rules #14/#15). It carries no timestamp and must
 * never gain one. This store is a SEPARATE concern: a liveness/history record
 * that lets `computeTopology` render an OFFLINE row for a node that is no
 * longer in the live Moleculer window (or after a hub restart). It never
 * participates in capability routing — nothing reads it to resolve a provider.
 *
 * PERSISTENCE: the `cluster-agent` owner's `node-history` records kind
 * (D881) — one row per nodeId, `at` = `lastActive` (the real `lastSeen` for
 * offline rows), `data.descriptor` = the static node descriptor + last-known
 * addonIds. There is no `cluster-node-history` table (D902): until the hub
 * binds the kind (`bindRecordsKind`, once the records provider is up) the
 * store is UNAVAILABLE — it writes nothing and every read is unanswered.
 *
 * All writes are best-effort: a records hiccup must never break
 * `listNodes()` / topology emission. Reads are validated and drop malformed
 * rows rather than throwing.
 */

/** The stored per-node descriptor (everything except the mutable `lastActive`). */
export interface ClusterNodeDescriptor {
  readonly id: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string | null
  readonly cpuCores: number
  readonly memoryMB: number
  readonly engines: readonly string[]
  readonly isHub: boolean
  readonly localIps: readonly string[]
  /** Last-known addon-id roster for the node — snapshotted while online (R3). */
  readonly addonIds: readonly string[]
  /**
   * Last-declared npm PACKAGE roster for the node — the intended set the addon
   * back-fill converges to after a wipe. Distinct from `addonIds` (declaration
   * ids) because delivery is per package, and one package ships many addons.
   *
   * Written by the node's own declaration (`$agent.status` during reconcile),
   * never invented hub-side. GROW-ONLY on write: `recordPackages` merges rather
   * than replaces, so a node that comes back wiped (reporting 4 of 14) cannot
   * erase the record of what it should have. It shrinks only through
   * {@link ClusterNodeHistoryStore.prunePackages}, driven by an explicit
   * undeploy.
   *
   * Optional: rows written before the back-fill shipped have no roster, which
   * reads as "the hub has no record for this node" — nothing is back-filled,
   * which is the safe direction.
   */
  readonly packages?: readonly NodePackageEntry[]
  /**
   * Packages deliberately removed from this node (D982) — a hub uninstall for
   * the node, or an operator undeploy. The desired set excludes them, so the
   * hub never puts one back; an explicit delivery to the node clears the entry.
   * Distinct from `packages`, which is only the node's last observation.
   */
  readonly tombstones?: readonly string[]
}

/**
 * What {@link ClusterNodeHistoryStore.forget} actually did.
 *
 *  - `removed`           — a row existed and is gone.
 *  - `not-found`         — there was no row; nothing changed.
 *  - `store-unavailable` — the records kind is not bound yet (early boot).
 *                          The row's fate is UNKNOWN — this must never be
 *                          reported as a deletion.
 *  - `failed`            — the store threw.
 */
export type ForgetHistoryOutcome = 'removed' | 'not-found' | 'store-unavailable' | 'failed'

/** A persisted node row: the descriptor plus its `lastActive` timestamp. */
export interface PersistedClusterNode extends ClusterNodeDescriptor {
  readonly lastActive: number
}

const DescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string().nullable(),
  cpuCores: z.number(),
  memoryMB: z.number(),
  engines: z.array(z.string()).readonly(),
  isHub: z.boolean(),
  localIps: z.array(z.string()).readonly(),
  addonIds: z.array(z.string()).readonly(),
  packages: z
    .array(z.object({ name: z.string(), version: z.string().nullable() }))
    .readonly()
    .optional(),
  tombstones: z.array(z.string()).readonly().optional(),
})

/** A row as the store reads it: `at` as `lastActive`, plus the descriptor. */
const RowDataSchema = z.object({
  lastActive: z.number(),
  descriptor: DescriptorSchema,
})

/**
 * How stale `lastActive` may get on an ONLINE node before an otherwise
 * unchanged snapshot is written anyway. Five minutes turns the 30 s topology
 * poll's 2,880 writes/node/day into 288 while keeping "last seen" honest to
 * within one window. Every real transition — descriptor change, disconnect —
 * is written on its own edge and is not subject to this bound.
 */
const LAST_ACTIVE_HEARTBEAT_MS = 5 * 60_000

/**
 * Structural equality over a node descriptor. Every field is a scalar or an
 * array of scalars/`{name,version}` pairs, so a JSON-shaped deep compare is
 * exact — and reference equality would be useless here, since the descriptor
 * is rebuilt from the live Moleculer registry on every poll.
 */
function descriptorsEqual(a: ClusterNodeDescriptor, b: ClusterNodeDescriptor): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.hostname === b.hostname &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.cpuModel === b.cpuModel &&
    a.cpuCores === b.cpuCores &&
    a.memoryMB === b.memoryMB &&
    a.isHub === b.isHub &&
    sameStrings(a.engines, b.engines) &&
    sameStrings(a.localIps, b.localIps) &&
    sameStrings(a.addonIds, b.addonIds) &&
    samePackages(a.packages, b.packages) &&
    sameStrings(a.tombstones ?? [], b.tombstones ?? [])
  )
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function samePackages(
  a: readonly NodePackageEntry[] | undefined,
  b: readonly NodePackageEntry[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.length === b.length && a.every((p, i) => p.name === b[i]?.name && p.version === b[i]?.version)
  )
}

export class ClusterNodeHistoryStore {
  private resolveKind: () => ClusterNodeHistoryKind | null

  constructor(
    private readonly logger: IScopedLogger,
    resolveKind: () => ClusterNodeHistoryKind | null = () => null,
  ) {
    this.resolveKind = resolveKind
  }

  /** Hub wiring after `records.forOwner('cluster-agent').declare(...)`. */
  bindRecordsKind(resolver: () => ClusterNodeHistoryKind | null): void {
    this.resolveKind = resolver
  }

  /**
   * Upsert a node's descriptor + addon roster while it is ONLINE, stamping
   * `lastActive = Date.now()`. Called on each `listNodes()` refresh for every
   * live node (R2 capture point).
   *
   * WRITES ONLY ON A CHANGE, OR ONCE PER {@link LAST_ACTIVE_HEARTBEAT_MS}.
   * `listNodes()` runs off the 30 s topology heartbeat, so the unconditional
   * upsert this used to be was the worst write:row ratio in the whole system —
   * measured on the live hub at ~6 upserts/minute = **8,640 a day to maintain
   * three rows**, i.e. 40 % of every ledger write on the hub, on the same shfs
   * SQLite file whose WAL checkpoint can stall hub-main for seconds (D96).
   *
   * Nothing is lost. `lastActive` exists to answer "when was this node last
   * seen", which only matters at OFFLINE resolution — and the disconnect edge
   * is written by {@link touch}, which is unbounded. The bound costs at most
   * five minutes of precision on a node that then disappeared without a
   * `$node.disconnected`, and buys 288 writes/day/node instead of 2,880.
   */
  async snapshot(descriptor: ClusterNodeDescriptor): Promise<void> {
    const kind = this.resolveKind()
    if (kind === null) return
    try {
      // Carry the package roster forward. `listNodes()` does not resolve it
      // (only the reconcile does), so writing this descriptor blind would erase
      // the back-fill's intended set on the very next topology poll.
      const existing = await this.readStored(kind, descriptor.id)
      const packages = descriptor.packages ?? existing?.descriptor.packages
      const tombstones = descriptor.tombstones ?? existing?.descriptor.tombstones
      const next: ClusterNodeDescriptor = {
        ...descriptor,
        ...(packages === undefined ? {} : { packages }),
        ...(tombstones === undefined ? {} : { tombstones }),
      }
      if (existing !== null && !this.worthWriting(existing, next)) return
      await this.writeStored(kind, descriptor.id, Date.now(), next)
    } catch (err) {
      this.logger.warn('snapshot upsert failed (best-effort)', {
        tags: { nodeId: descriptor.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Is this snapshot worth a commit? Yes when the descriptor CHANGED, or when
   * the stored `lastActive` has aged past the heartbeat bound. A read that
   * fails never reaches here — `snapshot` writes when there is no existing row.
   */
  private worthWriting(
    existing: { lastActive: number; descriptor: ClusterNodeDescriptor },
    next: ClusterNodeDescriptor,
  ): boolean {
    if (Date.now() - existing.lastActive >= LAST_ACTIVE_HEARTBEAT_MS) return true
    return !descriptorsEqual(existing.descriptor, next)
  }

  /** Read one node's row, validated. `null` when absent or malformed. */
  private async readStored(
    kind: ClusterNodeHistoryKind,
    nodeId: string,
  ): Promise<{ lastActive: number; descriptor: ClusterNodeDescriptor } | null> {
    const row = await kind.get(nodeId)
    if (row === null) return null
    const parsed = RowDataSchema.safeParse({
      lastActive: row.at ?? 0,
      descriptor: row.data.descriptor,
    })
    return parsed.success ? parsed.data : null
  }

  private async writeStored(
    kind: ClusterNodeHistoryKind,
    nodeId: string,
    lastActive: number,
    descriptor: ClusterNodeDescriptor,
  ): Promise<void> {
    const body = ClusterNodeHistoryBodySchema.safeParse({ descriptor })
    if (!body.success) return
    await kind.put({ id: nodeId, at: lastActive, data: body.data })
  }

  /** A placeholder descriptor for a node the topology pass has not seen yet. */
  private static placeholderDescriptor(nodeId: string): ClusterNodeDescriptor {
    return {
      id: nodeId,
      name: nodeId,
      hostname: nodeId,
      platform: 'unknown',
      arch: 'unknown',
      cpuModel: null,
      cpuCores: 0,
      memoryMB: 0,
      engines: [],
      isHub: false,
      localIps: [],
      addonIds: [],
    }
  }

  /**
   * The node's last-declared package roster — the intended set the back-fill
   * converges to. Empty when the hub has no record, which is the safe answer:
   * nothing is delivered rather than something guessed.
   */
  async getPackages(nodeId: string): Promise<readonly NodePackageEntry[]> {
    const kind = this.resolveKind()
    if (kind === null) return []
    try {
      return (await this.readStored(kind, nodeId))?.descriptor.packages ?? []
    } catch (err) {
      this.logger.warn('getPackages failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  /**
   * Merge a node's freshly declared package roster into its record.
   *
   * GROW-ONLY by construction: an entry absent from `packages` is left in place.
   * That is what makes a wiped node recoverable — it reconnects declaring 4 of
   * its 14 packages, and the record still names all 14. Removal is a separate,
   * explicit act ({@link prunePackages}).
   */
  async recordPackages(nodeId: string, packages: readonly NodePackageEntry[]): Promise<void> {
    if (packages.length === 0) return
    const kind = this.resolveKind()
    if (kind === null) return
    try {
      const existing = await this.readStored(kind, nodeId)
      const merged = new Map<string, NodePackageEntry>(
        (existing?.descriptor.packages ?? []).map((p) => [p.name, p]),
      )
      // The node's current declaration wins on version — it is the authority on
      // what it is actually running.
      for (const entry of packages) merged.set(entry.name, entry)
      const descriptor: ClusterNodeDescriptor = {
        ...(existing?.descriptor ?? ClusterNodeHistoryStore.placeholderDescriptor(nodeId)),
        packages: [...merged.values()],
      }
      await this.writeStored(kind, nodeId, existing?.lastActive ?? Date.now(), descriptor)
    } catch (err) {
      this.logger.warn('recordPackages failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Drop packages from a node's record. The ONLY way the intended set shrinks —
   * driven by an explicit undeploy (the operator's `nodes.undeployAddon`, or the
   * stale-addon reconcile), never by a node simply failing to report something.
   */
  async prunePackages(nodeId: string, names: readonly string[]): Promise<void> {
    if (names.length === 0) return
    const kind = this.resolveKind()
    if (kind === null) return
    try {
      const existing = await this.readStored(kind, nodeId)
      if (existing === null) return
      const current = existing.descriptor.packages
      if (current === undefined || current.length === 0) return
      const drop = new Set(names)
      const remaining = current.filter((p) => !drop.has(p.name))
      if (remaining.length === current.length) return
      await this.writeStored(kind, nodeId, existing.lastActive, {
        ...existing.descriptor,
        packages: remaining,
      })
      this.logger.info('pruned node package record', {
        tags: { nodeId },
        meta: { removed: [...drop] },
      })
    } catch (err) {
      this.logger.warn('prunePackages failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** The packages tombstoned for a node (D982). Empty when none or unreadable. */
  async getTombstones(nodeId: string): Promise<ReadonlySet<string>> {
    const kind = this.resolveKind()
    if (kind === null) return new Set()
    try {
      return new Set((await this.readStored(kind, nodeId))?.descriptor.tombstones ?? [])
    } catch (err) {
      this.logger.warn('getTombstones failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
      return new Set()
    }
  }

  /** Keep packages off a node: an operator undeploy / hub uninstall for it. */
  async addTombstones(nodeId: string, names: readonly string[]): Promise<void> {
    await this.editTombstones(nodeId, names, 'add')
  }

  /** An explicit delivery to the node lifts the tombstone. */
  async clearTombstones(nodeId: string, names: readonly string[]): Promise<void> {
    await this.editTombstones(nodeId, names, 'clear')
  }

  private async editTombstones(
    nodeId: string,
    names: readonly string[],
    mode: 'add' | 'clear',
  ): Promise<void> {
    if (names.length === 0) return
    const kind = this.resolveKind()
    if (kind === null) return
    try {
      const existing = await this.readStored(kind, nodeId)
      if (existing === null && mode === 'clear') return
      const current = new Set(existing?.descriptor.tombstones ?? [])
      const before = current.size
      for (const name of names) {
        if (mode === 'add') current.add(name)
        else current.delete(name)
      }
      if (current.size === before) return
      const base = existing?.descriptor ?? ClusterNodeHistoryStore.placeholderDescriptor(nodeId)
      await this.writeStored(kind, nodeId, existing?.lastActive ?? Date.now(), {
        ...base,
        tombstones: [...current].sort(),
      })
    } catch (err) {
      this.logger.warn('editTombstones failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err), mode },
      })
    }
  }

  /**
   * Touch `lastActive` for a node without rewriting its descriptor — used on
   * `$node.disconnected` so an offline node's "last seen" is the disconnect
   * time. A no-op if the node was never snapshotted (nothing to update).
   */
  async touch(nodeId: string): Promise<void> {
    const kind = this.resolveKind()
    if (kind === null) return
    try {
      const existing = await this.readStored(kind, nodeId)
      if (existing === null) return
      await this.writeStored(kind, nodeId, Date.now(), existing.descriptor)
    } catch (err) {
      this.logger.warn('touch failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Read the full persisted history, validated. Malformed rows are dropped. */
  async getAll(): Promise<readonly PersistedClusterNode[]> {
    return (await this.tryGetAll()) ?? []
  }

  /**
   * Read the full persisted history, validated, or `null` when the store did
   * not ANSWER (the kind is not bound yet, or the read threw). A caller that must not claim
   * a node absent from an unanswered read (D315) uses this; `getAll` folds the
   * `null` into `[]` for the callers that only render what exists. Malformed
   * rows are dropped (and logged) — the rest of the answer still stands.
   */
  async tryGetAll(): Promise<readonly PersistedClusterNode[] | null> {
    const kind = this.resolveKind()
    if (kind === null) return null
    try {
      const result: PersistedClusterNode[] = []
      const rows = (await readAllRows(kind)).map((row) => ({
        id: row.id,
        data: { lastActive: row.at ?? 0, descriptor: row.data.descriptor },
      }))
      for (const row of rows) {
        const parsed = RowDataSchema.safeParse(row.data)
        if (!parsed.success) {
          this.logger.warn('dropping malformed cluster-node-history row', {
            tags: { nodeId: row.id },
          })
          continue
        }
        result.push({
          ...parsed.data.descriptor,
          lastActive: parsed.data.lastActive,
        })
      }
      return result
    } catch (err) {
      this.logger.warn('history read failed (best-effort)', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Permanently forget a node's history row (the inline "Forget node" action).
   *
   * Returns WHAT HAPPENED, not void. The caller's answer to the operator is
   * only as honest as this: an unreachable store, a row that was never there,
   * and a row actually deleted are three different facts, and before
   * 2026-09-01 all three reached the UI as `{"success": true}`.
   */
  async forget(nodeId: string): Promise<ForgetHistoryOutcome> {
    const kind = this.resolveKind()
    if (kind === null) return 'store-unavailable'
    try {
      // Read first: `delete` on this provider is idempotent and cannot tell a
      // removal from a no-op, and "there was nothing to remove" is the answer
      // that stops an operator repeating a working action forever.
      const existed = (await this.readStored(kind, nodeId)) !== null
      await kind.delete(nodeId)
      if (!existed) {
        this.logger.info('cluster node had no history row to forget', {
          tags: { nodeId },
        })
        return 'not-found'
      }
      this.logger.info('forgot cluster node', { tags: { nodeId } })
      return 'removed'
    } catch (err) {
      this.logger.warn('forget failed (best-effort)', {
        tags: { nodeId },
        meta: { error: errMsg(err) },
      })
      return 'failed'
    }
  }
}
