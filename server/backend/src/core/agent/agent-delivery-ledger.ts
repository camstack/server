/**
 * "Is the hub currently writing addons to this node?"
 *
 * WHY THIS EXISTS
 * The addon back-fill repairs a node by comparing the roster the node reports
 * NOW against the roster it last declared. A hub-initiated delivery makes that
 * comparison lie, for a window it opens itself:
 *
 *   1. `$agent.deploy`'s `onApplied` evicts the package's declaration ids from
 *      the node's `loadedAddons`, so `$agent.status` stops reporting it;
 *   2. `$agent.reload` re-instantiates every runner, and a status read landing
 *      mid-reload sees a PARTIAL roster — measured on `agent-a`
 *      2026-08-07 as the same reconcile reporting "14 checked" and, seconds
 *      later, "20 checked";
 *   3. the reload re-registers the node, which fires the reconcile, which reads
 *      the roster of step 1/2 and concludes the package is missing.
 *
 * The hub then "repairs" the node by installing over the bundle an operator
 * delivered 1.5 seconds earlier. That defect (fixed once by making the pack
 * source the hub's installed copy) is a symptom: the trigger is a roster gap
 * the hub itself caused. This ledger removes the trigger.
 *
 * IT IS NOT A SLEEP
 * The window opens on the FIRST byte of a delivery and closes
 * {@link DELIVERY_GRACE_MS} after the LAST in-flight delivery to that node
 * finishes. A delivery that takes four minutes (the pipeline stack on a slow
 * agent) holds the window open for four minutes; nothing is timed
 * speculatively. The grace tail covers the re-registration storm that follows
 * a reload, which arrives after the RPC has already returned.
 *
 * PROCESS-SCOPED AND HOLDS NO INTENT
 * Same shape as `BackfillAttemptTracker`: in-memory, per hub lifetime, and
 * carrying nothing durable. Losing it on a restart is correct — a hub that just
 * restarted has no delivery in flight.
 */

/**
 * How long after a delivery finishes the node stays protected from a back-fill.
 *
 * Sized for the re-registration storm: `$agent.reload` returns when the runners
 * have been asked to restart, and their `$hub.registerNode` calls (one per
 * group runner — 12 on `agent-a`) land over the following seconds. Each
 * one fires a reconcile.
 */
export const DELIVERY_GRACE_MS = 60_000

interface NodeDeliveryState {
  /** Deliveries currently running to this node. */
  inFlight: number
  /** Epoch ms the last in-flight delivery to this node completed. */
  lastFinishedAt: number
  /** Package names delivered in the current/most recent window — for the log. */
  readonly packages: Set<string>
}

/** Why a node is protected, in the words the log line uses. */
export interface DeliverySuppression {
  readonly nodeId: string
  readonly inFlight: number
  readonly msSinceLastDelivery: number | null
  readonly packages: readonly string[]
}

export class AgentDeliveryLedger {
  private readonly byNode = new Map<string, NodeDeliveryState>()

  private forNode(nodeId: string): NodeDeliveryState {
    const existing = this.byNode.get(nodeId)
    if (existing) return existing
    const created: NodeDeliveryState = {
      inFlight: 0,
      lastFinishedAt: 0,
      packages: new Set<string>(),
    }
    this.byNode.set(nodeId, created)
    return created
  }

  /**
   * A delivery to `nodeId` is starting. Returns the function that closes it —
   * callers MUST invoke it in a `finally`, or the node stays protected for the
   * rest of the hub's life and the back-fill silently stops repairing it.
   */
  begin(nodeId: string, packageName: string, now: () => number = Date.now): () => void {
    const state = this.forNode(nodeId)
    state.inFlight += 1
    state.packages.add(packageName)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      state.inFlight = Math.max(0, state.inFlight - 1)
      // Stamped at CLOSE, not at begin: the grace tail measures time since the
      // delivery finished, and a four-minute install must not have spent its
      // grace while it was still running.
      state.lastFinishedAt = Math.max(state.lastFinishedAt, now())
    }
  }

  /**
   * `null` when the node is free to be back-filled; a described suppression
   * otherwise. Returning the REASON rather than a boolean is deliberate: a
   * back-fill that declines to run must say why, or it is indistinguishable
   * from a back-fill that found nothing to do.
   */
  suppressionFor(nodeId: string, now: number = Date.now()): DeliverySuppression | null {
    const state = this.byNode.get(nodeId)
    if (!state) return null
    const since = state.lastFinishedAt === 0 ? null : now - state.lastFinishedAt
    if (state.inFlight === 0 && (since === null || since >= DELIVERY_GRACE_MS)) {
      // Window closed — drop the package memory so a later suppression names
      // only the packages of the delivery that caused it.
      state.packages.clear()
      return null
    }
    return {
      nodeId,
      inFlight: state.inFlight,
      msSinceLastDelivery: since,
      packages: [...state.packages],
    }
  }

  /** Drop everything remembered about a node (e.g. "Forget node"). */
  forget(nodeId: string): void {
    this.byNode.delete(nodeId)
  }
}
