/**
 * An Amcrest clip's IDENTITY — and it is a TIME WINDOW, which is the one thing
 * that makes this provider different from its two siblings.
 *
 * `native:amcrest:onboard:<startSec>:<endSec>`, epoch seconds, OUR clock.
 *
 * ## Why the window and not the file name
 *
 * Because the camera accepts two different handles for the same recording and
 * they are not interchangeable (measured 2026-09-23, device 3836):
 *
 * - **`/cam/playback?channel=1&starttime=…&endtime=…`** — RTSP playback. The
 *   ONLY form that serves: `?filename=<FilePath>` answers 404 and so does the
 *   bare path form `rtsp://…/mnt/sd/…mp4`.
 * - **`/cgi-bin/RPC_Loadfile<FilePath>`** — the bytes. Takes the file path and
 *   nothing else.
 *
 * So the window is the identity and the path is a property of the row. A
 * provider that conflated them would address playback by a handle playback
 * refuses.
 *
 * ## The id is self-contained and the row is still required
 *
 * The window in the id is enough to build a playback URI, which makes a
 * deep-link readable and a log line diagnosable. It deliberately does NOT make
 * the id sufficient: every method still resolves the catalog ROW, and an id
 * whose row this node has not listed is `catalog-miss` — the truth ("I have
 * never heard of it"), not a failure. Otherwise a caller could mint an id for
 * a window nobody checked exists, and the camera would answer a `DESCRIBE`
 * 404 that this firmware ALSO uses for "all three playback slots are busy".
 *
 * Pure. No I/O, no clock.
 */

/** The camera's own recordings — the one Amcrest source. */
export const CLIP_SOURCE_ONBOARD = 'native:amcrest:onboard'

/** Every source this provider can name. Order is the picker's order. */
export const AMCREST_CLIP_SOURCES = [CLIP_SOURCE_ONBOARD] as const

export type AmcrestClipSource = (typeof AMCREST_CLIP_SOURCES)[number]

export interface ClipIdParts {
  readonly source: AmcrestClipSource
  readonly startMs: number
  readonly endMs: number
}

/**
 * The key a row is filed under, and the segment a data-plane URL carries.
 *
 * `<startSec>-<endSec>` rather than a hash: it is already short, already
 * unique (two files cannot own the same window on one channel), URL-safe
 * without encoding, and readable in a log line — which a sha1 is not, on a
 * provider whose whole identity question is "which window".
 */
export function clipKeyFor(startMs: number, endMs: number): string {
  return `${String(Math.floor(startMs / 1000))}-${String(Math.floor(endMs / 1000))}`
}

export function mintClipId(parts: ClipIdParts): string {
  return `${parts.source}:${clipKeyFor(parts.startMs, parts.endMs)}`
}

/**
 * Parse an id this provider minted. `null` for anything else — including an id
 * from the analytics, Reolink or Hikvision source, which is how the collection
 * dispatcher's "nobody claimed this id" branch stays honest.
 */
export function parseClipId(clipId: string): ClipIdParts | null {
  const source = AMCREST_CLIP_SOURCES.find((candidate) => clipId.startsWith(`${candidate}:`))
  if (source === undefined) return null
  const rest = clipId.slice(source.length + 1)
  const match = /^(\d+)-(\d+)$/.exec(rest)
  if (match === null) return null
  const startSec = Number(match[1])
  const endSec = Number(match[2])
  if (!Number.isSafeInteger(startSec) || !Number.isSafeInteger(endSec)) return null
  // An end BEFORE the start is not a window, and a zero-length one is a JPEG
  // row that should never have been listed (the catalog filters those out by
  // `Types`, and this is the second wall).
  if (endSec <= startSec) return null
  return { source, startMs: startSec * 1000, endMs: endSec * 1000 }
}

/** The key a clip id names, without re-deriving the arithmetic. */
export function clipKeyOf(parts: ClipIdParts): string {
  return clipKeyFor(parts.startMs, parts.endMs)
}
