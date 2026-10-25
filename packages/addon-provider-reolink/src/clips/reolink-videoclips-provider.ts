/**
 * The Reolink `videoclips` provider — ONE source of a camera's clip
 * collection, on every topology, listed BESIDE the analytics visits and never
 * instead of them (D549 1/2).
 *
 * ## What it must never do
 *
 * **A read never logs into a standalone battery camera.** On UDP the login IS
 * the wake, so every gate runs BEFORE `getApi()` — a gate after it gates
 * nothing (`packages/addon-provider-reolink/CLAUDE.md`). A sleeping camera
 * lists its persisted catalog with `catalogAsOf` and
 * `thumbnailUnavailable.reason: 'sleeping'`; the mint answers 204; playback is
 * refused with a named reason. Only the explicit "Wake and refresh" gesture
 * reaches the camera, and that is slice 4's.
 *
 * **It constructs no session.** Every call — both sources, calendar, listing,
 * stills, bytes, prefetch — goes through the ONE api the device hands out
 * (`parent.getApi()` for a hub child, the camera's own for a standalone). A
 * second session to this Home Hub produced 27 `ECONNRESET`s (D549 17).
 *
 * ## What an empty answer means, per source
 *
 * Never "this camera has no recordings" unless that is what was measured. The
 * five honest states are `no-storage` (640: `mount 0`), `sleeping` (with an
 * age), `index-empty` (618: the calendar marks the day, the index lists
 * nothing), `unreachable` (the camera's own refusal, verbatim) and — through
 * the reason rather than the state — `uid-missing`, which is 3825 today: a hub
 * child whose uid was never persisted cannot be addressed at all, and
 * that is not the same as having no clips. `uid-missing` is a HUB CHILD's
 * state only: a standalone ignores the uid and is refused for nothing
 * (`clip-addressing.ts`; an unconditional gate refused 592 for a whole
 * release). `ok` is the only state whose list may be read as complete.
 *
 * **And `ok` is MEASURED, never defaulted** (D561). `listSources` probes for
 * it — the storage question, the calendar, and one listing of the newest day
 * the calendar claims — because it used to inherit `ok` from nothing and, on
 * the cold runners a deploy produces, handed the surface `ok` for a camera
 * with no card (106) and for a camera whose own index contradicts its own
 * calendar (618). The honest states were computed only as a side effect of
 * `listClips`, in a Map that a restart empties. A standalone battery camera is
 * asked nothing at all: the gate is `isBattery`, never the BELIEF `sleeping`,
 * which is `?? false` and therefore reads "awake" for a slice that has not
 * restored.
 *
 * **And an empty clip list is an answer only when the source could ANSWER.**
 * `listClips` refuses by name — the state and the camera's own words — when it
 * produced no rows and the source is not `ok`. An ordinary empty day (the
 * camera's calendar names no day in the window) is still `[]`.
 *
 * ## ONE source, ONE catalog primitive
 *
 * There is exactly one Reolink source per camera, `native:reolink:onboard`,
 * and it reads exactly one API on every topology: **`FileInfoList`
 * (cmd 14/15/16) is the catalog**, `fileName` is the id, bytes (cmd 5) and
 * stills (cmd 298) are addressed from it (D565, superseding D549 19).
 *
 * A file IS a clip — it has a start, an end, bytes, and it plays. An event
 * window is not playable on its own: it has to be joined to the file that
 * contains it before anything can be downloaded, and that join is neither
 * free nor total. On 3628, day 16, 28 of 29 event windows fell inside a
 * listed file; the 29th declared a recording no file covered and needed a
 * `playable: false, no-file-for-window` row that existed only because the
 * grain was wrong.
 *
 * **D549 19 made a hub child's catalog the EVENT list, on two grounds, and
 * both were re-measured away on 2026-09-20:**
 *
 * - *it was faster* — 29 events in 293 ms against 20 files in 503 ms. Today
 *   the same child, same session: `searchEventLog` **950 ms** (day 16) and
 *   **678 ms** (day 9) against `FileInfoList` sub **137 ms** / **514 ms**.
 *   The comparison is reversed, not merely narrowed.
 * - *it was the only class source there* — a hub child's own files really do
 *   come back `recordType: none` on every row (`{"none": 20}` day 16,
 *   `{"none": 28}` day 9). But `searchAlarmVideos` answers the same child in
 *   **247–306 ms** and joins to the day's files by their start stamp, so the
 *   file list carries the class too (`clip-alarm-labels.ts`).
 *
 * What is left is uniformity: one path, one grain, one way to be wrong. The
 * event view is kept and NOT WIRED (`clip-event-catalog.ts`), with
 * `clip-event-path-is-not-wired.spec.ts` standing in the way of re-wiring it
 * by accident.
 *
 * `ClipSource.via` went with it. It existed so the operator could read which
 * API answered when two cameras behaved differently; with one path it has
 * nothing to say, and a field whose only value is constant reads as a choice
 * that still exists.
 *
 * ## What the one path costs the operator
 *
 * A hub child's rows are now per FILE, not per EVENT: 20 rows where the event
 * view listed 29, because a recording holds 1–13 windows. He gains the main
 * twin on every row (the event view carried no `streams` at all, so a hub
 * child had no `high` copy to play) and loses the per-window split. The
 * per-window upgrade is `findAlarmVideo`'s own surface and is a clip DETAIL
 * question (D549 20), not a list one.
 */
import type {
  CamProfile,
  Clip,
  ClipBytes,
  ClipBytesOffer,
  ClipExportFailure,
  ClipPlayback,
  ClipSource,
  ClipSourceAvailability,
  ClipStreamDial,
  ClipStreamAudioReason,
  ClipWake,
  IScopedLogger,
  IVideoclipsProvider,
  PeerBytesTicket,
} from '@camstack/types'
import {
  CLIP_PLAYBACK_OPTIONS,
  type ClipPlaybackOptions,
  clipExportFailure,
  VIDEOCLIPS_MAX_OFFER_BYTES,
  VIDEOCLIPS_MAX_READ_BYTES,
} from '@camstack/types'
import type { CameraUid } from './clip-addressing.js'
import type { ClipStreamAudioAsk } from './clip-stream.js'
import { listableClips } from './clip-window.js'
import { chooseClipTwin, type ClipTwin } from './clip-twins.js'
import { uidIsMissing, UID_MISSING_REASON } from './clip-addressing.js'
import type { ClipCatalogCache } from './clip-catalog-cache.js'
import {
  listDayRows,
  monthsBetween,
  readDayIndex,
  readStorageState,
  type ClipMediaApi,
  type DayRecordsApi,
  type FileInfoListApi,
  type HddInfoApi,
  type ReolinkClipRow,
} from './clip-catalog.js'
import {
  CLIP_SOURCE_ONBOARD,
  clipKeyFor,
  mintClipId,
  parseClipId,
  type ReolinkClipSource,
} from './clip-identity.js'
import {
  dayNeedsAlarmLabels,
  joinAlarmLabels,
  readAlarmWindows,
  type AlarmVideoApi,
} from './clip-alarm-labels.js'
import { classifyNativeTypes } from './clip-native-types.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { enumerateWallClockDays, wallClockDayKey, type WallClockDay } from './clip-wall-clock.js'

/**
 * The one api object the device hands out. Never constructed here.
 *
 * `EventLogApi` is deliberately absent: the catalog does not read the hub's
 * event log, and leaving it in the type would let a call back in without an
 * import anyone reviews (`clip-event-path-is-not-wired.spec.ts`).
 */
export type ReolinkClipApi = HddInfoApi &
  DayRecordsApi &
  FileInfoListApi &
  ClipMediaApi &
  AlarmVideoApi

/** Everything the clip path needs to know about one camera. */
export interface ClipDeviceRef {
  readonly deviceId: number
  readonly channel: number
  /**
   * The CAMERA's own uid. On a hub this selects the child — the hub's own uid
   * addresses no catalog at all (measured: empty month over 24 months, zero
   * files, zero rows), so absent means a hub child's read cannot be addressed:
   * a dropped branch, logged as `uid-missing`. On a STANDALONE it is ignored
   * by the camera and absent is normal — 107 has none and never will. The rule
   * is `clip-addressing.ts` and lives nowhere else.
   *
   * Branded: it may only come from `resolveCameraUid`, which sees BOTH places
   * a uid is held. Reading one of them directly does not compile — 3825
   * answered `uid-missing` while holding one, because the reader believed the
   * copy frozen at adoption.
   */
  readonly uid: CameraUid | undefined
  readonly isHubChild: boolean
  readonly isBattery: boolean
  /** Believed asleep. A read NEVER changes this. */
  readonly sleeping: boolean
  /** The camera's wall clock, named explicitly and never inherited (D549 7). */
  readonly timeZone: string
  /**
   * The CoverPreview lane key — the host this camera is reached at. One hub's
   * channels share a lane, because the library's backoff is host-keyed and the
   * hub really does refuse concurrent stills across its children.
   */
  readonly hostKey: string
  /** The ONE session. Never called when a gate refuses. */
  readonly getApi: () => Promise<ReolinkClipApi>
}

export interface PreparePlaybackInput {
  readonly device: ClipDeviceRef
  readonly row: ReolinkClipRow | null
  /** The byte handle to fetch — the main twin for `high`, the sub otherwise. */
  readonly fileName: string
  readonly clipKey: string
  readonly profile: CamProfile
}

/**
 * Which of a recording's two files is being produced.
 *
 * Re-exported from `clip-twins.ts`, which owns both the type and
 * {@link chooseClipTwin} — the one function allowed to map a requested
 * profile onto a twin. Three call sites in this file used to decide it
 * independently, and they disagreed.
 */
export type { ClipTwin }

/**
 * Why a clip's bytes could not be produced — a SUBSET of the clip-export
 * vocabulary, pinned to it.
 *
 * `Extract` rather than a fresh union on purpose: the engine believes a
 * producer that speaks these words and turns anything else into
 * `fetch-failed` with the prose verbatim (D572), so a token invented here
 * would be a refusal no surface can render. The producer cannot answer
 * `catalog-miss`, `clip-in-progress`, `unsupported-option`,
 * `too-large-to-transfer` or `wake-expired` — those are decided from the
 * catalog row, above, before anything reaches a camera.
 */
export type ClipBytesRefusalCode = Extract<
  ClipExportFailure,
  'sleeping' | 'catalog-unreachable' | 'no-file-for-window' | 'camera-refused' | 'fetch-failed'
>

export interface PrepareClipBytesInput {
  readonly deviceId: number
  readonly row: ReolinkClipRow
  /** The byte handle for {@link twin} — a PATH on the camera, never a guess. */
  readonly fileName: string
  readonly twin: ClipTwin
  /**
   * The operator's authorisation to wake a sleeping standalone battery camera
   * for this one read. Absent is the default and means REFUSED by name.
   */
  readonly wake?: ClipWake
}

export type PrepareClipBytesOutcome =
  | {
      readonly kind: 'ok'
      readonly bytes: Buffer
      /** MEASURED on this pass, or `null`. Never derived from the row (D393). */
      readonly durationMs: number | null
    }
  | { readonly kind: 'refused'; readonly code: ClipBytesRefusalCode; readonly detail: string }

/**
 * What {@link ReolinkVideoclipsDeps.prepareOffer} answers.
 *
 * A TICKET rather than bytes. The cmd-5 transfer is collected in memory on
 * this vendor, so the provider still holds ONE copy — the one it already had.
 * What this removes is the base64 inflation and the SECOND copy in the caller
 * (D613): the consumer streams the ticket straight to its own file.
 */
export type PrepareClipOfferOutcome =
  | {
      readonly kind: 'ok'
      readonly ticket: PeerBytesTicket
      /** MEASURED on this pass, or `null`. Never derived from the row (D393). */
      readonly durationMs: number | null
      readonly bytes: number
    }
  | { readonly kind: 'refused'; readonly code: ClipBytesRefusalCode; readonly detail: string }

/** What a refused byte read puts on its log line, beside the branch. */
interface ClipReadMeta {
  readonly clipKey?: string
  readonly twin?: ClipTwin
  readonly declaredBytes?: number
  readonly bytes?: number
  readonly bound?: number
}

/**
 * The filename an export carries away, from the camera's own handle.
 *
 * A hub child's handle is a full path (`/mnt/sda/U10…/RecS02_….mp4`) and a
 * standalone's is a bare name, so only the last segment is a name; the
 * extension is re-stated because what we produce is an MP4 whatever the
 * camera called its file.
 */
function clipFileLabel(fileName: string): string {
  const base = fileName.split('/').at(-1) ?? fileName
  const stem = base.replace(/\.[^.]+$/, '')
  return `${stem === '' ? 'clip' : stem}.mp4`
}

export interface ReolinkVideoclipsDeps {
  readonly now: () => number
  readonly cache: ClipCatalogCache<ReolinkClipRow>
  /** `null` when this device is not a Reolink camera this addon owns. */
  resolveDevice(deviceId: number): Promise<ClipDeviceRef | null>
  /** True only when a JPEG is REALLY on disk. The vouch, never a template. */
  hasVouchedThumbnail(deviceId: number, clipKey: string): Promise<boolean>
  thumbnailUrl(deviceId: number, clipKey: string): string
  thumbnailMintUrl(deviceId: number, clipKey: string): string
  /** Slice 5: fetch + mux + publish. Returns the URL and what it served. */
  preparePlayback(input: PreparePlaybackInput): Promise<{
    readonly playbackUrl: string
    readonly served: CamProfile
  }>
  /**
   * One twin's finished MP4, in memory — the byte read a clip EXPORT pulls.
   *
   * The same producer the player uses, so there is exactly one fetch path,
   * one completion rule and one mux in this addon (D567, D568).
   */
  prepareBytes(input: PrepareClipBytesInput): Promise<PrepareClipBytesOutcome>
  /** The same clip, offered over the addon→addon byte transport (D613). */
  prepareOffer(input: PrepareClipBytesInput): Promise<PrepareClipOfferOutcome>
  /**
   * A one-shot URL for this clip's STREAM (D597), minted without touching
   * the camera. The gates the file path runs — the device, a sleeping
   * standalone, the uid — run here too, before a URL exists.
   */
  prepareStreamDial(input: PrepareStreamDialInput): Promise<PrepareStreamDialOutcome>
  readonly logger: IScopedLogger
}

export interface PrepareStreamDialInput {
  readonly deviceId: number
  readonly row: ReolinkClipRow
  /**
   * Which file to open. Either twin since D599 — the stream serves every
   * profile, and the answer states which one it carries. Named rather than
   * derived so the log line says it.
   */
  readonly twin: ClipTwin
  /**
   * Which audio codec the caller's session negotiated (D600), already
   * narrowed to what this provider can mux — `none` is a real ask and the
   * only one a caller that said nothing gets.
   */
  readonly audio: ClipStreamAudioAsk
}

export type PrepareStreamDialOutcome =
  | { readonly kind: 'ok'; readonly url: string; readonly expiresAtMs: number }
  | { readonly kind: 'refused'; readonly code: ClipBytesRefusalCode; readonly detail: string }

/** Why the LAST attempt to read a source could not answer. Per device+source. */
interface SourceHealth {
  readonly availability: ClipSourceAvailability
}

export function createReolinkVideoclipsProvider(deps: ReolinkVideoclipsDeps): IVideoclipsProvider {
  /** Last known availability per `deviceId|source`, written by every read. */
  const health = new Map<string, SourceHealth>()
  /** Every row this provider has listed, by `deviceId|clipKey`, so playback
   *  resolves the MAIN twin without re-searching the camera (D549 15). */
  const rowsByKey = new Map<string, ReolinkClipRow>()

  const healthKey = (deviceId: number, source: ReolinkClipSource): string => `${deviceId}|${source}`

  const noteHealth = (
    deviceId: number,
    source: ReolinkClipSource,
    availability: ClipSourceAvailability,
  ): void => {
    health.set(healthKey(deviceId, source), { availability })
  }

  /**
   * Read `onboard` for a window. Never throws for a gated branch — it RETURNS
   * the rows it has and records why, because a dropped branch that throws
   * takes the other source's rows with it.
   */
  const readOnboard = async (
    device: ClipDeviceRef,
    since: number,
    until: number,
  ): Promise<readonly ReolinkClipRow[]> => {
    const tags = { deviceId: device.deviceId }
    const days = enumerateWallClockDays(since, until, device.timeZone)

    // Gate BEFORE `getApi` — on a UDP battery camera the login IS the wake.
    if (device.isBattery && device.sleeping && !device.isHubChild) {
      const cached = days.flatMap((day) => deps.cache.peek(device.deviceId, day)?.clips ?? [])
      const asOf = days
        .map((day) => deps.cache.peek(device.deviceId, day)?.catalogAsOf)
        .filter((value): value is number => value !== undefined)
        .toSorted((a, b) => b - a)[0]
      deps.logger.warn('videoclips: not reading a sleeping battery camera — login is the wake', {
        tags,
        meta: {
          branch: 'sleeping',
          days: days.length,
          servedFromCache: cached.length,
        },
      })
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'sleeping',
        reason: 'A read would wake this camera; listing the catalog as it was last confirmed.',
        ...(asOf !== undefined ? { catalogAsOf: asOf } : {}),
      })
      return cached
    }

    // A uid is required by the TOPOLOGY, never universally: a standalone
    // ignores it (`clip-addressing.ts`), so demanding one here refused 592 —
    // a camera that lists 200+ clips a day — with `uid-missing`.
    if (uidIsMissing(device)) {
      deps.logger.warn('videoclips: no uid for this camera — its catalog cannot be addressed', {
        tags,
        meta: { branch: 'uid-missing', hubChild: device.isHubChild },
      })
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'unreachable',
        reason: UID_MISSING_REASON,
      })
      return []
    }

    let api: ReolinkClipApi
    try {
      api = await device.getApi()
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      deps.logger.warn('videoclips: could not reach this camera', {
        tags,
        meta: { branch: 'camera-refused', error: reason },
      })
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'unreachable',
        reason,
      })
      return []
    }

    // The cheap question first: never search a camera whose card is not there.
    const storage = await readStorageState(api)
    if (storage.state === 'absent') {
      deps.logger.info('videoclips: no SD card mounted — nothing to list', {
        tags,
        meta: { branch: 'no-storage' },
      })
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'no-storage',
        reason: 'The camera reports no mounted storage (HddInfo mount 0).',
      })
      return []
    }

    let calendar: ReadonlySet<string>
    try {
      calendar = await readDayIndex(api, {
        channel: device.channel,
        uid: device.uid,
        months: monthsBetween(since, until, device.timeZone),
      })
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      deps.logger.warn('videoclips: the day index refused', {
        tags,
        meta: { branch: 'camera-refused', error: reason },
      })
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'unreachable',
        reason,
      })
      return []
    }

    const today = wallClockDayKey(deps.now(), device.timeZone)
    const rows: ReolinkClipRow[] = []
    const emptyDays: string[] = []
    let refusal: string | undefined

    for (const day of days) {
      if (!calendar.has(day)) continue
      try {
        const entry = await deps.cache.serveAndRevalidate(
          device.deviceId,
          day,
          { closed: day !== today },
          async () => {
            const result = await listDayRows(api, {
              channel: device.channel,
              uid: device.uid,
              timeZone: device.timeZone,
              day,
            })
            // What the CAMERA answered for this day, in its own words. The
            // catalog's row count has always been logged; the newest file it
            // contains has not, and that is the number an operator disputes:
            // *"la lista mente, esistono clip recenti sicuramente"*. A day
            // whose newest file is hours old is either a quiet camera or a
            // search that stops early, and the two are indistinguishable from
            // a count (2026-09-21).
            const newest = result.rows[result.rows.length - 1] ?? result.rows[0]
            deps.logger.info('videoclips: the camera answered a day search', {
              tags,
              meta: {
                day,
                rows: result.rows.length,
                newestFile: newest?.subFileName ?? null,
                newestStartMs: newest?.startMs ?? null,
                oldestStartMs: result.rows[0]?.startMs ?? null,
                askedAtMs: Date.now(),
              },
            })
            if (result.mainSearchFailed !== undefined) {
              deps.logger.warn('videoclips: the main-stream search refused — no high twin today', {
                tags,
                meta: {
                  branch: 'camera-refused',
                  day,
                  error: result.mainSearchFailed,
                },
              })
            }
            return await labelDay(device, api, day, result.rows)
          },
        )
        if (entry.clips.length === 0) emptyDays.push(day)
        rows.push(...entry.clips)
      } catch (err: unknown) {
        refusal = err instanceof Error ? err.message : String(err)
        deps.logger.warn('videoclips: a day refused to list', {
          tags,
          meta: { branch: 'camera-refused', day, error: refusal },
        })
      }
    }

    if (refusal !== undefined && rows.length === 0) {
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'unreachable',
        reason: refusal,
      })
    } else if (emptyDays.length > 0) {
      // The camera's own calendar named these days and its own index answered
      // nothing for them. That is a defect ON the camera (108), and "no clips"
      // would be a lie about a card with 177 GB free.
      deps.logger.warn('videoclips: the calendar marks days the index will not list', {
        tags,
        meta: { branch: 'index-empty', days: emptyDays },
      })
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, indexEmpty(emptyDays))
    } else {
      noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, {
        state: 'ok',
        catalogAsOf: deps.now(),
      })
    }

    // THE WINDOW THAT WAS ASKED FOR.
    //
    // The day is the unit of WORK — it is what the camera indexes and what the
    // cache stores and revalidates — but it is not the unit of ANSWER. Until
    // now it was both: a one-hour window on 592 came back with 195 rows, 173
    // of them outside it (measured 2026-09-22), while the recorder's provider
    // honoured the same window in the same call. One camera, two sources, two
    // different answers to one question.
    //
    // Overlap, not containment (`clip-window.ts`): a clip that began at 14:59
    // and was still recording at 15:00 belongs to a 15:00 window.
    // REMEMBER every row the day really held, then answer with the listable
    // ones. The two are different questions, and collapsing them costs the
    // honest refusal: an id outlives the listing that produced it (a deep
    // link, a card drawn a minute ago, a queued export), and a row this
    // runner has forgotten comes back `catalog-miss` — "I have never heard of
    // it" — instead of `clip-in-progress`, which is the truth and is already
    // implemented. Forgetting is also what would make that branch dead code.
    for (const row of rows) rowsByKey.set(`${device.deviceId}|${row.clipKey}`, row)

    const narrowed = listableClips(rows, { since, until })
    if (narrowed.outOfWindow > 0 || narrowed.inProgress > 0) {
      // A branch that drops work says so, or the difference between "the
      // camera was quiet" and "we listed a whole day and kept an hour of it"
      // is invisible.
      deps.logger.info('videoclips: narrowed a day listing to what it can answer', {
        tags,
        meta: {
          branch: 'listing-narrowed',
          listed: rows.length,
          kept: narrowed.kept.length,
          // Two different facts about the day, counted apart: an hour asked
          // for out of a day listed, and files the camera has not closed yet.
          outOfWindow: narrowed.outOfWindow,
          inProgress: narrowed.inProgress,
          since,
          until,
        },
      })
    }
    return narrowed.kept
  }

  /**
   * Give a day's rows a class when the FILES carried none.
   *
   * The gate is what the day actually said, never what the camera is: a hub
   * child's files are `recordType: none` on every row (measured), a
   * standalone's carry `md,people,dog_cat,sched`, and a camera that changes
   * firmware changes which of those it is without this code learning a new
   * topology. The cheap question comes first (D54) — on 592 an alarm search
   * costs 8.2–9.5 s for 1 271 windows to restate labels already on the row.
   *
   * A refusal costs the LABELS and nothing else. Losing the day because its
   * class could not be read would be the upgrade destroying the thing it
   * upgrades — the same rule the MAIN search already lives by.
   */
  const labelDay = async (
    device: ClipDeviceRef,
    api: ReolinkClipApi,
    day: WallClockDay,
    rows: readonly ReolinkClipRow[],
  ): Promise<readonly ReolinkClipRow[]> => {
    const tags = { deviceId: device.deviceId }
    if (!dayNeedsAlarmLabels(rows)) return rows
    const startedAt = deps.now()
    let windows: readonly { fileName: string; alarmTypes: readonly string[] }[]
    try {
      windows = await readAlarmWindows(api, {
        channel: device.channel,
        uid: device.uid,
        timeZone: device.timeZone,
        day,
      })
    } catch (err: unknown) {
      deps.logger.warn('videoclips: the label search refused — the day lists without classes', {
        tags,
        meta: {
          branch: 'camera-refused',
          day,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return rows
    }
    const joined = joinAlarmLabels(rows, windows, device.timeZone)
    deps.logger.info('videoclips: read the classes a day of files does not carry', {
      tags,
      meta: {
        day,
        windows: windows.length,
        rows: rows.length,
        labelled: joined.matched,
        unmatchedWindows: joined.unmatchedWindows,
        elapsedMs: deps.now() - startedAt,
      },
    })
    return joined.rows
  }
  const toClip = async (
    device: ClipDeviceRef,
    source: ReolinkClipSource,
    row: ReolinkClipRow,
    catalogAsOf: number | undefined,
  ): Promise<Clip> => {
    rowsByKey.set(`${device.deviceId}|${row.clipKey}`, row)
    const classification = classifyNativeTypes(row.nativeTypes)
    const sleeping = device.isBattery && device.sleeping && !device.isHubChild
    // VOUCHED, never fabricated: a JPEG that is really on disk, or an offer,
    // or a named reason — never a URL template stamped on hope (D549 5).
    const vouched = await deps.hasVouchedThumbnail(device.deviceId, row.clipKey)

    const still = vouched
      ? { thumbnail: deps.thumbnailUrl(device.deviceId, row.clipKey) }
      : sleeping
        ? { thumbnailUnavailable: { reason: 'sleeping' as const } }
        : {
            thumbnailMint: deps.thumbnailMintUrl(device.deviceId, row.clipKey),
          }

    return {
      id: mintClipId({
        source,
        channel: row.channel,
        fileName: row.subFileName,
      }),
      source,
      kind: classification.kind,
      timeRange: { startMs: row.startMs, endMs: row.endMs },
      // The row is still being written: `endMs` stays — the mint window and
      // the byte fetch both need a bound — and this says what it is WORTH, so
      // the tile draws `Recording…` instead of a frozen 29 s (D563).
      ...(row.inProgress === true ? { inProgress: true } : {}),
      ...(classification.labels.length > 0 ? { labels: [...classification.labels] } : {}),
      ...(classification.behaviours.length > 0
        ? { behaviours: [...classification.behaviours] }
        : {}),
      ...(classification.nativeTypes.length > 0
        ? { nativeTypes: [...classification.nativeTypes] }
        : {}),
      ...still,
      ...(catalogAsOf !== undefined ? { catalogAsOf } : {}),
      supportSub: row.supportSub,
      streams: {
        sub: {
          id: mintClipId({
            source,
            channel: row.channel,
            fileName: row.subFileName,
          }),
          ...(row.subBytes !== undefined ? { bytes: row.subBytes } : {}),
        },
        ...(row.mainFileName !== undefined
          ? {
              main: {
                id: mintClipId({
                  source,
                  channel: row.channel,
                  fileName: row.mainFileName,
                }),
                ...(row.mainBytes !== undefined ? { bytes: row.mainBytes } : {}),
              },
            }
          : {}),
      },
    }
  }

  return {
    listSources: async ({ deviceId }): Promise<readonly ClipSource[]> => {
      const device = await deps.resolveDevice(deviceId)
      // Not this provider's camera. `[]` is cheap and honest — it is the
      // provider's own device knowledge doing the gating (D554 consequences).
      if (device === null) return []

      // ONE row, and no API to name on it. `onboard` and `hub` were two
      // sources for a few hours (D549 11) and then one source with two views
      // and a `via` saying which (D555); they are now one source with one
      // view, so there is nothing left for `via` to report (D565).
      return [
        {
          source: CLIP_SOURCE_ONBOARD,
          addonId: REOLINK_ADDON_ID,
          label: 'Camera storage',
          availability: await resolveAvailability(device),
        },
      ]
    },

    listClips: async ({ deviceId, since, until, limit }): Promise<readonly Clip[]> => {
      const device = await deps.resolveDevice(deviceId)
      if (device === null) return []
      const tags = { deviceId }

      // No view filter to honour. `listClips` names ONE provider now, and the
      // dispatcher has already refused the call if that provider is not this
      // one — a filter here would be a second authority over the same choice
      // (the `sources?: string[]` branch it replaced could only ever say "not
      // me", which is what the router now says first and by name).

      // ONE path, on every topology: the file list. A file IS a clip.
      const rows = await readOnboard(device, since, until)
      const asOf = health.get(healthKey(deviceId, CLIP_SOURCE_ONBOARD))?.availability.catalogAsOf
      const clips: Clip[] = await Promise.all(
        rows
          .toSorted((a, b) => b.startMs - a.startMs)
          .map((row) => toClip(device, CLIP_SOURCE_ONBOARD, row, asOf)),
      )

      const ordered = clips.toSorted((a, b) => b.timeRange.startMs - a.timeRange.startMs)
      const capped = limit !== undefined ? ordered.slice(0, limit) : ordered

      const vouched = capped.filter((c) => c.thumbnail !== undefined).length
      deps.logger.info('videoclips: listed a Reolink catalog', {
        tags,
        meta: {
          source: CLIP_SOURCE_ONBOARD,
          clips: capped.length,
          truncated: limit !== undefined && ordered.length > limit,
          unplayable: capped.filter((c) => c.playable === false).length,
          thumbsVouched: vouched,
          thumbsUnavailable: capped.length - vouched,
          availability: health.get(healthKey(deviceId, CLIP_SOURCE_ONBOARD))?.availability.state,
        },
      })

      // An empty list is an answer only when the source could ANSWER. 640
      // stores nothing and 618's own index contradicts its own calendar;
      // handing either of them back as `[]` is "this camera has no
      // recordings", which is the one sentence this whole line of work exists
      // to stop the surface from having to guess. The state is already
      // computed — it is refused by name, in the source's own words, rather
      // than flattened into an empty array that has nowhere to carry them.
      const availability = health.get(healthKey(deviceId, CLIP_SOURCE_ONBOARD))?.availability
      if (capped.length === 0 && availability !== undefined && availability.state !== 'ok') {
        deps.logger.warn('videoclips: nothing to list, and the source cannot answer', {
          tags,
          meta: {
            branch: 'refused-empty',
            state: availability.state,
            reason: availability.reason ?? null,
          },
        })
        throw new Error(
          `videoclips: device ${deviceId} listed no clips, and that is not an empty day — ` +
            `the source is "${availability.state}"` +
            (availability.reason !== undefined ? `: ${availability.reason}` : '.'),
        )
      }
      return capped
    },

    getClipPlayback: async ({ deviceId, clipId, profile }): Promise<ClipPlayback> => {
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        throw new Error(`videoclips: clip id "${clipId}" was not minted by the Reolink provider`)
      }
      const device = await deps.resolveDevice(deviceId)
      if (device === null) {
        throw new Error(`videoclips: device ${deviceId} is not a Reolink camera`)
      }
      // Gate BEFORE any api call — the login is the wake.
      if (device.isBattery && device.sleeping && !device.isHubChild) {
        throw new Error(
          `videoclips: device ${deviceId} is a standalone battery camera and is sleeping — ` +
            'fetching a clip would wake it. Use "Wake and refresh" first.',
        )
      }

      const row =
        rowsByKey.get(`${deviceId}|${clipKeyFor(parsed.channel, parsed.fileName)}`) ?? null
      // The same authority the byte read and the stream dial ask. A row this
      // node has not walked has no twin to offer, so the parsed id stands.
      const chosen =
        row === null
          ? null
          : chooseClipTwin(profile, {
              subFileName: row.subFileName,
              ...(row.mainFileName !== undefined ? { mainFileName: row.mainFileName } : {}),
            })
      const fileName = chosen === null || chosen.fileName === '' ? parsed.fileName : chosen.fileName

      const prepared = await deps.preparePlayback({
        device,
        row,
        fileName,
        clipKey: clipKeyFor(parsed.channel, parsed.fileName),
        profile: chosen?.served ?? 'low',
      })
      return {
        playbackUrl: prepared.playbackUrl,
        format: 'mp4',
        served: prepared.served,
      }
    },

    /**
     * This clip's BYTES, base64, bounded — the producing half of a clip
     * export (D558 § 3, D572).
     *
     * ## What it refuses, and in whose words
     *
     * Every exit throws `clipExportFailure(<token>, <prose>)`. The engine
     * recovers the token with `clipExportFailureOf` and BELIEVES it; anything
     * that does not parse becomes `fetch-failed` with the prose kept verbatim.
     * So a refusal this side can name is named here — a `sleeping` that
     * arrives as prose is a `sleeping` the modal cannot render.
     *
     * ## The order of the questions, and why it is this order
     *
     * The cheap ones come first and none of them touches the camera: the id,
     * the row, whether the file is still being written, which twin exists, and
     * the SIZE the catalog already declared for it. A main twin over the bound
     * is refused for nothing — no session, no transfer, no mux — which is the
     * rule bulk work over stored media already follows (D54). Only then does
     * `prepareBytes` reach a camera, behind the sleep gate that has to sit in
     * front of the login.
     *
     * ## `high` against a 50 MiB ceiling
     *
     * A missing main twin is a DIVERGENCE, not a refusal: the sub is served
     * and `served` says `low`, exactly as the player does (D549 15), because
     * 17 of 546 clips on 592 have no main copy and an export of the copy that
     * exists beats no export. A main twin that exists and is too BIG is the
     * other case and is refused by name — the cap's own docblock settles it
     * ("above the bound the provider REFUSES with the size in the message,
     * never truncates"), the operator keeps the unbounded playback route for
     * that file, and the chunked read the cap names is what removes the
     * refusal rather than a silent 33× quality substitution.
     */
    readClipBytes: async ({ deviceId, clipId, profile, maxBytes, wake }): Promise<ClipBytes> => {
      const tags = { deviceId }
      const refuse = (code: ClipExportFailure, detail: string, meta: ClipReadMeta): never => {
        deps.logger.warn('videoclips: refusing a clip byte read', {
          tags,
          meta: { clipId, branch: code, ...meta },
        })
        throw new Error(clipExportFailure(code, detail))
      }

      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Reolink provider`,
          {},
        )
      }
      const clipKey = clipKeyFor(parsed.channel, parsed.fileName)
      const row = rowsByKey.get(`${deviceId}|${clipKey}`)
      if (row === undefined) {
        // From cold — a redeploy, a restart, a runner that has listed another
        // day — this provider holds no row for the clip, and a file name is a
        // path on the camera: there is nothing to guess and nothing to widen
        // the search to. `catalog-miss` is the honest answer and the engine
        // has already listed the day once (D572), so it is also a rare one.
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${deviceId} — ` +
            'list the day that holds it first',
          { clipKey },
        )
      }
      if (row.inProgress === true) {
        // Its `endMs` is a frozen guess (D563), so the fetch has nothing true
        // to prove its own completion against (D568).
        return refuse(
          'clip-in-progress',
          `clip "${clipId}" is still being written, so it has no end to export`,
          { clipKey },
        )
      }

      // Which twin, and what it would COST — both from the row, before the
      // camera is touched at all.
      const chosen = chooseClipTwin(profile, row)
      if (chosen.downgraded) {
        deps.logger.warn('videoclips: no main twin for this clip — serving the sub copy', {
          tags,
          meta: { clipId, clipKey, branch: 'no-main-twin', asked: profile },
        })
      }
      const twin = chosen.twin
      const fileName = chosen.fileName
      if (fileName === '') {
        return refuse(
          'no-file-for-window',
          `clip "${clipId}" is listed with no byte handle behind it`,
          { clipKey, twin },
        )
      }
      const served: CamProfile = chosen.served
      // The caller's bound, capped by the ceiling whatever it passes: the
      // envelope is unary, so the payload is held whole in the provider AND in
      // the caller on a hub this repo has already OOM'd (D9/D18).
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_READ_BYTES, VIDEOCLIPS_MAX_READ_BYTES)
      const declaredBytes = twin === 'main' ? row.mainBytes : row.subBytes
      if (declaredBytes !== undefined && declaredBytes > bound) {
        // The number is the CAMERA'S listed file size, and it is named as such
        // because it is not the size we would deliver: a remux drops the
        // container, the index and any track we refuse to copy, and the
        // delivered file measured 58–81 % of the listed size on every clip
        // this fleet has produced. So this gate refuses some clips that would
        // have fitted (11.3 % of 592's main twins sit in that band) and it is
        // still the right gate: the alternative is pulling up to 175 MB over
        // the ONE session every other read on that camera shares, base64-ing
        // it, and refusing anyway — on a hub this repo has already OOM'd
        // (D9/D18, D576).
        return refuse(
          'too-large-to-transfer',
          `the camera lists the ${twin} file of clip "${clipId}" as ${declaredBytes} bytes, ` +
            `over the ${bound}-byte bound for an inline read — play it from its playback ` +
            'URL instead',
          { clipKey, twin, declaredBytes, bound },
        )
      }

      const outcome = await deps.prepareBytes({
        deviceId,
        row,
        fileName,
        twin,
        ...(wake !== undefined ? { wake } : {}),
      })
      if (outcome.kind === 'refused') {
        // Already logged, with its branch, by the producer.
        throw new Error(clipExportFailure(outcome.code, outcome.detail))
      }
      if (outcome.bytes.byteLength > bound) {
        // The row under-declares: the listed size has never matched the
        // received byte count on any clip measured (D568). Half a video is
        // worse than an honest refusal, so the file is dropped, not truncated.
        return refuse(
          'too-large-to-transfer',
          `clip "${clipId}" muxed to ${outcome.bytes.byteLength} bytes, over the ` +
            `${bound}-byte bound for an inline read`,
          { clipKey, twin, bytes: outcome.bytes.byteLength, bound },
        )
      }

      deps.logger.info('videoclips: served a Reolink clip inline', {
        tags,
        meta: {
          clipId,
          clipKey,
          twin,
          served,
          asked: profile ?? null,
          bytes: outcome.bytes.byteLength,
          durationMs: outcome.durationMs,
          wake: wake ?? 'none',
        },
      })
      return {
        base64: outcome.bytes.toString('base64'),
        contentType: 'video/mp4',
        name: clipFileLabel(fileName),
        bytes: outcome.bytes.byteLength,
        served,
        // Absent when nothing measured it — never zero, which would say the
        // file is empty, and never the row's span, which is a projection.
        ...(outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
      }
    },

    /**
     * The same clip, over the addon→addon byte transport (D613).
     *
     * Every gate {@link readClipBytes} runs, in the same order and with the
     * same vocabulary — the id, the row, a clip still being written, the twin,
     * the size the ROW declares, and the sleep gate, which the producer
     * decides before `getApi()` because on UDP the login IS the wake. The one
     * difference is the envelope: the bytes leave over a one-shot loopback
     * socket instead of inside a base64 field, so the caller holds nothing and
     * this process holds the one copy the cmd-5 transfer already produced.
     *
     * The bound is {@link VIDEOCLIPS_MAX_OFFER_BYTES}: ten times the inline
     * one, because the inline one was paying for two inflated copies and this
     * pays for one plain one.
     */
    offerClipBytes: async ({
      deviceId,
      clipId,
      profile,
      maxBytes,
      wake,
    }): Promise<ClipBytesOffer> => {
      const tags = { deviceId }
      const refuse = (code: ClipExportFailure, detail: string, meta: ClipReadMeta): never => {
        deps.logger.warn('videoclips: refusing a clip byte offer', {
          tags,
          meta: { clipId, branch: code, ...meta },
        })
        throw new Error(clipExportFailure(code, detail))
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Reolink provider`,
          {},
        )
      }
      const clipKey = clipKeyFor(parsed.channel, parsed.fileName)
      const row = rowsByKey.get(`${deviceId}|${clipKey}`)
      if (row === undefined) {
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${deviceId} — ` +
            'list the day that holds it first',
          { clipKey },
        )
      }
      if (row.inProgress === true) {
        return refuse(
          'clip-in-progress',
          `clip "${clipId}" is still being written, so it has no end to export`,
          { clipKey },
        )
      }
      const chosen = chooseClipTwin(profile, row)
      if (chosen.downgraded) {
        deps.logger.warn('videoclips: no main twin for this clip — serving the sub copy', {
          tags,
          meta: { clipId, clipKey, branch: 'no-main-twin', asked: profile },
        })
      }
      const twin = chosen.twin
      const fileName = chosen.fileName
      if (fileName === '') {
        return refuse(
          'no-file-for-window',
          `clip "${clipId}" is listed with no byte handle behind it`,
          { clipKey, twin },
        )
      }
      const served: CamProfile = chosen.served
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_OFFER_BYTES, VIDEOCLIPS_MAX_OFFER_BYTES)
      const declaredBytes = twin === 'main' ? row.mainBytes : row.subBytes
      if (declaredBytes !== undefined && declaredBytes > bound) {
        return refuse(
          'too-large-to-transfer',
          `the camera lists the ${twin} file of clip "${clipId}" as ${declaredBytes} bytes, ` +
            `over the ${bound}-byte bound for one transfer`,
          { clipKey, twin, declaredBytes, bound },
        )
      }
      const outcome = await deps.prepareOffer({
        deviceId,
        row,
        fileName,
        twin,
        ...(wake !== undefined ? { wake } : {}),
      })
      if (outcome.kind === 'refused') {
        // Already logged, with its branch, by the producer.
        throw new Error(clipExportFailure(outcome.code, outcome.detail))
      }
      if (outcome.bytes > bound) {
        // The row under-declares: the listed size has never matched the
        // received byte count on any clip measured (D568). The offer is
        // dropped rather than handing over a body nobody may keep.
        return refuse(
          'too-large-to-transfer',
          `clip "${clipId}" muxed to ${outcome.bytes} bytes, over the ` +
            `${bound}-byte bound for one transfer`,
          { clipKey, twin, bytes: outcome.bytes, bound },
        )
      }
      deps.logger.info('videoclips: offered a Reolink clip by handle', {
        tags,
        meta: {
          clipId,
          clipKey,
          twin,
          served,
          asked: profile ?? null,
          bytes: outcome.bytes,
          durationMs: outcome.durationMs,
          wake: wake ?? 'none',
        },
      })
      return {
        ticket: outcome.ticket,
        contentType: 'video/mp4',
        name: clipFileLabel(fileName),
        served,
        ...(outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
      }
    },

    /**
     * What a surface may DRAW for this camera's clips (D612).
     *
     * A CONSTANT, and it has to be: this method is asked per camera, and the
     * answer is a fact about which accessors this provider wires, not about
     * the camera. Every clip here reaches the player over
     * {@link dialClipStream}'s forward-only stream, so every clip gets the
     * `stream` envelope — measured, not assumed: the broker's `chooseClipPath`
     * reads only whether the dial and the file read are wired, and never the
     * clip or the profile.
     *
     * The rates are the BROKER's re-pacing ladder, and they are the only
     * rates there are. The camera's own `<playSpeed>` is NOT a second rate
     * mechanism waiting to be wired — measured on 592, 2026-09-23 (D620):
     * at 1, 2, 4 and 8 it returns a byte-identical transfer (947 472 B, 594
     * access units, the same 39.855 s presentation span, the same 624 AAC
     * frames) and changes only how fast those bytes cross. It buys SUPPLY,
     * never speed. `playSpeed 16` is not a rate either: the camera switches
     * to one frame per GOP across the whole clip (20 units, 2 025 ms apart,
     * no audio) — a different STREAM, dialled as one, never a rate applied to
     * this one.
     *
     * So 8x and 16x do not arrive here. They arrive when the broker's pacer
     * is allowed above 4 (`clampPlaybackRate`, the `setRate` bound and
     * `CLIP_BROKER_PACED_RATES`, together) — and only once the supply behind
     * them is real: D620 measured this camera delivering at 1.2–1.37x while
     * the library positions every replay with cmd 123, against 95–116x when
     * it does not. A ladder widened before that is a rate accepted and not
     * delivered, which is the whole defect D612 exists to end.
     */
    getPlaybackOptions: async (): Promise<ClipPlaybackOptions> => CLIP_PLAYBACK_OPTIONS.stream,

    /**
     * Where this clip's STREAM is dialled (D597) — the same questions
     * `readClipBytes` asks before the camera is touched (the id, the row, a
     * file still being written), the same vocabulary, and NO fetch: the URL
     * is one shot on the provider's own listener and the camera is opened
     * when the broker dials it.
     *
     * It serves EVERY profile, through the same {@link chooseClipTwin} the
     * byte read asks (D599). It used to refuse `high` by name, on the grounds
     * that handing a sub copy to a `high` ask is the silent 33× substitution
     * D576 forbids — true, but the refusal was not the cure. The cure is
     * `served`, which is on this answer and states which twin the stream
     * actually carries. Refusing left the operator with `high` looking
     * unsupported, and left two transports behind one pointer.
     */
    dialClipStream: async ({ deviceId, clipId, profile, audio }): Promise<ClipStreamDial> => {
      const tags = { deviceId }
      const refuse = (code: ClipExportFailure, detail: string, meta: ClipReadMeta): never => {
        deps.logger.warn('videoclips: refusing a clip stream dial', {
          tags,
          meta: { clipId, branch: code, ...meta },
        })
        throw new Error(clipExportFailure(code, detail))
      }
      const parsed = parseClipId(clipId)
      if (parsed === null) {
        return refuse(
          'catalog-miss',
          `clip id "${clipId}" was not minted by the Reolink provider`,
          {},
        )
      }
      const clipKey = clipKeyFor(parsed.channel, parsed.fileName)
      const row = rowsByKey.get(`${deviceId}|${clipKey}`)
      if (row === undefined) {
        return refuse(
          'catalog-miss',
          `clip "${clipId}" is not in this node's catalog for device ${deviceId} — ` +
            'list the day that holds it first',
          { clipKey },
        )
      }
      if (row.inProgress === true) {
        return refuse(
          'clip-in-progress',
          `clip "${clipId}" is still being written; it has no end to stream to`,
          { clipKey },
        )
      }
      const chosen = chooseClipTwin(profile, row)
      if (chosen.downgraded) {
        deps.logger.warn('videoclips: no main twin for this clip — streaming the sub copy', {
          tags,
          meta: { clipId, clipKey, branch: 'no-main-twin', asked: profile },
        })
      }
      if (chosen.fileName === '') {
        return refuse(
          'no-file-for-window',
          `clip "${clipId}" is listed with no byte handle behind it`,
          {
            clipKey,
            twin: chosen.twin,
          },
        )
      }
      // An ask this provider cannot mux is refused BY NAME on the answer, not
      // silently downgraded — the audio shape of `served` (D600). Absent is
      // `none` (D382: an unstated ask is zero), which is what a broker older
      // than the field sends, and it keeps the video-only stream it had.
      const askedAudio: ClipStreamAudioAsk = audio ?? 'none'
      const audioReason: ClipStreamAudioReason | null =
        askedAudio === 'none' ? 'not-requested' : null
      const outcome = await deps.prepareStreamDial({
        deviceId,
        row,
        twin: chosen.twin,
        audio: askedAudio,
      })
      if (outcome.kind === 'refused') {
        return refuse(outcome.code, outcome.detail, { clipKey, twin: chosen.twin })
      }
      return {
        url: outcome.url,
        expiresAtMs: outcome.expiresAtMs,
        transport: 'forward-only',
        // What the stream WILL carry, not what was asked. This is the whole
        // reason the dial no longer has to refuse `high`.
        served: chosen.served,
        // The codec, promised. Whether the RECORDING has sound is not knowable
        // before its first audio frame arrives, so that answer is in the
        // stream's own `moov` and the broker reads it there.
        servedAudio: askedAudio,
        ...(audioReason !== null ? { audioReason } : {}),
      }
    },
  }

  /**
   * What a source is saying right now — MEASURED, never defaulted.
   *
   * A listing that already ran is the better answer and wins: `listClips`
   * asked the whole window and this probe asks one day, so re-deciding from
   * the narrower question would throw away 618's other nineteen empty days.
   * With nothing established, the probe runs — and `ok` is only ever returned
   * because something was really read.
   *
   * ## What it costs, per call, and why
   *
   * This used to answer `ok` after at most one storage command, and `ok` is
   * the one state whose list may be read as complete. On the live hub, on the
   * cold runners a deploy had just produced, that default made 640 (no SD
   * card) and 618 (an index that lists nothing for days its own calendar
   * marks) both answer `ok` and then an empty list — the exact lie this line
   * of work exists to end. So `listSources` pays for its answer:
   *
   * - **a standalone battery camera: NOTHING, ever.** No `getApi`, no command,
   *   not even the cheap one — on UDP the login IS the wake. `sleeping`, with
   *   the age of whatever is cached. The gate is `isBattery`, never the
   *   BELIEF `sleeping`: that belief is `state.battery.sleeping ?? false`, so
   *   a slice that has not restored reads as awake, and a probe on it is a
   *   wake nobody asked for.
   * - **a hub child: one `getDayRecords` through the parent's existing socket**
   *   (65 ms measured on 3628). The child never hears it; the storage question
   *   is the HUB's and is not asked.
   * - **a mains standalone: `getHddInfoList` (ms) + `getDayRecords`
   *   (38 ms–1.9 s) + ONE day listing of the NEWEST day the calendar claims**
   *   (0.3–6 s, and cache-backed — `serveAndRevalidate`, so a day already
   *   listed costs nothing and a day listed here is free for the `listClips`
   *   that follows). The day listing is what distinguishes `index-empty` from
   *   `ok`, and nothing cheaper can: `no-storage` is the cheap question and it
   *   comes first precisely so a camera with no card never pays the rest.
   *
   * The calendar is read for the CURRENT month only. A picker asks "can this
   * source answer", not "what does it hold since April", and the measured
   * defect (618) is in the month the operator is looking at.
   */
  async function resolveAvailability(device: ClipDeviceRef): Promise<ClipSourceAvailability> {
    const known = health.get(healthKey(device.deviceId, CLIP_SOURCE_ONBOARD))?.availability
    if (known !== undefined) return known
    const availability = await probeAvailability(device)
    noteHealth(device.deviceId, CLIP_SOURCE_ONBOARD, availability)
    return availability
  }

  async function probeAvailability(device: ClipDeviceRef): Promise<ClipSourceAvailability> {
    const tags = { deviceId: device.deviceId }

    // A standalone battery camera is never asked. Its state is what was last
    // CONFIRMED, with the age; a camera nobody may reach has no `ok` to give.
    if (device.isBattery && !device.isHubChild) {
      const asOf = newestCachedAsOf(device.deviceId)
      deps.logger.warn('videoclips: not probing a standalone battery camera — login is the wake', {
        tags,
        meta: {
          branch: 'sleeping',
          believedSleeping: device.sleeping,
          confirmedAt: asOf,
        },
      })
      return {
        state: 'sleeping',
        reason:
          asOf === undefined
            ? 'A read would wake this standalone battery camera. Nothing has been confirmed yet.'
            : 'A read would wake this standalone battery camera; showing the catalog as last confirmed.',
        ...(asOf !== undefined ? { catalogAsOf: asOf } : {}),
      }
    }

    // A uid is required by the TOPOLOGY, never universally: a standalone
    // ignores it (`clip-addressing.ts`), so demanding one here refused 592.
    if (uidIsMissing(device)) {
      deps.logger.warn('videoclips: no uid for this camera — its catalog cannot be addressed', {
        tags,
        meta: { branch: 'uid-missing', probe: true },
      })
      return { state: 'unreachable', reason: UID_MISSING_REASON }
    }

    let api: ReolinkClipApi
    try {
      api = await device.getApi()
    } catch (err: unknown) {
      return unreachableFrom(device, 'camera-refused', err)
    }

    // The cheap question first, and only where the storage is the CAMERA's: a
    // hub child's footage lives on the parent's disk and the child's HddInfo
    // says nothing about it.
    if (!device.isHubChild) {
      const storage = await readStorageState(api)
      if (storage.state === 'absent') {
        deps.logger.info('videoclips: no SD card mounted — nothing to list', {
          tags,
          meta: { branch: 'no-storage', probe: true },
        })
        return {
          state: 'no-storage',
          reason: 'The camera reports no mounted storage (HddInfo mount 0).',
        }
      }
      // D393: a measurement that FAILED is not a measurement. Folding an
      // unreadable `HddInfo` into "the card is fine" is how a camera with no
      // card answers `ok` — and the first command after a login racing the
      // socket is measured on this fleet, not hypothetical.
      if (storage.state === 'unknown') {
        deps.logger.warn('videoclips: the storage question was not answered', {
          tags,
          meta: {
            branch: 'camera-refused',
            probe: true,
            error: storage.reason ?? null,
          },
        })
        return {
          state: 'unreachable',
          reason:
            storage.reason ??
            'The camera did not answer the storage question (HddInfo unreadable).',
        }
      }
    }

    const today = wallClockDayKey(deps.now(), device.timeZone)
    let calendar: ReadonlySet<string>
    try {
      calendar = await readDayIndex(api, {
        channel: device.channel,
        uid: device.uid,
        months: [{ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }],
      })
    } catch (err: unknown) {
      return unreachableFrom(device, 'camera-refused', err)
    }

    const claimed = [...calendar].toSorted().toReversed()
    // The camera itself says it holds nothing this month. That IS a complete
    // answer — an ordinary quiet camera, not a broken one.
    if (claimed.length === 0) return { state: 'ok', catalogAsOf: deps.now() }

    // A hub child gets the day listing too, now that its catalog IS the file
    // list: it has an index of its own that can contradict its own calendar,
    // and nothing cheaper than one listing can tell `index-empty` from `ok`.
    // It costs 137–514 ms through the parent's existing socket, and it is
    // cache-backed, so the `listClips` behind it gets that day free.
    const newest = claimed[0]
    if (newest === undefined) return { state: 'ok', catalogAsOf: deps.now() }
    try {
      await deps.cache.serveAndRevalidate(
        device.deviceId,
        newest,
        { closed: newest !== today },
        async () =>
          (
            await listDayRows(api, {
              channel: device.channel,
              uid: device.uid,
              timeZone: device.timeZone,
              day: newest,
            })
          ).rows,
      )
    } catch (err: unknown) {
      return unreachableFrom(device, 'camera-refused', err)
    }

    // Every day the CALENDAR claims that the INDEX has been asked about and
    // answered nothing for. Cold that is one day; after a `listClips` it is
    // every day of that window, which is why the cache and not a local
    // variable is the memory here.
    const emptyClaimed = claimed.filter(
      (day) => deps.cache.peek(device.deviceId, day)?.clips.length === 0,
    )
    if (emptyClaimed.length > 0) {
      deps.logger.warn('videoclips: the calendar marks days the index will not list', {
        tags,
        meta: { branch: 'index-empty', probe: true, days: emptyClaimed },
      })
      return indexEmpty(emptyClaimed)
    }
    return { state: 'ok', catalogAsOf: deps.now() }
  }

  function unreachableFrom(
    device: ClipDeviceRef,
    branch: string,
    err: unknown,
  ): ClipSourceAvailability {
    const reason = err instanceof Error ? err.message : String(err)
    deps.logger.warn('videoclips: the source could not be probed', {
      tags: { deviceId: device.deviceId },
      meta: { branch, probe: true, error: reason },
    })
    return { state: 'unreachable', reason }
  }

  /** When any day of this device's catalog was last confirmed, newest first. */
  function newestCachedAsOf(deviceId: number): number | undefined {
    let newest: number | undefined
    for (const day of deps.cache.daysHeld(deviceId)) {
      const asOf = deps.cache.peek(deviceId, day)?.catalogAsOf
      if (asOf !== undefined && (newest === undefined || asOf > newest)) newest = asOf
    }
    return newest
  }

  /** The one wording for "the camera's calendar and its own index disagree". */
  function indexEmpty(days: readonly string[]): ClipSourceAvailability {
    return {
      state: 'index-empty',
      reason:
        `The camera’s calendar marks ${days.length} day(s) with footage that its own ` +
        `index lists no files for: ${days.join(', ')}.`,
      catalogAsOf: deps.now(),
    }
  }
}
