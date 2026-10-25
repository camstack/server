/**
 * Where a clip's CLASS comes from when the file itself does not carry one.
 *
 * `FileInfoList` is the catalog on every topology (D565), and on a standalone
 * the class rides along for free: the file's own `recordType` CSV. Measured
 * 2026-09-19 on 592 — 546 files carrying `md 498 / dog_cat 118 / people 108 /
 * sched 40`. On a HUB CHILD that same field is `none` on every row (measured
 * 2026-09-16 on 3628: `{"none": 20}`, and 2026-09-09: `{"none": 28}`), so the
 * class has to be asked for, and `findAlarmVideo` (272/273/274,
 * `searchAlarmVideos`) is where the hub keeps it.
 *
 * ## The cheap question first
 *
 * This is an UPGRADE for a day that has no class, never a second authority
 * over a day that has one. On 592 the alarm search costs **8.2–9.5 s for
 * 1 271 windows** against the 2.1 s the whole day's listing costs, and it
 * would re-derive labels already on the row (D549 20 measured the two
 * agreeing on 164 of 167 files). On 3628 it costs **247–306 ms** and is the
 * only class there. So the gate is what the DAY's files actually said —
 * `dayNeedsAlarmLabels` — and not the topology: a camera is asked because its
 * answer was empty, not because of what it is.
 *
 * ## The join key is the file's START STAMP, not its name
 *
 * D555 recorded that the two surfaces "join on `<name>`". Taken literally
 * against what the library returns, that join scores **0 of 539**:
 * `RecordingFile.fileName` is the full `<Id>` path
 * (`/mnt/sda/Mp4Record/2026-09-19/RecS03_DST20260919_000145_000348_….mp4`)
 * while an `AlarmVideoWindow.fileName` is the short form the XML `<name>`
 * carries — `01` + `YYYYMMDDHHMMSS`, e.g. `0120260919000145`. The 14-digit
 * tail is the file's start in the CAMERA's wall clock, and that is what really
 * joins. Measured 2026-09-20, distinct names matching a file's start stamp:
 *
 * | camera / day | `streamType` | names | a SUB start | a MAIN start |
 * | --- | --- | --- | --- | --- |
 * | 592 / 09-19 | 0 | 539 | 205 | **539** |
 * | 592 / 09-19 | 1 | 539 | **539** | 205 |
 * | 3628 / 09-16 | 0 | 22 | 10 | 20 |
 * | 3628 / 09-16 | 1 | 21 | **20** | 10 |
 *
 * So `streamType` DOES select the file set the names are drawn from — `0` the
 * main set, `1` the sub set, exactly as nodelink-js documents it and not as
 * D555 read it off the hub ("both returned the same 28 file names"; the two
 * sets overlap heavily, they are not the same set). We ask for the SUB set
 * because the catalog row IS the sub file, and we still try the row's main
 * twin's stamp, because one hub name of twenty-one matched neither and a
 * label is an upgrade rather than the catalog.
 *
 * `streamType` here is a NUMBER and it is not `getVideoclips`'s
 * `subStream` | `mainStream` STRING. Two different things wearing one name:
 * they are never unified and never passed through one another.
 */
import type { ReolinkClipRow } from './clip-catalog.js'
import { dayBounds, type WallClockDay } from './clip-wall-clock.js'

/**
 * `searchAlarmVideos`'s SUB file set. Numeric, and deliberately not reachable
 * from `FileInfoList`'s `streamType` string.
 */
export const ALARM_SEARCH_SUB_FILE_SET = 1

/** The narrow slice of the library this module uses. */
export interface AlarmVideoWindowLike {
  /** The SHORT name — `01` + `YYYYMMDDHHMMSS`, never the `<Id>` path. */
  readonly fileName: string
  /** `alarmType` split on commas. Open vocabulary, carried through raw. */
  readonly alarmTypes: readonly string[]
  readonly startTime?: Date
  readonly endTime?: Date
}

export interface AlarmVideoApi {
  searchAlarmVideos(params: {
    channel?: number
    uid?: string
    start: Date
    end: Date
    streamType?: number
    timeZone?: string
    maxPages?: number
    timeoutMs?: number
  }): Promise<readonly AlarmVideoWindowLike[]>
}

export interface ReadAlarmWindowsInput {
  readonly channel: number
  /** The CHILD's uid on a hub; ignored by a standalone (`clip-addressing.ts`). */
  readonly uid: string | undefined
  readonly timeZone: string
  readonly day: WallClockDay
}

/**
 * Every alarm window of ONE camera-local day.
 *
 * The one-day clamp is the firmware's, not ours: an 18→19 September ask
 * answered 462 windows all dated the 18th. The caller owns the iteration, and
 * this is asked from inside the day loop the listing already runs.
 */
export async function readAlarmWindows(
  api: AlarmVideoApi,
  input: ReadAlarmWindowsInput,
): Promise<readonly AlarmVideoWindowLike[]> {
  const { startMs, endMs } = dayBounds(input.day, input.timeZone)
  return await api.searchAlarmVideos({
    channel: input.channel,
    start: new Date(startMs),
    end: new Date(endMs),
    streamType: ALARM_SEARCH_SUB_FILE_SET,
    timeZone: input.timeZone,
    ...(input.uid !== undefined ? { uid: input.uid } : {}),
  })
}

/** The camera declined to class this file: `none`, or no `recordType` at all. */
export function fileCarriesNoClass(nativeTypes: readonly string[]): boolean {
  return nativeTypes.every((type) => type === 'none')
}

/**
 * Should this day's labels be asked for separately?
 *
 * Only when NOTHING in the day carried a class. One file saying `md` is proof
 * that this camera writes `recordType`, and then the free answer is the
 * answer — paying 8–9 s to restate it is the cheap-question rule inverted.
 */
export function dayNeedsAlarmLabels(rows: readonly ReolinkClipRow[]): boolean {
  return rows.length > 0 && rows.every((row) => fileCarriesNoClass(row.nativeTypes))
}

export interface AlarmLabelJoin {
  /** New rows. The input is never mutated. */
  readonly rows: readonly ReolinkClipRow[]
  /** How many rows gained a class. */
  readonly matched: number
  /** Windows that named a file this day's listing does not hold. */
  readonly unmatchedWindows: number
}

/**
 * Attach each window's `alarmType`s to the file whose START it names.
 *
 * A row the camera already classed is returned untouched: the file's own
 * `recordType` is the authority wherever it exists, and a per-window answer
 * must not narrow it. A window that names no listed file contributes nothing
 * and is COUNTED — it is never attached to the nearest neighbour, which is how
 * a surface ends up showing one recording's class on another's row.
 */
export function joinAlarmLabels(
  rows: readonly ReolinkClipRow[],
  windows: readonly AlarmVideoWindowLike[],
  timeZone: string,
): AlarmLabelJoin {
  const byStamp = new Map<string, string[]>()
  for (const window of windows) {
    const key = window.fileName.slice(-STAMP_LENGTH)
    const existing = byStamp.get(key)
    const target = existing ?? []
    if (existing === undefined) byStamp.set(key, target)
    for (const type of window.alarmTypes) {
      if (type !== '' && !target.includes(type)) target.push(type)
    }
  }

  const claimed = new Set<string>()
  let matched = 0
  const out = rows.map((row): ReolinkClipRow => {
    if (!fileCarriesNoClass(row.nativeTypes)) return row
    const subKey = alarmJoinKey(row.startMs, timeZone)
    const mainKey =
      row.mainStartMs !== undefined ? alarmJoinKey(row.mainStartMs, timeZone) : undefined
    const key = byStamp.has(subKey)
      ? subKey
      : mainKey !== undefined && byStamp.has(mainKey)
        ? mainKey
        : undefined
    if (key === undefined) return row
    const types = byStamp.get(key)
    if (types === undefined || types.length === 0) return row
    claimed.add(key)
    matched += 1
    return { ...row, nativeTypes: [...types] }
  })

  return { rows: out, matched, unmatchedWindows: byStamp.size - claimed.size }
}

/** `YYYYMMDDHHMMSS` — 14 digits. */
const STAMP_LENGTH = 14

const FORMATTER_BY_ZONE = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTER_BY_ZONE.get(timeZone)
  if (cached !== undefined) return cached
  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  FORMATTER_BY_ZONE.set(timeZone, made)
  return made
}

/**
 * The 14-digit tail of the short name a window carries — the file's start in
 * the CAMERA's wall clock. Never a UTC stamp: 00:30 Rome on the 17th is 22:30
 * UTC on the 16th, and a UTC key would file it under the wrong day and join it
 * to nothing.
 */
export function alarmJoinKey(atMs: number, timeZone: string): string {
  const parts = new Map(
    formatterFor(timeZone)
      .formatToParts(new Date(atMs))
      .map((part) => [part.type, part.value]),
  )
  return (
    `${parts.get('year') ?? ''}${parts.get('month') ?? ''}${parts.get('day') ?? ''}` +
    `${normaliseHour(parts.get('hour'))}${parts.get('minute') ?? ''}${parts.get('second') ?? ''}`
  )
}

/** `hourCycle: h23` still renders midnight as `24` in some ICU builds. */
function normaliseHour(hour: string | undefined): string {
  return hour === '24' ? '00' : (hour ?? '')
}
