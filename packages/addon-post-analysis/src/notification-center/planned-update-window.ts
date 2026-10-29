/**
 * A node that ANNOUNCED an update is expected to go offline — the window that
 * says so lives here.
 *
 * `system.restarting` becomes `node-updating` / `node-restarting`; the centre
 * records the announcement per node (RAM, refreshed by the event, never by a
 * read — D49). An offline for that node inside {@link PLANNED_UPDATE_OFFLINE_GRACE_MS}
 * of the announcement is held for the whole window instead of the usual 60 s
 * hold-off: back in time means no offline notification at all, not back means
 * one offline that says it happened during an update. A lost announcement
 * (events may be dropped, D8) simply behaves as before.
 */

/** How long after an announcement an offline is held, and how long the announcement counts. */
export const PLANNED_UPDATE_OFFLINE_GRACE_MS = 10 * 60_000

const NC_PLANNED_UPDATE_NODES_MAX = 256

/** The slice of a system subject this window reads. */
export interface PlannedUpdateSubject {
  readonly kind: string
  readonly nodeId?: string
}

export class NcPlannedUpdateWindow {
  /** Insertion-ordered: the oldest node is evicted first. */
  private readonly announcedAt = new Map<string, number>()
  /** When an offline was put on hold, per node. */
  private readonly heldAt = new Map<string, number>()

  constructor(private readonly graceMs: number = PLANNED_UPDATE_OFFLINE_GRACE_MS) {}

  get windowMs(): number {
    return this.graceMs
  }

  get graceMinutes(): number {
    return Math.round(this.graceMs / 60_000)
  }

  /** Feed every system subject the intake accepted; only the two announcements are kept. */
  observe(system: PlannedUpdateSubject, atMs: number): void {
    if (system.kind !== 'node-updating' && system.kind !== 'node-restarting') return
    const nodeId = system.nodeId
    if (nodeId === undefined) return
    this.announcedAt.delete(nodeId)
    this.announcedAt.set(nodeId, atMs)
    while (this.announcedAt.size > NC_PLANNED_UPDATE_NODES_MAX) {
      const oldest = this.announcedAt.keys().next()
      if (oldest.done === true) break
      this.announcedAt.delete(oldest.value)
    }
  }

  /** True when the node announced an update no longer than the window ago. */
  isPlanned(nodeId: string, atMs: number): boolean {
    const at = this.announcedAt.get(nodeId)
    return at !== undefined && atMs - at <= this.graceMs
  }

  /** An offline was put on hold for this node. */
  hold(nodeId: string, atMs: number): void {
    this.heldAt.set(nodeId, atMs)
  }

  /**
   * The node is back: seconds the held offline lasted, or `null` when no offline
   * was held, or its window already ran out (the offline was sent).
   */
  release(nodeId: string, atMs: number): number | null {
    const at = this.heldAt.get(nodeId)
    if (at === undefined) return null
    this.heldAt.delete(nodeId)
    return atMs - at < this.graceMs ? Math.round((atMs - at) / 1000) : null
  }
}
