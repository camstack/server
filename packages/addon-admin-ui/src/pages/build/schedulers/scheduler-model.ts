/**
 * The editing model of a scheduler: pure helpers between the timeline the
 * operator sees and the `SchedulerInput` the hub saves.
 *
 * `checkSchedulerDraft` is the only way out of the editor. It runs the same two
 * steps the hub runs (`SchedulerInputSchema`, then `validateSchedulerInput`
 * against the site), so a draft that passes here is one `schedulers.create` /
 * `schedulers.update` accepts; a refusal carries the path the editor puts the
 * message on. Positions on the day come from `occurrenceOn`, the engine's own
 * reader of a `TimeSpec` — a sun point is never estimated here.
 */
import {
  DEFAULT_MAX_LATE_MS,
  localDateOf,
  occurrenceOn,
  type SchedulerInput,
  SchedulerInputSchema,
  type SchedulerIssue,
  type SchedulerPoint,
  type SchedulerProfile,
  type SchedulerPointMode,
  type TimeSite,
  validateSchedulerInput,
  type WeekdayKey,
} from '@camstack/types'

/** The site as `system.getSiteLocation` answers it. */
export interface SiteView {
  readonly timeZone: string
  readonly location: {
    readonly latitude: number
    readonly longitude: number
  } | null
}

export const ALL_WEEKDAYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const MAX_SUN_OFFSET_MIN = 720
const DAY_MINUTES = 1440

/** A point's moment: a clock time or a sun event (a one-shot date has no place on a day). */
export type PointTime = SchedulerPoint['at']

export type DraftCheck =
  | { readonly ok: true; readonly input: SchedulerInput }
  | { readonly ok: false; readonly issues: readonly SchedulerIssue[] }

export function emptySchedulerDraft(): SchedulerInput {
  return {
    name: '',
    enabled: true,
    priority: 0,
    maxLateMs: DEFAULT_MAX_LATE_MS,
    profiles: [emptyProfile('profile-1', 'Every day')],
  }
}

export function emptyProfile(id: string, name: string): SchedulerProfile {
  return { id, name, enabled: true, days: [...ALL_WEEKDAYS], points: [] }
}

/** A new point at `minute`, a clock time. A release has no steps. */
export function newPoint(mode: SchedulerPointMode, id: string, minute: number): SchedulerPoint {
  return {
    id,
    at: { kind: 'clock', hh: Math.floor(minute / 60), mm: minute % 60 },
    mode,
    steps: [],
  }
}

export function nextId(prefix: string, taken: readonly string[]): string {
  let n = taken.length + 1
  while (taken.includes(`${prefix}-${String(n)}`)) n += 1
  return `${prefix}-${String(n)}`
}

export function siteOf(view: SiteView): TimeSite | null {
  if (view.location === null) return null
  return {
    lat: view.location.latitude,
    lon: view.location.longitude,
    timeZone: view.timeZone,
  }
}

/** Minute of the site-local day of an instant. */
export function minuteOfDay(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(epochMs))
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return read('hour') * 60 + read('minute')
}

export function todayAt(view: SiteView, now: number = Date.now()): string {
  return localDateOf(now, view.timeZone)
}

/** Minute of the day a spec happens on `localDate`, or `null` (no site for a sun point, or no crossing). */
export function pointMinute(spec: PointTime, view: SiteView, localDate: string): number | null {
  const site = siteOf(view)
  if (site === null) {
    return spec.kind === 'clock' ? spec.hh * 60 + spec.mm : null
  }
  const at = occurrenceOn(spec, localDate, site)
  return at === null ? null : minuteOfDay(at, view.timeZone)
}

/** The minute of a sun event with no offset, the base a drag measures its offset from. */
export function sunBaseMinute(spec: PointTime, view: SiteView, localDate: string): number | null {
  if (spec.kind !== 'sun') return null
  return pointMinute({ ...spec, offsetMin: 0 }, view, localDate)
}

/** What a drag to `minute` makes of a spec. A sun point keeps its event and moves its offset. */
export function timeSpecAfterDrag(
  spec: PointTime,
  minute: number,
  sunBase: number | null,
): PointTime {
  if (spec.kind === 'clock') return { kind: 'clock', hh: Math.floor(minute / 60), mm: minute % 60 }
  if (spec.kind === 'sun' && sunBase !== null) {
    const offsetMin = Math.max(-MAX_SUN_OFFSET_MIN, Math.min(MAX_SUN_OFFSET_MIN, minute - sunBase))
    return { ...spec, offsetMin }
  }
  return spec
}

export function parseClockText(text: string): PointTime | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (match === null) return null
  return { kind: 'clock', hh: Number(match[1]), mm: Number(match[2]) }
}

export function clockText(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function minuteText(minute: number): string {
  return clockText(Math.floor(minute / 60), minute % 60)
}

export interface HoldBand {
  readonly id: string
  readonly fromMinute: number
  readonly toMinute: number
}

/** Each hold lasts until the next point on the timeline, the last one until midnight. */
export function holdBands(
  points: readonly SchedulerPoint[],
  view: SiteView,
  localDate: string,
): readonly HoldBand[] {
  const placed = points
    .flatMap((point) => {
      const minute = pointMinute(point.at, view, localDate)
      return minute === null ? [] : [{ point, minute }]
    })
    .toSorted((a, b) => a.minute - b.minute)
  return placed.flatMap((entry, index) => {
    if (entry.point.mode !== 'hold') return []
    const next = placed[index + 1]
    return [
      {
        id: entry.point.id,
        fromMinute: entry.minute,
        toMinute: next === undefined ? DAY_MINUTES : next.minute,
      },
    ]
  })
}

export function checkSchedulerDraft(draft: SchedulerInput, view: SiteView): DraftCheck {
  const parsed = SchedulerInputSchema.safeParse(draft)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }
  const verdict = validateSchedulerInput(parsed.data, view)
  if (!verdict.ok) return { ok: false, issues: verdict.issues }
  return { ok: true, input: parsed.data }
}
