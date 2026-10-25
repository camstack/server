/**
 * What the share election remembers between sessions: how many sessions each
 * candidate was elected for lately, decayed exponentially. On-motion sessions
 * rarely overlap, so at every election nothing is running and the deficits tie;
 * without this memory the key order won every time (3 Corals of weight 100
 * got 38 / 1 / 0 of 39 sessions). The decayed count enters the election as
 * `ShareCandidate.recent`, so the cumulative split follows the shares.
 *
 * In-memory and advisory: a restart costs a few unfair elections, never a
 * wrong one. Scoped (a node id, or `nodes` for the node tier) so two nodes
 * that both own a `cpu` device do not share a count.
 */

/** A decayed election is worth half after this long. */
export const SHARE_HISTORY_HALF_LIFE_MS = 30 * 60_000

interface Entry {
  count: number
  at: number
}

export class ShareElectionHistory {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly halfLifeMs: number = SHARE_HISTORY_HALF_LIFE_MS,
  ) {}

  private decayed(entry: Entry | undefined): number {
    if (entry === undefined) return 0
    return entry.count * 0.5 ** (Math.max(0, this.now() - entry.at) / this.halfLifeMs)
  }

  /** The decayed number of recent elections of `key` within `scope`. */
  recent(scope: string, key: string): number {
    return this.decayed(this.entries.get(`${scope}\u0000${key}`))
  }

  /** Record that `key` was elected within `scope` now. */
  noteElected(scope: string, key: string): void {
    const id = `${scope}\u0000${key}`
    this.entries.set(id, { count: this.decayed(this.entries.get(id)) + 1, at: this.now() })
  }
}
