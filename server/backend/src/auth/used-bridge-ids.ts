/**
 * The `jti`s of login bridges already swapped for a session or a link.
 *
 * A bridge lives 5 minutes; until it expires a second presentation is refused.
 * Entries are kept for {@link RETENTION_MS} (longer than any bridge), and the
 * set is bounded — only a bridge that verified AND matched its browser's
 * state cookie is ever recorded, so filling it needs that many real sign-ins.
 *
 * In memory: a hub restart within a bridge's 5 minutes forgets it, and the
 * browser binding (the bridge is useless without the state cookie of the
 * browser that started the sign-in) is what still stands then.
 */
const RETENTION_MS = 10 * 60_000
const DEFAULT_MAX_ENTRIES = 10_000

export class UsedBridgeIds {
  private readonly used = new Map<string, number>()
  private readonly now: () => number
  private readonly maxEntries: number

  constructor(opts: { now?: () => number; maxEntries?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /** Record `jti`; `true` the first time, `false` for every replay. */
  consume(jti: string): boolean {
    const at = this.now()
    this.prune(at)
    if (this.used.has(jti)) return false
    while (this.used.size >= this.maxEntries) {
      const oldest = this.used.keys().next()
      if (oldest.done) break
      this.used.delete(oldest.value)
    }
    this.used.set(jti, at + RETENTION_MS)
    return true
  }

  size(): number {
    return this.used.size
  }

  private prune(at: number): void {
    for (const [jti, until] of this.used) {
      if (until > at) break // insertion order = expiry order
      this.used.delete(jti)
    }
  }
}
