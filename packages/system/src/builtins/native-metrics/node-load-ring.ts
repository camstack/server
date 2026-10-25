/**
 * In-memory retention for the per-node load snapshots — the shared analogue of
 * the log ring (`packages/system/src/logging/partitioned-log-buffer.ts`), and
 * built to the same shape for the same reason: a fixed-capacity circular
 * partition per key, plus **declared hard ceilings** on the total.
 *
 * ## What this is, and what it deliberately is not
 *
 * `native-metrics` emits `metrics.node-processes-snapshot` every 20 s on every
 * node whether or not anyone is watching (D250). Until now nobody kept it: the
 * Load charts accumulated 180 points inside the browser tab, so closing the
 * page threw the hour away and two operators looking at the same node saw two
 * different windows.
 *
 * This ring RETAINS what already arrives. It adds no timer, no sampler, no
 * probe and no new event — subscribing to a fan-out that exists is the whole
 * mechanism. It is **not** durable retention: nothing here reaches disk, and a
 * stored series remains its own decision with its own resolution, retention and
 * owner (D250 § Consequences).
 *
 * ## It does not know what a load snapshot looks like
 *
 * `TProcess` is a type parameter and the payload is stored **verbatim**. The
 * ring reads exactly two things off the envelope — which node, and when — and
 * never a field of a process row. A field added to the snapshot (a `deviceId`
 * next to the pid, say) flows through untouched, because there is nothing here
 * for it to flow through.
 *
 * ## Measured cost — see `docs/architecture/load-ledger.md`
 *
 * Measured, not estimated, against the real process payloads of the live
 * cluster (`metricsProvider.listNodeProcesses` on all three nodes: 42 + 20 + 14
 * rows) replayed 180 deep and weighed as V8 retained heap after a forced GC:
 *
 *   **464 B per process row**, so the live cluster's full hour —
 *   3 nodes x 180 samples x 76 rows = 13 680 rows — is **6.06 MiB**.
 *
 * Linear in rows (checked at 360 samples: 463.9 B/row). Every ceiling below is
 * expressed in ROWS for that reason: rows are what the memory is proportional
 * to, and samples are not.
 */

/** One retained snapshot: when it arrived, and the payload exactly as it came. */
export interface LoadSample<TProcess> {
  readonly atMs: number
  readonly processes: readonly TProcess[]
}

/** What a reader gets back for one node. */
export interface NodeLoadSeries<TProcess> {
  readonly nodeId: string
  /** Oldest-first, and filtered by the caller's `sinceMs` when given. */
  readonly samples: readonly LoadSample<TProcess>[]
  /** Samples retained for this node right now — independent of `sinceMs`. */
  readonly retainedSamples: number
  /** Oldest retained sample's timestamp, or `null` when nothing is retained. */
  readonly oldestAtMs: number | null
  /** The per-node ceiling in force, so a caller can say what it is looking at. */
  readonly capacity: number
}

/**
 * Per-node ceiling, in SAMPLES.
 *
 * 180 at the 20 s process-snapshot cadence is **one hour** — the window the
 * operator asked to keep, and the same 180 the browser buffer used before this
 * existed (`LOAD_SERIES_MAX_POINTS`). The cap is on points, not on age, so a
 * node whose emits are deduped away covers a longer wall-clock window at the
 * same cost.
 */
export const DEFAULT_SAMPLES_PER_NODE = 180

/**
 * Fleet ceiling, in PROCESS ROWS across every node.
 *
 * This is the bound the per-node ceiling cannot provide. 180 samples is a fixed
 * number of samples, not a fixed amount of memory: a node whose process count
 * explodes — a leaked tsx tree, an inference pool respawning, the ghost storms
 * the Processes tab exists to surface — multiplies its own partition without
 * ever touching the per-node cap. That is precisely the defect the RTP pre-roll
 * rings have in `docs/architecture/load-ledger.md` (#5): a maximum per instance
 * and no budget for the fleet, which reached 898 MB across 47 rings.
 *
 * 32 000 rows x the measured 464 B = **14.2 MiB**, which is deliberately the
 * same envelope hub-main already accepted for the log ring
 * (`DEFAULT_MAX_TOTAL_LOG_ENTRIES` 50 000 x ~306 B ~ 15 MB). It is 2.3x the
 * live cluster's full hour (13 680 rows), so no real deployment evicts on it —
 * it exists so a runaway node costs 14 MiB instead of everything.
 */
export const DEFAULT_MAX_TOTAL_PROCESS_ROWS = 32_000

/**
 * Ceiling on the number of PARTITIONS.
 *
 * The backstop for an unbounded key space, exactly as `DEFAULT_MAX_LOG_BUCKETS`
 * is: a partition is created on first write, and a node id that appears once —
 * a renamed agent, a node that joined for an afternoon — must not hold a ring
 * for the life of the process. 16 is >5x the live fleet of 3.
 */
export const DEFAULT_MAX_NODES = 16

/**
 * A partition whose newest sample is older than this is dropped whole.
 *
 * **Why age, and why this age.** The alternative — evict when the node leaves
 * the cluster registry — was rejected twice over: it couples this ring to a
 * registry it has no other reason to know, and a node that is merely offline is
 * never "removed", so the case that actually happens (an agent that stops
 * answering) would keep its partition forever. That is the failure mode being
 * bounded.
 *
 * The number is not chosen, it is derived: `DEFAULT_SAMPLES_PER_NODE` x the 20 s
 * snapshot cadence = **one hour** = the entire window this ring can represent.
 * A node silent for that long holds nothing that overlaps the hour an operator
 * is asking about; every point in it has aged out of the question. Below that
 * threshold the partition is still answering a live question and is kept, even
 * though the node is quiet — a node emits at least once a minute
 * (`METRICS_SNAPSHOT_HEARTBEAT_MS`), so an hour of silence is not a slow node,
 * it is a gone one.
 */
export const DEFAULT_NODE_IDLE_EVICTION_MS = 3_600_000

export interface NodeLoadRingOptions {
  readonly samplesPerNode?: number
  readonly maxTotalProcessRows?: number
  readonly maxNodes?: number
  readonly idleEvictionMs?: number
  /** Injectable clock. Tests drive eviction without sleeping for an hour. */
  readonly now?: () => number
}

/** Result of one {@link LoadPartition.push}. */
interface PushOutcome {
  readonly accepted: boolean
  readonly rowDelta: number
}

/**
 * One node's fixed-capacity circular buffer of samples.
 *
 * Mirrors {@link LogRingBuffer}: write at `head`, wrap, and once full every
 * accepted sample evicts the oldest. `rows` is carried alongside so the fleet
 * budget never has to walk the samples to know what a partition costs.
 */
class LoadPartition<TProcess> {
  private readonly slots: Array<LoadSample<TProcess> | undefined>
  private head = 0
  private count = 0
  private rows = 0
  /** Newest retained sample's timestamp — the monotonic gate for `push`. */
  private newestAtMs: number | null = null

  constructor(private readonly capacity: number) {
    this.slots = Array.from<LoadSample<TProcess> | undefined>({ length: capacity })
  }

  /**
   * Accept a sample.
   *
   * A sample at or before the newest one already held is REFUSED. The bus drops
   * a node's own broadcast echo, but a cross-node redelivery or a replayed
   * subscription must not be able to double a point — and idempotence here is
   * what lets every reader above treat the series as a set.
   *
   * `accepted` is reported separately from `rowDelta` on purpose: a full ring
   * that evicts a sample of the same size has a delta of zero and is not a
   * refusal, and conflating the two would silently stop advancing the write
   * ordinal on a steady-state cluster.
   */
  push(sample: LoadSample<TProcess>): PushOutcome {
    if (this.newestAtMs !== null && sample.atMs <= this.newestAtMs) {
      return { accepted: false, rowDelta: 0 }
    }
    const evicted =
      this.count === this.capacity ? (this.slots[this.head]?.processes.length ?? 0) : 0
    this.slots[this.head] = sample
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
    this.newestAtMs = sample.atMs
    const rowDelta = sample.processes.length - evicted
    this.rows += rowDelta
    return { accepted: true, rowDelta }
  }

  /** Drop the oldest sample. Returns the rows reclaimed (0 when empty). */
  dropOldest(): number {
    if (this.count === 0) return 0
    const index = (this.head - this.count + this.capacity) % this.capacity
    const victim = this.slots[index]
    this.slots[index] = undefined
    this.count--
    const reclaimed = victim?.processes.length ?? 0
    this.rows -= reclaimed
    if (this.count === 0) this.newestAtMs = null
    return reclaimed
  }

  /** Oldest-first, optionally only what is strictly newer than `sinceMs`. */
  list(sinceMs?: number): readonly LoadSample<TProcess>[] {
    const out: LoadSample<TProcess>[] = []
    for (let i = 0; i < this.count; i++) {
      const index = (this.head - this.count + i + this.capacity) % this.capacity
      const sample = this.slots[index]
      if (sample === undefined) continue
      if (sinceMs !== undefined && sample.atMs <= sinceMs) continue
      out.push(sample)
    }
    return out
  }

  size(): number {
    return this.count
  }

  rowCount(): number {
    return this.rows
  }

  oldestAtMs(): number | null {
    if (this.count === 0) return null
    const index = (this.head - this.count + this.capacity) % this.capacity
    return this.slots[index]?.atMs ?? null
  }

  lastWriteAtMs(): number | null {
    return this.newestAtMs
  }
}

/**
 * The partitioned ring: one {@link LoadPartition} per node id.
 *
 * Three bounds, doing three different jobs — the same division as the log
 * buffer, for the same reason:
 *
 * - **`samplesPerNode`** is HARD and per partition. It is what the operator
 *   asked for (an hour) and it can never be exceeded.
 * - **`maxTotalProcessRows`** is the FLEET budget, and it is denominated in the
 *   thing memory is proportional to. When it bites, the oldest sample of the
 *   HEAVIEST partition is dropped — the node creating the pressure is the node
 *   that pays, and a quiet node keeps its full hour. The node just written to is
 *   NOT protected here: if it is the heaviest, it is the culprit.
 * - **`maxNodes`** is the backstop against an unbounded key space, and it drops
 *   whole partitions least-recently-written first, never the one being written.
 *
 * Plus {@link DEFAULT_NODE_IDLE_EVICTION_MS}, which is what stops a node that
 * simply stopped emitting from living in memory forever.
 */
export class NodeLoadRing<TProcess> {
  private readonly partitions = new Map<string, LoadPartition<TProcess>>()
  /**
   * Node id → write ordinal of its last accepted sample. A monotonic counter,
   * not a clock: partition eviction must follow the order writes actually
   * happened, and node clocks disagree.
   */
  private readonly lastWriteSeq = new Map<string, number>()
  private writeSeq = 0
  private totalRows = 0

  private readonly samplesPerNode: number
  private readonly maxTotalProcessRows: number
  private readonly maxNodes: number
  private readonly idleEvictionMs: number
  private readonly now: () => number

  constructor(options: NodeLoadRingOptions = {}) {
    this.samplesPerNode = options.samplesPerNode ?? DEFAULT_SAMPLES_PER_NODE
    this.maxTotalProcessRows = options.maxTotalProcessRows ?? DEFAULT_MAX_TOTAL_PROCESS_ROWS
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
    this.idleEvictionMs = options.idleEvictionMs ?? DEFAULT_NODE_IDLE_EVICTION_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Retain one snapshot. `processes` is stored by reference — the payload is
   * already an immutable arrival off the bus, and copying it would double the
   * measured cost for nothing.
   *
   * Returns whether the sample was ACCEPTED — that is, whether it was new
   * rather than a replay of a timestamp this node has already delivered.
   *
   * The return value is not diagnostics. It is the idempotence gate the
   * DURABLE tier rides on this return value (`node-metrics-history-recorder.ts`):
   * only an accepted sample is sent to device-history. The gate is one monotonic
   * comparison in memory.
   */
  record(nodeId: string, atMs: number, processes: readonly TProcess[]): boolean {
    if (nodeId.length === 0) return false
    // Sweep BEFORE the write: a node being written to is by definition not
    // idle, so it can never be its own victim.
    this.sweepIdle()

    let partition = this.partitions.get(nodeId)
    if (partition === undefined) {
      partition = new LoadPartition<TProcess>(this.samplesPerNode)
      this.partitions.set(nodeId, partition)
    }
    const outcome = partition.push({ atMs, processes })
    if (!outcome.accepted) {
      // A replay of a point already held. Nothing changed, including the write
      // ordinal — a refused sample must not rescue a partition from eviction.
      if (partition.size() === 0) this.partitions.delete(nodeId)
      return false
    }
    this.totalRows += outcome.rowDelta
    this.lastWriteSeq.set(nodeId, ++this.writeSeq)

    if (this.partitions.size > this.maxNodes) {
      this.evictPartitions(this.partitions.size - this.maxNodes, nodeId)
    }
    this.enforceRowBudget()
    return true
  }

  /**
   * Read one node's retained series, oldest-first.
   *
   * `sinceMs` is EXCLUSIVE: a caller passes the newest timestamp it already
   * holds and gets back only what it is missing. That is the whole contract
   * that lets the admin UI seed from here and then continue live without
   * doubling a point it already drew.
   *
   * A node nobody has recorded answers with an empty series, not an error —
   * unknown is the truth about a node that has not reported.
   */
  read(nodeId: string, sinceMs?: number): NodeLoadSeries<TProcess> {
    this.sweepIdle()
    const partition = this.partitions.get(nodeId)
    if (partition === undefined) {
      return {
        nodeId,
        samples: [],
        retainedSamples: 0,
        oldestAtMs: null,
        capacity: this.samplesPerNode,
      }
    }
    return {
      nodeId,
      samples: partition.list(sinceMs),
      retainedSamples: partition.size(),
      oldestAtMs: partition.oldestAtMs(),
      capacity: this.samplesPerNode,
    }
  }

  /** Node ids with a live partition. Observability for the fleet bound. */
  nodeIds(): readonly string[] {
    return [...this.partitions.keys()]
  }

  /** Process rows retained across every partition — the number that IS memory. */
  rowCount(): number {
    return this.totalRows
  }

  /** Samples retained across every partition. */
  sampleCount(): number {
    let total = 0
    for (const partition of this.partitions.values()) total += partition.size()
    return total
  }

  /**
   * Drop partitions whose newest sample is older than the retention window.
   *
   * Lazy, on write and on read — never a timer. A timer would be a new
   * periodic cost in a subsystem whose entire premise is that it adds none,
   * and a ring that nobody writes to and nobody reads is not growing either.
   */
  private sweepIdle(): void {
    const cutoff = this.now() - this.idleEvictionMs
    for (const [nodeId, partition] of [...this.partitions.entries()]) {
      const lastWrite = partition.lastWriteAtMs()
      if (lastWrite !== null && lastWrite > cutoff) continue
      this.dropPartition(nodeId)
    }
  }

  /**
   * Bring the fleet back under the row budget by dropping the OLDEST sample of
   * the HEAVIEST partition, repeatedly.
   *
   * Terminates: every iteration removes one sample from a non-empty partition,
   * and the population of samples is finite and strictly decreasing.
   */
  private enforceRowBudget(): void {
    while (this.totalRows > this.maxTotalProcessRows) {
      const victim = this.heaviestPartition()
      if (victim === null) return
      const [nodeId, partition] = victim
      this.totalRows -= partition.dropOldest()
      if (partition.size() === 0) this.dropPartition(nodeId)
    }
  }

  private heaviestPartition(): readonly [string, LoadPartition<TProcess>] | null {
    let best: readonly [string, LoadPartition<TProcess>] | null = null
    for (const entry of this.partitions.entries()) {
      if (entry[1].size() === 0) continue
      if (best === null || entry[1].rowCount() > best[1].rowCount()) best = entry
    }
    return best
  }

  /** Drop `count` whole partitions, least-recently-written first. */
  private evictPartitions(count: number, protectedNodeId: string): void {
    const order = [...this.partitions.keys()]
      .filter((nodeId) => nodeId !== protectedNodeId)
      .toSorted((a, b) => (this.lastWriteSeq.get(a) ?? 0) - (this.lastWriteSeq.get(b) ?? 0))
    let remaining = count
    for (const nodeId of order) {
      if (remaining <= 0) return
      this.dropPartition(nodeId)
      remaining -= 1
    }
  }

  /** Remove a partition and everything that indexes it. */
  private dropPartition(nodeId: string): void {
    const partition = this.partitions.get(nodeId)
    if (partition === undefined) return
    this.totalRows -= partition.rowCount()
    this.partitions.delete(nodeId)
    this.lastWriteSeq.delete(nodeId)
  }
}
