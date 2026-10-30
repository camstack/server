/**
 * Per-track deep audit — the operator's track audit, ported into a tool.
 *
 * Aggregate percentages of missing media MISS the defects an operator sees;
 * this inspects EVERY track (trajectory, media rows, timing, enrichment) and
 * emits per-track findings. Thresholds were tuned on the 2026-07-22 triage.
 * The detection rules are pure and live in `@camstack/develop` (shared with
 * `camstack mcp`); {@link auditTracks} is the read-only fetch loop around them.
 *
 * Reading a finding, and the hard rule to LOOK at a flagged track's media before
 * claiming a fix: `.claude/skills/audit-debug-tracks/SKILL.md`.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import {
  FINDING_CODES,
  analyzeTrack,
  isSynthetic,
  qualifiesForFace,
  qualifiesForPlate,
  toToolOutput,
  type Finding,
  type FindingCode,
  type EnrichmentProbe,
} from '@camstack/develop'
import {
  MediaInfoSchema,
  MediaWithBytesSchema,
  RecentTracksPageSchema,
  CameraStatusSchema,
  parseWire,
  type MediaInfo,
  type Track,
} from './wire.js'
export { analyzeTrack, qualifiesForFace, qualifiesForPlate }

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
    const found = await hub.query(method, {
      deviceId: track.deviceId,
      trackId: track.trackId,
    })
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
      const found = analyzeTrack({
        track,
        siblings: tracks,
        media,
        ffEqualsLf,
        enrichment,
      })
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
