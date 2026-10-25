/**
 * What the live view's openings read SAYS in the log — on change only.
 *
 * `getAlarmConfig` is polled every 2–15 s by the admin's Alarm tab, and every
 * poll runs the openings read. A WARN per poll turned one asleep contact into
 * hundreds of identical lines an hour and buried everything else. So the read
 * is logged as a state machine over its OUTCOME:
 *
 *  - the first failure, or a failure DIFFERENT from the last one (another
 *    kind, or another set of unanswered ids) → WARN;
 *  - the same failure again → silent (it is still true, and still visible in
 *    the view as `unknown`);
 *  - the first healthy read after a failure → ONE INFO, so "since when is it
 *    fine again" has an answer;
 *  - a healthy read after a healthy read → silent.
 *
 * Pure: the caller owns the logger and tags every line with the panel id.
 */

export type NcAlarmLiveReadOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'no-reader'; readonly covered: number }
  | { readonly kind: 'threw'; readonly covered: number; readonly error: string }
  | {
      readonly kind: 'partial'
      readonly covered: number
      readonly unansweredIds: readonly number[]
    }

export type NcAlarmLiveReadFailure = Exclude<NcAlarmLiveReadOutcome, { kind: 'ok' }>

export interface NcAlarmLiveReadLogLine {
  readonly level: 'warn' | 'info'
  readonly message: string
  readonly meta: Readonly<Record<string, string | number>>
}

/** What makes two failures "the same" — the error TEXT is not part of it. */
function failureKey(panelId: number, failure: NcAlarmLiveReadFailure): string {
  if (failure.kind === 'partial') {
    return `${String(panelId)}:partial:${failure.unansweredIds.join(',')}`
  }
  return `${String(panelId)}:${failure.kind}`
}

function warnLine(failure: NcAlarmLiveReadFailure): NcAlarmLiveReadLogLine {
  switch (failure.kind) {
    case 'no-reader':
      return {
        level: 'warn',
        message: 'alarm live view: no openings reader is wired — every opening is unknown',
        meta: { covered: failure.covered },
      }
    case 'threw':
      return {
        level: 'warn',
        message: 'alarm live view: openings read failed — every opening is unknown',
        meta: { covered: failure.covered, error: failure.error },
      }
    case 'partial':
      return {
        level: 'warn',
        message: 'alarm live view: covered devices did not answer — shown as unknown',
        meta: {
          covered: failure.covered,
          unanswered: failure.unansweredIds.length,
          unansweredIds: failure.unansweredIds.join(','),
        },
      }
  }
}

export class NcAlarmLiveReadLog {
  /** The failure last logged; null while the read is healthy (or never ran). */
  private last: { readonly key: string; readonly kind: NcAlarmLiveReadFailure['kind'] } | null =
    null

  /** The line this outcome deserves, or null when it would repeat the last one. */
  next(panelId: number, outcome: NcAlarmLiveReadOutcome): NcAlarmLiveReadLogLine | null {
    if (outcome.kind === 'ok') {
      const previous = this.last
      this.last = null
      if (previous === null) return null
      return {
        level: 'info',
        message: 'alarm live view: every covered device answers again',
        meta: { previousFailure: previous.kind },
      }
    }
    const key = failureKey(panelId, outcome)
    if (this.last?.key === key) return null
    this.last = { key, kind: outcome.kind }
    return warnLine(outcome)
  }
}
