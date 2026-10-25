/**
 * A `node-updating` announcement that would be delivered AFTER the update it
 * announces has landed is stale — this is where that is decided (D723).
 *
 * ## Why it can happen
 *
 * A node announces its own restart (`system.restarting`) and exits after a
 * grace. When the node is the HUB, the notification centre runs on the hub and
 * has those seconds to send the push. The outbox is durable, so a send that did
 * not finish is retried after the reboot — and lands next to the
 * `server-updated` the new process announces, saying "about to update" about
 * an update that is already over.
 *
 * ## The rule
 *
 * The centre records every `server-updated` it hears (whether or not any rule
 * matched it: the landing is a fact about the node, not about a rule), keyed by
 * node and target version. At send time a `node-updating` row whose node and
 * target version are recorded is DROPPED, benignly (the row ends `sent`, like a
 * snooze), with a log line naming the node. Nothing else is touched: a plain
 * `node-restarting` has no version to compare and is never superseded, and an
 * agent's announcement is sent while the hub is up, before the landing exists.
 *
 * The record is RAM and bounded. The case it exists for is one process
 * lifetime: the retry after a reboot and the landing heard by the same
 * process. A landing heard AFTER the stale row drained cannot recall it — the
 * two then arrive in the right order, which is the harmless half.
 */
import type { NcSystemEventSubject } from './rule-engine.js'
import type { NcOutboxEntry } from './outbox.js'

/** How many landings are remembered — one per node per update, so a fleet's worth. */
const NC_UPDATE_LANDINGS_MAX = 256

/** Why a row is not sent — the caller logs it. */
export interface NcSupersededAnnouncement {
  readonly nodeId: string
  readonly toVersion: string
  /** When the landing was heard (epoch ms). */
  readonly landedAt: number
}

function landingKey(nodeId: string, toVersion: string): string {
  return `${nodeId}\u0000${toVersion}`
}

export class NcUpdateLandings {
  /** Insertion-ordered: the oldest landing is the first one evicted. */
  private readonly landed = new Map<string, number>()

  constructor(private readonly max: number = NC_UPDATE_LANDINGS_MAX) {}

  /** Feed every system subject the intake accepted; only `server-updated` is kept. */
  observe(system: NcSystemEventSubject, atMs: number): void {
    if (system.kind !== 'server-updated') return
    const nodeId = system.nodeId
    const toVersion = system.textParams?.['toVersion']
    if (nodeId === undefined || toVersion === undefined) return
    const key = landingKey(nodeId, toVersion)
    this.landed.delete(key)
    this.landed.set(key, atMs)
    while (this.landed.size > this.max) {
      const oldest = this.landed.keys().next()
      if (oldest.done === true) break
      this.landed.delete(oldest.value)
    }
  }

  /** The landing that makes this row stale, or `null` when it should be sent. */
  supersedes(entry: NcOutboxEntry): NcSupersededAnnouncement | null {
    const system = entry.payload.subject.systemEvent
    if (system === undefined || system.kind !== 'node-updating') return null
    const nodeId = system.nodeId
    const toVersion = system.textParams?.['toVersion']
    if (nodeId === undefined || toVersion === undefined) return null
    const landedAt = this.landed.get(landingKey(nodeId, toVersion))
    return landedAt === undefined ? null : { nodeId, toVersion, landedAt }
  }
}
