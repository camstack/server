import { type EventCatalog, EventCategory, type EventSource, type IEventBus } from '@camstack/types'
import type { IUpdateAvailabilityStore } from './update-availability-store.js'

export type UpdateAvailablePayload = EventCatalog['update.available']

export type UpdateAvailablePackage = {
  readonly packageName: string
  readonly currentVersion: string
  readonly latestVersion: string
  readonly nodeId?: string
}

/**
 * Emits update availability only when a successful check changes an observed
 * `latestVersion` (or first-sees a package/node that has one). Repeated polls
 * of the same latests are silent.
 *
 * One event carries the entire currently-available list **of one node** — the
 * scope that changed, never the union across nodes. The Notification Center
 * turns that into "2 aggiornamenti addon disponibili su agent-a" with
 * that node's packages under it.
 *
 * The union was the shape until 2026-08-19, and on a three-node cluster one
 * 6-hourly sweep sent the operator THREE pushes that each listed hub +
 * MacMiniAgent + agent-a and named no node: every scope's change
 * re-emitted the whole held map, so the notifications differed by one line and
 * read as identical. A list is only actionable if it belongs to somebody.
 *
 * A successful empty snapshot clears prior state for that scope; failed checks
 * should not call this method.
 *
 * When a {@link IUpdateAvailabilityStore} is injected the dedup state is
 * DURABLE: a restart does not re-announce what the operator already saw, and a
 * genuinely newer version still announces. Without one the emitter stays
 * RAM-only (the shape every unit test uses).
 */
export class UpdateAvailabilityEmitter {
  private readonly latestByKey = new Map<string, string>()
  private readonly held = new Map<string, UpdateAvailablePayload>()
  /** Set when in-memory state diverged from what the store last saw. */
  private dirty = false

  constructor(
    private readonly eventBus: IEventBus,
    private readonly source: EventSource,
    private readonly store?: IUpdateAvailabilityStore,
  ) {
    const persisted = store?.load() ?? null
    if (persisted === null) return
    for (const [key, version] of Object.entries(persisted.latestByKey)) {
      this.latestByKey.set(key, version)
    }
    for (const [key, candidate] of Object.entries(persisted.held)) {
      this.held.set(key, candidate)
    }
  }

  publishSnapshot(
    target: UpdateAvailablePayload['target'],
    candidates: readonly UpdateAvailablePayload[],
    nodeId?: string,
  ): void {
    const scope = nodeId ?? 'hub'
    const present = new Set<string>()
    let latestChanged = false
    for (const candidate of candidates) {
      if (candidate.target !== target) continue
      const stamped = stampNode(candidate, nodeId)
      const key = this.key(stamped)
      present.add(key)
      if (this.note(stamped)) latestChanged = true
    }
    for (const key of [...this.held.keys()]) {
      if (!key.startsWith(`${target}:${scope}:`)) continue
      if (present.has(key)) continue
      this.held.delete(key)
      this.latestByKey.delete(key)
      this.dirty = true
    }
    this.persistIfDirty()
    if (!latestChanged) return
    this.emitList(target, scope)
  }

  /** Publish a partial candidate set without treating omissions as up-to-date. */
  publishCandidates(candidates: readonly UpdateAvailablePayload[]): void {
    // Only the (target, node) pairs that actually moved are announced — a
    // partial sweep of one node must not re-announce another node's list.
    const changed = new Map<string, { target: UpdateAvailablePayload['target']; scope: string }>()
    for (const candidate of candidates) {
      if (!this.note(candidate)) continue
      const scope = scopeOf(candidate)
      changed.set(`${candidate.target}:${scope}`, { target: candidate.target, scope })
    }
    this.persistIfDirty()
    for (const { target, scope } of changed.values()) this.emitList(target, scope)
  }

  private note(candidate: UpdateAvailablePayload): boolean {
    const key = this.key(candidate)
    const previous = this.latestByKey.get(key)
    const previousHeld = this.held.get(key)
    if (
      previousHeld === undefined ||
      previousHeld.currentVersion !== candidate.currentVersion ||
      previousHeld.latestVersion !== candidate.latestVersion ||
      previousHeld.nodeId !== candidate.nodeId
    ) {
      this.dirty = true
    }
    this.held.set(key, candidate)
    this.latestByKey.set(key, candidate.latestVersion)
    return previous !== candidate.latestVersion
  }

  /**
   * Flush to the durable store. Called BEFORE the emit so a crash between the
   * two costs a duplicate announcement, never a silent one.
   */
  private persistIfDirty(): void {
    if (!this.dirty) return
    this.dirty = false
    this.store?.save({
      latestByKey: Object.fromEntries(this.latestByKey),
      held: Object.fromEntries(this.held),
    })
  }

  /** Announce ONE scope's full list. `scope` is the node id, `hub` for the hub. */
  private emitList(target: UpdateAvailablePayload['target'], scope: string): void {
    const list = [...this.held.values()].filter(
      (candidate) => candidate.target === target && scopeOf(candidate) === scope,
    )
    if (list.length === 0) return
    // Every row names its node, the hub's included: the row a caller published
    // without a nodeId is still ABOUT a node, and an unlabelled line in a
    // cluster-wide list is unreadable.
    const packages: UpdateAvailablePackage[] = list.map((candidate) => ({
      packageName: candidate.packageName,
      currentVersion: candidate.currentVersion,
      latestVersion: candidate.latestVersion,
      nodeId: scope,
    }))
    const head = list[0]!
    // `target: 'wrapper'` carries WHICH shell, and it has to survive the
    // rebuild here or the notification loses the only thing that makes it
    // actionable — a docker node would be told to press a button that cannot
    // exist. Absent for every other target.
    const wrapperKind = head.wrapperKind
    this.eventBus.emit({
      id: `update.available:${target}:${scope}:${packages
        .map((pkg) => `${pkg.packageName}@${pkg.latestVersion}`)
        .toSorted()
        .join(',')}`,
      timestamp: new Date(),
      source: this.source,
      category: EventCategory.UpdateAvailable,
      data: {
        target,
        packageName: head.packageName,
        currentVersion: head.currentVersion,
        latestVersion: head.latestVersion,
        packages,
        nodeId: scope,
        nodeIds: [scope],
        ...(wrapperKind !== undefined ? { wrapperKind } : {}),
      },
    })
  }

  private key(candidate: UpdateAvailablePayload): string {
    return `${candidate.target}:${scopeOf(candidate)}:${candidate.packageName}`
  }
}

/** The node an availability row belongs to. A row without one is the hub's. */
function scopeOf(candidate: UpdateAvailablePayload): string {
  return candidate.nodeId ?? 'hub'
}

function stampNode(
  candidate: UpdateAvailablePayload,
  nodeId: string | undefined,
): UpdateAvailablePayload {
  if (nodeId === undefined || candidate.nodeId !== undefined) return candidate
  return { ...candidate, nodeId }
}
