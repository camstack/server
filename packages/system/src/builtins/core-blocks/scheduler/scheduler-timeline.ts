/**
 * The pure half of the scheduler (D983): which profile is in force on a day,
 * where its points land on the timeline, and which hold window an instant is
 * in. No clock, no I/O — the engine, `preview` and `conflicts` all read the
 * timeline through here so they cannot disagree.
 */
import {
  type AutomationWhen,
  localDateOf,
  occurrenceOn,
  type Scheduler,
  type SchedulerProfile,
  type SchedulerPoint,
  type SiteReading,
  siteFor,
  type TimeSite,
  weekdayOfLocalDate,
  zoneOnlySite,
} from '@camstack/types'

/** `localDate` moved by `days`. */
export function addLocalDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10)
}

/**
 * The site a clock or sun point is read at: the real one when it has a
 * location, else a zone-only one (a sun point then has no occurrence — it is
 * refused at save, this is the read side).
 */
export function timeSiteOf(reading: SiteReading): TimeSite {
  return siteFor(reading) ?? zoneOnlySite(reading.timeZone)
}

/** The instant a local day ends (the next local midnight). */
export function endOfLocalDay(localDate: string, site: TimeSite): number {
  return occurrenceOn({ kind: 'clock', hh: 0, mm: 0 }, addLocalDays(localDate, 1), site) ?? 0
}

/** The instant a local day starts. */
export function startOfLocalDay(localDate: string, site: TimeSite): number {
  return occurrenceOn({ kind: 'clock', hh: 0, mm: 0 }, localDate, site) ?? 0
}

export interface TimelineEntry {
  readonly point: SchedulerPoint
  /** When the point happens that day. */
  readonly at: number
  /** The next point of the profile that day, else the end of the local day. */
  readonly until: number
}

/**
 * A profile's points on one local day, in time order. A point whose moment
 * does not exist that day (the sun never crosses) is left out.
 */
export function profileTimeline(
  profile: SchedulerProfile,
  localDate: string,
  site: TimeSite,
): TimelineEntry[] {
  const placed = profile.points
    .map((point) => ({ point, at: occurrenceOn(point.at, localDate, site) }))
    .filter((p): p is { point: SchedulerPoint; at: number } => p.at !== null)
    .toSorted((a, b) => a.at - b.at)
  const dayEnd = endOfLocalDay(localDate, site)
  return placed.map((entry, i) => ({
    point: entry.point,
    at: entry.at,
    until: placed[i + 1]?.at ?? Math.max(dayEnd, entry.at),
  }))
}

/** The entry an instant is in the window of: the last point at or before it. */
export function windowAt(entries: readonly TimelineEntry[], t: number): TimelineEntry | null {
  let found: TimelineEntry | null = null
  for (const entry of entries) {
    if (entry.at <= t) found = entry
  }
  return found !== null && t < found.until ? found : null
}

/** Is a `when` state tree true right now? `undefined` (no tree) is true. */
export type StateTruth = (when: AutomationWhen | undefined) => boolean

export type ProfileState =
  | 'in-force'
  | 'scheduler-disabled'
  | 'scheduler-inactive'
  | 'profile-disabled'
  | 'profile-inactive'
  | 'not-today'
  | 'shadowed'

/** Why a profile is or is not in force on `localDate`. */
export function profileState(
  scheduler: Scheduler,
  profile: SchedulerProfile,
  localDate: string,
  isTrue: StateTruth,
): ProfileState {
  if (!scheduler.enabled) return 'scheduler-disabled'
  if (!isTrue(scheduler.activeWhen)) return 'scheduler-inactive'
  if (!profile.enabled) return 'profile-disabled'
  if (!profile.days.includes(weekdayOfLocalDate(localDate))) return 'not-today'
  if (!isTrue(profile.activeWhen)) return 'profile-inactive'
  const earlier = scheduler.profiles.slice(0, scheduler.profiles.indexOf(profile))
  const shadowing = earlier.some(
    (p) => p.enabled && p.days.includes(weekdayOfLocalDate(localDate)) && isTrue(p.activeWhen),
  )
  return shadowing ? 'shadowed' : 'in-force'
}

export type ProfileSelection =
  | { readonly profile: SchedulerProfile; readonly idleReason: null }
  | { readonly profile: null; readonly idleReason: string }

/**
 * The profile in force on `localDate`: scheduler and profile enabled, both
 * `activeWhen` true, the day among its days — and the FIRST such profile in the
 * scheduler's order wins.
 */
export function selectProfile(
  scheduler: Scheduler,
  localDate: string,
  isTrue: StateTruth,
): ProfileSelection {
  if (!scheduler.enabled) return { profile: null, idleReason: 'the scheduler is switched off' }
  if (!isTrue(scheduler.activeWhen)) {
    return {
      profile: null,
      idleReason: 'the scheduler is not active (its condition is false)',
    }
  }
  const weekday = weekdayOfLocalDate(localDate)
  for (const profile of scheduler.profiles) {
    if (!profile.enabled || !profile.days.includes(weekday)) continue
    if (!isTrue(profile.activeWhen)) continue
    return { profile, idleReason: null }
  }
  return { profile: null, idleReason: `no profile is in force on ${weekday}` }
}

/** The local date of `epochMs` in the site's zone. */
export function localDateIn(epochMs: number, site: TimeSite): string {
  return localDateOf(epochMs, site.timeZone)
}
