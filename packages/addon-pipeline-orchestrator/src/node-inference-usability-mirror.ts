/**
 * NodeInferenceUsabilityMirror — "can this node still infer?", kept off the
 * placement path.
 *
 * Placement is synchronous over cached topology; usability comes from an async
 * probe. So the answer is MIRRORED here, refreshed by the same
 * `resolveEligibleInferenceDevices` call the dispatcher already makes (and by
 * the session controller's background refresher), and read synchronously when
 * a camera needs a home.
 *
 * ## The two rules that make it safe to act on
 *
 * Excluding a node from placement is DESTRUCTIVE — a wrong exclusion strands
 * cameras — so the mirror is deliberately reluctant, in the shape D49 pinned
 * after a doorbell rang 0/3 on one bad read:
 *
 *  1. **A node never observed is USABLE.** Absence of evidence is not evidence.
 *  2. **Going unusable is ARMED, not applied.** The first unusable observation
 *     arms it; a second CONSECUTIVE one applies it. One failed probe looks
 *     exactly like a dead accelerator, and a probe that answers again clears
 *     the arm without anything having happened.
 *
 * Recovery is immediate and unconditional in the other direction: one usable
 * observation puts a node straight back into placement. The asymmetry is the
 * point — being slow to exclude costs some wasted inference attempts, being
 * slow to re-include costs a camera nobody is watching.
 */

export type NodeUsabilityTransition =
  /** Just became unusable (the arm was confirmed) — emit the system event. */
  | 'became-unusable'
  /** Just came back — log it; there is deliberately no "recovered" event. */
  | 'recovered'
  /** Nothing changed that a caller should act on. */
  | null

interface NodeState {
  readonly usable: boolean
  /** An unusable observation is pending confirmation. */
  readonly armed: boolean
}

export class NodeInferenceUsabilityMirror {
  private readonly state = new Map<string, NodeState>()

  /**
   * Fold one observation in and report whether the caller should act.
   * Never throws.
   */
  observe(nodeId: string, usable: boolean): NodeUsabilityTransition {
    const prev = this.state.get(nodeId)
    if (usable) {
      this.state.set(nodeId, { usable: true, armed: false })
      // A node that was never seen, or was already usable, is not a recovery.
      return prev !== undefined && !prev.usable ? 'recovered' : null
    }
    if (prev === undefined) {
      // First ever observation of this node, and it is bad. ARM it — a node
      // whose probe has answered exactly once has not proven anything.
      this.state.set(nodeId, { usable: true, armed: true })
      return null
    }
    if (!prev.usable) {
      // Already excluded; stay excluded, say nothing.
      this.state.set(nodeId, { usable: false, armed: true })
      return null
    }
    if (!prev.armed) {
      this.state.set(nodeId, { usable: true, armed: true })
      return null
    }
    this.state.set(nodeId, { usable: false, armed: true })
    return 'became-unusable'
  }

  /** Can this node be given cameras? Unknown nodes answer YES. */
  isUsable(nodeId: string): boolean {
    return this.state.get(nodeId)?.usable ?? true
  }

  /** Nodes currently excluded — for the placement log and diagnostics. */
  unusableNodeIds(): readonly string[] {
    const out: string[] = []
    for (const [nodeId, s] of this.state) if (!s.usable) out.push(nodeId)
    return out.toSorted()
  }

  forget(nodeId: string): void {
    this.state.delete(nodeId)
  }

  reset(): void {
    this.state.clear()
  }
}
