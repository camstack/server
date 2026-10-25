import type { IScopedLogger, LogExtras } from '@camstack/types'

/**
 * Counting reporter for alarm events we receive but do not act on.
 *
 * A line per event and silence are both wrong answers. `videoloss`/`inactive`
 * produced 83 200 byte-identical lines in 12 h — that is not information, it is
 * a haystack that hid the two `io`/`active` lines from the same window. But
 * dropping the type without a word would hide the fact that a camera is sending
 * something we cannot read.
 *
 * So: report HOW MANY, not WHAT, once you have seen it before. The first
 * occurrence of each `(type, state)` is logged immediately — that is the one
 * that carries news, and a rare event must never be delayed behind a window it
 * may not survive. Everything after it inside `intervalMs` is counted and
 * folded into the next line: "videoloss/inactive ×7013 in 300 s".
 */

/**
 * Gap between two reports of the SAME `(type, state)`.
 *
 * At the measured 116 events/min this turns ~166 000 lines/day into ~one line
 * per camera per five minutes, while a genuinely new type still surfaces on its
 * first occurrence.
 */
export const ALARM_TALLY_INTERVAL_MS = 300_000

export interface AlarmTypeTally {
  /**
   * Record one occurrence. `reason` is attached when the drop is a declared
   * policy (see `hikvision-alarm-ignore.ts`) rather than an unknown type.
   */
  note(type: string, state: string | null, reason?: string): void
}

export interface AlarmTypeTallyDeps {
  readonly logger: IScopedLogger | null
  /** Numeric device id — every line carries it, so "why is 3839 different from
   *  102?" stays answerable. Never a camera name in its place. */
  readonly deviceId: number | null
  /** Log message. Constant per tally so the lines group in Loki. */
  readonly message: string
  readonly level: 'debug' | 'info'
  readonly intervalMs?: number
}

export function createAlarmTypeTally(deps: AlarmTypeTallyDeps): AlarmTypeTally {
  const intervalMs = deps.intervalMs ?? ALARM_TALLY_INTERVAL_MS
  const lastLoggedAt = new Map<string, number>()
  const suppressed = new Map<string, number>()

  const note = (type: string, state: string | null, reason?: string): void => {
    const logger = deps.logger
    if (!logger) return

    const key = `${type}/${state ?? 'none'}`
    const now = Date.now()
    const last = lastLoggedAt.get(key)
    if (last !== undefined && now - last < intervalMs) {
      suppressed.set(key, (suppressed.get(key) ?? 0) + 1)
      return
    }

    // This occurrence plus everything folded into it since the last line.
    const count = (suppressed.get(key) ?? 0) + 1
    suppressed.set(key, 0)
    lastLoggedAt.set(key, now)

    const extras: LogExtras = {
      ...(deps.deviceId === null ? {} : { tags: { deviceId: deps.deviceId } }),
      meta: {
        type,
        state,
        count,
        ...(last === undefined ? { first: true } : { windowMs: now - last }),
        ...(reason === undefined ? {} : { reason }),
      },
    }
    if (deps.level === 'debug') logger.debug(deps.message, extras)
    else logger.info(deps.message, extras)
  }

  return { note }
}
