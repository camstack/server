/**
 * The pure edits of a `time-is` row. The leaf keeps its optional keys OMITTED
 * when unset (the recipe is serialised into the generated file), and "every
 * day" is the absence of `days`, never a list of seven.
 */
import {
  type AutomationRecipe,
  recipeSiteIssues,
  type SiteReading,
  type SunEvent,
  type TimeIsLeaf,
  type WeekdayKey,
} from '@camstack/types'

export const ALL_WEEKDAYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const SUN_EVENTS: readonly SunEvent[] = ['sunrise', 'sunset', 'dawn', 'dusk']

export type TimeWindow = NonNullable<TimeIsLeaf['between']>
/** One end of the window: a clock time or a sun event (a one-date spec cannot bound a daily window). */
export type TimeEnd = Extract<TimeWindow['from'], { kind: 'clock' | 'sun' }>
export type TimeEndKey = 'from' | 'to'
export type TimeEndKind = TimeEnd['kind']

const DEFAULT_WINDOW: TimeWindow = {
  from: { kind: 'clock', hh: 22, mm: 0 },
  to: { kind: 'clock', hh: 6, mm: 0 },
}

function build(
  between: TimeWindow | undefined,
  days: readonly WeekdayKey[] | undefined,
): TimeIsLeaf {
  return {
    kind: 'time-is',
    ...(between === undefined ? {} : { between }),
    ...(days === undefined ? {} : { days: [...days] }),
  }
}

/** The days the row shows pressed: an absent list is every day. */
export function selectedDays(leaf: TimeIsLeaf): readonly WeekdayKey[] {
  return leaf.days ?? ALL_WEEKDAYS
}

/**
 * Press or release one day. All seven with a window is "every day" (no list);
 * with no window the list stays, because the row needs one of the two. Releasing
 * the last day leaves an empty list the schema refuses — the row then says so
 * instead of silently meaning "every day".
 */
export function toggleDay(leaf: TimeIsLeaf, day: WeekdayKey): TimeIsLeaf {
  const current = selectedDays(leaf)
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : ALL_WEEKDAYS.filter((d) => d === day || current.includes(d))
  const everyDay = next.length === ALL_WEEKDAYS.length
  return build(leaf.between, everyDay && leaf.between !== undefined ? undefined : next)
}

/** The whole day, or a window. Dropping the window keeps the days explicit: the row needs one of the two. */
export function withWindow(leaf: TimeIsLeaf, on: boolean): TimeIsLeaf {
  if (on) {
    const everyDay = leaf.days !== undefined && leaf.days.length === ALL_WEEKDAYS.length
    return build(leaf.between ?? DEFAULT_WINDOW, everyDay ? undefined : leaf.days)
  }
  return build(undefined, selectedDays(leaf))
}

export function withEnd(leaf: TimeIsLeaf, key: TimeEndKey, end: TimeEnd): TimeIsLeaf {
  const between = leaf.between ?? DEFAULT_WINDOW
  return build({ ...between, [key]: end }, leaf.days)
}

/** A blank end of one kind. */
export function seedEnd(kind: TimeEndKind): TimeEnd {
  return kind === 'sun'
    ? { kind: 'sun', event: 'sunset', offsetMin: 0 }
    : { kind: 'clock', hh: 12, mm: 0 }
}

/** The end as the row edits it; a one-date spec (which the schema refuses here) reads as a blank clock time. */
export function editableEnd(end: TimeWindow['from']): TimeEnd {
  return end.kind === 'date' ? seedEnd('clock') : end
}

/** Two clock ends where the second is not after the first: the window ends the next day. */
export function wrapsMidnight(leaf: TimeIsLeaf): boolean {
  const between = leaf.between
  if (between === undefined || between.from.kind !== 'clock' || between.to.kind !== 'clock')
    return false
  return between.to.hh * 60 + between.to.mm <= between.from.hh * 60 + between.from.mm
}

/**
 * Why this site cannot place a time window of the recipe (a sun end with no
 * site location), as the sentence the editor shows — or null. `reading` is
 * undefined while the site has not ANSWERED: an unanswered read never refuses.
 */
export function recipeSiteError(
  recipe: AutomationRecipe,
  reading: SiteReading | undefined,
): string | null {
  if (reading === undefined) return null
  const issue = recipeSiteIssues(recipe, reading)[0]
  return issue === undefined ? null : `${issue.path}: ${issue.message}`
}
