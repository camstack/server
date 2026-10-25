/**
 * `NodeLivenessMirror` — "is the node that owns this frame handle reachable?",
 * answered from the CLUSTER REGISTRY's own pushed snapshot, synchronously, on
 * the frame path.
 *
 * ## Why this exists
 *
 * Every pixel this addon stores is fetched by handle from the node that
 * produced the frame (`pipelineRunner.getNativeCrop`, pinned to
 * `handle.nodeId` — D18). When that node goes away the fetch does not miss
 * quietly: the cap router throws `CapRouteError{reason:'node-offline'}` for
 * EVERY target of EVERY frame, for as long as the camera keeps being ingested
 * elsewhere. Measured on the live hub 2026-08-06: 403 of the day's key-frame
 * misses were that one error, 388 of them for a single developer laptop that
 * had acted as an agent node and then closed its lid.
 *
 * Those captures cannot succeed. Issuing them costs a scheduler slot, a
 * cross-node round trip and a 60 s timeout each, and buys nothing.
 *
 * ## Where the answer comes from
 *
 * `EventCategory.ClusterTopologySnapshot` — the hub's own topology emitter
 * pushes the payload of `nodes.topology` (the `HubNodeRegistry` view, D3) on
 * every agent/addon lifecycle change (debounced 200 ms) plus a 30 s heartbeat.
 * There is no probe here and no second inventory: this class only REMEMBERS
 * what the registry last said.
 *
 * ## Why it takes two snapshots to gate
 *
 * The gate DESTROYS work — a wrong "offline" means a camera stores no media at
 * all. [D49](../../../../docs/decisions/adr-0049.md): a mirror consulted off
 * the event path must need a SECOND read to agree before it acts in the
 * destructive direction. So:
 *
 *  - a node the snapshot never mentioned is **unknown**, never gated;
 *  - a node that DISAPPEARS from a snapshot is unknown again (streak reset) —
 *    absence is not evidence of death;
 *  - `isOnline: false` must arrive {@link NodeLivenessOptions.offlineConfirmations}
 *    times in a row (default 2 → ≥200 ms apart, and in the steady state one
 *    heartbeat apart) before the gate closes;
 *  - and if snapshots STOP arriving the mirror expires
 *    ({@link NodeLivenessOptions.staleAfterMs}) and gates nothing, so a wedged
 *    emitter can never blind media capture indefinitely.
 *
 * Every one of those four falls OPEN. The worst case of a stale mirror is the
 * behaviour that existed before this class.
 */

/** One node as the cluster topology snapshot describes it (the two fields this
 *  mirror reads out of `TopologyNodeSchema`). */
export interface NodeLivenessNode {
  readonly id: string
  readonly isOnline: boolean
}

export interface NodeLivenessOptions {
  /**
   * Consecutive snapshots that must report `isOnline: false` before
   * {@link NodeLivenessMirror.isKnownOffline} answers true (D49's "a second
   * read must agree"). Default 2.
   */
  readonly offlineConfirmations?: number
  /**
   * How long a snapshot stays trustworthy. Past this the mirror answers
   * `false` for everything — the emitter heartbeats every 30 s, so the default
   * 120 s is four missed beats. Default 120 000.
   */
  readonly staleAfterMs?: number
}

const DEFAULT_OFFLINE_CONFIRMATIONS = 2
const DEFAULT_STALE_AFTER_MS = 120_000

/** Per-node offline evidence accumulated across snapshots. */
interface OfflineStreak {
  /** Consecutive snapshots that reported this node `isOnline: false`. */
  count: number
}

export class NodeLivenessMirror {
  private readonly offlineStreaks = new Map<string, OfflineStreak>()
  private readonly confirmations: number
  private readonly staleAfterMs: number
  /** Wall clock of the last applied snapshot; `null` until the first one. */
  private lastSnapshotAtMs: number | null = null

  constructor(options: NodeLivenessOptions = {}) {
    this.confirmations = options.offlineConfirmations ?? DEFAULT_OFFLINE_CONFIRMATIONS
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  /**
   * Fold one registry snapshot into the mirror. Nodes absent from it are reset
   * to unknown — a node the registry stopped describing is not a node the
   * registry called dead.
   */
  applySnapshot(nodes: readonly NodeLivenessNode[], nowMs: number): void {
    this.lastSnapshotAtMs = nowMs
    const seen = new Set<string>()
    for (const node of nodes) {
      seen.add(node.id)
      if (node.isOnline) {
        this.offlineStreaks.delete(node.id)
        continue
      }
      const streak = this.offlineStreaks.get(node.id)
      if (streak === undefined) this.offlineStreaks.set(node.id, { count: 1 })
      else streak.count += 1
    }
    for (const nodeId of [...this.offlineStreaks.keys()]) {
      if (!seen.has(nodeId)) this.offlineStreaks.delete(nodeId)
    }
  }

  /**
   * True only when the registry has told us, twice running and recently, that
   * this node is offline. Synchronous and allocation-free — it is called once
   * per frame per camera.
   */
  isKnownOffline(nodeId: string, nowMs: number): boolean {
    const at = this.lastSnapshotAtMs
    if (at === null) return false
    if (nowMs - at > this.staleAfterMs) return false
    return (this.offlineStreaks.get(nodeId)?.count ?? 0) >= this.confirmations
  }

  /** Drop everything (addon dispose). */
  clear(): void {
    this.offlineStreaks.clear()
    this.lastSnapshotAtMs = null
  }
}

/**
 * Narrow an untyped `ClusterTopologySnapshot` bus payload to the node list.
 *
 * A type GUARD rather than a cast: this payload crosses a process boundary and
 * a version-skewed emitter is exactly the shape that would otherwise gate media
 * capture on `undefined`. Anything unrecognised yields `null` and the mirror is
 * left untouched — a read that fails changes nothing (D49).
 */
export function parseTopologySnapshotNodes(data: unknown): readonly NodeLivenessNode[] | null {
  if (typeof data !== 'object' || data === null) return null
  if (!('nodes' in data)) return null
  const { nodes } = data
  if (!Array.isArray(nodes)) return null
  const parsed: NodeLivenessNode[] = []
  for (const entry of nodes) {
    if (typeof entry !== 'object' || entry === null) continue
    if (!('id' in entry) || !('isOnline' in entry)) continue
    const { id, isOnline } = entry
    if (typeof id !== 'string' || typeof isOnline !== 'boolean') continue
    parsed.push({ id, isOnline })
  }
  return parsed
}
