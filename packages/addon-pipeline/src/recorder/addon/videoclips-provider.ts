/**
 * Default `videoclips` provider — composes recorded footage visits with the
 * analytics event log. A clip is a time-WINDOW over existing footage, never a
 * separate file: `getClipPlayback` resolves to
 * `recording.getPlaybackManifest(startMs, endMs)`.
 *
 * When availability is present the grain is a *visit* (events-mode keep-window
 * clustered at `VISIT_MERGE_GAP_MS`), not one clip per motion heartbeat. The
 * clip id still encodes the window (`analytics:<startMs>:<endMs>:visit`) so
 * playback is self-contained. Without availability (or when that read fails)
 * the provider falls back to per-event padded windows.
 *
 * Pure helpers (`eventsToClips` / `clusterFootageVisits` / `clipIdFor` /
 * `parseClipId`) are unit-tested in isolation; the provider factory wires
 * injected fetch/resolve deps so the compose logic is testable without I/O.
 */
import {
  type Clip,
  type ClipPlayback,
  EVENT_OWNER_TYPES,
  type IVideoclipsProvider,
  VISIT_MERGE_GAP_MS,
} from '@camstack/types'
import { applyQuietKinds } from './clip-quiet-kinds.js'
import { clusterEventVisits, clusterFootageVisits, visitsToClips } from './videoclip-visits.js'
import type {
  ClipPad,
  EventBuckets,
  EventLike,
  FootageRange,
  MediaOwnersQuery,
  VouchedEventIds,
} from './videoclips-shared.js'

export type {
  ClipPad,
  EventBuckets,
  EventLike,
  FootageRange,
  MediaOwnerKind,
  MediaOwnersQuery,
  VouchedEventIds,
} from './videoclips-shared.js'

const SOURCE = 'analytics'

/** The addon that registers this provider — stamped on its source row. */
const CLIP_SOURCE_ADDON_ID = 'recorder'

/**
 * Backstop on the ANNOTATION read — never on the clip list.
 *
 * A visit is annotated by every event inside it, so the clip `limit` must not
 * reach this fetch (one 101 visit legitimately spans 2 345 motion rows). This
 * bound exists only so a pathological camera-day cannot pull an unbounded page:
 * the store orders `timestamp DESC`, so a truncation drops the OLDEST rows and
 * the EARLIEST visits silently lose their annotations — which is why hitting it
 * is logged, per camera, rather than absorbed.
 */
export const VISIT_EVENT_FETCH_LIMIT = 5_000

export function clipIdFor(eventId: string, startMs: number, endMs: number): string {
  return `${SOURCE}:${startMs}:${endMs}:${eventId}`
}

export interface ParsedClipId {
  readonly eventId: string
  readonly startMs: number
  readonly endMs: number
}

/** Parse a default-provider clip id back into its window + event id. Returns
 *  `null` for any id this provider did not mint (e.g. a native clip id). */
export function parseClipId(clipId: string): ParsedClipId | null {
  const parts = clipId.split(':')
  if (parts.length < 4 || parts[0] !== SOURCE) return null
  const startMs = Number(parts[1])
  const endMs = Number(parts[2])
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  const eventId = parts.slice(3).join(':')
  if (!eventId) return null
  return { eventId, startMs, endMs }
}

/** Map per-kind events into time-ranged clips, newest-first. Pure. */
export function eventsToClips(
  events: EventBuckets,
  pad: ClipPad,
  vouched: VouchedEventIds,
): Clip[] {
  const make = (e: EventLike, kind: 'motion' | 'object' | 'audio'): Clip => {
    const startMs = e.timestamp - pad.preMs
    const endMs = e.timestamp + pad.postMs
    return {
      id: clipIdFor(e.id, startMs, endMs),
      source: SOURCE,
      kind,
      timeRange: { startMs, endMs },
      // Recording clip: this event IS the interval's main event. Thumbnail is
      // its analytics still, never a frame pulled from the fMP4 — and only
      // when the media index vouched for it (`mediaUrl` is a template stamp,
      // not evidence).
      ...(e.mediaUrl !== undefined && vouched.has(e.id) ? { thumbnail: e.mediaUrl } : {}),
      // No `stillAtMs`: this window is padded around an event, not carved out
      // of availability. Promising a recorded still here would 204 on exactly
      // the cameras that have no footage.
    }
  }
  const all = [
    ...events.motion.map((e) => make(e, 'motion')),
    ...events.object.map((e) => make(e, 'object')),
    ...events.audio.map((e) => make(e, 'audio')),
  ]
  return all.toSorted((a, b) => b.timeRange.startMs - a.timeRange.startMs)
}

/** Injected deps so the provider is decoupled from the addon + testable. */
export interface VideoclipsProviderDeps {
  readonly defaultPad: ClipPad
  fetchEvents(input: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
    readonly limit?: number
  }): Promise<EventBuckets>
  /** Recorded ranges for the query window. Optional: when absent, no footage
   *  filter is applied (legacy behaviour). */
  fetchAvailability?(input: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
  }): Promise<readonly FootageRange[]>
  /**
   * Which of these owners actually hold ≥ 1 media row — an INDEX read, never a
   * blob read, batched once per owner kind (§7.2 P2). REQUIRED, not optional:
   * a provider wired without it would silently stop vouching, and this cap has
   * already shipped one unverifiable claim.
   *
   * MUST throw rather than answer partially. A probe that under-reports reads
   * as "these events own nothing" and drops live thumbnails.
   */
  fetchMediaOwners(input: MediaOwnersQuery): Promise<ReadonlySet<string>>
  /** Surface a failed read or a truncated fetch — the LIST always fails OPEN (a
   *  fallible read must never empty a surface), but the degradation is logged
   *  with `deviceId` so it can be asked per camera. */
  logWarn?(message: string, meta: Record<string, unknown>): void
  /** Per-call counters for work that produced nothing to draw (§3.5). */
  logInfo?(message: string, meta: Record<string, unknown>): void
  resolvePlayback(input: {
    readonly deviceId: number
    readonly startMs: number
    readonly endMs: number
  }): Promise<ClipPlayback>
}

/** Every event in the three buckets, in the order the composers tag them. */
function allEvents(events: EventBuckets): EventLike[] {
  return [...events.motion, ...events.object, ...events.audio]
}

/** Every id in the three buckets, in the order the composers tag them. */
function allEventIds(events: EventBuckets): string[] {
  return allEvents(events).map((e) => e.id)
}

/**
 * Resolve the event ids whose `mediaUrl` is backed by real bytes, mirroring
 * `resolveDefaultEventMedia`: the event's OWN media when it has any, else its
 * owning TRACK's. Up to four batched index reads — one PER EVENT KIND that has
 * any ids (D476: `motion` / `object` / `audio` are separate owner kinds now,
 * so a single combined read can no longer ask "does any of these ids own
 * media" — a motion id and an object id can be the same number post-D474 and
 * are answered by different rows) — plus the track fallback, only over the
 * object events the first pass did not already answer for (motion and audio
 * are trackless roots, so they never need it).
 *
 * THROWS on a failed read. The caller fails closed on the CLAIM and open on the
 * LIST; swallowing here would collapse those two opposite directions into one.
 */
async function resolveVouchedEvents(
  deviceId: number,
  events: EventBuckets,
  fetchMediaOwners: (input: MediaOwnersQuery) => Promise<ReadonlySet<string>>,
): Promise<VouchedEventIds> {
  const ownMedia = new Set<string>()
  for (const ownerType of EVENT_OWNER_TYPES) {
    const ownerIds = events[ownerType].map((e) => e.id)
    if (ownerIds.length === 0) continue
    const found = await fetchMediaOwners({ deviceId, ownerKind: ownerType, ownerIds })
    for (const id of found) ownMedia.add(id)
  }

  const residualTracks: string[] = []
  const seenTracks = new Set<string>()
  for (const event of events.object) {
    const trackId = event.trackId
    if (trackId === undefined || ownMedia.has(event.id) || seenTracks.has(trackId)) continue
    seenTracks.add(trackId)
    residualTracks.push(trackId)
  }
  const trackMedia =
    residualTracks.length === 0
      ? new Set<string>()
      : await fetchMediaOwners({ deviceId, ownerKind: 'track', ownerIds: residualTracks })

  const vouched = new Set<string>(ownMedia)
  for (const event of events.object) {
    const trackId = event.trackId
    if (trackId !== undefined && trackMedia.has(trackId)) vouched.add(event.id)
  }
  return vouched
}

/** Keep only clips that actually touch the caller's window. The reads are
 *  widened by {@link leftOverhangMs}; the ANSWER is not. */
function intersectsWindow(clip: Clip, since: number, until: number): boolean {
  return clip.timeRange.startMs < until && clip.timeRange.endMs > since
}

/**
 * How far BEFORE `since` the event + availability reads must reach.
 *
 * A visit straddling `since` keeps its heartbeat rows and loses the transition
 * row — the only one that ever carries a snapshot — so the same visit shows a
 * picture or doesn't depending on where the operator scrolled. One wider range
 * scan on an indexed column buys a list that stops changing under the cursor.
 */
export function leftOverhangMs(pad: ClipPad): number {
  // Derived from the pad, like the merge grain itself (D583). The furthest
  // event that can still join a visit inside the window sits one GRAIN before
  // the first in-window event, and its own padded window opens `preMs` before
  // that. Left on `VISIT_MERGE_GAP_MS` this would have been a constant nothing
  // else consults any more — a number whose meaning had quietly expired.
  return pad.preMs + pad.postMs + pad.preMs
}

/** No events at all — what the degraded branch annotates its visits with. */
const NO_EVENTS: EventBuckets = { motion: [], object: [], audio: [] }

export function createVideoclipsProvider(deps: VideoclipsProviderDeps): IVideoclipsProvider {
  /**
   * Cameras whose LAST `listClips` could not read the analytics event log, with
   * the refusal verbatim.
   *
   * Not a cache of anybody else's fact (D224): it is this provider reporting
   * what IT just did, refreshed on the same call that produces it and cleared
   * by the next read that succeeds. `listSources` has no window argument and
   * must not go and ask again — an extra events read on the listing path would
   * be a second, disagreeing answer to the question `listClips` already
   * answered.
   */
  const eventsUnreachable = new Map<number, string>()

  return {
    listClips: async ({ deviceId, since, until, limit }) => {
      const readSince = since - leftOverhangMs(deps.defaultPad)
      // Visit clustering needs the full event set for annotations; `limit`
      // applies to the number of *clips* returned, not to the heartbeats
      // inside a visit. The per-event fallback still forwards limit because
      // there clip count === event count.
      let events: EventBuckets
      try {
        events = await deps.fetchEvents({
          deviceId,
          since: readSince,
          until,
          limit: deps.fetchAvailability ? VISIT_EVENT_FETCH_LIMIT : limit,
        })
      } catch (err: unknown) {
        return await listWithoutEvents(deps, eventsUnreachable, errMessage(err), {
          deviceId,
          since,
          until,
          readSince,
          limit,
        })
      }
      eventsUnreachable.delete(deviceId)
      warnOnTruncatedFetch(deps, deviceId, events)

      // Fail CLOSED on the claim: a presence read that failed cannot license a
      // `thumbnail`. Fail OPEN on the list: the clips still ship.
      let vouched: VouchedEventIds = new Set<string>()
      try {
        vouched = await resolveVouchedEvents(deviceId, events, deps.fetchMediaOwners)
      } catch (err: unknown) {
        deps.logWarn?.('videoclips: media presence read failed — listing without thumbnails', {
          deviceId,
          events: allEventIds(events).length,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      let clips = eventsToClips(events, deps.defaultPad, vouched)
      if (deps.fetchAvailability) {
        try {
          const ranges = await deps.fetchAvailability({ deviceId, since: readSince, until })
          // The visit is a burst of EVENTS clamped to the footage behind it —
          // not a stretch of recording. Clustering the availability assumed an
          // events-mode camera, where the writer opens and closes around
          // activity; a camera that records CONTINUOUSLY has no gaps at all,
          // so the visit became the recording session. Measured on 592: seven
          // rows for a whole day, one of them 7 h 58 m. Same day, same 30 s
          // gap, clustered on the events instead: 36 visits in the daytime
          // window, median 17 s, longest 99 s.
          clips = visitsToClips(
            clusterEventVisits(allEvents(events), ranges, deps.defaultPad),
            events,
            deps.defaultPad,
            vouched,
          )
        } catch (err: unknown) {
          deps.logWarn?.('videoclips: availability read failed — listing unfiltered', {
            deviceId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // BEFORE the window filter and before the limit. A cooldown applied
      // after paging would count rows that then vanish, so page 1 would be
      // short and the operator's `limit` would mean a different number of rows
      // on every camera. Before the window filter too, so the rows an earlier
      // window already listed still consume their kind's quiet time — a
      // cooldown that restarts at the edge of whatever the operator scrolled
      // to is a cooldown that does nothing at a boundary.
      const thinned = applyQuietKinds(clips)
      const inWindow = thinned.filter((c) => intersectsWindow(c, since, until))
      const answer = limit != null ? inWindow.slice(0, limit) : inWindow
      reportUnvouchedClips(deps, deviceId, answer)
      return answer
    },
    /**
     * The one source this provider serves, on every camera: the hub's own
     * analytics visits over recorded footage.
     *
     * Always `ok`, and that is not optimism — this source IS the process
     * answering the call, so there is no reachability question to report. A
     * read that fails INSIDE `listClips` degrades that list (and logs it); a
     * source that cannot be reached at all is reported by the collection
     * dispatcher, which is the only layer that can tell the difference.
     * `label` is what the picker draws.
     */
    listSources: async ({ deviceId }) => {
      const outage = eventsUnreachable.get(deviceId)
      return [
        {
          source: SOURCE,
          // Who serves this row. One addon may serve several of a camera's
          // sources, which is why the per-device switch is keyed by SOURCE
          // rather than by this (D555) — this one happens to serve exactly one.
          addonId: CLIP_SOURCE_ADDON_ID,
          label: 'CamStack recordings',
          // `ok` even when the event log is down, and the reason says what was
          // lost. This source ANSWERED — it shipped the footage visits — and
          // `unreachable` renders as "its clips are missing from this list"
          // (`clip-source-state.ts`), which beside a list that HAS them is the
          // same defect pointed the other way. The availability enum models
          // what the source can do about its store; a degraded annotation is
          // not a fifth member of it.
          availability:
            outage === undefined
              ? { state: 'ok' }
              : {
                  state: 'ok',
                  reason: `${EVENTS_UNREACHABLE_NOTICE} (${outage})`,
                },
        },
      ]
    },
    getClipPlayback: async ({ deviceId, clipId }) => {
      const parsed = parseClipId(clipId)
      if (!parsed) throw new Error(`videoclips: unrecognized clipId "${clipId}"`)
      const playback = await deps.resolvePlayback({
        deviceId,
        startMs: parsed.startMs,
        endMs: parsed.endMs,
      })
      // This source's playback IS the recorder's HLS master. Stamping the
      // format here rather than leaving it absent means the ONE player never
      // has to guess: a native source says `mp4` and this one says `hls`, and
      // an absent value is a provider that predates the field, not a shrug.
      return { ...playback, format: 'hls' }
    },
    /**
     * This source has no bytes to hand over, and says so rather than
     * inventing a path to them.
     *
     * An `analytics` clip is a time WINDOW over footage the recorder already
     * owns — there is no file behind it, and a caller that wants it as one
     * asks for it as an EXPORT, where the source playlist and
     * `export-dense-map` handle the holes a visit spans by construction
     * (D558 § 5.4.3). Reading it here would be this addon fetching from
     * itself, over a cap channel, in base64.
     */
    readClipBytes: async ({ clipId }) => {
      throw new Error(
        `videoclips: "${clipId}" is an analytics visit — a window over recorded footage with no ` +
          'file behind it. Export it through recordingExport with the same clip subject; the ' +
          'recorder renders it from its own segments.',
      )
    },
  }
}

/** What the source row says while the event log is down. */
export const EVENTS_UNREACHABLE_NOTICE =
  'The analytics event log could not be read on the last listing — these clips are recorded footage only, with no labels, stills or event counts'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface ListWindow {
  readonly deviceId: number
  readonly since: number
  readonly until: number
  readonly readSince: number
  readonly limit?: number
}

/**
 * Footage present, EVENTS unreachable — the mirror of the two degradations
 * this provider already had, and the one that could not happen while a single
 * addon held both halves (D560).
 *
 * A visit is a window over recorded footage; the events only ANNOTATE it. So
 * when availability answers, the visits are still real and still playable —
 * their ids encode the window — and the honest answer is that list without its
 * annotations. An availability that answered `[]` yields an empty list that is
 * TRUE about footage: with availability present a clip only ever comes from a
 * recorded range, so it is the same answer a successful events read would have
 * given.
 *
 * Without availability (absent, or its read failed too) the clips ARE the
 * events, so there is nothing left that is true to say. That is a REFUSAL
 * naming both reads — never an empty list, which reads as "this camera has no
 * recordings".
 */
async function listWithoutEvents(
  deps: VideoclipsProviderDeps,
  eventsUnreachable: Map<number, string>,
  reason: string,
  window: ListWindow,
): Promise<Clip[]> {
  const { deviceId, since, until, readSince, limit } = window
  const fetchAvailability = deps.fetchAvailability
  if (fetchAvailability === undefined) {
    eventsUnreachable.set(deviceId, reason)
    throw new Error(
      `videoclips: the analytics event log is unreachable for device ${deviceId} (${reason}) and this source lists no recorded footage — refusing rather than answering an empty list`,
    )
  }
  let ranges: readonly FootageRange[]
  try {
    ranges = await fetchAvailability({ deviceId, since: readSince, until })
  } catch (err: unknown) {
    eventsUnreachable.set(deviceId, reason)
    throw new Error(
      `videoclips: neither read answered for device ${deviceId} — events: ${reason}; footage: ${errMessage(err)}. Refusing rather than answering an empty list.`,
    )
  }
  eventsUnreachable.set(deviceId, reason)
  deps.logWarn?.(
    'videoclips: event log unreachable — listing the recorded footage visits without their events',
    { deviceId, error: reason, ranges: ranges.length },
  )
  const clips = visitsToClips(
    clusterFootageVisits(ranges, VISIT_MERGE_GAP_MS),
    NO_EVENTS,
    deps.defaultPad,
    new Set<string>(),
  ).filter((clip) => intersectsWindow(clip, since, until))
  return limit != null ? clips.slice(0, limit) : clips
}

/** The annotation backstop biting is a SILENT loss of the earliest visits'
 *  events — say so, per camera, instead of shipping a thinner list. */
function warnOnTruncatedFetch(
  deps: VideoclipsProviderDeps,
  deviceId: number,
  events: EventBuckets,
): void {
  if (!deps.fetchAvailability) return
  const truncated = (['motion', 'object', 'audio'] as const).filter(
    (kind) => events[kind].length >= VISIT_EVENT_FETCH_LIMIT,
  )
  if (truncated.length === 0) return
  deps.logWarn?.('videoclips: annotation fetch truncated — earliest visits lose their events', {
    deviceId,
    kinds: truncated,
    limit: VISIT_EVENT_FETCH_LIMIT,
  })
}

/** The operator's acceptance criterion as a number: a rising count on one
 *  camera is its motion-snapshot capturer failing, not a quiet day. */
function reportUnvouchedClips(
  deps: VideoclipsProviderDeps,
  deviceId: number,
  clips: readonly Clip[],
): void {
  const clipsWithoutStill = clips.filter((c) => c.thumbnail === undefined).length
  if (clipsWithoutStill === 0) return
  deps.logInfo?.('videoclips: visit has no vouched still', {
    deviceId,
    clipsWithoutStill,
    clips: clips.length,
  })
}
