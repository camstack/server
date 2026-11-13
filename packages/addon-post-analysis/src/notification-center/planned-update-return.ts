/**
 * A node that went offline for an update is expected back. This is the
 * deadline that says it did not come back.
 *
 * Armed when the offline is dropped ({@link PLANNED_UPDATE_RETURN_DEADLINE_MS}
 * from the ledger row's `updatedAt`). The decision reads the in-memory ledger
 * only — never a store read on the timer or the event path (D49). A process
 * that dies in between recovers from the same row on boot: already past the
 * deadline notifies once, still inside it re-arms the remainder. The row's
 * cause becomes `update-unreturned` before the notification is handed off, so
 * a second pass (the timer and the boot, or a later boot) does not send it
 * again.
 */

import type { IScopedLogger } from '@camstack/types'
import type { NcIncomingEvent } from './event-intake.js'
import type { NcLivenessRow } from './liveness-ledger.js'
import { NC_SYSTEM_DEVICE_ID } from './rule-engine.js'

/** How long a planned-update offline may stay offline before it is news. */
export const PLANNED_UPDATE_RETURN_DEADLINE_MS = 10 * 60_000

/** The sentence for a node that missed that deadline. */
export const PLANNED_UPDATE_UNRETURNED_BODY_KEY = 'system.node-offline.body.agent.update-unreturned'

export interface PlannedUpdateReturnDeps {
  readonly now: () => number
  readonly logger: IScopedLogger
  /** The in-memory ledger row for `node:<id>`, if the ledger holds one. */
  readonly rowForNode: (nodeId: string) => NcLivenessRow | undefined
  /** Mirror first, write behind. A second pass must already see the mark. */
  readonly markUnreturned: (row: NcLivenessRow) => void
  readonly deliver: (nodeId: string, offlineAt: number) => void
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly cancel?: (id: ReturnType<typeof setTimeout>) => void
}

type ReturnVia = 'deadline' | 'boot'

export class NcPlannedUpdateReturn {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly scheduleFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly cancelFn: (id: ReturnType<typeof setTimeout>) => void

  constructor(
    private readonly deps: PlannedUpdateReturnDeps,
    private readonly deadlineMs: number = PLANNED_UPDATE_RETURN_DEADLINE_MS,
  ) {
    this.scheduleFn = deps.schedule ?? setTimeout
    this.cancelFn = deps.cancel ?? clearTimeout
  }

  /** The offline was just accepted as a planned update. `offlineAt` is the row's `updatedAt`. */
  arm(nodeId: string, offlineAt: number): void {
    this.scheduleNode(nodeId, this.deadlineMs - (this.deps.now() - offlineAt))
  }

  /** Boot: the ledger is already in memory. Expired rows notify; younger ones wait out the rest. */
  recover(rows: readonly NcLivenessRow[]): void {
    for (const row of rows) {
      if (row.state !== 'offline' || row.cause !== 'update') continue
      const nodeId = nodeIdOfSubject(row.subject)
      if (nodeId === undefined) {
        this.deps.logger.info(
          'planned update return skipped — the offline row is not a node subject',
          { meta: { nodeId: row.subject } },
        )
        continue
      }
      const remainingMs = this.deadlineMs - (this.deps.now() - row.updatedAt)
      if (remainingMs <= 0) {
        this.notifyIfStillOffline(nodeId, 'boot')
        continue
      }
      this.scheduleNode(nodeId, remainingMs)
    }
  }

  /** The node came back inside the deadline. The matching online stays quiet. */
  cancel(nodeId: string): void {
    if (!this.timers.has(nodeId)) return
    this.clearTimer(nodeId)
    this.deps.logger.info('planned update return deadline cancelled — the node came back', {
      meta: { nodeId },
    })
  }

  dispose(): void {
    for (const nodeId of [...this.timers.keys()]) {
      this.clearTimer(nodeId)
      this.deps.logger.info(
        'planned update return deadline cleared on stop — the ledger still holds the offline',
        { meta: { nodeId } },
      )
    }
  }

  private scheduleNode(nodeId: string, remainingMs: number): void {
    this.clearTimer(nodeId)
    if (remainingMs <= 0) {
      this.deps.logger.info('planned update return deadline already elapsed', {
        meta: { nodeId, remainingMs },
      })
      this.notifyIfStillOffline(nodeId, 'deadline')
      return
    }
    const id = this.scheduleFn(() => {
      this.timers.delete(nodeId)
      this.notifyIfStillOffline(nodeId, 'deadline')
    }, remainingMs)
    this.timers.set(nodeId, id)
    this.deps.logger.info('planned update return deadline armed', {
      meta: { nodeId, remainingMs },
    })
  }

  private notifyIfStillOffline(nodeId: string, via: ReturnVia): void {
    const row = this.deps.rowForNode(nodeId)
    if (row === undefined || row.state !== 'offline' || row.cause !== 'update') {
      this.deps.logger.info(
        'planned update return not notified — the node is no longer offline from the update',
        { meta: { nodeId, via, state: row?.state, cause: row?.cause } },
      )
      return
    }
    const offlineForMs = this.deps.now() - row.updatedAt
    if (offlineForMs < this.deadlineMs) {
      this.deps.logger.info('planned update return deadline not reached — re-armed', {
        meta: { nodeId, via, remainingMs: this.deadlineMs - offlineForMs },
      })
      this.scheduleNode(nodeId, this.deadlineMs - offlineForMs)
      return
    }
    this.deps.markUnreturned(row)
    this.deps.logger.info('node did not come back after the update — notifying', {
      meta: { nodeId, via, offlineForMs },
    })
    this.deps.deliver(nodeId, row.updatedAt)
  }

  private clearTimer(nodeId: string): void {
    const existing = this.timers.get(nodeId)
    if (existing === undefined) return
    this.cancelFn(existing)
    this.timers.delete(nodeId)
  }
}

/** The ledger subject an agent offline is stored under. */
export function plannedUpdateNodeSubject(nodeId: string): string {
  return `node:${nodeId}`
}

function nodeIdOfSubject(subject: string): string | undefined {
  if (!subject.startsWith('node:')) return undefined
  const nodeId = subject.slice('node:'.length)
  if (nodeId.length === 0 || nodeId.includes('/')) return undefined
  return nodeId
}

/** One `node-offline` the rules already match, worded as a missed update return. */
export function unreturnedUpdateIncoming(
  nodeId: string,
  offlineAt: number,
  notifiedAt: number,
): NcIncomingEvent {
  const subject = plannedUpdateNodeSubject(nodeId)
  return {
    kind: 'system-event',
    origin: 'system',
    subject: {
      kind: 'system-event',
      recordId: `update-unreturned:${nodeId}:${offlineAt}`,
      deviceId: NC_SYSTEM_DEVICE_ID,
      timestamp: notifiedAt,
      classNames: [],
      zones: [],
      systemEvent: {
        kind: 'node-offline',
        subject,
        titleKey: 'system.node-offline.title',
        bodyKey: PLANNED_UPDATE_UNRETURNED_BODY_KEY,
        textParams: { nodeId, nodeName: nodeId },
        nodeId,
        data: { category: 'agent.offline', updateReturn: 'unreturned' },
      },
    },
    log: () => ({
      tags: {},
      meta: { nodeId, kind: 'node-offline', subject, offlineAt },
    }),
  }
}
