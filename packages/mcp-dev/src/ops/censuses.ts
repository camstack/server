/**
 * Read-only censuses, ported from `scripts/hub/{model-pin-census,retrain-census,
 * keyframe-presence}.mjs` (retired — they ran through the password-era hub.mjs).
 *
 * Rule kept from the scripts: a failed READ is never "nothing found". Every
 * census either completes or throws; it never reports zero from a read it could
 * not make.
 */
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { toToolOutput } from './redact.js'
import { CameraStatusSchema, MediaInfoSchema, TrackSchema, parseWire } from './wire.js'

// ── model pin census (D661) ─────────────────────────────────────────────────

const DirectorySchema = z.looseObject({
  complete: z.boolean().optional(),
  nodes: z.array(z.looseObject({ id: z.string(), isOnline: z.boolean().optional() })),
})

const ClusterFieldsSchema = z
  .looseObject({
    sections: z
      .array(
        z.looseObject({
          fields: z
            .array(z.looseObject({ key: z.string().optional(), value: z.unknown().optional() }))
            .optional(),
        }),
      )
      .optional(),
  })
  .nullable()

export interface PinHit {
  readonly where: string
  readonly modelId: string
}

/** Every model id whose quoted string appears in `value`. */
export function pinsIn(where: string, value: unknown, ids: readonly string[]): PinHit[] {
  const text = JSON.stringify(value) ?? ''
  return ids.filter((id) => text.includes(`"${id}"`)).map((modelId) => ({ where, modelId }))
}

/**
 * Is any of `modelIds` pinned anywhere in the cluster (per-node step models, the
 * `clusterModel:*` rows, the custom model registry)? A camera carries no model
 * (D927), so there is no per-camera row to read. Disk presence is NOT checked: that needed SSH, which the ops
 * toolset does not use.
 */
export async function modelPinCensus(hub: OpsHub, modelIds: readonly string[]): Promise<unknown> {
  const hits: PinHit[] = []
  const notes: string[] = []
  const directory = parseWire(
    DirectorySchema,
    await hub.query('nodes.directory'),
    'nodes.directory',
  )
  if (directory.complete !== true) {
    throw new Error(
      'nodes.directory answered complete:false — the node list may be missing nodes; the census proves nothing',
    )
  }
  for (const node of directory.nodes) {
    if (node.isOnline) {
      const devices = await hub.query('pipelineOrchestrator.getNodeInferenceDevices', {
        nodeId: node.id,
      })
      hits.push(...pinsIn(`inference devices ${node.id}`, devices, modelIds))
    } else {
      notes.push(
        `node ${node.id} is offline: its persisted pins are read from listAgentSettings only`,
      )
    }
  }
  hits.push(
    ...pinsIn(
      'agent settings',
      await hub.query('pipelineOrchestrator.listAgentSettings'),
      modelIds,
    ),
    ...pinsIn('custom model registry', await hub.query('customModelRegistry.listModels'), modelIds),
  )
  const orchestrator = parseWire(
    ClusterFieldsSchema,
    await hub.query('addonSettings.getGlobalSettings', { addonId: 'pipeline-orchestrator' }),
    'addonSettings.getGlobalSettings',
  )
  let clusterRows = 0
  for (const section of orchestrator?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (!(field.key ?? '').startsWith('clusterModel:')) continue
      clusterRows += 1
      hits.push(...pinsIn(`cluster row ${field.key}`, { value: field.value }, modelIds))
    }
  }
  if (clusterRows === 0) {
    throw new Error(
      'no clusterModel:* field in the pipeline-orchestrator settings — the shape changed; the census proves nothing',
    )
  }
  return toToolOutput({
    pinned: hits.length > 0,
    hits,
    notes,
    checked: { nodes: directory.nodes.length, clusterRows },
    notChecked: 'files on disk (needs shell access to each node — outside the ops toolset)',
  })
}

// ── retrain corpus census ───────────────────────────────────────────────────

const StagingTrackSchema = z.looseObject({
  trackId: z.string(),
  className: z.string(),
  deviceId: z.number(),
  annotationCount: z.number(),
})
const RetrainFramesSchema = z.looseObject({
  copies: z.array(z.unknown()),
  candidates: z.array(z.unknown()),
})
const CustomModelSchema = z.looseObject({
  stepId: z.string(),
  entry: z.looseObject({
    id: z.string(),
    formats: z.record(z.string(), z.unknown()),
    labels: z.array(z.unknown()),
  }),
})

const STAGING_LIMIT = 500

function tally<T>(rows: readonly T[], keyOf: (row: T) => string | number): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const key = String(keyOf(row))
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export interface RetrainCensusArgs {
  /** Upper bound on per-track frame reads (the script read all of them). */
  readonly maxFrameReads?: number
}

export async function retrainCensus(hub: OpsHub, args: RetrainCensusArgs = {}): Promise<unknown> {
  const staging = parseWire(
    z.array(StagingTrackSchema),
    await hub.query('pipelineAnalytics.listRetrainStaging', { limit: STAGING_LIMIT }),
    'pipelineAnalytics.listRetrainStaging',
  )
  const budget = args.maxFrameReads ?? 100
  const sampled = staging.slice(0, budget)
  let copies = 0
  let candidates = 0
  for (const track of sampled) {
    const frames = parseWire(
      RetrainFramesSchema,
      await hub.query('pipelineAnalytics.listRetrainFrames', { trackId: track.trackId }),
      'pipelineAnalytics.listRetrainFrames',
    )
    copies += frames.copies.length
    candidates += frames.candidates.length
  }
  const unstamped = await hub.query('pipelineAnalytics.countUnstampedEventMedia', {})
  const models = parseWire(
    z.array(CustomModelSchema),
    await hub.query('customModelRegistry.listModels'),
    'customModelRegistry.listModels',
  )
  return toToolOutput({
    staging: {
      tracks: staging.length,
      truncated: staging.length >= STAGING_LIMIT,
      byClass: tally(staging, (t) => t.className),
      byDevice: tally(staging, (t) => t.deviceId),
      annotations: staging.reduce((sum, t) => sum + t.annotationCount, 0),
    },
    retrainFrames: {
      copies,
      candidatesOnStagingTracks: candidates,
      tracksRead: sampled.length,
      partial: sampled.length < staging.length,
    },
    unstampedEventMedia: unstamped,
    customModels: {
      count: models.length,
      entries: models.map((m) => ({
        stepId: m.stepId,
        id: m.entry.id,
        formats: Object.keys(m.entry.formats),
        labels: m.entry.labels.length,
      })),
    },
  })
}

// ── keyframe / zero-media presence ──────────────────────────────────────────

export interface KeyframeArgs {
  readonly hours?: number
  readonly minDurationSec?: number
  /** Bound on tracks inspected per camera (each costs one media-index read). */
  readonly maxTracksPerCamera?: number
}

interface PresenceRow {
  deviceId: number
  tracks: number
  keyFrame: number
  thumbnail: number
  zeroMedia: number
  sampled: boolean
}

const pct = (n: number, d: number): number | null =>
  d === 0 ? null : Math.round((1000 * n) / d) / 10

/**
 * Per-camera keyFrame / thumbnail / zero-media presence over a window — the
 * fleet number that caught D419 (99.5 % to 76.6 %). The script counted through
 * `addons.custom debug.analyze` (a mutation); this reads each track's media
 * index with the query `listTrackMedia`, and samples evenly when a camera has
 * more eligible tracks than the bound.
 */
export async function keyframePresence(
  hub: OpsHub,
  args: KeyframeArgs = {},
  now: number = Date.now(),
): Promise<unknown> {
  const hours = args.hours ?? 6
  const minDurationMs = (args.minDurationSec ?? 1.5) * 1000
  const bound = args.maxTracksPerCamera ?? 150
  const cameras = parseWire(
    z.array(CameraStatusSchema),
    await hub.query('pipelineOrchestrator.getCameraStatuses', {}),
    'pipelineOrchestrator.getCameraStatuses',
  )
  const rows: PresenceRow[] = []
  for (const cam of cameras) {
    const raw = await hub.query('pipelineAnalytics.listTracks', {
      deviceId: cam.deviceId,
      since: now - hours * 3_600_000,
      until: now,
      projection: 'slim',
      limit: 2000,
    })
    const tracks = parseWire(z.array(TrackSchema), raw, 'pipelineAnalytics.listTracks').filter(
      (t) => t.lastSeen - t.firstSeen >= minDurationMs && t.source !== 'audio',
    )
    if (tracks.length === 0) continue
    const stride = Math.max(1, Math.ceil(tracks.length / bound))
    const picked = tracks.filter((_, i) => i % stride === 0).slice(0, bound)
    const row: PresenceRow = {
      deviceId: cam.deviceId,
      tracks: 0,
      keyFrame: 0,
      thumbnail: 0,
      zeroMedia: 0,
      sampled: picked.length < tracks.length,
    }
    for (const track of picked) {
      const media = parseWire(
        z.array(MediaInfoSchema),
        await hub.query('pipelineAnalytics.listTrackMedia', {
          trackId: track.trackId,
          deviceId: cam.deviceId,
        }),
        'pipelineAnalytics.listTrackMedia',
      )
      const kinds = new Set(media.map((m) => m.kind))
      row.tracks += 1
      if (kinds.has('keyFrame')) row.keyFrame += 1
      if (kinds.has('thumbnail')) row.thumbnail += 1
      if (media.length === 0) row.zeroMedia += 1
    }
    rows.push(row)
  }
  const fleet = rows.reduce(
    (acc, r) => ({
      tracks: acc.tracks + r.tracks,
      keyFrame: acc.keyFrame + r.keyFrame,
      thumbnail: acc.thumbnail + r.thumbnail,
      zeroMedia: acc.zeroMedia + r.zeroMedia,
    }),
    { tracks: 0, keyFrame: 0, thumbnail: 0, zeroMedia: 0 },
  )
  return toToolOutput({
    window: { hours, minDurationSec: minDurationMs / 1000 },
    cameras: rows
      .toSorted((a, b) => a.deviceId - b.deviceId)
      .map((r) => ({
        deviceId: r.deviceId,
        tracks: r.tracks,
        sampled: r.sampled,
        keyFramePct: pct(r.keyFrame, r.tracks),
        thumbnailPct: pct(r.thumbnail, r.tracks),
        zeroMediaPct: pct(r.zeroMedia, r.tracks),
      })),
    fleet: {
      tracks: fleet.tracks,
      keyFramePct: pct(fleet.keyFrame, fleet.tracks),
      thumbnailPct: pct(fleet.thumbnail, fleet.tracks),
      zeroMediaPct: pct(fleet.zeroMedia, fleet.tracks),
    },
    reference:
      '2026-09-09, 32 cameras: keyFrame 99.5 % before D419, 76.6 % under it; zero media 0.0 % to 11.8 %',
  })
}
