/**
 * `training_frame_candidates` (#451) — find the instants of a camera worth
 * putting in the retrain corpus for a class (packages first), read-only.
 *
 * A package left on a doormat never becomes a track: nothing moves after the
 * courier leaves. So the walk is not "tracks of the class" alone. It reads the
 * camera's tracks in the window and proposes, from the RECORDING:
 *   - `class-track`   the middle of an existing track of the class,
 *   - `after-actor`   shortly after any other actor (person, doorbell, contact)
 *                     ends — where an object left behind first shows,
 *   - `idle-sweep`    sampled instants of the quiet stretch that follows, up to
 *                     the next actor, so a still object is found while it sits.
 * An instant not on a recording is dropped and counted (a frame needs footage).
 *
 * Whether the detector SAW anything at those instants is the assist run of
 * `training_frame_mark`, which stages the frame first: a read cannot ask a
 * model about a frame the dataset does not hold.
 */
import { toToolOutput } from '@camstack/develop'
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { judgeCoverage, mergeIntervals, readRecording } from './timeline-audit.js'
import { RecentTracksPageSchema, parseWire, type Track } from './wire.js'

const PAGE = 200
const MAX_TRACKS = 1000
/** Instants closer than this are one instant. */
const MIN_SPACING_MS = 20_000

export const TrainingCandidatesArgsSchema = z.object({
  deviceId: z.number().int(),
  /** Window start, epoch ms. */
  fromMs: z.number().int().nonnegative(),
  /** Window end, epoch ms. */
  toMs: z.number().int().nonnegative(),
  /** The detector class the corpus is missing, e.g. `package`. */
  className: z.string().min(1).max(64).optional(),
  /** How long after an actor ends the first look is taken (seconds). */
  afterSec: z.number().int().min(5).max(600).optional(),
  /** Spacing of the idle sweep (seconds). */
  sweepSec: z.number().int().min(30).max(3600).optional(),
  maxCandidates: z.number().int().positive().max(60).optional(),
})
export type TrainingCandidatesArgs = z.infer<typeof TrainingCandidatesArgsSchema>

export type CandidateKind = 'class-track' | 'after-actor' | 'idle-sweep'

export interface Candidate {
  readonly epochMs: number
  readonly kind: CandidateKind
  readonly reason: string
  readonly trackId?: string
}

export interface PlanInput {
  readonly tracks: readonly Track[]
  readonly className: string
  readonly fromMs: number
  readonly toMs: number
  readonly afterMs: number
  readonly sweepMs: number
}

const isActor = (t: Track, className: string): boolean =>
  t.className !== className && t.source !== 'audio' && t.className !== 'switch'

/** Pure: every instant worth a look, before the recording and the cap are applied. */
export function planCandidates(input: PlanInput): Candidate[] {
  const out: Candidate[] = []
  for (const t of input.tracks) {
    if (t.className === input.className) {
      out.push({
        epochMs: Math.round((t.firstSeen + t.lastSeen) / 2),
        kind: 'class-track',
        reason: `track of the class (${t.state ?? 'state unknown'}) — check the box is right`,
        trackId: t.trackId,
      })
    }
  }
  const actors = input.tracks
    .filter((t) => isActor(t, input.className))
    .toSorted((a, b) => a.firstSeen - b.firstSeen)
  actors.forEach((actor, i) => {
    const start = actor.lastSeen + input.afterMs
    out.push({
      epochMs: start,
      kind: 'after-actor',
      reason: `${Math.round(input.afterMs / 1000)}s after the ${actor.className} track ended`,
      trackId: actor.trackId,
    })
    const nextStart = actors.slice(i + 1).find((n) => n.firstSeen > actor.lastSeen)?.firstSeen
    const sweepEnd = Math.min(nextStart ?? input.toMs, input.toMs)
    for (let at = start + input.sweepMs; at < sweepEnd; at += input.sweepMs) {
      out.push({
        epochMs: at,
        kind: 'idle-sweep',
        reason: `quiet stretch after the ${actor.className} track, no actor since`,
        trackId: actor.trackId,
      })
    }
  })
  return out
    .filter((c) => c.epochMs >= input.fromMs && c.epochMs <= input.toMs)
    .toSorted((a, b) => a.epochMs - b.epochMs)
    .reduce<Candidate[]>((kept, c) => {
      const last = kept[kept.length - 1]
      if (last !== undefined && c.epochMs - last.epochMs < MIN_SPACING_MS) {
        // a class-track instant outranks a neighbouring guess
        if (c.kind === 'class-track' && last.kind !== 'class-track') kept[kept.length - 1] = c
        return kept
      }
      kept.push(c)
      return kept
    }, [])
}

async function listTracks(hub: OpsHub, deviceId: number, since: number, until: number) {
  const tracks: Track[] = []
  let cursor: string | undefined
  let truncated = false
  while (tracks.length < MAX_TRACKS) {
    const raw = await hub.query('pipelineAnalytics.listRecentTracks', {
      deviceIds: [deviceId],
      since,
      until,
      limit: PAGE,
      projection: 'slim',
      ...(cursor ? { cursor } : {}),
    })
    const page = parseWire(RecentTracksPageSchema, raw, 'pipelineAnalytics.listRecentTracks')
    tracks.push(...page.tracks)
    cursor = page.nextCursor ?? undefined
    if (!cursor || page.tracks.length === 0) return { tracks, truncated }
  }
  truncated = true
  return { tracks, truncated }
}

export async function trainingFrameCandidates(
  hub: OpsHub,
  args: TrainingCandidatesArgs,
): Promise<unknown> {
  if (args.toMs <= args.fromMs) throw new Error('toMs must be after fromMs')
  const className = args.className ?? 'package'
  const cap = args.maxCandidates ?? 24
  const { tracks, truncated } = await listTracks(hub, args.deviceId, args.fromMs, args.toMs)
  const planned = planCandidates({
    tracks,
    className,
    fromMs: args.fromMs,
    toMs: args.toMs,
    afterMs: (args.afterSec ?? 30) * 1000,
    sweepMs: (args.sweepSec ?? 300) * 1000,
  })
  const recording = await readRecording(hub, args.deviceId, args.fromMs, args.toMs)
  let onRecording = planned
  let dropped: number | null = 0
  if (recording.ok) {
    const ranges = mergeIntervals(recording.ranges)
    onRecording = planned.filter(
      (c) => judgeCoverage({ start: c.epochMs, end: c.epochMs + 1_000 }, ranges).covered,
    )
    dropped = planned.length - onRecording.length
  } else {
    dropped = null
  }
  const stride = Math.max(1, Math.ceil(onRecording.length / cap))
  const picked = onRecording.filter((_, i) => i % stride === 0).slice(0, cap)
  const classTracks = tracks.filter((t) => t.className === className)
  return toToolOutput({
    window: { deviceId: args.deviceId, fromMs: args.fromMs, toMs: args.toMs },
    className,
    tracksScanned: tracks.length,
    tracksTruncated: truncated,
    existingClassTracks: classTracks.slice(0, 20).map((t) => ({
      trackId: t.trackId.slice(0, 8),
      firstSeen: t.firstSeen,
      lastSeen: t.lastSeen,
    })),
    existingClassTrackCount: classTracks.length,
    recording: recording.ok
      ? { read: true, droppedNotOnRecording: dropped }
      : {
          read: false,
          reason: recording.reason,
          note: 'candidates are NOT checked against footage',
        },
    candidatesTotal: onRecording.length,
    candidates: picked.map((c) => ({
      ...c,
      at: new Date(c.epochMs).toISOString(),
      trackId: c.trackId?.slice(0, 8),
    })),
    next: 'Open the frames you want (training_frame_mark with epochMs[], a collection and — for a package — a NORMALISED [0,1] zone): it dry-runs first, then adds the stills and runs the assist for the verdict.',
  })
}
