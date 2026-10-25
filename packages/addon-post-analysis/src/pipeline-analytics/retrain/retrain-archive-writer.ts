/**
 * The annotated archive body, written to ANY sink.
 *
 * One body, two consumers: the data-plane download (`retrain-export-handler`,
 * sink = the HTTP response) and `pipelineAnalytics.writeRetrainArchive` (sink
 * = one streamed HTTP upload to a training provider). The disciplines are the
 * training export's: the manifest is the first entry, one JPEG is in memory at
 * a time, a pause between files keeps the hub's one thread available, and the
 * batch id is stamped only on what the sink actually received.
 */
import { createHash } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import { tarBlocks, tarNameTooLong, tarTrailer } from '../training-export/tar-stream.js'
import type { RetrainExportManifest, RetrainManifestAnnotation } from './retrain-export.js'
import type { RetrainFrame } from './retrain-frame-store.js'

export const RETRAIN_MANIFEST_ENTRY = 'annotations.json'

/** Pause between files so a large export cannot monopolise the hub's thread. */
const RETRAIN_ARCHIVE_PACING_MS = 25

export interface RetrainExportPlan {
  readonly manifest: RetrainExportManifest
  readonly frames: readonly RetrainFrame[]
}

/** Where the bytes go. `write` resolves when the chunk may be followed. */
export interface RetrainArchiveSink {
  readonly write: (chunk: Buffer) => Promise<void>
}

/** Cut one subject crop from a frame copy; `null` = cannot be cut. */
export type RetrainCropCutter = (
  frameBytes: Buffer,
  frame: RetrainFrame,
  annotation: RetrainManifestAnnotation,
) => Promise<Buffer | null>

export interface WriteRetrainArchiveDeps {
  readonly plan: RetrainExportPlan
  readonly readFrame: (frame: RetrainFrame) => Promise<Buffer | null>
  /** Required when the manifest's layout is `crops`. */
  readonly cutCrop?: RetrainCropCutter
  readonly sink: RetrainArchiveSink
  readonly markExported: (frameIds: readonly string[], batchId: string) => Promise<void>
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly pacingMs?: number
}

export interface RetrainArchiveStats {
  readonly batchId: string
  readonly frames: number
  readonly crops: number
  readonly annotations: number
  readonly missing: number
  readonly bytes: number
  readonly sha256: string
}

export async function writeRetrainArchiveTo(
  deps: WriteRetrainArchiveDeps,
): Promise<RetrainArchiveStats> {
  const { plan, logger } = deps
  const pacingMs = deps.pacingMs ?? RETRAIN_ARCHIVE_PACING_MS
  const hash = createHash('sha256')
  let bytes = 0
  const write = async (chunk: Buffer): Promise<void> => {
    hash.update(chunk)
    bytes += chunk.length
    await deps.sink.write(chunk)
  }
  const writeEntry = async (name: string, body: Buffer, mtimeMs: number): Promise<void> => {
    for (const block of tarBlocks({ name, body, mtimeMs })) await write(block)
  }
  const mtimeMs = deps.now()
  await writeEntry(
    RETRAIN_MANIFEST_ENTRY,
    Buffer.from(JSON.stringify(plan.manifest, null, 2), 'utf8'),
    mtimeMs,
  )

  const byId = new Map(plan.manifest.frames.map((f) => [f.frameId, f]))
  const shipped: string[] = []
  let missing = 0
  let crops = 0
  for (const frame of plan.frames) {
    const entry = byId.get(frame.frameId)
    if (entry === undefined) continue
    if (tarNameTooLong(entry.path)) {
      // Dropped, and SAID so with the deviceId: a dataset short one frame
      // looks exactly like a track that never contributed one.
      missing += 1
      logger.warn('retrain export skipped a frame — path too long for the archive', {
        tags: { deviceId: frame.deviceId },
        meta: { trackId: frame.trackId, frameId: frame.frameId, path: entry.path },
      })
      continue
    }
    const frameBytes = await deps.readFrame(frame)
    if (frameBytes === null) {
      missing += 1
      logger.warn('retrain export skipped a frame — the COPY is unreadable', {
        tags: { deviceId: frame.deviceId },
        meta: { trackId: frame.trackId, frameId: frame.frameId },
      })
      continue
    }
    await writeEntry(entry.path, frameBytes, mtimeMs)
    for (const annotation of entry.annotations) {
      if (annotation.cropPath === undefined) continue
      const crop = deps.cutCrop ? await deps.cutCrop(frameBytes, frame, annotation) : null
      if (crop === null) {
        logger.warn('retrain export skipped a crop — it could not be cut', {
          tags: { deviceId: frame.deviceId },
          meta: {
            frameId: frame.frameId,
            annotationId: annotation.id,
            cropPath: annotation.cropPath,
          },
        })
        continue
      }
      await writeEntry(annotation.cropPath, crop, mtimeMs)
      crops += 1
    }
    shipped.push(frame.frameId)
    if (pacingMs > 0) await new Promise((resolve) => setTimeout(resolve, pacingMs))
  }
  await write(tarTrailer())

  // Stamped AFTER the archive was written, and only for the frames that made
  // it: a batch id on an annotation nobody received is how the same subject
  // silently never gets exported again.
  await deps.markExported(shipped, plan.manifest.batchId)
  const stats: RetrainArchiveStats = {
    batchId: plan.manifest.batchId,
    frames: shipped.length,
    crops,
    annotations: plan.manifest.annotationCount,
    missing,
    bytes,
    sha256: hash.digest('hex'),
  }
  logger.info('retrain export complete', {
    meta: { ...stats, layout: plan.manifest.layout, modelErrors: plan.manifest.modelErrorCount },
  })
  return stats
}
