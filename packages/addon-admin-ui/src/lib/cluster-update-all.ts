/**
 * The cluster-wide "Update all nodes" sequence — the part that decides what
 * HAPPENED, kept out of the page component so it can be tested against every
 * outcome the hub can produce.
 *
 * ## What this replaces, and why
 *
 * The loop on the Cluster page used to be:
 *
 * ```ts
 * try { await applyAllMutation.mutateAsync(routing) } catch {
 *   // A hub/agent restart drops this request's socket mid-response —
 *   // expected once the update lands, not a genuine failure.
 * }
 * ```
 *
 * The comment is true and the conclusion does not follow. Two separate holes,
 * both of which fired on the live cluster on 2026-09-01 (agents reached
 * 1.2.205, the hub stayed on 1.2.201 and logged nothing):
 *
 *  1. **A refusal is not an exception.** `applyServerUpdate` answers
 *     `{accepted:false, message}` on six branches — workspace boot mode, an
 *     operation in flight, a version already staged, an unresolvable latest,
 *     the target already running, missing dev-channel uploads. The loop never
 *     looked at `accepted`, so every one of those read as a success. This half
 *     is not ambiguous at all and is simply fixed.
 *
 *  2. **A thrown error IS ambiguous, and must not be guessed.** The node we
 *     just armed restarting, and a forward that timed out because the node was
 *     wedged, produce the same rejection at this layer — the transport cannot
 *     tell them apart, and no amount of message-sniffing makes it able to.
 *     So the drop is not classified from the error: it is RECONCILED by
 *     reading the node back (`getServerPackageStatus`) and asking whether the
 *     work PERSISTED — `pendingVersion` armed, or `runningVersion` already the
 *     new one. That is the D58 discipline ("gate on did it land"), and it
 *     yields `unconfirmed` — never `applied` — when the node cannot answer.
 */
import type { ServerPackageStatus, ServerUpdateActionResult } from '@camstack/types'
import i18n from '../i18n/index'

/**
 * Singleton cap routing: the hub is the unpinned default provider, agents are
 * `nodeId`-pinned. Same convention as `NodeServerManagementSection`.
 */
export interface NodeRouting {
  /**
   * The cap procedure's input is a LOOSE object (`{[x: string]: unknown} &
   * {version?: string}`) so the `nodeId` routing key can ride alongside the
   * method's own fields. The index signature is what makes this type
   * assignable to it — without it the routing object is rejected at the
   * mutation call, which is a type error, not a shape the runtime cares about.
   */
  readonly [key: string]: unknown
  readonly nodeId?: string
}

/** The cluster-node slice this sequence needs. */
export interface UpdateAllTarget {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
}

/**
 * What one node's update did.
 *
 *  - `applied`     — the node accepted and armed the update.
 *  - `refused`     — the node answered and declined; `detail` says why.
 *  - `failed`      — the call was dropped AND the node came back settled and
 *                    unchanged, so nothing was ever armed.
 *  - `unconfirmed` — the call was dropped and the node could not be read back.
 *                    Not a success and not a failure; the honest third answer.
 *  - `skipped`     — never attempted: the hub step before it did not land, and
 *                    `detail` names it. An agent is not updated past a hub that
 *                    still runs the old server.
 */
export type NodeUpdateOutcome = 'applied' | 'refused' | 'failed' | 'unconfirmed' | 'skipped'

export interface NodeUpdateReport {
  readonly nodeId: string
  readonly nodeName: string
  readonly outcome: NodeUpdateOutcome
  readonly detail: string
}

/** The I/O this sequence performs, injected so it is testable end to end. */
export interface UpdateAllSeams {
  readonly apply: (routing: NodeRouting) => Promise<ServerUpdateActionResult>
  readonly readStatus: (routing: NodeRouting) => Promise<ServerPackageStatus>
  readonly wait: (ms: number) => Promise<void>
}

/**
 * How many times a dropped call is reconciled against the node, and how long
 * between attempts. A node that is applying the update is mid-restart, so the
 * first read usually fails; three attempts over ~20 s covers a container
 * bounce without making a genuinely dead node hold the sequence for minutes.
 */
const CONFIRM_ATTEMPTS = 3
const CONFIRM_DELAY_MS = 7_000

/**
 * How long the hub is given to come back on the target before the agents are
 * left alone: 36 reads, 5 s apart (~3 min), enough for a container bounce.
 */
const HUB_SETTLE_ATTEMPTS = 36
const HUB_SETTLE_DELAY_MS = 5_000

/**
 * Hub first, agents after: one update order everywhere (the CLI's
 * `ops-update-apply` already does it). An agent's server and addons are judged
 * against what the hub requires, and the hub is what delivers an agent its
 * addons — an agent updated ahead of the hub is told to wait or ends up on a
 * server the hub does not yet speak.
 */
export function orderForUpdateAll(nodes: readonly UpdateAllTarget[]): readonly UpdateAllTarget[] {
  return [...nodes].sort((a, b) => (a.isHub === b.isHub ? 0 : a.isHub ? -1 : 1))
}

function routingFor(node: UpdateAllTarget): NodeRouting {
  return node.isHub ? {} : { nodeId: node.id }
}

/**
 * Did the update LAND on this node? Answered from the node's own state, not
 * from the shape of the error that interrupted us.
 */
function landedFromStatus(status: ServerPackageStatus): boolean {
  if (status.updateState === 'staging' || status.updateState === 'pending-restart') return true
  if (status.pendingVersion !== null) return true
  // The node already came back on the newer code: nothing left to apply.
  return !status.updateAvailable
}

async function confirmDroppedCall(
  node: UpdateAllTarget,
  seams: UpdateAllSeams,
): Promise<NodeUpdateReport> {
  const routing = routingFor(node)
  let lastError = i18n.t('helpers.clusterUpdateAll.noAnswer')
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      const status = await seams.readStatus(routing)
      if (landedFromStatus(status)) {
        return {
          nodeId: node.id,
          nodeName: node.name,
          outcome: 'applied',
          detail: i18n.t('helpers.clusterUpdateAll.landed', {
            state: status.updateState,
            version: status.runningVersion ?? i18n.t('helpers.clusterUpdateAll.unknown'),
          }),
        }
      }
      return {
        nodeId: node.id,
        nodeName: node.name,
        outcome: 'failed',
        detail: i18n.t('helpers.clusterUpdateAll.unchanged', {
          version: status.runningVersion ?? i18n.t('helpers.clusterUpdateAll.unknown'),
        }),
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (attempt < CONFIRM_ATTEMPTS) await seams.wait(CONFIRM_DELAY_MS)
    }
  }
  return {
    nodeId: node.id,
    nodeName: node.name,
    outcome: 'unconfirmed',
    detail: i18n.t('helpers.clusterUpdateAll.unconfirmed', {
      attempts: CONFIRM_ATTEMPTS,
      error: lastError,
    }),
  }
}

/**
 * A node that ANSWERED. `accepted` alone cannot separate "declined, nothing
 * wrong" from "tried and died on the registry" — on 2026-09-19 the hub's
 * staging install hit `ECONNRESET` and the sequence would have filed it next
 * to "already running". The provider's `outcome` says which; a provider too
 * old to send one is read the way it always was.
 */
function classifyAnswer(result: ServerUpdateActionResult): NodeUpdateOutcome {
  if (result.accepted) return 'applied'
  return result.outcome === 'failed' ? 'failed' : 'refused'
}

/**
 * Is the hub RUNNING the target, read from its own status? A read that fails
 * (the hub is mid-restart) is another attempt, never a pass.
 */
async function hubSettled(seams: UpdateAllSeams): Promise<boolean> {
  for (let attempt = 1; attempt <= HUB_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      const status = await seams.readStatus({})
      if (
        !status.updateAvailable &&
        status.updateState === 'idle' &&
        status.pendingVersion === null
      ) {
        return true
      }
    } catch {
      // restarting — read again
    }
    if (attempt < HUB_SETTLE_ATTEMPTS) await seams.wait(HUB_SETTLE_DELAY_MS)
  }
  return false
}

function skippedReport(node: UpdateAllTarget, hub: UpdateAllTarget, why: string): NodeUpdateReport {
  return {
    nodeId: node.id,
    nodeName: node.name,
    outcome: 'skipped',
    detail: i18n.t('helpers.clusterUpdateAll.skippedAfterHub', { hub: hub.name, why }),
  }
}

/**
 * Run the sequence. Never throws: every node produces exactly one report. The
 * hub goes FIRST and the agents wait until it runs the target; if the hub
 * step does not land, the agents are reported `skipped` and name that step.
 * Between agents, one outcome never stops the next.
 */
export async function updateAllNodes(
  nodes: readonly UpdateAllTarget[],
  seams: UpdateAllSeams,
): Promise<readonly NodeUpdateReport[]> {
  const reports: NodeUpdateReport[] = []
  let blockedBy: { readonly hub: UpdateAllTarget; readonly why: string } | null = null
  for (const node of orderForUpdateAll(nodes)) {
    if (blockedBy !== null) {
      reports.push(skippedReport(node, blockedBy.hub, blockedBy.why))
      continue
    }
    let report: NodeUpdateReport
    let alreadyCurrent = false
    try {
      const result = await seams.apply(routingFor(node))
      alreadyCurrent = result.outcome === 'already-current' || result.reason === 'already-running'
      report = {
        nodeId: node.id,
        nodeName: node.name,
        outcome: classifyAnswer(result),
        detail: result.message,
      }
    } catch {
      report = await confirmDroppedCall(node, seams)
    }
    reports.push(report)
    if (node.isHub) {
      const isLast = reports.length === nodes.length
      // A hub that is already on the target needs nothing and blocks nothing:
      // the agents are the part still behind.
      if (alreadyCurrent) {
        // continue with the agents
      } else if (report.outcome !== 'applied') {
        blockedBy = { hub: node, why: report.outcome }
      } else if (!isLast && !(await hubSettled(seams))) {
        blockedBy = { hub: node, why: i18n.t('helpers.clusterUpdateAll.hubNotSettled') }
      }
    }
  }
  return reports
}
