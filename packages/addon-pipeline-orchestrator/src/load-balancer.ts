import type { RunnerLocalLoad } from '@camstack/types'

/**
 * Input to the load balancer: one entry per online runner node.
 */
export interface BalancerInput {
  /** Per-node load snapshots fetched from each runner's `getLocalLoad()` cap. */
  readonly nodes: readonly RunnerLocalLoad[]
  /** Optional L1 affinity — if set and the node is online AND under its cap, it wins. */
  readonly preferredAgent?: string | null
  /**
   * Optional per-node camera capacity caps. Maps nodeId → max cameras allowed
   * (null or absent entry = unlimited). Pins count toward the cap:
   * a pinned node at/over its cap returns `pending` rather than over-assigning.
   */
  readonly nodeCaps?: Readonly<Record<string, number | null>>
  /**
   * Optional set of nodes that can OBTAIN this camera's decoded frames
   * (the frame-source constraint). Absent/undefined = no constraint
   * (back-compat for callers that do not model frame sourcing).
   *
   * Semantics: a node NOT in `eligibleNodes` is NEVER assignable — neither by
   * L1 pin nor L2 capacity. A pin to an online node outside this set returns
   * `{kind:'pending', reason:'no-frame-source'}` rather than silently placing
   * the camera on a node that cannot decode its frames (R6/R8).
   */
  readonly eligibleNodes?: readonly string[]
  /**
   * Optional per-node detection WEIGHT (share). Maps nodeId → relative weight
   * (e.g. Mac 60 / hub 30 / N100 10). Absent/<=0 = weight 1. The balancer picks
   * the lowest `capacityScore / weight`, so a node with 6× the weight sustains
   * ~6× the cameras before it stops being preferred — i.e. unpinned cameras
   * distribute PROPORTIONALLY to weight (placement-model-design §4). Ceiling is
   * still enforced independently via {@link nodeCaps} (a hard clamp on top of
   * the weight share). Absent map = equal weights (back-compat, score-only).
   */
  readonly weights?: Readonly<Record<string, number>>
}

/** A successful balancer result — the camera was assigned to a node. */
export interface BalancerAssigned {
  readonly kind: 'assigned'
  readonly agentNodeId: string
  readonly reason: 'manual' | 'capacity'
  readonly score: number
}

/**
 * The balancer could not assign the camera because all eligible nodes are at
 * or over their configured `maxCameras` cap. The camera should remain
 * unassigned until capacity is freed.
 */
export interface BalancerPending {
  readonly kind: 'pending'
  /**
   * - `over-cap`   → every eligible node is at/over its `maxCameras` cap.
   * - `no-frame-source` → the only online (or pinned) nodes are outside
   *   `eligibleNodes`, i.e. none of them can obtain this camera's frames.
   */
  readonly reason: 'over-cap' | 'no-frame-source'
}

/**
 * Output of the load balancer.
 * - `null` → no runners are online at all; the caller defers the assignment.
 * - `BalancerPending` → runners are online but all at/over cap.
 * - `BalancerAssigned` → a node was selected.
 */
export type BalancerDecision = BalancerAssigned | BalancerPending

/**
 * Compute the L2 capacity score for a runner node. Lower is better.
 *
 * The score is **committed standing load + real-time backpressure**:
 *
 *  - `attachedCameras` — the primary signal. Every attached camera is a
 *    standing commitment: an `on-motion` camera costs ≈ zero while idle but
 *    WILL fork a decode+inference session on its node the moment motion fires.
 *    Counting *attachments* (not current inference activity) is what makes the
 *    balancer honest about steady-state load and gives the per-node `weights`
 *    sliders camera-count-share semantics.
 *  - `queueDepthTotal` — real-time pressure: a node whose frame queues are
 *    backing up is falling behind NOW and must be deprioritised beyond its
 *    camera count.
 *
 * The previous formula multiplied `attachedCameras * avgInferenceFps`, which
 * scored a node carrying many IDLE on-motion cameras (fps 0) identically to an
 * empty node — the balancer then piled unpinned cameras onto an already-loaded
 * node until `maxCameras` bit. `avgInferenceFps` (in practice a mislabeled SUM
 * of per-camera fps) is deliberately dropped: transient inference activity is
 * not steady-state load, and a genuinely overloaded node surfaces through
 * `queueDepthTotal` instead.
 */
export function computeCapacityScore(load: RunnerLocalLoad): number {
  const committed = Math.max(load.attachedCameras, 0)
  const pressure = Math.max(load.queueDepthTotal, 0)
  return committed + pressure
}

/**
 * Node detection weight, defaulting to 1 when absent/invalid. A higher weight
 * makes a node preferred proportionally more (see {@link BalancerInput.weights}).
 */
function nodeWeight(nodeId: string, weights: BalancerInput['weights']): number {
  const w = weights?.[nodeId]
  return w !== undefined && w > 0 ? w : 1
}

/**
 * Weight-adjusted capacity score — the value the balancer minimises. Dividing
 * the raw capacity score by the node's weight makes a heavier node accumulate
 * proportionally more load before it loses preference, yielding weight-
 * proportional distribution while still preferring drained/idle nodes.
 */
function weightedScore(load: RunnerLocalLoad, weights: BalancerInput['weights']): number {
  return computeCapacityScore(load) / nodeWeight(load.nodeId, weights)
}

/**
 * Weighted-score improvement of moving one camera off `current` onto `target`
 * (both weight-adjusted). Positive = `target` is less loaded than `current`.
 *
 * Used by the auto-rebalance hysteresis: a migration is applied only when this
 * clears a margin (> 1), so equalizing a mere 1-camera gap — which would just
 * reverse the imbalance — is skipped and a periodic pass never churns an
 * already-balanced cluster.
 */
export function capacityImprovement(
  current: RunnerLocalLoad,
  target: RunnerLocalLoad,
  weights: BalancerInput['weights'],
): number {
  return weightedScore(current, weights) - weightedScore(target, weights)
}

/**
 * Returns true when the node has remaining capacity.
 * A node is eligible iff `cap` is unlimited (null/absent/<=0) OR
 * its `attachedCameras` count is strictly less than the cap.
 * Pins count toward the cap via `attachedCameras`.
 */
function isEligible(node: RunnerLocalLoad, caps: BalancerInput['nodeCaps']): boolean {
  const cap = caps?.[node.nodeId]
  if (cap === null || cap === undefined || cap <= 0) return true // unlimited
  return node.attachedCameras < cap
}

/**
 * One scored, assignable candidate produced by {@link rankCandidates} — the L2
 * view of a node (or, at the device tier, of a deviceKey).
 *
 * `sortKey` is the WEIGHT-ADJUSTED score the balancer minimises; `score` is the
 * raw capacity score reported to the caller. Two candidates with an identical
 * `sortKey` are a genuine TIE: nothing in the load signal separates them, and
 * `balance()` resolves them by `nodeId.localeCompare` — which is constant, not
 * fair. A caller that needs fairness at a tie (the device tier — see
 * `device-balancer.ts`) uses this list to see the tied set and choose within it.
 */
export interface BalancerCandidate {
  readonly nodeId: string
  readonly score: number
  readonly sortKey: number
}

/** The three progressively-narrower node sets `balance()` reasons about. */
interface BalancerPartition {
  /** Nodes with a non-empty id (the caller's "online" set). */
  readonly online: readonly RunnerLocalLoad[]
  /** …that can also obtain this camera's frames (`eligibleNodes` constraint). */
  readonly sourceable: readonly RunnerLocalLoad[]
  /** …that are also under their `maxCameras` cap — the L2 candidate set. */
  readonly eligible: readonly RunnerLocalLoad[]
}

/**
 * Split the balancer input into online / frame-sourceable / cap-eligible.
 * Shared by {@link balance} and {@link rankCandidates} so the two can never
 * disagree about which nodes are assignable.
 */
function partition(input: BalancerInput): BalancerPartition {
  const online = input.nodes.filter((n) => n.nodeId.length > 0)
  // Frame-source constraint — only nodes that can obtain this camera's frames
  // are ever assignable. Absent `eligibleNodes` = no constraint (back-compat).
  const eligibleNodes = input.eligibleNodes
  const sourceable = eligibleNodes ? online.filter((n) => eligibleNodes.includes(n.nodeId)) : online
  return { online, sourceable, eligible: sourceable.filter((n) => isEligible(n, input.nodeCaps)) }
}

/** Score + sort a candidate set. Ascending `sortKey`, then `nodeId` (stable). */
function rankEligible(
  eligible: readonly RunnerLocalLoad[],
  weights: BalancerInput['weights'],
): readonly BalancerCandidate[] {
  return eligible
    .map(
      (node): BalancerCandidate => ({
        nodeId: node.nodeId,
        score: computeCapacityScore(node),
        sortKey: weightedScore(node, weights),
      }),
    )
    .toSorted((a, b) => a.sortKey - b.sortKey || a.nodeId.localeCompare(b.nodeId))
}

/**
 * The L2 candidate list `balance()` picks its head from — every assignable
 * (online ∧ frame-sourceable ∧ under-cap) node, ascending by weight-adjusted
 * score. Ignores `preferredAgent` entirely: a pin is L1 and short-circuits
 * before L2, so this list answers only "how does the CAPACITY tier rank them".
 *
 * Exported so a caller can detect a TIE at the head (equal `sortKey`) and apply
 * its own fair choice within the tied set — see `device-balancer.ts`. Pure and
 * deterministic; the node tier does not use it for selection and so keeps its
 * constant lexicographic tie-break.
 */
export function rankCandidates(input: BalancerInput): readonly BalancerCandidate[] {
  return rankEligible(partition(input).eligible, input.weights)
}

/**
 * Run the two-level camera balancer.
 *
 * Frame-source constraint: when `eligibleNodes` is set, only nodes in that set
 * can obtain this camera's decoded frames. Such a node is a prerequisite for
 * BOTH L1 and L2 — a node outside `eligibleNodes` is never assignable, and a
 * pin to an online-but-ineligible node returns `{kind:'pending',
 * reason:'no-frame-source'}` (mirrors the over-cap-pin behaviour: a pinned
 * camera is never silently placed on a different node).
 *
 * L1 (manual affinity): if `preferredAgent` names an online + frame-sourceable
 * node AND that node is under its `maxCameras` cap, return it. If the node is
 * online but at/over cap, return `{kind:'pending', reason:'over-cap'}`; if it
 * is online but not frame-sourceable, `{kind:'pending', reason:'no-frame-source'}`
 * — a pinned camera is never silently over-assigned or re-homed.
 *
 * L2 (capacity): among the frame-sourceable nodes, filter to those under cap
 * and pick the lowest capacity score. If no frame-sourceable node exists (but
 * online nodes do), return `no-frame-source`; if they exist but are all at/over
 * cap, return `over-cap`.
 *
 * Returns `null` when no runners are online. The orchestrator decides how to
 * react — typically by logging and deferring the assignment until a runner
 * comes online.
 */
export function balance(input: BalancerInput): BalancerDecision | null {
  const { online, sourceable, eligible } = partition(input)
  if (online.length === 0) return null

  // L1 — manual affinity wins, but only when the pinned node is frame-sourceable
  // AND under its cap.
  if (input.preferredAgent) {
    const pinnedOnline = online.find((n) => n.nodeId === input.preferredAgent)
    if (pinnedOnline) {
      if (!sourceable.some((n) => n.nodeId === pinnedOnline.nodeId)) {
        // Pinned node is online but cannot obtain this camera's frames — the
        // camera waits (visible/pending) rather than stranding on a node that
        // cannot decode it or silently falling through to a different node.
        const pending: BalancerPending = { kind: 'pending', reason: 'no-frame-source' }
        return pending
      }
      if (eligible.some((n) => n.nodeId === pinnedOnline.nodeId)) {
        const assigned: BalancerAssigned = {
          kind: 'assigned',
          agentNodeId: pinnedOnline.nodeId,
          reason: 'manual',
          score: computeCapacityScore(pinnedOnline),
        }
        return assigned
      }
      // Pinned node is online + frame-sourceable but at/over cap — camera waits
      // rather than over-assigning or silently falling through to another node.
      const pending: BalancerPending = { kind: 'pending', reason: 'over-cap' }
      return pending
    }
  }

  if (eligible.length === 0) {
    // No eligible node. Distinguish "no node can source frames" from "all
    // frame-sourceable nodes are at/over cap" so the orchestrator can surface
    // the right pending reason (T3).
    const reason: BalancerPending['reason'] =
      sourceable.length === 0 ? 'no-frame-source' : 'over-cap'
    const pending: BalancerPending = { kind: 'pending', reason }
    return pending
  }

  // L2 — lowest WEIGHT-ADJUSTED capacity score among eligible nodes. The
  // reported `score` stays the raw capacity score; selection minimises
  // `score / weight` so unpinned cameras distribute proportionally to weight.
  // Deterministic tie-break on nodeId so equal-share re-runs don't reshuffle.
  // NOTE — that tie-break is CONSTANT, not fair. At the NODE tier this is
  // wanted (an idempotent re-run must not reshuffle a whole cluster); at the
  // DEVICE tier it starved a second accelerator forever, which is why
  // `device-balancer.ts` re-ranks with {@link rankCandidates} and resolves the
  // tie itself rather than this function becoming non-deterministic.
  const best = rankEligible(eligible, input.weights)[0]!

  const assigned: BalancerAssigned = {
    kind: 'assigned',
    agentNodeId: best.nodeId,
    reason: 'capacity',
    score: best.score,
  }
  return assigned
}

// NOTE — the decoder balancer (`balanceDecoder` / `isDecoderPinHonored`) was
// removed together with the advisory decoder-assignment surface. Decode is
// always co-located with its frame consumer (the shm ring is node-local; an
// off-owner detection node decodes locally via its satellite plane), so there
// is no decoder-placement decision to balance.
