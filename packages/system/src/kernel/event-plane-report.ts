/**
 * event-plane-report — the fan-out counters this cluster has always kept and
 * never read, on the line it already emits.
 *
 * ## Why this exists
 *
 * hub-main's memory is a RATE, not a set. Measured 2026-08-29 over the first 25
 * minutes of telemetry this process has ever produced: every forced compaction
 * drops `arrayBuffers` to **12–29 MB** — ten passes out of ten — so a reading of
 * 726 MB is 707 MB of dead Buffers not yet swept, not a retained set. The real
 * quantity is the slope: **181–330 MB/min steady, with one burst of ≥1.3 GB in
 * ≤11 s**.
 *
 * And it is sockets, not media. `/proc/<pid>/io` over the same windows: ~21 800
 * reads/s and ~22 500 writes/s at a **0.33 KB mean**, with regular-file reads at
 * 0.73 MB/min. A 64 KB proxy chunk or a 200 KB JPEG cannot hide inside a 0.33 KB
 * mean, so the cost is per MESSAGE on a fan-out plane nobody has ever counted —
 * an IDLE addon still reads 82 messages/s of it, across ~38 runners.
 *
 * The strongest single number available is that **78–82% of hub-main's outbound
 * bytes correlate with `hub/pipeline-analytics`, in both windows** — but `rchar`
 * on that runner also counts page-cache reads and it owns a vector store, so the
 * correlation is not an attribution. `fanoutTop` turns it into one.
 *
 * ## Both planes always filter
 *
 * The cross-node plane ran a `shadow` burn-in (`CAMSTACK_MOLECULER_EVENT_FANOUT`)
 * with no end condition, and the UDS plane carried the same three-mode switch
 * (`CAMSTACK_UDS_EVENT_FANOUT`). Both switches were removed on 2026-10-06: a
 * suppressed count now always means "this many WERE dropped", and the line no
 * longer prints a regime because there is only one.
 *
 * ## The fail-open nobody can see
 *
 * A child that never declares its pattern set (`eventPatterns === null`,
 * `local-child-registry.ts:170`) makes the per-child gate fail OPEN, and per
 * `setNodeEventInterest` ANY undeclared child makes the whole node's inbound
 * cross-node gate fail open too. **One legacy runner silently disables the
 * filtering on both planes**, and nothing reported it. `childrenUndeclared` is
 * printed even at zero for the same reason `largeObjectSpace=0MB` is: absence
 * must never be ambiguous.
 *
 * ## Deltas, never totals
 *
 * Both registries count cumulatively for the life of the process. A cumulative
 * number on a heartbeat answers "how much since boot", which nobody asked; the
 * question is "which peer receives the 22 500 writes/s", and that is a rate. So
 * the meter is read ONCE PER LINE and reports the window since the previous read
 * — the same discipline the loop-delay histogram already follows, for the same
 * reason.
 *
 * ## The unit trap (D467)
 *
 * `fanoutSent` / `fanoutSuppressed` are **(event × child) pairs**, not events:
 * `broadcastEventToChildren` increments them inside the per-child loop, so on a
 * 39-child node ONE emit produces up to 38 increments. A 2026-09-12 reading of
 * `fanoutSuppressed=433461` was read as "433k events a minute, 97% discarded";
 * the real production was **~11 700 events/min**. The line proves it itself —
 * every pure-consumer child's `sent + suppressed` converges on 11 730, because
 * that sum IS the distinct broadcast count, and the two rows that fall short
 * (`pipeline-orchestrator`, `pipeline-analytics`) fall short by exactly what
 * they originated. `fanoutEvents` is the production rate, counted once per emit
 * outside that loop, and it is printed so the pair counters can never be read as
 * one again.
 *
 * `fanoutCats` names PRODUCERS (`fanoutTop` names subscribers) and
 * `fanoutOrphans` counts what was serialised and walked across every child with
 * zero subscribers. A suppressed pair was measured at **255 ns** — 1.84 ms/s of
 * event loop at this rate — so the filter is not the cost; the emit is.
 */

/** One child's fan-out counters, as the registry keeps them (cumulative). */
export interface ChildFanoutSample {
  readonly childId: string
  readonly sent: number
  readonly suppressed: number
}

/** One child's fan-out over the window since the previous read. */
export interface ChildFanoutDelta {
  readonly childId: string
  readonly sent: number
  readonly suppressed: number
}

/** What `LocalChildRegistry` exposes, structurally — the kernel's heartbeat
 *  must not depend on the transport layer's class. */
export interface ChildFanoutRegistryChild {
  readonly childId: string
}

export interface ChildFanoutRegistryStats {
  readonly sent: number
  readonly suppressed: number
}

/**
 * D467 — one PRODUCED category, cumulative, as the registry keeps it.
 *
 * `broadcasts` is EMITS, not deliveries; `wanted` is the number of child
 * subscriptions that matched, summed over those emits.
 */
export interface CategoryFanoutSample {
  readonly category: string
  readonly broadcasts: number
  readonly wanted: number
}

export interface ChildFanoutRegistry {
  readonly listChildren: () => readonly ChildFanoutRegistryChild[]
  readonly getChildEventStats: (childId: string) => ChildFanoutRegistryStats | null
  readonly undeclaredChildCount: () => number
  readonly categoryFanout: () => readonly CategoryFanoutSample[]
  readonly categoryCensusOverflow: () => number
}

/** What `getMoleculerEventStats` returns, structurally. */
export interface CrossNodeEventStats {
  readonly delivered: number
  readonly suppressed: number
}

/** One cumulative reading of both planes. */
export interface EventPlaneCounters {
  readonly children: readonly ChildFanoutSample[]
  readonly childrenConnected: number
  readonly childrenUndeclared: number
  readonly crossNodeDelivered: number
  readonly crossNodeSuppressed: number
  readonly categories: readonly CategoryFanoutSample[]
  readonly categoryOverflow: number
}

/** `undefined` = this process has no event plane to report (every forked
 *  runner, and hub-main before the registry exists). */
export type EventPlaneReader = () => EventPlaneCounters | undefined

/** Where a reader gets each part. Every one is late-bound, because the
 *  heartbeat starts before any of them exist. */
export interface EventPlaneSources {
  readonly registry: () => ChildFanoutRegistry | null
  readonly crossNodeStats: () => CrossNodeEventStats | null
}

/**
 * Build a reader over the two registries.
 *
 * Returns `undefined` until the child registry exists — the heartbeat starts as
 * the FIRST statement of `bootstrap()` (a process that dies early still leaves
 * samples) and `LocalChildRegistry` is built hundreds of lines later inside
 * `MoleculerService.onModuleInit`. Printing zeros in that window would report a
 * silent plane where there is no plane at all.
 *
 * Wrapped: a registry mid-teardown may throw, and a diagnostic that can crash
 * the process it watches is worse than none.
 */
export function createEventPlaneReader(sources: EventPlaneSources): EventPlaneReader {
  return (): EventPlaneCounters | undefined => {
    try {
      const registry = sources.registry()
      if (registry === null) return undefined
      const children: ChildFanoutSample[] = []
      const listed = registry.listChildren()
      for (const child of listed) {
        const stats = registry.getChildEventStats(child.childId)
        // A child with no recorded events reports null. Absent and silent are
        // the same statement here, so it simply does not appear.
        if (stats === null) continue
        children.push({ childId: child.childId, sent: stats.sent, suppressed: stats.suppressed })
      }
      const crossNode = sources.crossNodeStats()
      return {
        children,
        childrenConnected: listed.length,
        childrenUndeclared: registry.undeclaredChildCount(),
        crossNodeDelivered: crossNode?.delivered ?? 0,
        crossNodeSuppressed: crossNode?.suppressed ?? 0,
        categories: registry.categoryFanout(),
        categoryOverflow: registry.categoryCensusOverflow(),
      }
    } catch {
      return undefined
    }
  }
}

/**
 * How many children get named on the line.
 *
 * Five, because the question is which peer DOMINATES and the measured
 * distribution is not flat: one peer accounted for 78–82% of outbound bytes and
 * the runner-up for ~6%. Five names the dominant peer, its challenger and enough
 * of the tail to see the shape change; naming all ~38 would put a kilobyte-long
 * line in the hub's shared log every minute, which is how a log stops being read.
 */
export const EVENT_PLANE_TOP_N = 5

/** Both planes over one heartbeat window. */
export interface EventPlaneWindow {
  readonly childrenConnected: number
  readonly childrenUndeclared: number
  readonly fanoutSent: number
  readonly fanoutSuppressed: number
  readonly crossNodeDelivered: number
  readonly crossNodeSuppressed: number
  /** Largest `sent` first, at most {@link EVENT_PLANE_TOP_N} entries. */
  readonly top: readonly ChildFanoutDelta[]
  /** Events PRODUCED in the window — emits, summed over categories. */
  readonly categoryBroadcasts: number
  /** Produced events no child subscribed to. Pure waste. */
  readonly orphanBroadcasts: number
  /** Largest `broadcasts` first, at most {@link EVENT_PLANE_TOP_N} entries. */
  readonly topCategories: readonly CategoryFanoutDelta[]
  /** The orphans alone, largest first, at most {@link EVENT_PLANE_TOP_N}. */
  readonly topOrphans: readonly CategoryFanoutDelta[]
  /** Broadcasts the census could not attribute because it was full. */
  readonly categoryOverflow: number
}

/** One category's production over the window since the previous read. */
export interface CategoryFanoutDelta {
  readonly category: string
  readonly broadcasts: number
  readonly wanted: number
}

/** Previous cumulative reading, kept between lines. */
export interface EventPlaneBaseline {
  readonly children: ReadonlyMap<string, ChildFanoutSample>
  readonly categories: ReadonlyMap<string, CategoryFanoutSample>
  readonly crossNodeDelivered: number
  readonly crossNodeSuppressed: number
  readonly categoryOverflow: number
}

/** A process that has never read a plane. */
export const EMPTY_EVENT_PLANE_BASELINE: EventPlaneBaseline = {
  children: new Map(),
  categories: new Map(),
  crossNodeDelivered: 0,
  crossNodeSuppressed: 0,
  categoryOverflow: 0,
}

/**
 * Subtract the previous cumulative reading from the current one.
 *
 * A child that RESTARTED has counters that went backwards — the registry keys by
 * childId and a respawned runner reconnects under the same id with a fresh
 * entry. Clamping at 0 reports the restart as a quiet window rather than as a
 * negative rate: the window's traffic is genuinely unknown, and a negative
 * number on a rate reads as a broken meter.
 */
export function diffEventPlane(
  baseline: EventPlaneBaseline,
  current: EventPlaneCounters,
  topN: number = EVENT_PLANE_TOP_N,
): EventPlaneWindow {
  const deltas: ChildFanoutDelta[] = []
  let fanoutSent = 0
  let fanoutSuppressed = 0
  for (const sample of current.children) {
    const before = baseline.children.get(sample.childId)
    const sent = Math.max(0, sample.sent - (before?.sent ?? 0))
    const suppressed = Math.max(0, sample.suppressed - (before?.suppressed ?? 0))
    fanoutSent += sent
    fanoutSuppressed += suppressed
    if (sent > 0 || suppressed > 0) deltas.push({ childId: sample.childId, sent, suppressed })
  }
  const categoryDeltas: CategoryFanoutDelta[] = []
  let categoryBroadcasts = 0
  let orphanBroadcasts = 0
  for (const sample of current.categories) {
    const before = baseline.categories.get(sample.category)
    const broadcasts = Math.max(0, sample.broadcasts - (before?.broadcasts ?? 0))
    if (broadcasts === 0) continue // a category that did not move is absent, not zero
    const wanted = Math.max(0, sample.wanted - (before?.wanted ?? 0))
    categoryBroadcasts += broadcasts
    if (wanted === 0) orphanBroadcasts += broadcasts
    categoryDeltas.push({ category: sample.category, broadcasts, wanted })
  }
  const byBroadcasts = categoryDeltas.toSorted(
    (a, b) => b.broadcasts - a.broadcasts || a.category.localeCompare(b.category),
  )
  return {
    childrenConnected: current.childrenConnected,
    childrenUndeclared: current.childrenUndeclared,
    fanoutSent,
    fanoutSuppressed,
    crossNodeDelivered: Math.max(0, current.crossNodeDelivered - baseline.crossNodeDelivered),
    crossNodeSuppressed: Math.max(0, current.crossNodeSuppressed - baseline.crossNodeSuppressed),
    top: deltas
      .toSorted((a, b) => b.sent - a.sent || a.childId.localeCompare(b.childId))
      .slice(0, topN),
    categoryBroadcasts,
    orphanBroadcasts,
    topCategories: byBroadcasts.slice(0, topN),
    topOrphans: byBroadcasts.filter((c) => c.wanted === 0).slice(0, topN),
    categoryOverflow: Math.max(0, current.categoryOverflow - baseline.categoryOverflow),
  }
}

/** Reads the delta since the PREVIOUS read. Same contract as the loop meter. */
export interface EventPlaneMeter {
  readonly read: () => EventPlaneWindow | undefined
}

export function createEventPlaneMeter(
  reader: EventPlaneReader,
  topN: number = EVENT_PLANE_TOP_N,
): EventPlaneMeter {
  let baseline: EventPlaneBaseline = EMPTY_EVENT_PLANE_BASELINE
  return {
    read: (): EventPlaneWindow | undefined => {
      const current = reader()
      if (current === undefined) return undefined
      const window = diffEventPlane(baseline, current, topN)
      baseline = {
        children: new Map(current.children.map((s) => [s.childId, s])),
        categories: new Map(current.categories.map((c) => [c.category, c])),
        crossNodeDelivered: current.crossNodeDelivered,
        crossNodeSuppressed: current.crossNodeSuppressed,
        categoryOverflow: current.categoryOverflow,
      }
      return window
    },
  }
}

/**
 * The suffix appended to a `[mem]` line — leading space included, empty when
 * this process has no event plane.
 *
 * Only two processes in the cluster have one (hub-main, and an agent's main), so
 * these fields never appear on the ~38 runner lines that share the same log
 * stream. On the two that do, every field is printed on every line INCLUDING at
 * zero: the modes because a suppressed count without its regime is unreadable,
 * `childrenUndeclared` because one undeclared child silently disables both
 * gates, and the deltas because "the plane went quiet for a minute" is a
 * reading, not a blank.
 *
 * `fanoutTop` is the one conditional field — a ranked list of nothing is noise —
 * and it is a single comma-separated value so the field COUNT does not change
 * from line to line: `childId:sent/suppressed`, largest first.
 */
export function formatEventPlane(window: EventPlaneWindow | undefined): string {
  if (window === undefined) return ''
  const top = window.top.map((d) => `${d.childId}:${d.sent}/${d.suppressed}`).join(',')
  const cats = window.topCategories
    .map((c) => `${c.category}:${c.broadcasts}/${c.wanted}`)
    .join(',')
  const orphans = window.topOrphans.map((c) => `${c.category}:${c.broadcasts}`).join(',')
  return (
    ` children=${window.childrenConnected} childrenUndeclared=${window.childrenUndeclared}` +
    ` fanoutSent=${window.fanoutSent} fanoutSuppressed=${window.fanoutSuppressed}` +
    ` crossNodeDelivered=${window.crossNodeDelivered}` +
    ` crossNodeSuppressed=${window.crossNodeSuppressed}` +
    ` fanoutEvents=${window.categoryBroadcasts}` +
    ` fanoutOrphans=${window.orphanBroadcasts}` +
    ` fanoutCatsDropped=${window.categoryOverflow}` +
    (top.length === 0 ? '' : ` fanoutTop=${top}`) +
    (cats.length === 0 ? '' : ` fanoutCats=${cats}`) +
    (orphans.length === 0 ? '' : ` fanoutOrphanTop=${orphans}`)
  )
}
