/**
 * The STATE SUMMARY's tick (D647): for every enabled summary rule, is a
 * window owed, and if so collect → word → enqueue → stamp.
 *
 * Driven by the centre's existing rule-reload tick — no timer of its own — and
 * single-flight. It reads RAM only: the rule mirror, the stamps and the state
 * mirrors (D447: nothing on this schedule queries SQLite).
 *
 * Every branch that sends nothing SAYS so: an empty state (INFO), a missed
 * window (WARN), a stamp ledger that has not been read (WARN — nothing is sent
 * until it has, because without it a restart could send a window twice), a
 * delivery that failed (WARN, retried on the next tick inside the grace).
 *
 * The stamp is LAST, as in the digest: a window whose enqueue failed stays owed.
 */
import {
  type IScopedLogger,
  type NcRule,
  type NcSchedule,
  systemEventSummaryScheduleOf,
} from '@camstack/types'
import { canonicalHash } from '@camstack/types/node'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import { isEmptyStateSummary, type NcStateSummary } from './state-summary.js'
import type { NcStateSummaryStamp, NcStateSummaryStampPort } from './state-summary-stamps.js'
import {
  decideStateSummary,
  NC_STATE_SUMMARY_MAX_LOOKBACK_MS,
  nextStateSummaryClose,
} from './state-summary-window.js'

export interface NcStateSummarySchedulerDeps {
  /** Every enabled `system-event` rule (the scheduler picks the summary ones). */
  readonly rules: () => readonly NcRule[]
  readonly stamps: NcStateSummaryStampPort
  readonly collect: (rule: NcRule, nowMs: number) => Promise<NcStateSummary>
  /** Enqueue the summary through the outbox; resolves to the rows inserted. */
  readonly deliver: (rule: NcRule, summary: NcStateSummary, window: ClosedWindow) => Promise<number>
  readonly now: () => number
  readonly logger: IScopedLogger
  readonly graceMs?: number
}

/** A cached next close — {@link NcStateSummaryScheduler}. */
interface NcNextClose {
  readonly floorMs: number
  readonly scheduleKey: string
  readonly atMs: number
}

export interface NcStateSummaryTickReport {
  /** Rules whose window was actually computed this tick (the cache missed). */
  readonly decisions: number
  readonly sent: number
  readonly empty: number
  readonly missed: number
  readonly failed: number
  readonly held: boolean
}

interface MutableTickReport {
  decisions: number
  sent: number
  empty: number
  missed: number
  failed: number
  held: boolean
}

export class NcStateSummaryScheduler {
  private inFlight = false
  /** Per rule: the next window close, valid for one floor and one schedule. */
  private readonly nextClose = new Map<string, NcNextClose>()
  /** One WARN per hold, not one per tick. */
  private holdReported = false

  constructor(private readonly deps: NcStateSummarySchedulerDeps) {}

  async tick(): Promise<NcStateSummaryTickReport> {
    const report: MutableTickReport = {
      decisions: 0,
      sent: 0,
      empty: 0,
      missed: 0,
      failed: 0,
      held: false,
    }
    if (this.inFlight) return report
    this.inFlight = true
    try {
      const rules = this.deps.rules().filter((rule) => systemEventSummaryScheduleOf(rule) !== null)
      if (rules.length === 0) return report
      if (!this.deps.stamps.answered()) {
        report.held = true
        if (!this.holdReported) {
          this.holdReported = true
          this.deps.logger.warn('state summaries held — the send ledger has not been read yet', {
            meta: { rules: rules.map((rule) => rule.id) },
          })
        }
        return report
      }
      this.holdReported = false
      const nowMs = this.deps.now()
      for (const rule of rules) {
        const schedule = systemEventSummaryScheduleOf(rule)
        if (schedule !== null) await this.tickRule(rule, schedule, nowMs, report)
      }
      return report
    } finally {
      this.inFlight = false
    }
  }

  private async tickRule(
    rule: NcRule,
    schedule: NcSchedule,
    nowMs: number,
    report: MutableTickReport,
  ): Promise<void> {
    const stamp = await this.armed(rule, schedule, nowMs)
    if (stamp === null) return
    const floorMs = Math.max(stamp.armedAt, stamp.lastWindowEnd)
    // The next close is computed ONCE per arm or stamp and cached (review I4):
    // every tick before it answers from the cache, with no schedule work.
    const cached = this.nextClose.get(rule.id)
    if (
      cached !== undefined &&
      cached.floorMs === floorMs &&
      cached.scheduleKey === stamp.scheduleKey &&
      nowMs < cached.atMs
    ) {
      return
    }
    report.decisions += 1
    const decision = decideStateSummary({
      schedule,
      nowMs,
      floorMs,
      ...(this.deps.graceMs !== undefined ? { graceMs: this.deps.graceMs } : {}),
    })
    if (decision.kind === 'idle') {
      const next = nextStateSummaryClose(schedule, nowMs)
      this.nextClose.set(rule.id, {
        floorMs,
        scheduleKey: stamp.scheduleKey,
        // No close within the horizon: look again when the horizon has passed.
        atMs: next ?? nowMs + NC_STATE_SUMMARY_MAX_LOOKBACK_MS,
      })
      return
    }
    this.nextClose.delete(rule.id)
    const meta = {
      ruleId: rule.id,
      rule: rule.name,
      windowStart: decision.window.startMs,
      windowEnd: decision.window.endMs,
    }
    if (decision.kind === 'missed') {
      report.missed += 1
      this.deps.logger.warn('state summary window MISSED — closed too long ago to send now', {
        meta: { ...meta, overdueMs: nowMs - decision.window.endMs },
      })
      await this.stamp(stamp, decision.window.endMs)
      return
    }
    const summary = await this.deps.collect(rule, nowMs)
    if (isEmptyStateSummary(summary)) {
      report.empty += 1
      this.deps.logger.info('state summary has nothing to report — not sent', {
        meta: { ...meta, dropped: summary.dropped },
      })
      await this.stamp(stamp, decision.window.endMs)
      return
    }
    let inserted: number
    try {
      inserted = await this.deps.deliver(rule, summary, decision.window)
    } catch (err) {
      report.failed += 1
      this.deps.logger.warn('state summary could not be enqueued — retried on the next tick', {
        meta: { ...meta, error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    report.sent += 1
    this.deps.logger.info('state summary enqueued', {
      meta: {
        ...meta,
        late: decision.late,
        items: summary.itemCount,
        unavailable: summary.unavailableCount,
        sections: summary.sections.map((section) => `${section.id}:${section.status}`),
        dropped: summary.dropped,
        inserted,
      },
    })
    await this.stamp(stamp, decision.window.endMs)
  }

  /**
   * The rule's stamp, armed NOW when the rule is new to summary mode or its
   * schedule changed. `null` when arming could not be written — nothing is
   * sent on an unarmed rule.
   */
  private async armed(
    rule: NcRule,
    schedule: NcSchedule,
    nowMs: number,
  ): Promise<NcStateSummaryStamp | null> {
    const scheduleKey = canonicalHash(schedule)
    const held = this.deps.stamps.get(rule.id)
    if (held !== undefined && held.scheduleKey === scheduleKey) return held
    const armed: NcStateSummaryStamp = {
      ruleId: rule.id,
      armedAt: nowMs,
      lastWindowEnd: held?.lastWindowEnd ?? 0,
      scheduleKey,
    }
    try {
      await this.deps.stamps.put(armed)
    } catch (err) {
      this.deps.logger.warn('state summary rule could not be armed — nothing is sent until it is', {
        meta: { ruleId: rule.id, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
    this.deps.logger.info('state summary rule armed — windows closing from now on are sent', {
      meta: { ruleId: rule.id, rule: rule.name, rearmed: held !== undefined },
    })
    return armed
  }

  private async stamp(held: NcStateSummaryStamp, windowEndMs: number): Promise<void> {
    try {
      await this.deps.stamps.put({
        ...held,
        lastWindowEnd: Math.max(held.lastWindowEnd, windowEndMs),
      })
    } catch (err) {
      // The outbox's dedup id still refuses a second copy of this window.
      this.deps.logger.warn('state summary stamp did not land — the outbox dedup still holds', {
        meta: {
          ruleId: held.ruleId,
          windowEnd: windowEndMs,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}
