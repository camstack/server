/**
 * Per-track audit rules — pure, shared by the operator MCP and `camstack mcp`.
 *
 * Aggregate percentages of missing media MISS the defects an operator sees;
 * this inspects EVERY track (trajectory, media rows, timing, enrichment) and
 * emits per-track findings. Thresholds were tuned on the 2026-07-22 triage.
 * The detection rules are pure ({@link analyzeTrack}); the fetch loop around
 * them lives with each caller.
 *
 * Reading a finding, and the hard rule to LOOK at a flagged track's media before
 * claiming a fix: `.claude/skills/audit-debug-tracks/SKILL.md`.
 */
import type { MediaInfo, Track } from './wire.js'

export const FINDING_CODES = [
  'ZERO_MEDIA',
  'MISSING_FIRSTFRAME',
  'MISSING_LASTFRAME',
  'MISSING_THUMBNAIL',
  'FF_EQ_LF',
  'LASTFRAME_STALE',
  'MEDIA_STOPPED_EARLY',
  'BEST_SHOT_STALE',
  'BEST_AT_EDGE',
  'ENDED_MID_FRAME',
  'FRAGMENT_SUSPECT',
  'FACE_EXPECTED_MISSING',
  'PLATE_EXPECTED_MISSING',
  'MEDIA_UNREADABLE',
  'DEVICE_AUDIT_ERROR',
] as const
export type FindingCode = (typeof FINDING_CODES)[number]

export interface Finding {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  readonly code: FindingCode
  readonly detail: string
}

export const THRESHOLDS = {
  lastFrameStaleMs: 2_000,
  mediaCoverageMin: 0.5,
  longTrackMs: 5_000,
  betterShotRatio: 1.5,
  edgeFraction: 0.01,
  faceMinTrackMs: 3_000,
  plateMinTrackMs: 2_000,
  fragmentMaxMs: 1_500,
  fragmentNeighborWindowMs: 15_000,
} as const

/** Native sensor width the face-size estimate scales to (4K). */
const NATIVE_WIDTH_PX = 3_840
/** Rough facial height as a fraction of a standing person's bbox height. */
const FACE_FRACTION_DENOMINATOR = 7

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export const isSynthetic = (t: Track): boolean =>
  t.trackId.startsWith('pa-synth-') ||
  t.source === 'synthetic' ||
  t.source === 'sensor' ||
  t.className === 'switch'

/** Detection-grid dimensions, estimated from positions and the normalised envelope. */
export function frameDims(track: Track): {
  readonly W: number
  readonly H: number
} {
  let maxX = 0
  let maxY = 0
  for (const p of track.positions) {
    maxX = Math.max(maxX, p.bbox.x + p.bbox.w)
    maxY = Math.max(maxY, p.bbox.y + p.bbox.h)
  }
  const env = track.envelope
  const W = env?.maxX !== undefined && env.maxX > 0.05 ? maxX / env.maxX : Math.max(640, maxX)
  const H = env?.maxY !== undefined && env.maxY > 0.05 ? maxY / env.maxY : Math.max(360, maxY)
  return { W, H }
}

export function touchesEdge(b: Box, W: number, H: number): boolean {
  const f = THRESHOLDS.edgeFraction
  return b.x <= W * f || b.y <= H * f || b.x + b.w >= W * (1 - f) || b.y + b.h >= H * (1 - f)
}

export interface EnrichmentProbe {
  /** `null`: not checked (the track did not qualify). */
  readonly face: 'held' | 'missing' | null
  readonly plate: 'held' | 'missing' | null
}

export interface AnalyzeInput {
  readonly track: Track
  /** The other tracks of the same camera and window, for fragment detection. */
  readonly siblings: readonly Track[]
  /** `null` = media could not be read (every media finding is then UNKNOWN). */
  readonly media: readonly MediaInfo[] | null
  /** firstFrame/lastFrame byte-identical; `null` = not determined. */
  readonly ffEqualsLf: boolean | null
  readonly enrichment: EnrichmentProbe
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1)

function faceVerdict(track: Track, W: number, dur: number): string {
  const maxH = Math.max(...track.positions.map((p) => p.bbox.h), 0)
  const detPx = maxH / FACE_FRACTION_DENOMINATOR
  const nativePx = detPx * (NATIVE_WIDTH_PX / W)
  const verdict =
    nativePx >= 60
      ? 'UNEXPECTED — well above native gate, investigate detector/step'
      : nativePx >= 30
        ? 'borderline vs native gate'
        : 'likely below native gate (expected miss)'
  return `no face held for ${seconds(dur)}s; est. face ~${detPx.toFixed(0)}px detection-space (~${nativePx.toFixed(0)}px native) — ${verdict}`
}

/** The audit rules for one track. Pure: same input, same findings. */
export function analyzeTrack(input: AnalyzeInput): Finding[] {
  const { track, media } = input
  const findings: Finding[] = []
  const flag = (code: FindingCode, detail: string): void => {
    findings.push({
      deviceId: track.deviceId,
      trackId: track.trackId,
      className: track.className,
      code,
      detail,
    })
  }
  if (media === null) {
    flag(
      'MEDIA_UNREADABLE',
      'media index could not be read — media findings are unknown, not absent',
    )
    return findings
  }
  const dur = track.lastSeen - track.firstSeen
  const pos = track.positions
  const { W, H } = frameDims(track)
  const closed = track.active !== true
  const ofKind = (kind: string): MediaInfo | undefined => media.find((m) => m.kind === kind)
  const ff = ofKind('firstFrame')
  const lf = ofKind('lastFrame')
  const thumb = ofKind('thumbnail')

  if (media.length === 0)
    flag('ZERO_MEDIA', `dur=${dur}ms positions=${pos.length} state=${track.state}`)
  if (closed && media.length > 0) {
    if (!ff) flag('MISSING_FIRSTFRAME', `dur=${dur}ms media=${media.length}`)
    if (!lf) flag('MISSING_LASTFRAME', `dur=${dur}ms media=${media.length}`)
    if (!thumb) flag('MISSING_THUMBNAIL', `dur=${dur}ms media=${media.length}`)
  }
  if (input.ffEqualsLf === true) flag('FF_EQ_LF', 'firstFrame and lastFrame byte-identical')

  if (closed && lf && track.lastSeen - lf.timestamp > THRESHOLDS.lastFrameStaleMs) {
    flag('LASTFRAME_STALE', `lastFrame ${seconds(track.lastSeen - lf.timestamp)}s before close`)
  }
  if (closed && dur >= THRESHOLDS.longTrackMs && media.length > 0) {
    const lastMediaTs = Math.max(...media.map((m) => m.timestamp))
    const coverage = (lastMediaTs - track.firstSeen) / dur
    if (coverage < THRESHOLDS.mediaCoverageMin) {
      flag(
        'MEDIA_STOPPED_EARLY',
        `captures ceased at ${(coverage * 100).toFixed(0)}% of a ${seconds(dur)}s track`,
      )
    }
  }

  if (thumb && pos.length > 2) {
    const atThumb = pos.reduce((best, p) =>
      Math.abs(p.timestamp - thumb.timestamp) < Math.abs(best.timestamp - thumb.timestamp)
        ? p
        : best,
    )
    const areaAtThumb = atThumb.bbox.w * atThumb.bbox.h
    if (touchesEdge(atThumb.bbox, W, H)) {
      flag(
        'BEST_AT_EDGE',
        `bbox ${JSON.stringify(atThumb.bbox)} touches frame edge at capture (grid ~${W.toFixed(0)}x${H.toFixed(0)}) — letterbox/cut risk`,
      )
    }
    let better: { area: number; at: number } | null = null
    for (const p of pos) {
      if (p.timestamp <= thumb.timestamp) continue
      const area = p.bbox.w * p.bbox.h
      if (area >= areaAtThumb * THRESHOLDS.betterShotRatio && !touchesEdge(p.bbox, W, H)) {
        if (!better || area > better.area) better = { area, at: p.timestamp }
      }
    }
    if (better) {
      flag(
        'BEST_SHOT_STALE',
        `thumbnail@+${seconds(thumb.timestamp - track.firstSeen)}s area=${areaAtThumb.toFixed(0)}; in-frame area=${better.area.toFixed(0)} (${(better.area / areaAtThumb).toFixed(1)}x) existed @+${seconds(better.at - track.firstSeen)}s`,
      )
    }
  }

  if (closed && pos.length > 2) {
    const last = pos[pos.length - 1]!
    if (!touchesEdge(last.bbox, W, H) && dur >= THRESHOLDS.fragmentMaxMs) {
      flag(
        'ENDED_MID_FRAME',
        `last bbox ${JSON.stringify(last.bbox)} well inside ~${W.toFixed(0)}x${H.toFixed(0)} — early loss suspect (dur=${seconds(dur)}s)`,
      )
    }
  }
  if (closed && dur <= THRESHOLDS.fragmentMaxMs && track.state === 'entered') {
    const sibling = input.siblings.find(
      (o) =>
        o.trackId !== track.trackId &&
        o.className === track.className &&
        Math.abs(o.firstSeen - track.lastSeen) <= THRESHOLDS.fragmentNeighborWindowMs,
    )
    flag(
      'FRAGMENT_SUSPECT',
      `dur=${dur}ms never confirmed${sibling ? `; same-class sibling ${sibling.trackId.slice(0, 8)} within ${THRESHOLDS.fragmentNeighborWindowMs / 1000}s` : ''}`,
    )
  }

  if (input.enrichment.face === 'missing') flag('FACE_EXPECTED_MISSING', faceVerdict(track, W, dur))
  if (input.enrichment.plate === 'missing') {
    flag('PLATE_EXPECTED_MISSING', `no plate for ${seconds(dur)}s vehicle track`)
  }
  return findings
}

export function qualifiesForFace(track: Track, faceDevices: ReadonlySet<number>): boolean {
  return (
    track.className === 'person' &&
    faceDevices.has(track.deviceId) &&
    track.lastSeen - track.firstSeen >= THRESHOLDS.faceMinTrackMs
  )
}

export function qualifiesForPlate(track: Track, plateDevices: ReadonlySet<number>): boolean {
  return (
    track.className === 'vehicle' &&
    plateDevices.has(track.deviceId) &&
    track.lastSeen - track.firstSeen >= THRESHOLDS.plateMinTrackMs
  )
}
