import type { LogLevel, LogEntry, LogFilter, LogTags } from '@camstack/types'
import { logLevelAtMost } from '@camstack/types'

export type { LogLevel, LogEntry, LogFilter }

/**
 * Per-tag filter matcher with semantic-aware comparisons:
 *
 *   `addonId`  — matches the entry's bare addon id (strips any `@<workerId>`
 *                qualifier added by the cap-router for remote providers).
 *                So a UI filter for `audio-classifier` matches both the
 *                addon's own log lines and bridge management lines whose
 *                addonId is logged as `audio-classifier@dev-agent-0/audio-classifier`.
 *
 *   `agentId`  — matches when ANY of these hold:
 *                  * the entry was emitted by that agent (`agentId` exact)
 *                  * the entry's `nodeId` IS that agent (single-node case)
 *                  * the entry's `nodeId` starts with `<agent>/` (worker
 *                    inside that agent — e.g. `dev-agent-0/audio-classifier`)
 *                Captures all the log emission paths for an addon hosted
 *                on the agent regardless of who actually emitted the line.
 *
 *   any other key — exact match (legacy semantics).
 *
 * Returns `true` when ALL filter keys match (AND), `false` otherwise.
 * `undefined` filter values are skipped.
 */
export function matchesLogTags(
  entryTags: LogTags | undefined,
  filterTags: Partial<LogTags>,
): boolean {
  if (!entryTags) return false
  for (const [key, value] of Object.entries(filterTags)) {
    if (value === undefined) continue
    const entryValue = entryTags[key as keyof LogTags]
    if (key === 'addonId') {
      // Normalize away both suffix conventions so a filter on the
      // addon's manifest id matches every log line emitted by it:
      //   - `<addonId>@<version>` — bridge-injected when relaying
      //     logs from forked workers (kernel/capability-registry).
      //   - `<addonId>::<sub-service>` — sub-component scope used by
      //     addons that mount native-device-ops shims (e.g.
      //     `audio-codec-nodeav::native-device-ops`). Operators
      //     filtering by the addon's id expect to see those rows.
      let bare = entryValue
      if (typeof bare === 'string') {
        bare = bare.split('@')[0]
        if (typeof bare === 'string') {
          const colonIdx = bare.indexOf('::')
          if (colonIdx >= 0) bare = bare.slice(0, colonIdx)
        }
      }
      if (bare !== value) return false
    } else if (key === 'agentId') {
      const nodeId = entryTags['nodeId']
      const matchEmitter = entryValue === value
      const matchExactNode = nodeId === value
      const matchWorker = typeof nodeId === 'string' && nodeId.startsWith(`${value}/`)
      if (!matchEmitter && !matchExactNode && !matchWorker) return false
    } else {
      if (entryValue !== value) return false
    }
  }
  return true
}

export class LogRingBuffer {
  private readonly buffer: Array<LogEntry | undefined>
  private head = 0
  private count = 0

  constructor(private readonly capacity: number = 10000) {
    this.buffer = Array.from<LogEntry | undefined>({ length: capacity })
  }

  push(entry: LogEntry): void {
    this.buffer[this.head] = entry
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
  }

  getAll(): LogEntry[] {
    const result: LogEntry[] = []

    for (let i = 0; i < this.count; i++) {
      const index = (this.head - 1 - i + this.capacity) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  query(filter: LogFilter): LogEntry[] {
    const all = this.getAll()
    let result = all

    if (filter.level) {
      result = result.filter((entry) => entry.level === filter.level)
    }

    if (filter.since) {
      result = result.filter((entry) => entry.timestamp >= filter.since!)
    }

    if (filter.until) {
      result = result.filter((entry) => entry.timestamp <= filter.until!)
    }

    if (filter.tags) {
      const filterTags = filter.tags
      result = result.filter((entry) => matchesLogTags(entry.tags, filterTags))
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  /**
   * Drop entries that match `filter`. Returns the number of entries
   * removed. Triggered by the UI's "Clear logs" button so the operator
   * can wipe the historical buffer for a specific scope (per-device,
   * per-addon, per-agent) — without it, closing and reopening the
   * panel re-populates the cleared rows from the server's ring buffer.
   *
   * Filter semantics mirror `query` (same level / since / until / tags
   * handling) — whatever you'd see listed by `query(filter)` is what
   * gets removed.
   */
  clear(filter: LogFilter = {}): number {
    if (this.count === 0) return 0
    const survivors: LogEntry[] = []
    for (let i = 0; i < this.count; i++) {
      // Same iteration order as getAll (newest first), but we'll
      // re-insert oldest-first to preserve push semantics.
      const index = (this.head - 1 - i + this.capacity) % this.capacity
      const entry = this.buffer[index]!
      let matches = true
      if (filter.level !== undefined && entry.level !== filter.level) matches = false
      if (matches && filter.since !== undefined && entry.timestamp < filter.since) matches = false
      if (matches && filter.until !== undefined && entry.timestamp > filter.until) matches = false
      if (matches && filter.tags !== undefined && !matchesLogTags(entry.tags, filter.tags))
        matches = false
      if (!matches) survivors.push(entry)
    }
    const removed = this.count - survivors.length
    if (removed === 0) return 0
    // Re-seed the buffer in original push order (oldest first → newest last).
    this.buffer.fill(undefined)
    this.head = 0
    this.count = 0
    for (let i = survivors.length - 1; i >= 0; i--) {
      this.push(survivors[i]!)
    }
    return removed
  }

  /** Entries currently retained. */
  size(): number {
    return this.count
  }

  /**
   * Drop up to `max` entries, OLDEST first, whose level is at or below
   * `threshold`. Returns how many were removed.
   *
   * This is what lets a total-memory cap be enforced without losing the entries
   * that matter: sweeping `debug` reclaims almost all of the space (debug is the
   * overwhelming majority of any busy buffer) while `warn` and `error` are never
   * touched. Losing the one error line that explains an incident, in order to keep
   * a thousand debug lines about frame timings, would be the wrong trade.
   *
   * Oldest-first because recent context is what an operator is looking at.
   */
  pruneOldestAtOrBelow(threshold: LogLevel, max: number): number {
    if (this.count === 0 || max <= 0) return 0

    // Walk oldest → newest, marking victims until the quota is met.
    const victims = new Set<number>()
    for (let i = this.count - 1; i >= 0 && victims.size < max; i--) {
      const index = (this.head - 1 - i + this.capacity) % this.capacity
      const entry = this.buffer[index]
      if (entry !== undefined && logLevelAtMost(entry.level, threshold)) victims.add(index)
    }
    if (victims.size === 0) return 0

    // Re-seed with the survivors in push order, as `clear` does — the ring's
    // head/count invariants cannot survive an in-place hole.
    const survivors: LogEntry[] = []
    for (let i = this.count - 1; i >= 0; i--) {
      const index = (this.head - 1 - i + this.capacity) % this.capacity
      if (!victims.has(index)) survivors.push(this.buffer[index]!)
    }
    const removed = this.count - survivors.length
    this.buffer.fill(undefined)
    this.head = 0
    this.count = 0
    for (const entry of survivors) this.push(entry)
    return removed
  }
}
