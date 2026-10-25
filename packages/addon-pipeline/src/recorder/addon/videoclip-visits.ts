/**
 * Videoclip visits — the grain a clip should have on an events-mode camera.
 *
 * Disk writes one fMP4 per ffmpeg roll (~8–12 s). The recorder calendar merges
 * only gaps ≤ 5 s, so a single pantry walk shows up as several availability
 * ranges with ~8 s GOP holes between them. Analytics then mints one 15 s clip
 * per motion heartbeat. A *visit* is the keep-window those fragments belong
 * to: cluster availability with {@link VISIT_MERGE_GAP_MS}, annotate with
 * overlapping events. No second copy of the media; the files stay the source
 * of truth.
 */
import {
  type Clip,
  dominantClipLabels,
  eventOverlapsClipWindow,
  MAX_CLIP_EVENT_IDS,
  VISIT_MERGE_GAP_MS,
} from '@camstack/types'
import type {
  ClipPad,
  EventBuckets,
  EventLike,
  FootageRange,
  VouchedEventIds,
} from './videoclips-shared.js'

/** Synthetic event-id slot in `analytics:<start>:<end>:<id>` for a visit clip. */
export const VISIT_EVENT_ID = 'visit'

export interface FootageVisit {
  readonly startMs: number
  readonly endMs: number
  readonly ranges: readonly FootageRange[]
  readonly holes: readonly FootageRange[]
}

export function clusterFootageVisits(
  ranges: readonly FootageRange[],
  gapMs: number = VISIT_MERGE_GAP_MS,
): FootageVisit[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].toSorted((a, b) => a.startMs - b.startMs)
  const visits: FootageVisit[] = []
  let pieces: FootageRange[] = [sorted[0]!]
  let endMs = sorted[0]!.endMs
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!
    if (next.startMs <= endMs + gapMs) {
      pieces.push(next)
      endMs = Math.max(endMs, next.endMs)
      continue
    }
    visits.push(finishVisit(pieces, endMs))
    pieces = [next]
    endMs = next.endMs
  }
  visits.push(finishVisit(pieces, endMs))
  return visits
}

/**
 * A visit per BURST OF EVENTS, clamped to the footage that exists behind it.
 *
 * ## Why this replaced clustering the availability
 *
 * {@link VISIT_MERGE_GAP_MS}'s own docblock states the claim: 30 s "glues
 * those intra-visit holes without joining visits hours apart". It was applied
 * to the wrong input. {@link clusterFootageVisits} clusters AVAILABILITY, and
 * availability only has gaps on an EVENTS-MODE camera, where the writer opens
 * and closes around activity. A camera that records continuously has none —
 * so the visit became the recording session.
 *
 * Measured on 592, 2026-09-21, 24 h: seven rows covering the whole day, one of
 * them 7 h 58 m.
 *
 * ## And the grain is the PADDING, not a constant
 *
 * `VISIT_MERGE_GAP_MS` (30 s) was arbitrary here and sat on a cliff. 592's
 * worst hour holds 492 events — 150 object, 98 motion, **244 audio** — whose
 * LARGEST gap is 25 s, so nothing ever reached 30 and the hour was one row.
 * Measured on that hour:
 *
 * | rule | clips | longest |
 * | --- | --- | --- |
 * | 30 s | 1 | 66 min |
 * | `preMs + postMs` (15 s) | 105 | 3.5 min |
 *
 * So two clips merge exactly when they would otherwise OVERLAP. Nothing to
 * tune, nothing to disagree with the pad.
 *
 * ## What the footage is still for
 *
 * It CLAMPS, it does not define. A visit keeps only the pieces it actually
 * covers, because {@link stillInstantMs} takes the midpoint of the longest
 * piece — handed the whole session's range it would put the still hours from
 * the event. A burst with no footage behind it is dropped: an event the
 * recorder never kept is not a clip, and listing it is a row that opens onto
 * nothing.
 */
export function clusterEventVisits(
  events: readonly EventLike[],
  ranges: readonly FootageRange[],
  pad: ClipPad,
): FootageVisit[] {
  // The grain IS the padding: two clips merge exactly when they would
  // otherwise overlap — one's `postMs` reaching the next one's `preMs`. So
  // there is no separate threshold to get wrong, and a caller with a wider pad
  // gets a wider grain by construction.
  const gapMs = pad.preMs + pad.postMs
  if (events.length === 0 || ranges.length === 0) return []
  const times = [...events].map((e) => e.timestamp).toSorted((a, b) => a - b)
  const sortedRanges = [...ranges].toSorted((a, b) => a.startMs - b.startMs)

  const bursts: { startMs: number; endMs: number }[] = []
  let first = times[0]!
  let last = times[0]!
  for (let i = 1; i < times.length; i++) {
    const t = times[i]!
    if (t - last <= gapMs) {
      last = t
      continue
    }
    bursts.push({ startMs: first - pad.preMs, endMs: last + pad.postMs })
    first = t
    last = t
  }
  bursts.push({ startMs: first - pad.preMs, endMs: last + pad.postMs })

  const visits: FootageVisit[] = []
  for (const burst of bursts) {
    const pieces: FootageRange[] = []
    for (const range of sortedRanges) {
      const startMs = Math.max(range.startMs, burst.startMs)
      const endMs = Math.min(range.endMs, burst.endMs)
      if (endMs > startMs) pieces.push({ startMs, endMs })
    }
    if (pieces.length === 0) continue
    visits.push(finishVisit(pieces, pieces[pieces.length - 1]!.endMs))
  }
  return visits
}

function finishVisit(pieces: readonly FootageRange[], endMs: number): FootageVisit {
  const holes: FootageRange[] = []
  for (let i = 1; i < pieces.length; i++) {
    const prevEnd = pieces[i - 1]!.endMs
    const nextStart = pieces[i]!.startMs
    if (nextStart > prevEnd) holes.push({ startMs: prevEnd, endMs: nextStart })
  }
  return { startMs: pieces[0]!.startMs, endMs, ranges: pieces, holes }
}

const KIND_ORDER = ['object', 'motion', 'audio'] as const

/** The ONE overlap rule, shared with every native clip source (D923). */
function eventOverlapsVisit(event: EventLike, visit: FootageVisit, pad: ClipPad): boolean {
  return eventOverlapsClipWindow(event.timestamp, visit, pad)
}

function dominantKind(attached: { kind: (typeof KIND_ORDER)[number] }[]): Clip['kind'] {
  for (const kind of KIND_ORDER) {
    if (attached.some((a) => a.kind === kind)) return kind
  }
  return 'motion'
}

/**
 * The instant a recorded still can actually be decoded inside a visit: the
 * midpoint of its LONGEST contiguous range.
 *
 * NOT the midpoint of the visit. A visit spans its holes by construction (it is
 * ranges glued across gaps up to `VISIT_MERGE_GAP_MS`), so the naive midpoint
 * lands in dead air roughly as often as not and the recorder's still route
 * answers 204 for a visit with plenty of footage.
 */
export function stillInstantMs(ranges: readonly FootageRange[]): number | undefined {
  let best: FootageRange | undefined
  for (const range of ranges) {
    if (best === undefined || range.endMs - range.startMs > best.endMs - best.startMs) best = range
  }
  if (best === undefined) return undefined
  return Math.floor((best.startMs + best.endMs) / 2)
}

/**
 * The distinct object classes attached to a visit, most frequent first —
 * the ONE ranking, shared with every native clip source (D923). Empty when
 * nothing classified overlapped — the caller then omits the field so a
 * motion/audio-only visit keeps its kind label instead of carrying an empty
 * array every consumer length-checks.
 */
function dominantLabels(
  attached: readonly { kind: (typeof KIND_ORDER)[number]; event: EventLike }[],
): string[] {
  return dominantClipLabels(attached.filter((a) => a.kind === 'object').map((a) => a.event))
}

export function visitsToClips(
  visits: readonly FootageVisit[],
  events: EventBuckets,
  pad: ClipPad,
  vouched: VouchedEventIds,
): Clip[] {
  const tagged: { kind: (typeof KIND_ORDER)[number]; event: EventLike }[] = [
    ...events.object.map((event) => ({ kind: 'object' as const, event })),
    ...events.motion.map((event) => ({ kind: 'motion' as const, event })),
    ...events.audio.map((event) => ({ kind: 'audio' as const, event })),
  ]
  const clips: Clip[] = visits.map((visit) => {
    const attached = tagged.filter((t) => eventOverlapsVisit(t.event, visit, pad))
    const kind = dominantKind(attached)
    // Main event of the interval: the still that owns `kind` (object > motion
    // > audio). `mediaUrl` alone is not evidence — it is stamped from a
    // template for every event in the system — so only an id in `vouched`,
    // i.e. one the media INDEX answered for, may be published.
    const withThumb =
      attached.find((a) => a.kind === kind && a.event.mediaUrl && vouched.has(a.event.id)) ??
      attached.find((a) => a.event.mediaUrl && vouched.has(a.event.id))
    const stillAtMs = stillInstantMs(visit.ranges)
    const labels = dominantLabels(attached)
    return {
      id: `analytics:${visit.startMs}:${visit.endMs}:${VISIT_EVENT_ID}`,
      source: 'analytics',
      kind,
      timeRange: { startMs: visit.startMs, endMs: visit.endMs },
      ...(withThumb?.event.mediaUrl !== undefined ? { thumbnail: withThumb.event.mediaUrl } : {}),
      ...(stillAtMs !== undefined ? { stillAtMs } : {}),
      // A BOUNDED sample, not the whole annotation set: one 101 visit carried
      // 2 345 ids and `eventIds` was 99% of the camera-day payload. `eventCount`
      // keeps the truncation from reading as a quiet visit, and index 0 — the
      // surface's thumbnail fallback — is preserved by construction.
      eventIds: attached.slice(0, MAX_CLIP_EVENT_IDS).map((a) => a.event.id),
      eventCount: attached.length,
      holes: [...visit.holes],
      ...(labels.length > 0 ? { labels } : {}),
    }
  })
  return clips.toSorted((a, b) => b.timeRange.startMs - a.timeRange.startMs)
}
