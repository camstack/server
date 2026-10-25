/**
 * What the two SCHEDULED-PRODUCER tabs (Summaries, Timelapses) both need.
 *
 * Both author a rule that fires on a WINDOW rather than on a pipeline record,
 * both diff a form against a stored rule to build a patch, and both print the
 * same three things in a table: how long something is, when a window runs, and
 * how long ago it last produced. Two copies of any of those would be two
 * answers to one question — and the patch diff in particular is not a place to
 * have two opinions, because the upsert MERGES what it is sent: a key emitted
 * by mistake overwrites a stored one, and a key omitted preserves it.
 *
 * Everything here is pure and clock-free (the clock is always an argument).
 */

import type { NcRuleTarget, NcSchedule } from '@camstack/types'
import i18n from '../../i18n/index'

/** Compact duration: 90 → `90s`, 300 → `5m`, 3600 → `1h`, 5400 → `1h30m`. */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function minutesToHhmm(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * One line for a weekly schedule: the FIRST window in full, the rest as a
 * count. A cell that prints every window is a cell nobody can scan, and a cell
 * that prints only "Schedule" answers nothing — the question at the list is
 * always "when does this one run?".
 *
 * A window that crosses midnight (`start > end`) says so, because "21:00–07:00"
 * read as a same-day range is the one mistake this vocabulary invites.
 */
export function scheduleLabel(schedule: NcSchedule): string {
  const first = schedule.windows[0]
  if (first === undefined) return i18n.t('helpers.notificationDigest.noWindow')
  const days = first.days
    .toSorted((a, b) => a - b)
    .map((d) => DAY_LABELS[d] ?? String(d))
    .join(' ')
  const overnight = first.startMinute > first.endMinute ? ' (overnight)' : ''
  const more = schedule.windows.length - 1
  const invert = schedule.invert === true ? ' · outside' : ''
  return `${days} ${minutesToHhmm(first.startMinute)}–${minutesToHhmm(first.endMinute)}${overnight}${more > 0 ? ` +${more}` : ''}${invert}`
}

/**
 * How long ago something happened — or the caller's own word for "it never
 * has". Never a dash: a dash in a "last produced" column reads as a rendering
 * bug, and "never" is the single most important answer that column can give.
 */
export function agoLabel(atMs: number | undefined, nowMs: number, neverLabel: string): string {
  if (atMs === undefined || atMs <= 0) return neverLabel
  const ageMs = Math.max(0, nowMs - atMs)
  return i18n.t('helpers.notificationDigest.ago', {
    duration: formatSeconds(Math.round(ageMs / 1000)),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deterministic structural serialisation — sorted keys, so `{a,b}` and `{b,a}`
 * are one value. Used only on the small authored shapes these editors write;
 * nothing here ever sees a cyclic object.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Structural equality for the authored shapes — the patch diff's only test. */
export function sameShape(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

/** Target ids as the rule stores them. Params are authored per target on the
 *  Targets tab, never here, so this deliberately writes none. */
export function targetsFromIds(ids: readonly string[]): readonly NcRuleTarget[] {
  return ids.map((targetId) => ({ targetId }))
}
