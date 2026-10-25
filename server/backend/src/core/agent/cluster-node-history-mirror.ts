import type { PersistedClusterNode } from './cluster-node-history-store'

/**
 * The durable node history as last READ SUCCESSFULLY, so `nodes.directory`
 * does not put a settings-thread round trip (14.8–18.3 s on a congested hub,
 * D317) on every picker open.
 *
 * No timer of its own. The topology emitter already reads the history on its
 * 30 s heartbeat (`computeTopologyPass` → `getClusterNodeHistory` →
 * `refresh()`), and that read feeds this mirror. `current()` reads only when
 * the mirror is older than `maxAgeMs`, which covers a hub where nothing is
 * polling. Concurrent reads share one in-flight read.
 *
 * `null` means no read has ever answered (or the mirror was invalidated and
 * the re-read failed), which the directory reports as `complete: false` (D315).
 * A failed re-read of a stale mirror serves the last successful read, because
 * that is still an answer the store gave.
 */
export type HistoryRead = () => Promise<readonly PersistedClusterNode[] | null>

/** Two topology heartbeats: a mirror older than this was not being fed. */
export const HISTORY_MIRROR_MAX_AGE_MS = 60_000

interface MirrorEntry {
  readonly rows: readonly PersistedClusterNode[]
  readonly readAt: number
}

export class ClusterNodeHistoryMirror {
  private entry: MirrorEntry | null = null
  private inFlight: Promise<readonly PersistedClusterNode[] | null> | null = null
  /** Bumped by `invalidate()`: a read started before it must not land. */
  private generation = 0

  constructor(
    private readonly read: HistoryRead,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs: number = HISTORY_MIRROR_MAX_AGE_MS,
  ) {}

  /** Read the store now (sharing any read in flight). Returns THIS read's answer. */
  refresh(): Promise<readonly PersistedClusterNode[] | null> {
    if (this.inFlight !== null) return this.inFlight
    const generation = this.generation
    const flight = this.read().then((rows) => {
      if (rows !== null && generation === this.generation) {
        this.entry = { rows, readAt: this.now() }
      }
      return rows
    })
    const settled = flight.finally(() => {
      if (this.inFlight === settled) this.inFlight = null
    })
    this.inFlight = settled
    return settled
  }

  /** The mirror if fresh; otherwise a read, falling back to the last successful one. */
  async current(): Promise<readonly PersistedClusterNode[] | null> {
    const entry = this.entry
    if (entry !== null && this.now() - entry.readAt <= this.maxAgeMs) return entry.rows
    const rows = await this.refresh()
    return rows ?? this.entry?.rows ?? null
  }

  /**
   * The last successful read, however old, without reading. For a synchronous
   * caller that only wants a label (the node liveness events' display name) —
   * a stale name is still the right name, and no answer is `null`.
   */
  peek(): readonly PersistedClusterNode[] | null {
    return this.entry?.rows ?? null
  }

  /** Drop the mirror (a node was forgotten): the next `current()` must re-read. */
  invalidate(): void {
    this.generation += 1
    this.entry = null
    this.inFlight = null
  }
}
