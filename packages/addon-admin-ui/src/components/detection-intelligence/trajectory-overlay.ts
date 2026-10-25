/**
 * Pure trajectory-overlay mapping: detection-pixel track positions →
 * an SVG-ready polyline + per-position points + snapshot checkpoints +
 * start/end markers + peak (largest-area) bbox, all expressed in a 0..100
 * viewBox space. No React, no side effects.
 *
 * Positions (and snapshot positions) are stored in the DETECTION FRAME PIXEL
 * space — the resolution the pipeline decodes/analyses at (e.g. 640×360), NOT
 * the native-resolution key frame the event-detail hero may render. This is
 * the same space `getObjectEvents` reports via `frameWidth`/`frameHeight` and
 * `face-bbox.ts#normalizeFaceBbox` normalizes a face box from — `position.x`/
 * `position.y` is the bbox centroid, `bbox` is the box. This helper divides
 * every coordinate by the DETECTION frame's pixel dimensions so the resulting
 * 0..100 geometry, stretched over the displayed frame with
 * `preserveAspectRatio="none"`, lands on the subject regardless of whether the
 * displayed image is the detection frame itself (640×360) or a native-res key
 * frame (1920×1080) — both share the frame aspect. The caller therefore MUST
 * pass the DETECTION frame dims (recovered from a detection-resolution track
 * media), never the displayed hero's intrinsic size.
 *
 * The PATH itself (which positions, the placeholder and dwell rules, the
 * downsampling) is the shared subject-path geometry (`buildSubjectPath`,
 * D903) — the same line the notification picture draws with
 * `media.showSubjectPath`. This module only scales it into the 0..100 viewBox
 * and adds what the debug view alone shows (snapshots, the peak box).
 *
 * `snapshots` are the periodic checkpoints captured along the track; each
 * carries the `mediaId` (D482) of its saved frame so the overlay can offer a
 * click-to-that-frame affordance.
 */

import { buildSubjectPath } from '@camstack/ui-library'

export interface TrajPoint {
  readonly x: number
  readonly y: number
}

export interface TrajRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** One track position in detection frame pixel space (centroid + box). */
export interface TrajectoryInput {
  readonly x: number
  readonly y: number
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

/** One track snapshot: centroid in detection pixel space + its media row id. */
export interface TrajectorySnapshotInput {
  readonly x: number
  readonly y: number
  readonly mediaId: number
}

/** A snapshot checkpoint in 0..100 space, carrying its source `mediaId`. */
export interface TrajSnapshotMarker {
  readonly x: number
  readonly y: number
  readonly mediaId: number
}

/** Detection-frame pixel dimensions the positions were captured in. */
export interface TrajectoryFrame {
  readonly width: number
  readonly height: number
}

export interface TrajectoryOverlay {
  /** "x,y x,y …" in 0..100 space; '' when fewer than 2 points. */
  readonly polyline: string
  /** Every (downsampled) position as a dot, oldest→newest, in 0..100 space. */
  readonly points: readonly TrajPoint[]
  /** Snapshot checkpoints along the path (start→snapshots→end), in 0..100 space. */
  readonly snapshots: readonly TrajSnapshotMarker[]
  readonly start: TrajPoint | null
  readonly end: TrajPoint | null
  /** Largest-area bbox in 0..100 space. */
  readonly peakBox: TrajRect | null
}

const VIEW = 100

const EMPTY: TrajectoryOverlay = {
  polyline: '',
  points: [],
  snapshots: [],
  start: null,
  end: null,
  peakBox: null,
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
const r2 = (n: number): number => Math.round(n * 100) / 100

export function buildTrajectoryOverlay(
  positions: readonly TrajectoryInput[],
  frame: TrajectoryFrame | null,
  opts?: {
    readonly maxPoints?: number
    readonly snapshots?: readonly TrajectorySnapshotInput[]
  },
): TrajectoryOverlay {
  // No positions, or the frame dims aren't known yet / are degenerate:
  // normalizing against a zero/invalid frame is meaningless, so degrade to
  // "no overlay" (the panel then paints nothing — its loading state).
  if (positions.length === 0 || frame === null) return EMPTY
  const { width, height } = frame
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return EMPTY
  }

  const path = buildSubjectPath(
    positions.map((p) => ({
      x: p.x / width,
      y: p.y / height,
      w: p.bbox.w / width,
      h: p.bbox.h / height,
    })),
    opts?.maxPoints !== undefined ? { maxPoints: opts.maxPoints } : undefined,
  )
  const scaled: TrajPoint[] = path.nodes.map((n) => ({ x: r2(n.x * VIEW), y: r2(n.y * VIEW) }))
  const start = scaled[0] ?? null
  const end = scaled[scaled.length - 1] ?? null
  const polyline = scaled.length >= 2 ? scaled.map((p) => `${p.x},${p.y}`).join(' ') : ''

  const snapshots: TrajSnapshotMarker[] = (opts?.snapshots ?? []).map((s) => ({
    x: r2(clamp01(s.x / width) * VIEW),
    y: r2(clamp01(s.y / height) * VIEW),
    mediaId: s.mediaId,
  }))

  let peak: TrajectoryInput | null = null
  let peakArea = -1
  for (const p of positions) {
    const area = clamp01(p.bbox.w / width) * clamp01(p.bbox.h / height)
    if (area > peakArea) {
      peakArea = area
      peak = p
    }
  }
  const peakBox = peak
    ? {
        x: r2(clamp01(peak.bbox.x / width) * VIEW),
        y: r2(clamp01(peak.bbox.y / height) * VIEW),
        w: r2(clamp01(peak.bbox.w / width) * VIEW),
        h: r2(clamp01(peak.bbox.h / height) * VIEW),
      }
    : null

  return { polyline, points: scaled, snapshots, start, end, peakBox }
}
