/**
 * Which tracks were on a camera at one instant, each with its box AT that
 * instant — the read a `scene-boxes` notification picture draws its other
 * subjects from (D897).
 *
 * ## Why it is an internal read and not a capability
 *
 * The one consumer is the Notification Center, which runs IN the
 * pipeline-analytics process that owns the track store (`getSubjectTrail`, the
 * subject's own trail, is wired the same way). A cap method would be a
 * framework change — codegen, a closure publish, every node updated — for a
 * question no other addon asks, and it would ship whole trails across a
 * boundary to answer it. When a second caller appears, this function is what
 * the cap method serves.
 *
 * ## The box
 *
 * A track's ENVELOPE (`subject.bbox` on a rule subject) is the union of every
 * box it ever had — the right input for "did it pass through the zone", the
 * wrong one to draw: a person who walked across the drive has an envelope the
 * width of the drive. The box drawn is the trail position nearest the
 * instant when one is within a tick, else the interpolation of the two positions
 * bracketing it (never a later position than the instant), NORMALISED by the frame the track was
 * measured on (its own `frameWidth`/`frameHeight`, else the camera's last
 * known frame), so it scales onto any JPEG of that scene. A track with no box at the
 * instant was not visibly there and is left out.
 */
import type { NcTrackAtInstant } from './notification-image.js'

/** The parts of a track this read uses. */
export interface NcTrackAtInstantSource {
  readonly trackId: string
  readonly className: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly label?: string
  readonly subLabel?: string
  readonly frameWidth?: number
  readonly frameHeight?: number
  readonly positions: ReadonlyArray<{
    readonly timestamp: number
    readonly bbox: {
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
    readonly score?: number
  }>
}

/**
 * How many persisted rows the wiring reads per instant. A scene holds a handful
 * of subjects; the read is newest-first from the instant, so this bounds a
 * busy street without missing the tracks that were on screen.
 */
export const NC_TRACKS_AT_INSTANT_LIMIT = 25

/**
 * How far outside its own life a track may still be drawn: one detection tick.
 *
 * The box TOLERANCE (`toleranceMs`, 750 ms) is about how sparse a trail is —
 * a live track keeps a position every few frames — and it must never stretch
 * a LIFE. A track born after the frame was not on it: on 2026-10-22 the
 * tracker split a dog on camera 101 and the second piece, born 676 ms after
 * the key frame, was drawn at its first box as a second box on the dog. One
 * tick (~110–150 ms at that camera's detection rate, rounded up) absorbs the
 * gap between a frame and the detection that confirmed it, and nothing more.
 */
export const NC_TRACK_LIFE_SLACK_MS = 200

/**
 * A position this close to the instant is drawn as it is: one detection tick,
 * the same notion as {@link NC_TRACK_LIFE_SLACK_MS}. Anything farther is a
 * position of a MOVED subject, so it is either interpolated (a position on
 * each side inside the tolerance) or the track is left out — never drawn at a
 * later place than it was at the picture's instant.
 */
export const NC_BOX_EXACT_MS = NC_TRACK_LIFE_SLACK_MS

/** Why a track alive near the instant was not drawn. */
export type NcTrackDropReason = 'outside-life' | 'no-frame-dims' | 'no-position-near-instant'

/** One candidate the read refused, for the caller to log. */
export interface NcTrackDrop {
  readonly trackId: string
  readonly className: string
  readonly reason: NcTrackDropReason
  /** Distance of the nearest trail position, when the track had any. */
  readonly nearestDtMs?: number
}

/** Frame dimensions a track's pixel boxes are measured in. */
export interface NcFrameDims {
  readonly w: number
  readonly h: number
}

type Position = NcTrackAtInstantSource['positions'][number]

/** The box at `timestamp`: a near position as is, else the bracketing pair interpolated. */
function boxAt(
  positions: readonly Position[],
  timestamp: number,
  toleranceMs: number,
): {
  bbox: Position['bbox']
  score: number | undefined
  dtMs: number
  interpolated: boolean
} | null {
  let nearest: Position | null = null
  let before: Position | null = null
  let after: Position | null = null
  for (const p of positions) {
    const d = p.timestamp - timestamp
    if (nearest === null || Math.abs(d) < Math.abs(nearest.timestamp - timestamp)) nearest = p
    if (d <= 0 && (before === null || p.timestamp > before.timestamp)) before = p
    if (d >= 0 && (after === null || p.timestamp < after.timestamp)) after = p
  }
  if (nearest === null) return null
  const dt = nearest.timestamp - timestamp
  if (Math.abs(dt) <= NC_BOX_EXACT_MS) {
    return {
      bbox: nearest.bbox,
      score: nearest.score,
      dtMs: dt,
      interpolated: false,
    }
  }
  if (
    before === null ||
    after === null ||
    timestamp - before.timestamp > toleranceMs ||
    after.timestamp - timestamp > toleranceMs
  ) {
    return null
  }
  const span = after.timestamp - before.timestamp
  const f = span === 0 ? 0 : (timestamp - before.timestamp) / span
  const lerp = (a: number, b: number): number => a + (b - a) * f
  return {
    bbox: {
      x: lerp(before.bbox.x, after.bbox.x),
      y: lerp(before.bbox.y, after.bbox.y),
      w: lerp(before.bbox.w, after.bbox.w),
      h: lerp(before.bbox.h, after.bbox.h),
    },
    score: nearest.score,
    dtMs: dt,
    interpolated: true,
  }
}

/**
 * Every source track ALIVE at `timestamp` (± {@link NC_TRACK_LIFE_SLACK_MS})
 * with a box AT that instant: a trail position within {@link NC_BOX_EXACT_MS},
 * else the linear interpolation of the positions bracketing it (each within
 * `toleranceMs`). A track with neither is not drawn — `onDrop` names it.
 * Deduplicated by track id (a live copy and a persisted copy are one track).
 * Pure.
 */
export function tracksAtInstant(
  sources: readonly NcTrackAtInstantSource[],
  timestamp: number,
  toleranceMs: number,
  fallbackDims: NcFrameDims | undefined,
  onDrop?: (drop: NcTrackDrop) => void,
): readonly NcTrackAtInstant[] {
  const out = new Map<string, NcTrackAtInstant>()
  for (const track of sources) {
    if (out.has(track.trackId)) continue
    // ALIVE at the instant — the life is never widened by the box tolerance.
    if (
      track.firstSeen > timestamp + NC_TRACK_LIFE_SLACK_MS ||
      track.lastSeen < timestamp - NC_TRACK_LIFE_SLACK_MS
    ) {
      onDrop?.({
        trackId: track.trackId,
        className: track.className,
        reason: 'outside-life',
      })
      continue
    }
    const w = track.frameWidth ?? fallbackDims?.w ?? 0
    const h = track.frameHeight ?? fallbackDims?.h ?? 0
    if (w <= 0 || h <= 0) {
      onDrop?.({
        trackId: track.trackId,
        className: track.className,
        reason: 'no-frame-dims',
      })
      continue
    }
    const at = boxAt(track.positions, timestamp, toleranceMs)
    if (at === null) {
      const nearestDtMs = track.positions.reduce<number | undefined>((best, p) => {
        const d = p.timestamp - timestamp
        return best === undefined || Math.abs(d) < Math.abs(best) ? d : best
      }, undefined)
      onDrop?.({
        trackId: track.trackId,
        className: track.className,
        reason: 'no-position-near-instant',
        ...(nearestDtMs !== undefined ? { nearestDtMs } : {}),
      })
      continue
    }
    const label = track.subLabel ?? track.label
    out.set(track.trackId, {
      trackId: track.trackId,
      className: track.className,
      ...(label !== undefined && label !== track.className ? { label } : {}),
      ...(at.score !== undefined ? { confidence: at.score } : {}),
      bbox: {
        x: at.bbox.x / w,
        y: at.bbox.y / h,
        w: at.bbox.w / w,
        h: at.bbox.h / h,
      },
      dtMs: at.dtMs,
      interpolated: at.interpolated,
    })
  }
  return [...out.values()]
}
