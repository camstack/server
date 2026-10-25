/**
 * Per-track deep audit — the operator's track audit, ported into a tool.
 *
 * Aggregate percentages of missing media MISS the defects an operator sees;
 * this inspects EVERY track (trajectory, media rows, timing, enrichment) and
 * emits per-track findings. Thresholds were tuned on the 2026-07-22 triage.
 * The detection rules are pure ({@link analyzeTrack}); {@link auditTracks} is
 * the read-only fetch loop around them.
 *
 * Reading a finding, and the hard rule to LOOK at a flagged track's media before
 * claiming a fix: `.claude/skills/audit-debug-tracks/SKILL.md`.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { toToolOutput } from './redact.js'
import {
  MediaInfoSchema,
  MediaWithBytesSchema,
  RecentTracksPageSchema,
  CameraStatusSchema,
  parseWire,
  type MediaInfo,
  type Track,
} from './wire.js'

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

const isSynthetic = (t: Track): boolean =>
  t.trackId.startsWith('pa-synth-') ||
  t.source === 'synthetic' ||
  t.source === 'sensor' ||
  t.className === 'switch'

/** Detection-grid dimensions, estimated from positions and the normalised envelope. */
export function frameDims(track: Track): { readonly W: number; readonly H: number } {
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

export interface AuditArgs {
  /** Cameras to audit; omitted = every camera the orchestrator reports. */
  readonly deviceIds?: readonly number[]
  readonly hours: number
  /** Cameras where a face/plate is expected for long enough person/vehicle tracks. */
  readonly faceDevices?: readonly number[]
  readonly plateDevices?: readonly number[]
  /** Hard bound on tracks inspected (each costs 2–4 reads). */
  readonly maxTracks: number
}

export interface AuditReport {
  readonly window: { readonly since: number; readonly until: number }
  readonly tracksAudited: number
  readonly truncated: boolean
  readonly summary: Readonly<Record<string, number>>
  readonly findings: readonly Finding[]
  readonly cleanTracks: number
}

const PAGE = 200
const MAX_PAGES = 30

async function listWindow(
  hub: OpsHub,
  deviceId: number,
  since: number,
  until: number,
): Promise<Track[]> {
  const out: Track[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await hub.query('pipelineAnalytics.listRecentTracks', {
      deviceIds: [deviceId],
      since,
      until,
      limit: PAGE,
      projection: 'full',
      ...(cursor ? { cursor } : {}),
    })
    const parsed = parseWire(RecentTracksPageSchema, raw, 'pipelineAnalytics.listRecentTracks')
    out.push(...parsed.tracks)
    cursor = parsed.nextCursor ?? undefined
    if (!cursor || parsed.tracks.length === 0) break
  }
  return out.filter((t) => t.firstSeen >= since && t.firstSeen <= until && !isSynthetic(t))
}

async function readMedia(hub: OpsHub, track: Track): Promise<MediaInfo[] | null> {
  try {
    const raw = await hub.query('pipelineAnalytics.listTrackMedia', {
      trackId: track.trackId,
      deviceId: track.deviceId,
    })
    return parseWire(z.array(MediaInfoSchema), raw, 'pipelineAnalytics.listTrackMedia')
  } catch {
    // Named, not swallowed: the caller records MEDIA_UNREADABLE for this track.
    return null
  }
}

const sha1 = (base64: string): string =>
  createHash('sha1').update(Buffer.from(base64, 'base64')).digest('hex')

/** Equal sizes make identical bytes possible; only then are the two blobs fetched and hashed. */
async function firstEqualsLast(
  hub: OpsHub,
  track: Track,
  media: readonly MediaInfo[],
): Promise<boolean | null> {
  const ff = media.find((m) => m.kind === 'firstFrame')
  const lf = media.find((m) => m.kind === 'lastFrame')
  if (!ff || !lf) return null
  if (ff.sizeBytes !== lf.sizeBytes) return false
  const raw = await hub.query('pipelineAnalytics.getTrackMedia', {
    trackId: track.trackId,
    deviceId: track.deviceId,
    kinds: ['firstFrame', 'lastFrame'],
  })
  const rows = parseWire(z.array(MediaWithBytesSchema), raw, 'pipelineAnalytics.getTrackMedia')
  const a = rows.find((r) => r.kind === 'firstFrame')?.base64
  const b = rows.find((r) => r.kind === 'lastFrame')?.base64
  return a && b ? sha1(a) === sha1(b) : null
}

async function probe(hub: OpsHub, method: string, track: Track): Promise<'held' | 'missing'> {
  try {
    const found = await hub.query(method, { deviceId: track.deviceId, trackId: track.trackId })
    return found === null || found === undefined ? 'missing' : 'held'
  } catch {
    return 'held' // unknown is not a finding
  }
}

async function resolveDevices(hub: OpsHub, args: AuditArgs): Promise<number[]> {
  if (args.deviceIds && args.deviceIds.length > 0) return [...args.deviceIds]
  const raw = await hub.query('pipelineOrchestrator.getCameraStatuses', {})
  return parseWire(z.array(CameraStatusSchema), raw, 'pipelineOrchestrator.getCameraStatuses').map(
    (c) => c.deviceId,
  )
}

export async function auditTracks(
  hub: OpsHub,
  args: AuditArgs,
  now: number = Date.now(),
): Promise<AuditReport> {
  const since = now - args.hours * 3_600_000
  const faceDevices = new Set(args.faceDevices ?? [])
  const plateDevices = new Set(args.plateDevices ?? [])
  const findings: Finding[] = []
  let audited = 0
  let truncated = false
  const flagged = new Set<string>()

  for (const deviceId of await resolveDevices(hub, args)) {
    if (audited >= args.maxTracks) {
      truncated = true
      break
    }
    let tracks: Track[]
    try {
      tracks = await listWindow(hub, deviceId, since, now)
    } catch (err) {
      findings.push({
        deviceId,
        trackId: '-',
        className: '-',
        code: 'DEVICE_AUDIT_ERROR',
        detail: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    for (const track of tracks) {
      if (audited >= args.maxTracks) {
        truncated = true
        break
      }
      audited += 1
      const media = await readMedia(hub, track)
      const ffEqualsLf = media ? await firstEqualsLast(hub, track, media) : null
      const enrichment: EnrichmentProbe = {
        face: qualifiesForFace(track, faceDevices)
          ? await probe(hub, 'faceGallery.getFaceByTrack', track)
          : null,
        plate: qualifiesForPlate(track, plateDevices)
          ? await probe(hub, 'plateGallery.getPlateByTrack', track)
          : null,
      }
      const found = analyzeTrack({ track, siblings: tracks, media, ffEqualsLf, enrichment })
      if (found.length > 0) flagged.add(track.trackId)
      findings.push(...found)
    }
  }

  const summary: Record<string, number> = {}
  for (const f of findings) summary[f.code] = (summary[f.code] ?? 0) + 1
  const order = (code: FindingCode): number => FINDING_CODES.indexOf(code)
  return {
    window: { since, until: now },
    tracksAudited: audited,
    truncated,
    summary,
    findings: findings.toSorted((a, b) => order(a.code) - order(b.code)),
    cleanTracks: audited - flagged.size,
  }
}

/** The audit as tool output (bounded; ids shortened). */
export async function auditTracksTool(
  hub: OpsHub,
  args: AuditArgs,
  now?: number,
): Promise<unknown> {
  const report = await auditTracks(hub, args, now)
  return toToolOutput({
    ...report,
    findings: report.findings.map((f) => ({
      ...f,
      trackId: f.trackId === '-' ? f.trackId : f.trackId.slice(0, 8),
      fullTrackId: f.trackId,
    })),
    next: 'Open the flagged track media (pipelineAnalytics.getTrackMedia) and LOOK before claiming a fix — .claude/skills/audit-debug-tracks/SKILL.md',
  })
}
