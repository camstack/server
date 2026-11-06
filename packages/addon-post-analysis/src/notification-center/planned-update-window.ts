/**
 * A node that ANNOUNCED an update is expected to go offline — the window that
 * says so lives here.
 *
 * `system.restarting` becomes `node-updating` / `node-restarting`; the centre
 * records the announcement per node (RAM, refreshed by the event, never by a
 * read — D49). An offline for that node inside {@link PLANNED_UPDATE_OFFLINE_GRACE_MS}
 * of the announcement is delivered at once, worded as an update, instead of
 * waiting on the usual hold-off. A lost announcement (events may be dropped,
 * D8) simply behaves as before.
 */

/** How long an announcement counts. */
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

  constructor(private readonly graceMs: number = PLANNED_UPDATE_OFFLINE_GRACE_MS) {}

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
}
