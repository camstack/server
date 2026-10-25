/**
 * NOT WIRED. The hub's cross-child EVENT list (cmd 516/517/518), kept as a
 * working reader and reachable from nothing in the catalog path.
 *
 * It WAS the catalog on a hub child (D549 19) and stopped being one on
 * 2026-09-20 (D565): `FileInfoList` is now the catalog on every topology, and
 * `clip-event-path-is-not-wired.spec.ts` asserts that the provider neither
 * imports nor calls this module.
 *
 * ## What retired it — the two grounds D549 19 gave, re-measured
 *
 * - *"it was faster"*: 29 events in 293 ms against 20 files in 503 ms. Same
 *   child, same session, 2026-09-20: `searchEventLog` **950 ms** (day 16) and
 *   **678 ms** (day 9) against `FileInfoList` sub **137 ms** / **514 ms**.
 *   Reversed.
 * - *"it carries the class, and the files do not"*: true — a hub child's files
 *   really are `recordType: none` on every row. But `searchAlarmVideos`
 *   answered the same child in **247–306 ms** and joins to those files by
 *   their start stamp (`clip-alarm-labels.ts`), so the file list carries the
 *   class too.
 *
 * And the grain was the real cost: an event is not playable on its own, so
 * every row had to be joined to a file before anything could be downloaded —
 * 28 of 29 on 3628 day 16, with the 29th needing a `playable: false,
 * no-file-for-window` row that existed only because the grain was wrong.
 *
 * ## Why it is kept rather than deleted
 *
 * Not "for later": the hub's event feed is a DIFFERENT question from a
 * camera's clip catalog — "what happened across these children", multi-day,
 * newest first, where `bHasRecFile` is the honest "no clip for this one"
 * (D549 10 reserved it for exactly that). Its tests still run, so it cannot
 * rot into something that would not compile the day that surface opens.
 * Everything below is the reader as it was, including what it learned about
 * the wire; none of it runs today.
 *
 * ## An event is not a promise of a clip
 *
 * A row whose `hasRecFile` is false has nothing to play, and both of the wrong
 * things are easy: dropping it under-reports a camera's events, and showing it
 * as playable fails on click. It is listed with `playable: false` and a
 * reason, which is what `ClipSchema.unplayableReason` exists for.
 *
 * **How often that bites is a per-camera fact.** Measured 2026-09-20 over 20
 * days: 3628 → 222 rows with 0 orphans, 3629 → 1 059 rows with 0 orphans, and
 * the orphans D549 19 describes are on 3825 — the child whose uid was never
 * persisted, which this provider cannot address at all today. So one camera's
 * events are all playable and another's are all not, and a surface built for
 * either extreme is wrong on the other.
 *
 * ## Where the file comes from
 *
 * `findEventLog` rows carry no file name — they name events, not files. So the
 * file is resolved by WINDOW CONTAINMENT against the day's `FileInfoList`
 * rows, which the `onboard` reader already fetches: an event whose
 * `[start, end]` lies inside a file's `[start − 3 s, end + 3 s]`. 28 of 29 on
 * the measured day; the one that did not is a real orphan (the hub refused its
 * CoverPreview too), not a join bug.
 *
 * Deliberately NOT used here: `searchAlarmVideos` (272/273/274). It does carry
 * a `fileName`, and its containment is measured at 1271/1271 — but it is
 * clamped to ONE camera-local day (an 18→19 September window silently answered
 * 462 windows all dated the 18th) where `searchEventLog` spans the whole
 * window in one open, and D549 19 chose the event list on the measured timing.
 * Its place is the per-window label upgrade for a clip's DETAIL (D549 20), and
 * that is a separate slice.
 *
 * ## `devices` is the selector; `chnbits` is inert
 *
 * Measured: `chnbits: 3` answered exactly the same 9 rows as the default, and
 * OMITTING `devices` is refused outright by the library ("no devices to
 * search") rather than answered emptily — a hub that has pushed nothing yet is
 * a refusal, not an empty result. This module always passes `devices`, never
 * sends `chnbits`, and never derives one from the other. With one child named,
 * foreign rows in the reply were 0; the uid filter below is belt and braces.
 */
import { clipKeyFor } from './clip-identity.js'
import type { ReolinkClipRow } from './clip-catalog.js'

/** The narrow slice of the library this module uses. */
export interface EventLogEntryLike {
  readonly uid: string
  readonly logicChn: number
  readonly hasRecFile: boolean
  readonly alarmTypes: readonly string[]
  readonly startTime?: Date
  readonly endTime?: Date
}

export interface EventLogApi {
  searchEventLog(params: {
    devices?: readonly { uid: string; logicChnBitmap?: number }[]
    start: Date
    end: Date
    timeZone?: string
    maxPages?: number
    timeoutMs?: number
  }): Promise<readonly EventLogEntryLike[]>
}

export interface ListEventRowsInput {
  /** The CHILD's uid — the only thing that selects a camera on a hub. */
  readonly uid: string
  readonly channel: number
  readonly timeZone: string
  readonly since: number
  readonly until: number
}

/** One row of the events view, before it is joined to a file. */
export interface ReolinkEventRow {
  readonly channel: number
  readonly startMs: number
  readonly endMs: number
  /** Every `alarmType` the hub wrote, split and unmapped. */
  readonly nativeTypes: readonly string[]
  /** What the hub says about a recording existing for this event. */
  readonly hasRecFile: boolean
}

/**
 * Every event for ONE child in the window, newest first, in ONE call.
 *
 * The event list is multi-day by construction — a per-day loop would pay the
 * open/close for each day and answer the same rows. The bound the caller owes
 * is on the WINDOW, and it has a number behind it: measured on one hub child,
 * ONE day is 267 ms and 20 days is 3.6–5.4 s. A day-range default is therefore
 * a UI decision, not a free one.
 */
export async function listEventRows(
  api: EventLogApi,
  input: ListEventRowsInput,
): Promise<readonly ReolinkEventRow[]> {
  const entries = await api.searchEventLog({
    // `devices` is the selector. `chnbits` is measured inert and is not sent.
    devices: [{ uid: input.uid }],
    start: new Date(input.since),
    end: new Date(input.until),
    timeZone: input.timeZone,
  })

  const rows: ReolinkEventRow[] = []
  for (const entry of entries) {
    // One hub session answers for every child it was asked about. A sibling's
    // row must never become this camera's clip.
    if (entry.uid !== input.uid) continue
    const startMs = entry.startTime?.getTime()
    if (startMs === undefined || !Number.isFinite(startMs)) continue
    rows.push({
      channel: input.channel,
      startMs,
      endMs: entry.endTime?.getTime() ?? startMs,
      nativeTypes: [...entry.alarmTypes],
      hasRecFile: entry.hasRecFile,
    })
  }
  return rows.toSorted((a, b) => b.startMs - a.startMs)
}

/** How far outside a file's own window an event may still belong to it. */
export const EVENT_FILE_CONTAINMENT_TOLERANCE_MS = 3_000

/** An events-view row with its file resolved, or with the reason it has none. */
export interface JoinedEventRow extends ReolinkEventRow {
  /** The artifact key: the FILE's when one was found, this event's otherwise —
   *  never another clip's, or two rows would share a thumbnail they do not. */
  readonly clipKey: string
  /** The byte handle, present only when a file really covers this window. */
  readonly fileName?: string
  readonly playable: boolean
  /** `no-rec-file` (the hub says none exists) | `no-file-for-window` (it says
   *  one does and none of the day's files covers the window). */
  readonly unplayableReason?: string
}

export function joinEventsToFiles(
  events: readonly ReolinkEventRow[],
  files: readonly ReolinkClipRow[],
): readonly JoinedEventRow[] {
  return events.map((event): JoinedEventRow => {
    // The cheap question first: the hub already told us whether a file exists.
    // Searching for one it says is not there would find a neighbour's.
    if (!event.hasRecFile) {
      return {
        ...event,
        clipKey: eventKey(event),
        playable: false,
        unplayableReason: 'no-rec-file',
      }
    }
    const file = files.find(
      (candidate) =>
        event.startMs >= candidate.startMs - EVENT_FILE_CONTAINMENT_TOLERANCE_MS &&
        event.endMs <= candidate.endMs + EVENT_FILE_CONTAINMENT_TOLERANCE_MS,
    )
    if (file === undefined) {
      return {
        ...event,
        clipKey: eventKey(event),
        playable: false,
        unplayableReason: 'no-file-for-window',
      }
    }
    return { ...event, clipKey: file.clipKey, fileName: file.subFileName, playable: true }
  })
}

/** A key for a row with no file — stable, and its OWN. */
function eventKey(event: ReolinkEventRow): string {
  return clipKeyFor(event.channel, `event:${event.startMs}-${event.endMs}`)
}
