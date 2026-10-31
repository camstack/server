/**
 * The hub's runs ledger: what each automation block and each Action run DID.
 *
 * One row per owner (`automation:<blockId>` / `action:<actionId>`) holding the
 * cooldown stamp and a ring of run traces. It replaces the block's own
 * `ctx.storage` file: a block runs in a forked runner, and a trace written from
 * there never reached the editor that wants to paint it.
 *
 * Two rules from the repo shape this file:
 *  - A write is a read-modify-write of one row, so writes to an owner are
 *    chained — two reports racing would otherwise lose a trace.
 *  - A row is deleted with its owner, and a start-up sweep removes the rows
 *    whose owner is gone. The sweep only ever deletes after the owner list was
 *    read successfully AND read again (D49: a read that would destroy work is
 *    confirmed by a second one).
 *
 * @durable class=config owner=core-blocks
 *   write="a block or an Action run reports a run; the ring is bounded by `keepTraces`"
 *   retention="deleted with the block / action; orphans swept at start"
 */
import {
  appendTrace,
  type AutomationRunTrace,
  type AutomationStateDoc,
  EMPTY_AUTOMATION_STATE,
  type IScopedLogger,
  MAX_TRACE_KEEP,
  type RecordKindHandle,
} from '@camstack/types'
import type { RunsRowBody } from './record-kinds.js'

export const AUTOMATION_OWNER_PREFIX = 'automation:'
export const ACTION_OWNER_PREFIX = 'action:'
export const SCHEDULER_OWNER_PREFIX = 'scheduler:'

export function automationOwner(blockId: string): string {
  return `${AUTOMATION_OWNER_PREFIX}${blockId}`
}

export function actionOwner(actionId: string): string {
  return `${ACTION_OWNER_PREFIX}${actionId}`
}

export function schedulerOwner(schedulerId: string): string {
  return `${SCHEDULER_OWNER_PREFIX}${schedulerId}`
}

/** The ring size when a reporter does not say. */
export const DEFAULT_TRACE_KEEP = 20

export interface RunsReport {
  readonly trace?: AutomationRunTrace
  readonly runStartedAt?: number
  readonly keepTraces?: number
}

export interface RunsLedgerView extends AutomationStateDoc {
  readonly lastError: string | null
}

export const EMPTY_RUNS_VIEW: RunsLedgerView = { ...EMPTY_AUTOMATION_STATE, lastError: null }

export interface RunsLedgerOptions {
  readonly runs: RecordKindHandle<RunsRowBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/** The failure a trace stands for, or null when it did not fail. */
function failureOf(trace: AutomationRunTrace): string | null {
  if (trace.outcome !== 'failed') return null
  const step = trace.steps.find((s) => s.outcome === 'error')
  return step?.message ?? 'the run failed'
}

export class RunsLedger {
  private readonly runs: RecordKindHandle<RunsRowBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly chains = new Map<string, Promise<void>>()

  constructor(options: RunsLedgerOptions) {
    this.runs = options.runs
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  async get(owner: string): Promise<RunsLedgerView> {
    const row = await this.runs.get(owner)
    if (row === null) return EMPTY_RUNS_VIEW
    return {
      version: 1,
      lastRunStartedAt: row.data.lastRunStartedAt,
      traces: row.data.traces,
      lastError: row.data.lastError,
    }
  }

  /** Several owners in ONE read; an owner with no row is idle. */
  async getMany(owners: readonly string[]): Promise<ReadonlyMap<string, RunsLedgerView>> {
    const out = new Map<string, RunsLedgerView>()
    if (owners.length === 0) return out
    const rows = await this.runs.getMany(owners)
    for (const row of rows) {
      out.set(row.id, {
        version: 1,
        lastRunStartedAt: row.data.lastRunStartedAt,
        traces: row.data.traces,
        lastError: row.data.lastError,
      })
    }
    return out
  }

  /** Fold one report into the owner's row. Reports to one owner run one at a time. */
  report(owner: string, report: RunsReport): Promise<void> {
    const previous = this.chains.get(owner) ?? Promise.resolve()
    const next = previous.then(() => this.apply(owner, report))
    const settled = next.catch(() => undefined)
    this.chains.set(owner, settled)
    void settled.then(() => {
      if (this.chains.get(owner) === settled) this.chains.delete(owner)
    })
    return next
  }

  private async apply(owner: string, report: RunsReport): Promise<void> {
    const keep = Math.min(report.keepTraces ?? DEFAULT_TRACE_KEEP, MAX_TRACE_KEEP)
    const current = await this.get(owner)
    const traces =
      report.trace === undefined
        ? current.traces.slice(-keep)
        : appendTrace(current.traces, report.trace, keep)
    const failure = report.trace === undefined ? undefined : failureOf(report.trace)
    const lastError =
      report.trace === undefined || isSkip(report.trace) ? current.lastError : failure
    await this.runs.put({
      id: owner,
      data: {
        version: 1,
        lastRunStartedAt: report.runStartedAt ?? current.lastRunStartedAt,
        traces,
        lastError: lastError ?? null,
        updatedAt: this.now(),
      },
    })
  }

  async delete(owner: string): Promise<void> {
    await this.runs.delete(owner)
  }

  /**
   * Remove the rows whose owner no longer exists. `liveOwners` is asked TWICE;
   * only an owner missing from both answers loses its row, so one stale read
   * cannot destroy a ring.
   */
  async sweep(liveOwners: () => Promise<ReadonlySet<string>>): Promise<number> {
    const firstLook = await liveOwners()
    const orphans: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.runs.query({ ...(cursor === undefined ? {} : { cursor }) })
      for (const row of page.records) {
        if (!firstLook.has(row.id)) orphans.push(row.id)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    if (orphans.length === 0) return 0
    const secondLook = await liveOwners()
    const confirmed = orphans.filter((id) => !secondLook.has(id))
    if (confirmed.length === 0) return 0
    const removed = await this.runs.deleteMany(confirmed)
    this.logger.info('runs ledger: swept rows of owners that no longer exist', {
      meta: { removed, owners: confirmed },
    })
    return removed
  }
}

function isSkip(trace: AutomationRunTrace): boolean {
  return trace.outcome.startsWith('skipped-')
}
