/**
 * subject-path — the ONE geometry of "where did this subject go": the path a
 * track's positions draw over a frame.
 *
 * Two surfaces draw it: the event detail of the debug views (admin-ui, an SVG
 * over the hero frame) and the notification picture (addon-post-analysis, an
 * SVG burnt into the JPEG by `sharp`, when a rule sets
 * `media.showSubjectPath`). They must draw the SAME line for the same track,
 * so the point list, its simplification and the mapping into a crop live here
 * once. `@camstack/ui-library` re-exports this module for the UI side.
 *
 * It lives in `@camstack/types` and not in ui-library because the server
 * addon that renders the notification picture cannot take ui-library (a React
 * bundle for the browser), while `@camstack/types` is already the
 * framework-free contract every side imports — the hub, the admin UI and the
 * viewer (`@camstack/types/client`). No React, no DOM, no `sharp`: pure.
 *
 * ## Space
 *
 * Every input and output here is NORMALISED 0..1 in the frame the positions
 * were captured in. A caller holding pixel positions divides by that frame
 * first (the detection frame, never a native-res image it happens to show —
 * the two share the aspect, which is what makes one normalised path land on
 * both).
 *
 * ## Honesty rules (from real tracks, device 101, 2026-08-02)
 *
 *  - A near-FULL-FRAME box is a motion placeholder, not a localisation: its
 *    centre is an artefact, so it is never a path point (it is counted).
 *  - A still subject repeats one box many times; consecutive samples closer
 *    than {@link SUBJECT_PATH_DWELL_EPS} collapse into one node carrying the
 *    count and the time span. The path always ENDS on the last sample.
 *  - A long track is downsampled to {@link SUBJECT_PATH_MAX_POINTS}, first and
 *    last kept.
 *  - Fewer than two nodes is no path: a caller draws nothing.
 */

/** A rectangle in normalised 0..1 space. */
export interface SubjectPathRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A point in normalised 0..1 space. */
export interface SubjectPathPoint {
  readonly x: number
  readonly y: number
}

/** One position of the subject: its normalised CENTRE, the box extent when known, the instant. */
export interface SubjectPathSample {
  readonly x: number
  readonly y: number
  /** Normalised box width — absent when only the centre is known. */
  readonly w?: number
  /** Normalised box height — absent when only the centre is known. */
  readonly h?: number
  /** Capture instant (ms). Absent = order of the input. */
  readonly timestamp?: number
}

/** One drawn node: a normalised centre and the samples that collapsed into it. */
export interface SubjectPathNode extends SubjectPathPoint {
  readonly samples: number
  readonly firstTs: number
  readonly lastTs: number
}

/** The drawable path of one track. */
export interface SubjectPath {
  /** Oldest → newest. Fewer than 2 = nothing to draw. */
  readonly nodes: readonly SubjectPathNode[]
  /** Samples left out as motion placeholders (near-full-frame boxes). */
  readonly unlocalized: number
}

/** What to build the path from. */
export interface SubjectPathOptions {
  /** Only samples at or before this instant (the frame the path is drawn on). */
  readonly untilTimestamp?: number
  /** Downsample to at most this many nodes. Default {@link SUBJECT_PATH_MAX_POINTS}. */
  readonly maxPoints?: number
}

/** A box covering at least this fraction of BOTH frame sides is a placeholder. */
export const SUBJECT_PATH_FULL_FRAME_COVERAGE = 0.85
/** Consecutive centres closer than this (normalised euclidean) are one dwell node. */
export const SUBJECT_PATH_DWELL_EPS = 0.005
/** A path is downsampled to at most this many nodes. */
export const SUBJECT_PATH_MAX_POINTS = 120

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** The sample of a normalised box: its centre, its extent. */
export function subjectPathSampleFromBox(
  bbox: SubjectPathRect,
  timestamp?: number,
): SubjectPathSample {
  return {
    x: bbox.x + bbox.w / 2,
    y: bbox.y + bbox.h / 2,
    w: bbox.w,
    h: bbox.h,
    ...(timestamp !== undefined ? { timestamp } : {}),
  }
}

function isPlaceholder(s: SubjectPathSample): boolean {
  return (
    s.w !== undefined &&
    s.h !== undefined &&
    s.w >= SUBJECT_PATH_FULL_FRAME_COVERAGE &&
    s.h >= SUBJECT_PATH_FULL_FRAME_COVERAGE
  )
}

function downsample<T>(xs: readonly T[], max: number): readonly T[] {
  if (xs.length <= max || max < 2) return xs
  const step = (xs.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max - 1; i++) {
    const x = xs[Math.round(i * step)]
    if (x !== undefined) out.push(x)
  }
  const last = xs[xs.length - 1]
  if (last !== undefined) out.push(last)
  return out
}

function isFiniteSample(s: SubjectPathSample): boolean {
  return Number.isFinite(s.x) && Number.isFinite(s.y)
}

/**
 * The path of one track from its samples (normalised, oldest → newest).
 * Pure; never throws; malformed samples are skipped.
 */
export function buildSubjectPath(
  samples: readonly SubjectPathSample[],
  opts?: SubjectPathOptions,
): SubjectPath {
  const until = opts?.untilTimestamp
  const nodes: SubjectPathNode[] = []
  let unlocalized = 0
  // The last sample when it collapsed into the previous node — the path still
  // ENDS on it (below), so the line reaches where the subject last was.
  let tail: SubjectPathNode | null = null
  for (let index = 0; index < samples.length; index++) {
    const s = samples[index]
    if (s === undefined || !isFiniteSample(s)) continue
    if (until !== undefined && s.timestamp !== undefined && s.timestamp > until) continue
    if (isPlaceholder(s)) {
      unlocalized += 1
      continue
    }
    const ts = s.timestamp !== undefined && Number.isFinite(s.timestamp) ? s.timestamp : index
    const x = clamp01(s.x)
    const y = clamp01(s.y)
    const prev = nodes[nodes.length - 1]
    if (prev !== undefined && Math.hypot(x - prev.x, y - prev.y) < SUBJECT_PATH_DWELL_EPS) {
      nodes[nodes.length - 1] = {
        ...prev,
        samples: prev.samples + 1,
        lastTs: Math.max(prev.lastTs, ts),
      }
      tail = { x, y, samples: 1, firstTs: ts, lastTs: ts }
      continue
    }
    tail = null
    nodes.push({ x, y, samples: 1, firstTs: ts, lastTs: ts })
  }
  const end = nodes[nodes.length - 1]
  if (
    tail !== null &&
    end !== undefined &&
    end.samples > 1 &&
    (tail.x !== end.x || tail.y !== end.y)
  ) {
    nodes[nodes.length - 1] = { ...end, samples: end.samples - 1 }
    nodes.push(tail)
  }
  return {
    nodes: downsample(nodes, opts?.maxPoints ?? SUBJECT_PATH_MAX_POINTS),
    unlocalized,
  }
}

/** True when the path has something to draw (two nodes or more). */
export function isDrawableSubjectPath(path: SubjectPath): boolean {
  return path.nodes.length >= 2
}

function inside(p: SubjectPathPoint): boolean {
  return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
}

/** Liang–Barsky: the part of segment a→b inside the unit square, or null. */
function clipSegment(
  a: SubjectPathPoint,
  b: SubjectPathPoint,
): readonly [SubjectPathPoint, SubjectPathPoint] | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-dx, a.x],
    [dx, 1 - a.x],
    [-dy, a.y],
    [dy, 1 - a.y],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ]
}

function samePoint(a: SubjectPathPoint, b: SubjectPathPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

/**
 * The path as seen through `view` — a normalised rectangle of the frame (the
 * whole frame `{0,0,1,1}`, or the rectangle a crop cut). Points are re-mapped
 * into the view's own 0..1 space and the line is CLIPPED to it: a path that
 * leaves the crop and comes back is two runs. Runs of fewer than two points
 * are dropped, so an empty result means "nothing to draw".
 */
export function projectSubjectPath(
  points: readonly SubjectPathPoint[],
  view: SubjectPathRect,
): ReadonlyArray<readonly SubjectPathPoint[]> {
  if (points.length < 2 || !(view.w > 0) || !(view.h > 0)) return []
  const local = points.map((p) => ({ x: (p.x - view.x) / view.w, y: (p.y - view.y) / view.h }))
  const runs: SubjectPathPoint[][] = []
  let run: SubjectPathPoint[] = []
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1]
    const b = local[i]
    if (a === undefined || b === undefined) continue
    const seg = clipSegment(a, b)
    if (seg === null) {
      if (run.length >= 2) runs.push(run)
      run = []
      continue
    }
    const [from, to] = seg
    const last = run[run.length - 1]
    if (last === undefined || !samePoint(last, from)) {
      if (run.length >= 2) runs.push(run)
      run = [from]
    }
    run.push(to)
    if (!inside(b)) {
      if (run.length >= 2) runs.push(run)
      run = []
    }
  }
  if (run.length >= 2) runs.push(run)
  return runs
}

/** An SVG `points` attribute for a run in a `width` × `height` drawing ("x,y x,y …"). */
export function subjectPathSvgPoints(
  run: readonly SubjectPathPoint[],
  width: number,
  height: number,
): string {
  const fmt = (v: number): string => String(Math.round(v * 100) / 100)
  return run.map((p) => `${fmt(p.x * width)},${fmt(p.y * height)}`).join(' ')
}
