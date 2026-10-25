/**
 * `recording-onboard` — the vendor-neutral rules both providers share.
 *
 * Three things live here rather than in each addon, because two
 * hand-written copies of them would be two different opinions about the
 * same question:
 *
 *   1. {@link describeOnboardRefusal} — THE refusal vocabulary. A write
 *      a camera cannot honour is refused with one sentence an operator
 *      can read, and the sentence is the same whoever refuses it.
 *   2. {@link weeklyMaskToWindows} / {@link windowsToWeeklyMask} —
 *      Reolink's 7×24 hour mask ↔ the cap's {@link RecordWindow} list.
 *   3. {@link timeOfDayToMinutes} / {@link minutesToTimeOfDay} —
 *      Hikvision's `TimeOfDay` strings ↔ minutes since midnight.
 *
 * Pure. No I/O, no clock, no logger.
 */
import type {
  OnboardAllowedValues,
  RecordTrigger,
  RecordWindow,
  RecordingOnboardOptions,
  RecordingOnboardPatch,
} from './recording-onboard.cap.js'

/** Minutes in a day. `endMinute === 1440` means "to end of day". */
export const MINUTES_PER_DAY = 1440

/** Days in the cap's week, 0 = Monday. */
export const DAYS_PER_WEEK = 7

/** Hours per day — the resolution of Reolink's mask. */
export const HOURS_PER_DAY = 24

/** Length of a Reolink weekly `valueTable`: 7 days × 24 hours. */
export const WEEKLY_MASK_LENGTH = DAYS_PER_WEEK * HOURS_PER_DAY

/**
 * Day-of-week names in the cap's index order (0 = Monday), for messages
 * an operator reads and for Hikvision's `<DayOfWeek>` element.
 */
export const DAY_NAMES: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]

// ── Refusal ──────────────────────────────────────────────────────────

/**
 * Does `patch` ask this camera for something it cannot do?
 *
 * Returns the operator-readable reason, or `null` when every field in
 * the patch is within what `options` says this camera accepts. A
 * provider calls this BEFORE touching the camera and throws the string:
 * refusing is the point, and refusing identically on both vendors is why
 * this is one function.
 *
 * The order of checks is the order an operator would read them: the
 * scalar knobs first, then the schedule, because a schedule complaint is
 * longer and a scalar one is usually the real problem.
 */
export function describeOnboardRefusal(
  options: RecordingOnboardOptions,
  patch: RecordingOnboardPatch,
): string | null {
  if (patch.enabled !== undefined && !options.enabled.writable) {
    return unwritable('the master recording switch', options.enabled.reason)
  }
  if (patch.overwriteWhenFull !== undefined && !options.overwriteWhenFull.writable) {
    return unwritable('overwrite-when-full', options.overwriteWhenFull.reason)
  }

  const preRefusal = refuseNumeric(
    'pre-record seconds',
    patch.preRecordSec,
    options.preRecordSec,
    options.preRecordSecRange,
    options.preRecordSecAllowed,
  )
  if (preRefusal) return preRefusal

  const postRefusal = refuseNumeric(
    'post-record seconds',
    patch.postRecordSec,
    options.postRecordSec,
    options.postRecordSecRange,
    options.postRecordSecAllowed,
  )
  if (postRefusal) return postRefusal

  const segmentRefusal = refuseNumeric(
    'segment length (minutes)',
    patch.segmentMinutes,
    options.segmentMinutes,
    options.segmentMinutesRange,
    options.segmentMinutesAllowed,
  )
  if (segmentRefusal) return segmentRefusal

  if (patch.windows !== undefined) {
    const scheduleRefusal = refuseSchedule(options, patch.windows)
    if (scheduleRefusal) return scheduleRefusal
  }

  return null
}

function unwritable(what: string, reason: string | undefined): string {
  return reason
    ? `this camera cannot change ${what}: ${reason}`
    : `this camera cannot change ${what}`
}

function refuseNumeric(
  what: string,
  value: number | undefined,
  support: RecordingOnboardOptions['enabled'],
  range: { min: number; max: number; step: number } | undefined,
  allowed?: OnboardAllowedValues,
): string | null {
  if (value === undefined) return null
  if (!support.writable) return unwritable(what, support.reason)
  if (!Number.isFinite(value)) return `${what} must be a number, got ${String(value)}`
  // A declared SET wins over a span. Both these firmwares have one, and
  // neither is expressible as min/max/step — see `AllowedValuesSchema`.
  if (allowed) {
    if (allowed.values.includes(value)) return null
    const say = (v: number): string =>
      allowed.sentinel !== undefined && v === allowed.sentinel.value
        ? allowed.sentinel.meaning === 'no-limit'
          ? 'no limit'
          : 'off'
        : String(v)
    return `this camera accepts ${what} only as ${allowed.values.map(say).join(', ')}; ${say(value)} is not one of them`
  }
  if (!range) return null
  if (value < range.min || value > range.max) {
    return `this camera accepts ${what} between ${String(range.min)} and ${String(range.max)}; ${String(value)} is outside that`
  }
  if (range.step > 0 && (value - range.min) % range.step !== 0) {
    return `this camera accepts ${what} in steps of ${String(range.step)} from ${String(range.min)}; ${String(value)} is not one of them`
  }
  return null
}

function refuseSchedule(
  options: RecordingOnboardOptions,
  windows: readonly RecordWindow[],
): string | null {
  const schedule = options.schedule
  if (!schedule.support.writable) {
    return unwritable('the recording schedule', schedule.support.reason)
  }

  const allowed = new Set<RecordTrigger>(schedule.triggers)
  for (const window of windows) {
    if (!allowed.has(window.trigger)) {
      const offer = schedule.triggers.length > 0 ? schedule.triggers.join(', ') : 'none'
      return `this camera cannot record on "${window.trigger}"; it records on: ${offer}`
    }
    if (window.endMinute <= window.startMinute) {
      return `a window on ${dayName(window.day)} ends at or before it starts (${String(window.startMinute)} → ${String(window.endMinute)})`
    }
    const step = schedule.granularityMinutes
    if (step > 1 && (window.startMinute % step !== 0 || window.endMinute % step !== 0)) {
      return `this camera's schedule only moves in ${String(step)}-minute steps; the ${dayName(window.day)} window ${formatMinutes(window.startMinute)}–${formatMinutes(window.endMinute)} is not aligned to them`
    }
  }

  if (!schedule.supportsOverlappingTriggers) {
    const clash = findOverlapWithDifferentTrigger(windows)
    if (clash) {
      return `this camera stores one trigger per time range, so "${clash.a.trigger}" and "${clash.b.trigger}" cannot both cover ${dayName(clash.a.day)} ${formatMinutes(Math.max(clash.a.startMinute, clash.b.startMinute))}–${formatMinutes(Math.min(clash.a.endMinute, clash.b.endMinute))}`
    }
  }

  return null
}

interface WindowClash {
  readonly a: RecordWindow
  readonly b: RecordWindow
}

function findOverlapWithDifferentTrigger(windows: readonly RecordWindow[]): WindowClash | null {
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i]
      const b = windows[j]
      if (!a || !b) continue
      if (a.day !== b.day) continue
      if (a.trigger === b.trigger) continue
      if (a.startMinute < b.endMinute && b.startMinute < a.endMinute) return { a, b }
    }
  }
  return null
}

function dayName(day: number): string {
  return DAY_NAMES[day] ?? `day ${String(day)}`
}

/** `510` → `08:30`. For messages, not for the wire. */
export function formatMinutes(minute: number): string {
  const hour = Math.floor(minute / 60)
  const rest = minute % 60
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

// ── Reolink: the 7×24 weekly hour mask ───────────────────────────────

/**
 * Index of the mask character covering `day` at `hour`.
 *
 * **Layout: day-major, Monday first** — `day * 24 + hour`.
 *
 * This is an ASSUMPTION, and it is recorded as one because the fleet
 * cannot currently confirm it: every `valueTable` on every Reolink
 * measured on 2026-09-22 is uniform (all `1` or all `0`), and a uniform
 * mask reads identically under either layout. To settle it, set a single
 * hour on one day from the Reolink app and re-read `getRecordSchedule`.
 * Until then, a NON-uniform mask is reported as windows under this
 * layout and the day labels may be transposed; a uniform one is exact.
 */
export function weeklyMaskIndex(day: number, hour: number): number {
  return day * HOURS_PER_DAY + hour
}

/**
 * True when every slot of the mask carries the same value — the case in
 * which {@link weeklyMaskIndex}'s layout assumption cannot be wrong.
 */
export function weeklyMaskIsUniform(mask: string): boolean {
  if (mask.length === 0) return true
  const first = mask[0]
  for (const ch of mask) if (ch !== first) return false
  return true
}

/**
 * Expand one trigger's weekly hour mask into windows, merging adjacent
 * set hours into one window per run so a full day is ONE window rather
 * than twenty-four.
 *
 * A mask of the wrong length yields no windows: a truncated table is not
 * a schedule of fewer days, it is an answer we did not understand.
 */
export function weeklyMaskToWindows(mask: string, trigger: RecordTrigger): RecordWindow[] {
  if (mask.length !== WEEKLY_MASK_LENGTH) return []
  const out: RecordWindow[] = []
  for (let day = 0; day < DAYS_PER_WEEK; day += 1) {
    let runStart: number | null = null
    for (let hour = 0; hour <= HOURS_PER_DAY; hour += 1) {
      const set = hour < HOURS_PER_DAY && mask[weeklyMaskIndex(day, hour)] === '1'
      if (set && runStart === null) {
        runStart = hour
      } else if (!set && runStart !== null) {
        out.push({
          trigger,
          day,
          startMinute: runStart * 60,
          endMinute: hour * 60,
        })
        runStart = null
      }
    }
  }
  return out
}

/**
 * Collapse this trigger's windows back into a weekly hour mask.
 *
 * Windows for other triggers are ignored — the mask is per trigger. A
 * window that is not hour-aligned is REFUSED upstream by
 * {@link describeOnboardRefusal}; this function rounds nothing, it
 * simply sets every hour the window fully or partly covers, so a caller
 * that skipped the refusal cannot silently lose coverage.
 */
export function windowsToWeeklyMask(
  windows: readonly RecordWindow[],
  trigger: RecordTrigger,
): string {
  const slots = new Array<string>(WEEKLY_MASK_LENGTH).fill('0')
  for (const window of windows) {
    if (window.trigger !== trigger) continue
    if (window.day < 0 || window.day >= DAYS_PER_WEEK) continue
    const firstHour = Math.floor(window.startMinute / 60)
    const lastHour = Math.ceil(window.endMinute / 60)
    for (let hour = firstHour; hour < lastHour && hour < HOURS_PER_DAY; hour += 1) {
      slots[weeklyMaskIndex(window.day, hour)] = '1'
    }
  }
  return slots.join('')
}

// ── Hikvision: TimeOfDay strings ─────────────────────────────────────

/**
 * Parse a Hikvision `<TimeOfDay>` into minutes since midnight.
 *
 * The firmware is not self-consistent and both spellings are real, on
 * the same camera in the same block: a start time reads `00:00:00` and
 * the matching end time reads `24:00`. Seconds are accepted and
 * discarded — the cap's resolution is minutes — and `24:00` maps to
 * {@link MINUTES_PER_DAY}, not to 0.
 *
 * Returns null for anything else, which a caller reports as a window it
 * could not read rather than as midnight.
 */
export function timeOfDayToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (minute > 59) return null
  const total = hour * 60 + minute
  if (total > MINUTES_PER_DAY) return null
  return total
}

/**
 * Render minutes back as a Hikvision `TimeOfDay`.
 *
 * Emits the camera's own two spellings: `24:00` for end-of-day, because
 * that is what the firmware writes and `24:00:00` is not observed, and
 * `HH:MM:SS` otherwise.
 */
export function minutesToTimeOfDay(minute: number): string {
  if (minute >= MINUTES_PER_DAY) return '24:00'
  const hour = Math.floor(minute / 60)
  const rest = minute % 60
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}:00`
}

/** `'Monday'` → 0. Case-insensitive. Null for anything unrecognised. */
export function dayOfWeekToIndex(value: string): number | null {
  const needle = value.trim().toLowerCase()
  const index = DAY_NAMES.findIndex((name) => name.toLowerCase() === needle)
  return index >= 0 ? index : null
}

/** One field a camera stored differently from what it was asked. */
export interface OnboardClamp {
  readonly field: string
  readonly asked: number | boolean | string
  /** What the camera holds now. `null` when the read-back could not say. */
  readonly stored: number | boolean | string | null
}

/**
 * Which fields of a patch the camera did NOT take verbatim.
 *
 * Measured on a Hikvision I91DN (1436, 2026-09-22): a `PUT` of
 * `PreRecordTimeSeconds: 8` answered `200`, `statusCode 1`, `OK` — and stored
 * **5**. Neither the asked value nor the previous one. The camera declares no
 * allowed set for that field, so there is nothing to refuse against before the
 * wire: `/capabilities` returns a plain value where a constrained field would
 * carry an `opt=` list.
 *
 * So the only honest moment is after the read-back, and re-reading alone is
 * not enough — it makes the difference VISIBLE while leaving it unexplained.
 * A write that reports success for a value the camera never took is the same
 * silent substitution D599 removed from the clip path, wearing a different hat.
 *
 * Compares only the fields the patch actually named: a field nobody asked
 * about cannot have been clamped, and a read-back that could not answer it is
 * `stored: null` rather than a claim.
 */
export function describeOnboardClamp(
  patch: Readonly<Record<string, unknown>>,
  landed: Readonly<Record<string, unknown>> | null,
): readonly OnboardClamp[] {
  const out: OnboardClamp[] = []
  for (const [field, asked] of Object.entries(patch)) {
    if (asked === undefined) continue
    if (typeof asked !== 'number' && typeof asked !== 'boolean' && typeof asked !== 'string')
      continue
    const raw = landed === null ? undefined : landed[field]
    const stored =
      typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string' ? raw : null
    if (stored !== asked) out.push({ field, asked, stored })
  }
  return out
}
