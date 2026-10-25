/**
 * Which node runs the next piece of a rebuild pass — and which nodes have
 * removed themselves from the running.
 *
 * ## Why round-robin and not the balancer
 *
 * The device balancer's node tier breaks a score tie lexicographically
 * (`device-balancer.ts` documents why that is right there). For SHORT-LIVED
 * work it is a starvation bug: every candidate scores 0 at dispatch time
 * because nothing is attached yet, so the tie-break decides every single
 * dispatch and the alphabetically-first node runs the entire pass. A rebuild is
 * thousands of ~1 s units with no state to be affinity to, so plain rotation
 * both spreads the work and sidesteps the trap. The operator's own framing:
 * "first available node, or a setting to name one — it does not have to be
 * perfect."
 *
 * ## Why dropping is one-way
 *
 * A node leaves the rotation for a reason that will not change during the pass:
 * it does not have the step, cannot serve the pinned model, or has stopped
 * answering. Re-admitting it would re-pay the same failure once per track. Each
 * departure is recorded WITH its reason, because the operator's question at the
 * end is never "how many nodes" but "why did that one stop contributing".
 */

/** A node that left the rotation, and why. */
export interface DroppedNode {
  readonly nodeId: string
  readonly reason: string
}

/**
 * Round-robin over a fixed candidate set, minus whoever has dropped out.
 *
 * Deliberately a tiny mutable object rather than a pure fold: the pass is a
 * long sequential walk, and threading "the rotation state so far" through every
 * track would obscure the only thing that matters here, which is that
 * {@link next} can never return a dropped node and can never wedge.
 */
export class NodeRotation {
  private readonly candidates: string[]
  private readonly departed: DroppedNode[] = []
  private cursor = 0

  constructor(nodeIds: readonly string[]) {
    // De-duplicated: `getAgentLoad` and an operator override can name the same
    // node, and a doubled entry would silently double that node's share.
    this.candidates = [...new Set(nodeIds)]
  }

  /** Nodes still eligible, in rotation order. */
  get live(): readonly string[] {
    return this.candidates
  }

  /** Nodes that left, with the reason each one gave. */
  get dropped(): readonly DroppedNode[] {
    return this.departed
  }

  /** True when nothing is left to dispatch to — the pass cannot continue. */
  get exhausted(): boolean {
    return this.candidates.length === 0
  }

  /** The next node to use, or `null` when the rotation is empty. */
  next(): string | null {
    if (this.candidates.length === 0) return null
    const index = this.cursor % this.candidates.length
    this.cursor = index + 1
    return this.candidates[index] ?? null
  }

  /**
   * Remove a node for the rest of the pass. Idempotent — a node that fails two
   * different ways in the same track must not be recorded twice, or the
   * operator-facing list stops matching the count.
   */
  drop(nodeId: string, reason: string): void {
    const index = this.candidates.indexOf(nodeId)
    if (index < 0) return
    this.candidates.splice(index, 1)
    this.departed.push({ nodeId, reason })
    // The cursor indexes a list that just got shorter. Rewinding when the
    // removed entry was before it keeps the rotation from skipping the node
    // that shifted into its place — a skip is invisible and would quietly
    // starve one node for the rest of the pass.
    if (index < this.cursor && this.cursor > 0) this.cursor -= 1
  }
}
