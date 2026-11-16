/**
 * `timeline_audit` (#444) — the Timeline's events for chosen cameras over N days:
 * does each event have its images, and is its time span on a recording?
 *
 * Read-only and bounded. Events are the camera's tracks (the Timeline's rows),
 * paged with the cursor of `listRecentTracks` up to `maxEventsPerCamera`; the
 * media index (`listTrackMedia`, no bytes) is read for an even sample of at most
 * `mediaSamplePerCamera` closed tracks; recording coverage is ONE
 * `recording.getAvailability` read per camera for the whole window. The answer is
 * a per-camera summary plus one page of the failing events, each with the missing
 * kind and the reason. Nothing is reported as "absent" when it could not be read:
 * an unreadable media index or an `unreadable` recording answer is `null` + reason.
 */
import { isSynthetic, toToolOutput } from '@camstack/develop'
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { MediaInfoSchema, RecentTracksPageSchema, parseWire, type Track } from './wire.js'

/** `recording.cap.ts` RECORDING_SOURCE_CAMSTACK / _ADDON: the recorder's reserved source id and addon. */
const RECORDING_SOURCE_CAMSTACK = 'camstack'
const RECORDING_SOURCE_CAMSTACK_ADDON = 'recorder'
const DAY_MS = 86_400_000
const PAGE = 200
const MIN_SPAN_MS = 1_000
/** A span counts as covered when this much of it lies on a recording. */
const COVERED_FRACTION = 0.95
const GAPS_PER_CAMERA = 10

export const TIMELINE_MEDIA_KINDS = ['thumbnail', 'keyFrame', 'firstFrame', 'lastFrame'] as const
export type TimelineMediaKind = (typeof TIMELINE_MEDIA_KINDS)[number]

export const TimelineAuditArgsSchema = z.object({
  deviceIds: z.array(z.number().int()).min(1).max(20),
  days: z.number().positive().max(14).optional(),
  /** Tracks read per camera (newest first). */
  maxEventsPerCamera: z.number().int().positive().max(1000).optional(),
  /** Closed tracks whose media index is read per camera (evenly sampled). */
  mediaSamplePerCamera: z.number().int().positive().max(300).optional(),
  /** Kinds a closed track must have to count as complete. */
  requiredKinds: z.array(z.enum(TIMELINE_MEDIA_KINDS)).min(1).optional(),
  /** Recording gaps shorter than this are not reported (seconds). */
  minGapSec: z.number().positive().max(3600).optional(),
  /** Page of the failing-events list. */
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100).optional(),
})
export type TimelineAuditArgs = z.infer<typeof TimelineAuditArgsSchema>

const SourcesSchema = z.array(z.looseObject({ source: z.string(), addonId: z.string().optional() }))
const AvailabilitySchema = z.looseObject({
  read: z.enum(['read', 'unreadable']),
  ranges: z.array(
    z.looseObject({
      profile: z.string(),
      startMs: z.number(),
      endMs: z.number(),
    }),
  ),
  profilesWithFootage: z.array(z.string()).optional(),
})

export interface Interval {
  readonly start: number
  readonly end: number
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(input: readonly Interval[]): Interval[] {
  const sorted = input.toSorted((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && iv.start <= last.end) {
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, iv.end),
      }
    } else {
      out.push(iv)
    }
  }
  return out
}

export type CoverageVerdict =
  | { readonly covered: true }
  | {
      readonly covered: false
      readonly coveredFraction: number
      readonly reason: 'no-recording-at-all' | 'before-first-segment' | 'after-last-segment' | 'gap'
    }

/** How much of `span` lies on the merged `ranges`, and why when not enough. */
export function judgeCoverage(span: Interval, ranges: readonly Interval[]): CoverageVerdict {
  const length = Math.max(span.end - span.start, MIN_SPAN_MS)
  const end = span.start + length
  let covered = 0
  for (const r of ranges) {
    const overlap = Math.min(end, r.end) - Math.max(span.start, r.start)
    if (overlap > 0) covered += overlap
  }
  const fraction = Math.min(1, covered / length)
  if (fraction >= COVERED_FRACTION) return { covered: true }
  const first = ranges[0]
  const last = ranges[ranges.length - 1]
  const reason =
    first === undefined || last === undefined
      ? 'no-recording-at-all'
      : end <= first.start
        ? 'before-first-segment'
        : span.start >= last.end
          ? 'after-last-segment'
          : 'gap'
  return {
    covered: false,
    coveredFraction: Math.round(fraction * 100) / 100,
    reason,
  }
}

export interface RecordingGap extends Interval {
  readonly durationSec: number
  readonly events: number
}

/** Gaps BETWEEN merged ranges that at least one event falls in, longest first. */
export function gapsWithEvents(
  ranges: readonly Interval[],
  spans: readonly Interval[],
  minGapMs: number,
): RecordingGap[] {
  const gaps: RecordingGap[] = []
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1]
    const next = ranges[i]
    if (prev === undefined || next === undefined) continue
    const gap: Interval = { start: prev.end, end: next.start }
    if (gap.end - gap.start < minGapMs) continue
    const events = spans.filter((s) => s.start < gap.end && s.end > gap.start).length
    if (events > 0) {
      gaps.push({
        ...gap,
        durationSec: Math.round((gap.end - gap.start) / 1000),
        events,
      })
    }
  }
  return gaps.toSorted((a, b) => b.durationSec - a.durationSec).slice(0, GAPS_PER_CAMERA)
}

export type MediaProblem =
  | {
      readonly kind: 'media'
      readonly missing: TimelineMediaKind[]
      readonly reason: string
    }
  | { readonly kind: 'media-unreadable'; readonly reason: string }

export interface FailingEvent {
  readonly deviceId: number
  readonly trackId: string
  readonly fullTrackId: string
  readonly className: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly problems: (
    | MediaProblem
    | {
        readonly kind: 'recording'
        readonly reason: string
        readonly coveredFraction?: number
      }
  )[]
}

interface MediaReading {
  readonly kinds: ReadonlySet<string> | null
  readonly empty: ReadonlySet<string>
}

/** Pure: which required kinds a closed track lacks, and why. */
export function mediaProblem(
  reading: MediaReading,
  required: readonly TimelineMediaKind[],
): MediaProblem | null {
  if (reading.kinds === null) {
    return {
      kind: 'media-unreadable',
      reason: 'the media index could not be read — unknown, not absent',
    }
  }
  const missing = required.filter((k) => !reading.kinds?.has(k) || reading.empty.has(k))
  if (missing.length === 0) return null
  const reason =
    reading.kinds.size === 0
      ? 'zero media: the track has no capture at all'
      : missing.every((k) => reading.kinds?.has(k))
        ? 'row present but empty (0 bytes)'
        : 'kind was never captured (other kinds exist)'
  return { kind: 'media', missing, reason }
}

async function listEvents(
  hub: OpsHub,
  deviceId: number,
  since: number,
  until: number,
  cap: number,
): Promise<{ tracks: Track[]; truncated: boolean }> {
  const tracks: Track[] = []
  let cursor: string | undefined
  let truncated = false
  while (tracks.length < cap) {
    const raw = await hub.query('pipelineAnalytics.listRecentTracks', {
      deviceIds: [deviceId],
      since,
      until,
      limit: Math.min(PAGE, cap - tracks.length),
      projection: 'slim',
      ...(cursor ? { cursor } : {}),
    })
    const page = parseWire(RecentTracksPageSchema, raw, 'pipelineAnalytics.listRecentTracks')
    tracks.push(...page.tracks)
    cursor = page.nextCursor ?? undefined
    if (!cursor || page.tracks.length === 0) return { tracks, truncated }
  }
  truncated = cursor !== undefined
  return { tracks, truncated }
}

async function readMedia(hub: OpsHub, track: Track): Promise<MediaReading> {
  try {
    const raw = await hub.query('pipelineAnalytics.listTrackMedia', {
      trackId: track.trackId,
      deviceId: track.deviceId,
    })
    const rows = parseWire(z.array(MediaInfoSchema), raw, 'pipelineAnalytics.listTrackMedia')
    return {
      kinds: new Set(rows.map((r) => r.kind)),
      empty: new Set(rows.filter((r) => r.sizeBytes <= 0).map((r) => r.kind)),
    }
  } catch {
    return { kinds: null, empty: new Set() }
  }
}

type RecordingRead =
  | {
      readonly ok: true
      readonly ranges: Interval[]
      readonly note: string | null
    }
  | { readonly ok: false; readonly reason: string }

async function readRecording(
  hub: OpsHub,
  deviceId: number,
  since: number,
  until: number,
): Promise<RecordingRead> {
  try {
    const sources = parseWire(
      SourcesSchema,
      await hub.query('recording.listSources', { deviceId }),
      'recording.listSources',
    )
    const ours = sources.find(
      (s) =>
        s.source === RECORDING_SOURCE_CAMSTACK || s.addonId === RECORDING_SOURCE_CAMSTACK_ADDON,
    )
    if (ours === undefined)
      return {
        ok: false,
        reason: 'the camera has no CamStack recording source',
      }
    const answer = parseWire(
      AvailabilitySchema,
      await hub.query('recording.getAvailability', {
        deviceId,
        provider: ours.addonId ?? RECORDING_SOURCE_CAMSTACK_ADDON,
        fromMs: since,
        toMs: until,
      }),
      'recording.getAvailability',
    )
    if (answer.read === 'unreadable') {
      return {
        ok: false,
        reason: 'the recorder answered unreadable — coverage unknown',
      }
    }
    const profiles = new Set(answer.ranges.map((r) => r.profile))
    return {
      ok: true,
      ranges: mergeIntervals(answer.ranges.map((r) => ({ start: r.startMs, end: r.endMs }))),
      note:
        profiles.size > 1
          ? `ranges of several profiles merged (${[...profiles].join(', ')})`
          : null,
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

const pct = (n: number, d: number): number | null =>
  d === 0 ? null : Math.round((1000 * n) / d) / 10

interface CameraAudit {
  readonly summary: Record<string, unknown>
  readonly failing: FailingEvent[]
}

async function auditCamera(
  hub: OpsHub,
  deviceId: number,
  window: Interval,
  opts: {
    cap: number
    sample: number
    required: readonly TimelineMediaKind[]
    minGapMs: number
  },
): Promise<CameraAudit> {
  let listed: { tracks: Track[]; truncated: boolean }
  try {
    listed = await listEvents(hub, deviceId, window.start, window.end, opts.cap)
  } catch (err) {
    return {
      summary: {
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      },
      failing: [],
    }
  }
  const events = listed.tracks.filter((t) => !isSynthetic(t) && t.source !== 'audio')
  const closed = events.filter((t) => t.active !== true)
  const stride = Math.max(1, Math.ceil(closed.length / opts.sample))
  const sampled = closed.filter((_, i) => i % stride === 0).slice(0, opts.sample)
  const failing = new Map<string, FailingEvent>()
  const failingOf = (t: Track): FailingEvent => {
    const existing = failing.get(t.trackId)
    if (existing !== undefined) return existing
    const created: FailingEvent = {
      deviceId: t.deviceId,
      trackId: t.trackId.slice(0, 8),
      fullTrackId: t.trackId,
      className: t.className,
      firstSeen: t.firstSeen,
      lastSeen: t.lastSeen,
      problems: [],
    }
    failing.set(t.trackId, created)
    return created
  }

  const kindCount: Record<string, number> = Object.fromEntries(
    TIMELINE_MEDIA_KINDS.map((k) => [k, 0]),
  )
  let complete = 0
  let unreadable = 0
  for (const track of sampled) {
    const reading = await readMedia(hub, track)
    for (const k of TIMELINE_MEDIA_KINDS) {
      if (reading.kinds?.has(k) && !reading.empty.has(k)) kindCount[k] = (kindCount[k] ?? 0) + 1
    }
    const problem = mediaProblem(reading, opts.required)
    if (problem === null) complete += 1
    else {
      if (problem.kind === 'media-unreadable') unreadable += 1
      failingOf(track).problems.push(problem)
    }
  }

  const recording = await readRecording(hub, deviceId, window.start, window.end)
  let recordingSummary: Record<string, unknown>
  if (!recording.ok) {
    recordingSummary = { read: false, reason: recording.reason }
  } else {
    const spans = events.map((t) => ({ start: t.firstSeen, end: t.lastSeen }))
    let covered = 0
    const reasons: Record<string, number> = {}
    events.forEach((t, i) => {
      const span = spans[i]
      if (span === undefined) return
      const verdict = judgeCoverage(span, recording.ranges)
      if (verdict.covered) {
        covered += 1
        return
      }
      reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1
      failingOf(t).problems.push({
        kind: 'recording',
        reason: verdict.reason,
        coveredFraction: verdict.coveredFraction,
      })
    })
    recordingSummary = {
      read: true,
      eventsCovered: covered,
      eventsUncovered: events.length - covered,
      coveredPct: pct(covered, events.length),
      uncoveredReasons: reasons,
      gapsWithEvents: gapsWithEvents(recording.ranges, spans, opts.minGapMs),
      ...(recording.note ? { note: recording.note } : {}),
    }
  }

  return {
    summary: {
      deviceId,
      events: events.length,
      open: events.length - closed.length,
      eventsTruncated: listed.truncated,
      media: {
        checked: sampled.length,
        sampled: sampled.length < closed.length,
        unreadable,
        completePct: pct(complete, sampled.length - unreadable),
        presentPct: Object.fromEntries(
          TIMELINE_MEDIA_KINDS.map((k) => [k, pct(kindCount[k] ?? 0, sampled.length - unreadable)]),
        ),
      },
      recording: recordingSummary,
      failingEvents: failing.size,
    },
    failing: [...failing.values()],
  }
}

export async function timelineAudit(
  hub: OpsHub,
  args: TimelineAuditArgs,
  now: number = Date.now(),
): Promise<unknown> {
  const days = args.days ?? 1
  const window: Interval = { start: now - days * DAY_MS, end: now }
  const required = args.requiredKinds ?? ['thumbnail', 'firstFrame', 'lastFrame']
  const cameras: Record<string, unknown>[] = []
  const failing: FailingEvent[] = []
  for (const deviceId of args.deviceIds) {
    const audit = await auditCamera(hub, deviceId, window, {
      cap: args.maxEventsPerCamera ?? 300,
      sample: args.mediaSamplePerCamera ?? 100,
      required,
      minGapMs: (args.minGapSec ?? 60) * 1000,
    })
    cameras.push(audit.summary)
    failing.push(...audit.failing)
  }
  const ordered = failing.toSorted((a, b) => b.firstSeen - a.firstSeen)
  const offset = args.offset ?? 0
  const limit = args.limit ?? 50
  const page = ordered.slice(offset, offset + limit)
  return toToolOutput({
    window: { days, since: window.start, until: window.end },
    requiredKinds: required,
    note: 'Media presence comes from the media index (kind present and non-empty); bytes are not fetched. Media is sampled per camera; recording coverage covers every listed event.',
    cameras,
    failing: {
      total: ordered.length,
      offset,
      returned: page.length,
      nextOffset: offset + page.length < ordered.length ? offset + page.length : null,
      events: page,
    },
  })
}
