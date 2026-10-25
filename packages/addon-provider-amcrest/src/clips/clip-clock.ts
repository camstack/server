/**
 * The camera's clock, and the ONE place a time crosses between it and ours.
 *
 * **This is the trap that would put every clip two hours away.** Hikvision
 * stamps its catalog in UTC with a `Z`. Dahua does not: `mediaFileFind`'s
 * `StartTime`/`EndTime`, and the `starttime`/`endtime` that `/cam/playback`
 * accepts, are the camera's own LOCAL wall clock with no zone on them.
 * Measured 2026-09-23 on device 3836: `global.cgi?action=getCurrentTime`
 * answered `2026-09-23 11:29:27` while the host's UTC was `09:29:27.711`.
 *
 * ## Why the offset is READ and never inferred
 *
 * Two shortcuts both fail:
 *
 * - **The node's own timezone.** The addon runs wherever the runner runs; a
 *   hub in a UTC container would read the camera's strings two hours early
 *   and ask `/cam/playback` for footage that does not exist yet.
 * - **The camera's configured `NTP.TimeZone`.** It is a Dahua zone INDEX, it
 *   says nothing about DST on the day in question, and this addon already
 *   knows one Dahua index table is not a fact about the wire.
 *
 * So the offset is MEASURED: `getCurrentTime` against our own `Date.now()`.
 *
 * ## The offset is RAW, not rounded to a timezone
 *
 * It is tempting to round the measured difference to the nearest 15 minutes
 * and call it a UTC offset. That is wrong for this purpose. What the catalog
 * needs is a map between *the camera's clock* and *ours* — and a camera whose
 * clock has drifted ten minutes stamps its files ten minutes off. Carrying the
 * drift is what makes "the window the operator is looking at" and "the window
 * the camera will serve" the same window. Rounding it away would reintroduce
 * exactly the error it was meant to remove.
 *
 * A LARGE disagreement is still worth saying out loud, because it is an
 * operator-visible fault on the camera and not a fact about clips — see
 * {@link CAMERA_CLOCK_DISAGREEMENT_WARN_MS}. It is not a refusal: the map is
 * self-consistent at any offset, and refusing would break a working camera
 * over a cosmetic complaint.
 *
 * Pure. No I/O — the caller does the read and hands the two numbers in.
 */

/**
 * How long one clock read is trusted.
 *
 * Long enough that a listing does not pay for it every time, short enough that
 * a DST rollover — which moves the offset by a whole hour — is corrected
 * within one refresh rather than sending every subsequent search an hour
 * astray.
 */
export const CAMERA_CLOCK_STALE_MS = 10 * 60_000

/**
 * Past this, the camera's clock and ours disagree by more than any timezone
 * plus a plausible drift, so the difference is a camera fault worth a line.
 * 15 hours: the widest real UTC offset is +14, and this leaves room for it.
 */
export const CAMERA_CLOCK_DISAGREEMENT_WARN_MS = 15 * 60 * 60_000

/** A measured map between the camera's wall clock and ours. */
export interface AmcrestCameraClock {
  /** Add to an epoch-ms instant to get the camera's own wall clock, read as
   *  if it were UTC. Subtract to go the other way. */
  readonly offsetMs: number
  /** When this was measured, in OUR clock. */
  readonly readAtMs: number
}

/**
 * The raw body of `global.cgi?action=getCurrentTime`, which answers
 * `result=2026-09-23 11:29:27`. `null` when there is no timestamp in it — a
 * read that failed is not a reading (D393), and the caller must refuse rather
 * than fall back to its own clock.
 */
export function parseCurrentTimeBody(body: string): string | null {
  const match = /result\s*=\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(body)
  return match?.[1]?.replace('T', ' ') ?? null
}

/**
 * A Dahua wall-clock string read AS IF it were UTC — the intermediate every
 * conversion goes through. `null` on anything that is not the exact shape,
 * including the empty string and a date the calendar does not hold.
 */
export function parseWallClockAsUtcMs(wallClock: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(wallClock.trim())
  if (match === null) return null
  const [, y, mo, d, h, mi, s] = match
  if (y === undefined || mo === undefined || d === undefined) return null
  if (h === undefined || mi === undefined || s === undefined) return null
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  // Round-trip guard: `Date.UTC` happily rolls 31 February into March.
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1) return null
  if (back.getUTCDate() !== day) return null
  return ms
}

/**
 * The measured map. `null` when the camera's answer could not be parsed —
 * never a zero offset, which is the same shape as "the camera is on UTC" and
 * would silently move an archive by the timezone it really has.
 */
export function deriveCameraClock(input: {
  readonly currentTimeBody: string
  /**
   * OUR clock when the read was SENT, and when its answer came back.
   *
   * Both, because a one-sided reading carries the round trip as bias: taking
   * only the `after` stamp puts the camera's second an RTT earlier than it
   * really was. The estimate is the midpoint of the bracket, which is the
   * standard thing to do with a remote clock and costs one extra variable.
   * `hostUtcAfterMs` alone is accepted (the bracket collapses) for a caller
   * that has nothing better.
   */
  readonly hostUtcBeforeMs?: number
  readonly hostUtcAfterMs: number
}): AmcrestCameraClock | null {
  const wall = parseCurrentTimeBody(input.currentTimeBody)
  if (wall === null) return null
  const asUtc = parseWallClockAsUtcMs(wall)
  if (asUtc === null) return null
  const before = input.hostUtcBeforeMs ?? input.hostUtcAfterMs
  const hostAt = (before + input.hostUtcAfterMs) / 2
  // The camera answers WHOLE SECONDS and truncates rather than rounds: a
  // reading of `11:29:27` means its clock is somewhere in [27.000, 28.000).
  // Taking the string at face value biases the offset low by half a second, so
  // half a second is added back and the estimate is the MIDPOINT of the
  // interval the camera actually stated rather than its floor.
  //
  // What remains is accurate to about a second, which is what this is for: a
  // clip window on this camera is 43–92 s and the narrowing is an OVERLAP
  // test, so a second at an edge changes nothing. Nothing in the clip path
  // needs finer, and the camera cannot give finer.
  const offsetMs = Math.round((asUtc + 500 - hostAt) / 1000) * 1000
  return { offsetMs, readAtMs: input.hostUtcAfterMs }
}

/** Is this measurement still worth using? */
export function cameraClockIsFresh(clock: AmcrestCameraClock, nowMs: number): boolean {
  return nowMs - clock.readAtMs < CAMERA_CLOCK_STALE_MS
}

/** Does the difference deserve an operator-facing line? */
export function cameraClockDisagrees(clock: AmcrestCameraClock): boolean {
  return Math.abs(clock.offsetMs) > CAMERA_CLOCK_DISAGREEMENT_WARN_MS
}

/** An epoch instant as the camera's own wall clock — what a search condition
 *  and a `/cam/playback` query string both take. */
export function toCameraWallClock(epochMs: number, clock: AmcrestCameraClock): string {
  const shifted = new Date(epochMs + clock.offsetMs)
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-` +
    `${pad(shifted.getUTCDate(), 2)} ${pad(shifted.getUTCHours(), 2)}:` +
    `${pad(shifted.getUTCMinutes(), 2)}:${pad(shifted.getUTCSeconds(), 2)}`
  )
}

/** The camera's own wall clock as an epoch instant. `null` on a string this
 *  provider could not read — a row with an unreadable time is dropped BY NAME
 *  rather than placed at the epoch. */
export function fromCameraWallClock(wallClock: string, clock: AmcrestCameraClock): number | null {
  const asUtc = parseWallClockAsUtcMs(wallClock)
  if (asUtc === null) return null
  return asUtc - clock.offsetMs
}
