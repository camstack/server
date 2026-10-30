/**
 * One `mediaFileFind` row, read. Pure: no RPC, no clock read, no logger.
 *
 * ## `Summary` is never read, and that is a hard rule
 *
 * Every row this camera returns carries, on a plain `VideoMotion` recording in
 * a living room, on a camera with no ANPR licence:
 *
 * ```json
 * "Summary": { "TrafficCar": { "PlateNumber": " ", "PlateColor": "Yellow",
 *                              "PlateType": "Yellow", "Speed": 60,
 *                              "VehicleColor": "White" } }
 * ```
 *
 * `PlateNumber` is a single space and `Speed` is a constant 60 on all 60 rows
 * measured. It is an uninitialised struct serialised as data. A provider that
 * surfaced it would invent a licence-plate read and a 60 km/h vehicle on every
 * motion clip. {@link parseClipRow} reads `Events` and `Flags` and nothing
 * else about what happened.
 *
 * ## `Type` is an ECHO of the filter, not a fact about the file
 *
 * Measured 2026-09-23: the SAME recording comes back as `Type: "dav"` when the
 * search asked `Types: ["dav"]` and as `Type: "mp4"` when it asked
 * `Types: ["mp4"]` — identical `FilePath` in both, which really ends `.mp4`
 * and really is an ISO MP4. So the field is not carried onto the row at all.
 * The filter still matters enormously — see {@link buildFindCondition}.
 *
 * ## `Length` is the file, `Duration` is the WINDOW
 *
 * `Duration` is the wall-clock span between `StartTime` and `EndTime`. The
 * container inside runs about 7.5 % shorter (74 s row → 68.433 s media,
 * measured with `ffprobe`). Both are carried, separately, and a completion
 * check that compares the delivered media against the ROW naively would fire
 * on every clip this camera makes.
 */
import { type AmcrestCameraClock, fromCameraWallClock } from './clip-clock.js'
import { clipKeyFor } from './clip-identity.js'

/**
 * How many rows one `findNextFile` asks for.
 *
 * 64 answered a 60-row window in a single page. The value is a REQUEST — the
 * terminator is `found < count`, so a firmware that caps its own page smaller
 * just means more pages, never a truncated answer.
 */
export const CLIP_FIND_PAGE_SIZE = 64

/**
 * How many pages one listing may walk.
 *
 * Measured to 31 pages at `count: 2` over 60 rows, terminating on `found: 0`.
 * 64 pages at `CLIP_FIND_PAGE_SIZE` is 4096 rows — far past any window a
 * surface asks for. It is a BOUND, not a budget: a firmware whose paging never
 * terminates would otherwise loop for ever, and the honest answer to that is a
 * listing that stops and says it stopped.
 */
export const CLIP_FIND_MAX_PAGES = 64

/**
 * The file kinds a CLIP may be.
 *
 * **This filter is not cosmetic.** An unfiltered `Flags: ["Event"]` search
 * over the same window returned 60 rows of which **45 were single JPEG
 * snapshots** — `Duration: 0`, `StartTime === EndTime`, ~250 KB each. Listing
 * them would hand the operator three quarters of a catalog that cannot be
 * played, with a zero-length window that `/cam/playback` has nothing to serve.
 * `Types: ["dav"]` returned exactly the 15 recordings.
 */
export const CLIP_FIND_TYPES: readonly string[] = ['dav']

/**
 * The record reasons a clip may carry.
 *
 * All three, and not just `Event`, because the filter is what the camera
 * matches on: a camera scheduled for CONTINUOUS recording writes `Timing`
 * rows, and an `Event`-only search on such a camera would report an empty card
 * as confidently as a real one. Measured: a three-flag condition returns the
 * same 15 rows an `Event`-only one does on this camera, so the wider filter
 * costs nothing where it is not needed.
 */
export const CLIP_FIND_FLAGS: readonly string[] = ['Timing', 'Event', 'Manual']

/** One recording the camera's own index holds. */
export interface AmcrestClipRow {
  /** `<startSec>-<endSec>`. See `clip-identity.ts`. */
  readonly clipKey: string
  readonly startMs: number
  readonly endMs: number
  /**
   * The row's own `Duration`, in ms — the WALL-CLOCK window, which is about
   * 7.5 % longer than the media inside it. Never handed out as the media's
   * duration.
   */
  readonly windowMs: number
  /** `Length`. `null` when the camera did not state one — never 0, which says
   *  the file is empty (D393). */
  readonly sizeBytes: number | null
  /** What `RPC_Loadfile` takes. NOT what `/cam/playback` takes. */
  readonly filePath: string
  /** The camera's OWN event strings, unmapped (`VideoMotion`, …). */
  readonly events: readonly string[]
  /** The camera's OWN record reasons (`Event`, `Timing`, `Manual`). */
  readonly flags: readonly string[]
  /** 0-based, as `mediaFileFind` counts. The RTSP channel is this plus one. */
  readonly channel: number
}

/** Why a row the camera sent did not become a clip. Counted and logged, never
 *  silently dropped (D391). */
export type ClipRowRejection =
  | 'no-file-path'
  | 'unreadable-start'
  | 'unreadable-end'
  | 'not-a-window'

export type ParseClipRowOutcome =
  | { readonly kind: 'ok'; readonly row: AmcrestClipRow }
  | { readonly kind: 'rejected'; readonly reason: ClipRowRejection }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) if (typeof entry === 'string' && entry !== '') out.push(entry)
  return out
}

/**
 * A positive finite number, or `null`.
 *
 * `0` becomes `null` on purpose for `Length`: a zero-byte recording is not a
 * measurement, and a bound check that reads it as "comfortably under the
 * ceiling" would let an unmeasurable file through the one gate that exists to
 * stop it.
 */
function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

export function parseClipRow(raw: unknown, clock: AmcrestCameraClock): ParseClipRowOutcome {
  if (!isRecord(raw)) return { kind: 'rejected', reason: 'no-file-path' }
  const filePath = raw['FilePath']
  if (typeof filePath !== 'string' || filePath === '') {
    return { kind: 'rejected', reason: 'no-file-path' }
  }
  const startRaw = raw['StartTime']
  const endRaw = raw['EndTime']
  const startMs = typeof startRaw === 'string' ? fromCameraWallClock(startRaw, clock) : null
  if (startMs === null) return { kind: 'rejected', reason: 'unreadable-start' }
  const endMs = typeof endRaw === 'string' ? fromCameraWallClock(endRaw, clock) : null
  if (endMs === null) return { kind: 'rejected', reason: 'unreadable-end' }
  // A zero-or-negative window is a snapshot row the `Types` filter should have
  // excluded, or a firmware that wrote its end before its start. Either way
  // there is no window to play and no duration to draw.
  if (endMs <= startMs) return { kind: 'rejected', reason: 'not-a-window' }
  const declaredDuration = readPositiveNumber(raw['Duration'])
  const channelRaw = raw['Channel']
  return {
    kind: 'ok',
    row: {
      clipKey: clipKeyFor(startMs, endMs),
      startMs,
      endMs,
      // The camera's own `Duration` when it stated one; otherwise the span it
      // stated the window as. Both are the WINDOW — neither is the media.
      windowMs: declaredDuration !== null ? declaredDuration * 1000 : endMs - startMs,
      sizeBytes: readPositiveNumber(raw['Length']),
      filePath,
      events: readStrings(raw['Events']),
      flags: readStrings(raw['Flags']),
      channel: typeof channelRaw === 'number' && Number.isInteger(channelRaw) ? channelRaw : 0,
    },
  }
}

export interface FindConditionInput {
  /** 0-based, as `mediaFileFind` counts. */
  readonly channel: number
  /** The camera's own wall clock. */
  readonly startWallClock: string
  readonly endWallClock: string
}

/** The `condition` object `mediaFileFind.findFile` takes. */
export interface AmcrestFindCondition {
  readonly Channel: number
  readonly StartTime: string
  readonly EndTime: string
  readonly Flags: readonly string[]
  readonly Types: readonly string[]
}

export function buildFindCondition(input: FindConditionInput): AmcrestFindCondition {
  return {
    Channel: input.channel,
    StartTime: input.startWallClock,
    EndTime: input.endWallClock,
    Flags: CLIP_FIND_FLAGS,
    Types: CLIP_FIND_TYPES,
  }
}

/**
 * Has the walk reached the end?
 *
 * `found < count` and nothing else. **`mediaFileFind.getCount` must never be
 * called**: over CGI it is `501 Not Implemented`, and over RPC2 it is worse —
 * measured answering `{"params":{"count":0},"result":true}` on a find object
 * whose `findFile` had just succeeded and from which rows were then
 * enumerated. That is an authoritative-looking zero from a method that
 * answered successfully, which is the exact shape D393 forbids, produced by
 * the camera itself.
 */
export function findWalkIsComplete(found: number, asked: number): boolean {
  return found < asked
}
