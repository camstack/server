/**
 * Reading a Reolink camera's own clip catalog: the cheap question, the day
 * index, then one day's files.
 *
 * ## The order is the point
 *
 * 1. **Is there a card at all?** `getHddInfoList` (cmd 102). 640 answers
 *    `mount 0, capacity 0` — no SD card — and searching it is 400s and wasted
 *    wake budget. "The cheap question comes first" (D549 4 / D54).
 * 2. **Which days hold footage?** `getDayRecords` (cmd 142) once per month.
 *    The per-day listing loop of the earlier plan is deleted, not kept as a
 *    fallback (D549 8): 19 days in 50 ms beats 30 searches.
 * 3. **What is in one day?** `FileInfoList` (cmd 14/15/16), sub AND main, then
 *    twinned (D549 14b). A clip IS a file: its name is its id, its bytes
 *    (cmd 5) and its still (cmd 298) are addressed from it (D549 10).
 *
 * This is the ONE catalog, on every topology (D565, superseding D549 19). A
 * hub child read the parent's event log for a day; that view is kept and NOT
 * wired (`clip-event-catalog.ts`).
 *
 * What a hub child does NOT get from here is a class: its files come back
 * `recordType: none` on every row (measured `{"none": 20}` and `{"none": 28}`
 * on 3628). The class is joined on afterwards from `findAlarmVideo`, by the
 * file's start stamp — `clip-alarm-labels.ts`, and only for a day whose files
 * carried none, because a standalone's do.
 *
 * ## What an empty answer means
 *
 * A day the CALENDAR names and the INDEX answers with nothing is a defect on
 * the camera, measured on 108: the calendar marks 3–20 September, days 6–20
 * list zero files on both streams, on both filters, on a hand-built window,
 * with 177 GB free. The reader reports `indexEmpty` for that day so the
 * provider can say `index-empty` — never "no clips", which would be a lie
 * about a card that is full of them (D549 18).
 */

import { clipKeyFor } from './clip-identity.js'
import type { ClipDownloadResult } from './clip-mux.js'
import { parseNativeTypes } from './clip-native-types.js'
import { pairTwins, type TwinCandidate } from './clip-twins.js'
import { dayBounds, type WallClockDay, wallClockDayKey } from './clip-wall-clock.js'

// ── The narrow slice of the library this module uses ──────────────────────
//
// Declared here rather than imported so the reader is testable against fakes
// shaped from the captured wire, and so a library shape change shows up as a
// compile error in ONE place.

export interface DayRecordsChannelLike {
  readonly days: readonly { readonly day: number }[]
}

export interface HddInfoApi {
  getHddInfoList(options?: { timeoutMs?: number }): Promise<unknown>
}

export interface DayRecordsApi {
  getDayRecords(params: {
    year: number
    month: number
    channel?: number
    uid?: string
    timeoutMs?: number
  }): Promise<DayRecordsChannelLike>
}

export interface RecordingFileLike extends TwinCandidate {
  readonly fileName: string
}

export interface FileInfoListApi {
  getVideoclips(params: {
    channel?: number
    start: Date
    end: Date
    streamType?: 'mainStream' | 'subStream'
    uid?: string
    timeZone?: string
    maxIterations?: number
    timeoutMs?: number
  }): Promise<readonly RecordingFileLike[]>
}

/** cmd 298 (the still) and cmd 5 (the bytes), on the SAME one session. */
export interface ClipMediaApi {
  getVideoclipThumbnailJpeg(params: {
    channel?: number
    time: Date
    endTime?: Date
    snapType?: 'main' | 'sub'
    uid?: string
    isNvr?: boolean
    timeZone?: string
    timeoutMs?: number
    /** REQUIRED: the library's own default is a PATH `ffmpeg` (D540). */
    ffmpegPath: string
  }): Promise<Buffer>
  downloadRecordingDemuxed(params: {
    channel: number
    uid?: string
    fileName: string
    timeoutMs?: number
    idleTimeoutMs?: number
  }): Promise<ClipDownloadResult>
  /**
   * The same cmd 5 transfer, handed on chunk by chunk (`@apocaliss92/nodelink-js`
   * ≥ 0.8.0). `onChunk` receives each decrypted BcMedia chunk BEFORE it is
   * accumulated; a consumer that throws from it fails the transfer loudly,
   * which is the only lever the library offers to stop one. The library still
   * accumulates and returns the whole Buffer — that copy is the library's,
   * and stage 1 does not read it.
   */
  fileInfoListReplayBinaryDownload(params: {
    channel: number
    uid?: string
    fileName: string
    timeoutMs?: number
    idleTimeoutMs?: number
    onChunk?: (chunk: Buffer) => void
  }): Promise<Buffer>
}

// ── Storage ───────────────────────────────────────────────────────────────

export type StorageState =
  /** A card is mounted. */
  | { readonly state: 'present'; readonly capacityGb?: number }
  /** The camera reported a disk and it is not mounted — 106's measured case. */
  | { readonly state: 'absent' }
  /**
   * The camera did not say, or the read failed. NOT the same as `absent`: a
   * measurement that failed is `null`, never `0` (D393), and folding "we could
   * not read the card" into "there is no card" would refuse to list a healthy
   * camera.
   */
  | { readonly state: 'unknown'; readonly reason?: string }

/**
 * Locate the disk record structurally.
 *
 * The library's declared `HddInfoListConfig` and the captured wire disagree —
 * the body is generic parsed XML (`HddInfoList.HddInfo` with `mount`,
 * `capacity`, `remainSize`; the declared `item`/`itemNum` shape appears
 * nowhere). Searching for the KEY rather than the path survives both, and
 * survives the next firmware that nests it differently.
 */
function findRecordWithKey(node: unknown, key: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRecordWithKey(child, key)
      if (found !== null) return found
    }
    return null
  }
  const record: Record<string, unknown> = { ...(node as Record<string, unknown>) }
  if (key in record) return record
  for (const value of Object.values(record)) {
    const found = findRecordWithKey(value, key)
    if (found !== null) return found
  }
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

export async function readStorageState(api: HddInfoApi): Promise<StorageState> {
  let raw: unknown
  try {
    raw = await api.getHddInfoList()
  } catch (err: unknown) {
    return { state: 'unknown', reason: err instanceof Error ? err.message : String(err) }
  }
  const record = findRecordWithKey(raw, 'mount')
  if (record === null) return { state: 'unknown' }
  const mount = asNumber(record['mount'])
  if (mount === null) return { state: 'unknown' }
  if (mount === 0) return { state: 'absent' }
  const capacityGb = asNumber(record['capacity'])
  return capacityGb === null ? { state: 'present' } : { state: 'present', capacityGb }
}

// ── The day index ─────────────────────────────────────────────────────────

export interface CalendarMonth {
  readonly year: number
  readonly month: number
}

export interface DayIndexInput {
  readonly channel: number
  /**
   * The CHILD's uid on a hub, the camera's own on a standalone. Always sent:
   * cmd 142 needs it on a hub (400 without) and ignores it on a standalone
   * (D549 18). The HUB's own uid addresses no catalog at all — an empty month
   * over 24 months, measured on two children.
   */
  readonly uid: string | undefined
  readonly months: readonly CalendarMonth[]
}

/** Every camera-local day in those months that the camera says holds footage. */
export async function readDayIndex(
  api: DayRecordsApi,
  input: DayIndexInput,
): Promise<ReadonlySet<WallClockDay>> {
  const days = new Set<WallClockDay>()
  for (const { year, month } of input.months) {
    const answer = await api.getDayRecords({
      year,
      month,
      channel: input.channel,
      ...(input.uid !== undefined ? { uid: input.uid } : {}),
    })
    for (const entry of answer.days) {
      days.add(
        `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(entry.day).padStart(2, '0')}`,
      )
    }
  }
  return days
}

/** The calendar months a window touches, newest first. */
export function monthsBetween(
  sinceMs: number,
  untilMs: number,
  timeZone: string,
): readonly CalendarMonth[] {
  if (!(untilMs > sinceMs)) return []
  const out: CalendarMonth[] = []
  const seen = new Set<string>()
  // At most 24 months: a listing is a scroll, not a migration, and the oldest
  // footage measured on this fleet is 29 April of the same year.
  for (let index = 0; index < 24; index += 1) {
    const at = untilMs - index * 15 * 24 * 3_600_000
    if (at < sinceMs - 31 * 24 * 3_600_000) break
    const day = wallClockDayKey(Math.max(at, sinceMs), timeZone)
    const key = day.slice(0, 7)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) })
  }
  return out
}

// ── One day's files ───────────────────────────────────────────────────────

/** One recording as the catalog holds it: the sub file plus its main twin. */
export interface ReolinkClipRow {
  /** `clipKeyFor(channel, subFileName)` — the on-disk key for its artifacts. */
  readonly clipKey: string
  readonly channel: number
  readonly startMs: number
  readonly endMs: number
  /** The byte handle for the sub stream — the full `<Id>` path when the camera
   *  sent one, because cmd 5 is addressed by the path, not the short name. */
  readonly subFileName: string
  readonly subBytes?: number
  readonly mainFileName?: string
  readonly mainBytes?: number
  /**
   * The MAIN twin's own start. Not a duplicate of {@link startMs}: the twins
   * differ by 0–4 s, and the label join keys on the second a file STARTED, so
   * a window drawn from the main file set needs the main's stamp and not the
   * sub's (`clip-alarm-labels.ts`).
   */
  readonly mainStartMs?: number
  readonly supportSub: boolean
  /**
   * Every raw `recordType` the file carried, unmapped — or, where the file
   * carried none at all (`none` on every hub-child row, measured), the alarm
   * windows' own types joined in by `clip-alarm-labels.ts`.
   */
  readonly nativeTypes: readonly string[]
  /**
   * The recording is STILL BEING WRITTEN, so {@link endMs} is not its end.
   *
   * Absent means closed. See {@link isFileStillBeingWritten} for what the
   * camera actually says, and D563 for what it cost to draw a duration from
   * an open file's frozen `<endTime>`.
   */
  readonly inProgress?: boolean
}

/**
 * Is this file still being written?
 *
 * A Reolink recording is named `<prefix>_DST<date>_<start>_<end>_<hex>_<hex>`,
 * and while it is open the camera writes the END stamp as `000000` and the
 * size as `0` — measured on 592, 2026-09-20:
 * `RecS03_DST20260920_192927_000000_2B1E808_0.mp4`. Its `<endTime>` block is
 * FROZEN at whatever the index entry held when it was created (19:29:56, read
 * three times over fifteen minutes while the file grew), so a duration drawn
 * from it is a lie about the one row the operator sees first.
 *
 * BOTH signals are required. A recording that happens to end at midnight is
 * named `_000000_` and is closed; its bytes are what separate the two. Nothing
 * on the wire distinguishes them otherwise, and a false positive here would
 * replace a correct duration with `Recording…` for ever. Re-measured
 * read-only the same evening: of 355 sub and 355 main files on that camera's
 * day, zero carried a `_000000_` segment and zero carried a size of 0.
 */
export function isFileStillBeingWritten(file: TwinCandidate): boolean {
  if (file.sizeBytes !== undefined && file.sizeBytes > 0) return false
  return OPEN_END_STAMP.test(file.fileName)
}

/** The end-stamp field of an open recording, between its own separators. */
const OPEN_END_STAMP = /_000000_/

export interface ListDayInput {
  readonly channel: number
  readonly uid: string | undefined
  readonly timeZone: string
  readonly day: WallClockDay
  /** Ceiling on the pagination loop (40 files/page, no `<bFinished>`). */
  readonly maxPages?: number
}

export interface ListDayResult {
  readonly rows: readonly ReolinkClipRow[]
  /**
   * True when the camera answered the SUB search with nothing. The caller
   * pairs it with the calendar: a day the calendar named and this emptied is
   * `index-empty` (618), a day the calendar never named is simply not asked.
   */
  readonly indexEmpty: boolean
  /** The main search's refusal, verbatim, when it refused. The day still
   *  lists — losing the high twin must not lose the day. */
  readonly mainSearchFailed?: string
}

/** 50 pages × 40 files = 2 000 files: above the busiest day measured (546). */
export const DEFAULT_MAX_PAGES_PER_DAY = 50

function handleOf(file: RecordingFileLike): string {
  const id = file.id
  return id !== undefined && id !== '' ? id : file.fileName
}

export async function listDayRows(
  api: FileInfoListApi,
  input: ListDayInput,
): Promise<ListDayResult> {
  const { startMs, endMs } = dayBounds(input.day, input.timeZone)
  const common = {
    channel: input.channel,
    start: new Date(startMs),
    end: new Date(endMs),
    timeZone: input.timeZone,
    maxIterations: input.maxPages ?? DEFAULT_MAX_PAGES_PER_DAY,
    ...(input.uid !== undefined ? { uid: input.uid } : {}),
  }

  // The SUB search is the catalog. A refusal here is a refusal of the day and
  // travels to the caller — an empty day and an unread day are different
  // answers and must not collapse.
  const subs = await api.getVideoclips({ ...common, streamType: 'subStream' })

  // The MAIN search is the high-quality twin. Its refusal costs `high`
  // playback for the day and nothing else, so it is caught here and named.
  let mains: readonly RecordingFileLike[] = []
  let mainSearchFailed: string | undefined
  try {
    mains = await api.getVideoclips({ ...common, streamType: 'mainStream' })
  } catch (err: unknown) {
    mainSearchFailed = err instanceof Error ? err.message : String(err)
  }

  const rows = pairTwins(subs, mains).map((pair): ReolinkClipRow => {
    const subHandle = handleOf(pair.sub)
    return {
      clipKey: clipKeyFor(input.channel, subHandle),
      channel: input.channel,
      startMs: pair.sub.startTime?.getTime() ?? 0,
      endMs: pair.sub.endTime?.getTime() ?? pair.sub.startTime?.getTime() ?? 0,
      subFileName: subHandle,
      ...(pair.sub.sizeBytes !== undefined ? { subBytes: pair.sub.sizeBytes } : {}),
      ...(pair.main !== undefined ? { mainFileName: handleOf(pair.main) } : {}),
      ...(pair.main?.sizeBytes !== undefined ? { mainBytes: pair.main.sizeBytes } : {}),
      ...(pair.main?.startTime !== undefined ? { mainStartMs: pair.main.startTime.getTime() } : {}),
      supportSub: pair.sub.supportSub !== false,
      nativeTypes: parseNativeTypes(pair.sub.recordType),
      ...(isFileStillBeingWritten(pair.sub) ? { inProgress: true } : {}),
    }
  })

  return {
    rows,
    indexEmpty: subs.length === 0,
    ...(mainSearchFailed !== undefined ? { mainSearchFailed } : {}),
  }
}
