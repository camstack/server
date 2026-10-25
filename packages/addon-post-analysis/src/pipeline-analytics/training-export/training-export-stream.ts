/**
 * Stream the planned dataset as a tar, one file at a time.
 *
 * The archive is never assembled — not in memory, not on disk. Each entry is a
 * header, a blob and its padding, written and forgotten, so peak memory is ONE
 * JPEG regardless of whether the export is 12 files or 12,000. That is the
 * difference between this and the recording-export lifecycle it otherwise
 * resembles: an MP4 export mux takes minutes of CPU and has to be a job with a
 * temp file, while copying stored bytes has nothing to precompute, so a job
 * record here would be state for its own sake.
 *
 * Three properties are load-bearing:
 *
 *  - **The manifest goes FIRST**, so the archive self-describes even if a reader
 *    only pulls the first entry (the `system-backup` archive does the same, and
 *    for the same reason).
 *  - **The pass yields between files** (`pacingMs`). The measured harm behind
 *    D56 was a bulk media read starving hub-main for 43 minutes; a pause is the
 *    only thing standing between bulk maintenance and that.
 *  - **Every dropped file is reported**, in the manifest AND in a log line. A
 *    blob whose row survived but whose file did not is the single most likely
 *    failure here, and a training set that is quietly short a few hundred crops
 *    is worse than one that failed loudly.
 */

import type { IScopedLogger } from '@camstack/types'
import { displayLabel } from '../pipeline/label-tier.js'
import type { PlannedTrack, TrainingExportPlan } from './dataset-plan.js'
import { tarBlocks, tarNameTooLong, tarTrailer } from './tar-stream.js'

export const MANIFEST_ENTRY_NAME = 'manifest.json'
const DEFAULT_PACING_MS = 25

/** Where the archive goes. `write` resolves when the sink is ready for more. */
export interface ArchiveSink {
  readonly write: (chunk: Buffer) => Promise<void>
  readonly end: () => Promise<void>
}

/** Resolve one media key to its bytes, or `null` when the blob is unreadable. */
export type BlobReader = (mediaId: number) => Promise<Buffer | null>

export interface StreamDatasetDeps {
  readonly plan: TrainingExportPlan
  readonly sink: ArchiveSink
  readonly readBlob: BlobReader
  readonly logger: IScopedLogger
  readonly now: () => number
  /** Pause between files. Injected so tests do not sleep. */
  readonly pace: (ms: number) => Promise<void>
  readonly pacingMs?: number
  /** Abort between files — a disconnected client must not keep reading disk. */
  readonly aborted?: () => boolean
}

export interface StreamDatasetResult {
  readonly filesWritten: number
  readonly bytesWritten: number
  readonly filesMissing: number
  readonly aborted: boolean
}

/** A track as the manifest describes it — the plan minus the media keys. */
interface ManifestTrack {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly classes: readonly string[]
  readonly zonesVisited: readonly string[]
  readonly importance?: number
  readonly files: readonly { path: string; kind: string; timestamp: number; sizeBytes: number }[]
}

function manifestTrack(track: PlannedTrack): ManifestTrack {
  return {
    trackId: track.trackId,
    deviceId: track.deviceId,
    className: track.className,
    ...(displayLabel(track) !== undefined ? { label: displayLabel(track) } : {}),
    firstSeen: track.firstSeen,
    lastSeen: track.lastSeen,
    classes: track.classes,
    zonesVisited: track.zonesVisited,
    ...(track.importance !== undefined ? { importance: track.importance } : {}),
    files: track.files.map((f) => ({
      path: f.archivePath,
      kind: f.kind,
      timestamp: f.timestamp,
      sizeBytes: f.sizeBytes,
    })),
  }
}

/**
 * The manifest body.
 *
 * `mediaId` is deliberately NOT in it. The archive is a dataset handed to a
 * training pipeline, and a store-internal key is meaningless outside the hub
 * that issued it — worse, it invites a consumer to believe it can fetch by that
 * key later, on media the retention pin does not guarantee is still there once
 * the mark is removed. The archive path is the identity inside the archive.
 */
export function buildManifest(plan: TrainingExportPlan): Buffer {
  const body = {
    format: 'camstack-training-export',
    version: 1,
    generatedAt: plan.generatedAt,
    selection: "tracks in retrain staging (retrainStatus: 'staging')",
    trackCount: plan.trackCount,
    fileCount: plan.fileCount,
    byteCount: plan.byteCount,
    truncated: plan.truncated,
    devices: plan.totals,
    tracks: plan.tracks.map(manifestTrack),
  }
  return Buffer.from(JSON.stringify(body, null, 2), 'utf8')
}

/** Write the whole archive to the sink. */
export async function streamDataset(deps: StreamDatasetDeps): Promise<StreamDatasetResult> {
  const { plan, sink, readBlob, logger, now, pace } = deps
  const pacingMs = deps.pacingMs ?? DEFAULT_PACING_MS
  const mtimeMs = now()

  for (const block of tarBlocks({
    name: MANIFEST_ENTRY_NAME,
    body: buildManifest(plan),
    mtimeMs,
  })) {
    await sink.write(block)
  }

  let filesWritten = 0
  let bytesWritten = 0
  let filesMissing = 0
  let aborted = false

  for (const track of plan.tracks) {
    for (const file of track.files) {
      if (deps.aborted?.() === true) {
        aborted = true
        break
      }
      if (tarNameTooLong(file.archivePath)) {
        // Cannot be represented, so it is dropped — and said out loud, with the
        // deviceId, because a dataset short one crop looks exactly like a track
        // that never had one.
        filesMissing += 1
        logger.warn('training export skipped a file — path too long for the archive', {
          tags: { deviceId: track.deviceId },
          meta: { deviceId: track.deviceId, trackId: track.trackId, path: file.archivePath },
        })
        continue
      }
      const bytes = await readBlob(file.mediaId)
      if (bytes === null) {
        filesMissing += 1
        logger.warn('training export skipped a file — media unreadable', {
          tags: { deviceId: track.deviceId },
          meta: { deviceId: track.deviceId, trackId: track.trackId, mediaId: file.mediaId },
        })
        continue
      }
      for (const block of tarBlocks({ name: file.archivePath, body: bytes, mtimeMs })) {
        await sink.write(block)
      }
      filesWritten += 1
      bytesWritten += bytes.length
      if (pacingMs > 0) await pace(pacingMs)
    }
    if (aborted) break
  }

  await sink.write(tarTrailer())
  await sink.end()

  logger.info('training export complete', {
    meta: {
      tracks: plan.trackCount,
      filesWritten,
      filesMissing,
      bytesWritten,
      truncated: plan.truncated,
      aborted,
    },
  })

  return { filesWritten, bytesWritten, filesMissing, aborted }
}
