/**
 * The pure edits of a `time-is` row. The leaf keeps its optional keys OMITTED
 * when unset (the recipe is serialised into the generated file), and "every
 * day" is the absence of `days`, never a list of seven.
 */
import {
  type AutomationRecipe,
  recipeSiteIssues,
  type SiteReading,
  type TimeIsLeaf,
  type TimeWindow,
  type WeekdayKey,
} from '@dominevo/types'
import {
  type TimeWindowEnd,
  toggleWindowDay,
  windowWrapsMidnight,
  withWindowEnd,
  withWindowMode,
} from '@dominevo/ui-library'

export const ALL_WEEKDAYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** A leaf is a daily window plus its `kind`: the window edits live in the library's `TimeWindowInput` model. */
function windowOf(leaf: TimeIsLeaf): TimeWindow {
  const { kind: _kind, ...window } = leaf
  return window
}

function leafOf(window: TimeWindow): TimeIsLeaf {
  return { kind: 'time-is', ...window }
}

/** The days the row shows pressed: an absent list is every day. */
export function selectedDays(leaf: TimeIsLeaf): readonly WeekdayKey[] {
  return leaf.days ?? ALL_WEEKDAYS
}

/** Press or release one day (see `toggleWindowDay`). */
export function toggleDay(leaf: TimeIsLeaf, day: WeekdayKey): TimeIsLeaf {
  return leafOf(toggleWindowDay(windowOf(leaf), day))
}

/** The whole day, or a window. Dropping the window keeps the days explicit: the row needs one of the two. */
export function withWindow(leaf: TimeIsLeaf, on: boolean): TimeIsLeaf {
  return leafOf(withWindowMode(windowOf(leaf), on ? 'between' : 'whole-day'))
}

export function withEnd(leaf: TimeIsLeaf, key: 'from' | 'to', end: TimeWindowEnd): TimeIsLeaf {
  return leafOf(withWindowEnd(windowOf(leaf), key, end))
}

/** The window ends the next day. */
export function wrapsMidnight(leaf: TimeIsLeaf): boolean {
  return windowWrapsMidnight(windowOf(leaf))
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
