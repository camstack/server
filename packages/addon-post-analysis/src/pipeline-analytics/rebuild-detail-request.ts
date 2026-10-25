/**
 * The rebuild's request to the pipeline, and the reading of its answer.
 *
 * Split out of `index.ts` and kept pure so the load-bearing property of this
 * whole path — that a rebuilt vector is produced by the SAME code that produces
 * a live one — is testable without a broker, a runner or a camera.
 *
 * ## What makes it the same path
 *
 * A FULL FRAME (`frameJpeg`), never a pre-cut tile. The executing runner
 * derives the crop rectangle from the box with the cluster-wide convention,
 * through `deriveDetailCropRect`, exactly as it does for a live frame handle
 * ([D52](../../../../docs/decisions/adr-0052.md)). Sending a tile would have
 * unified the ENCODER while leaving the crop derivation split, which is the
 * defect wearing a fix's clothes.
 *
 * ## Why the box goes out NORMALISED
 *
 * It is stored normalised because the key frame is a native-resolution capture
 * while the detection ran on a downscaled analysis frame — different pixel
 * dimensions. The side that decodes the image is the only side that reliably
 * knows its dimensions, so the denormalisation happens there. The previous
 * version read the dimensions here with `sharp` and sent pixels; that made this
 * module a second reader of the image and put a coordinate conversion one
 * process away from the decode it depends on.
 *
 * ## Why the step is not resolved from an attachment
 *
 * `pipelineRunner.runDetailSubtree` resolves its steps from the live attach
 * state, so a pass over historical tracks reached only the cameras that
 * happened to be attached at that moment — measured 2026-08-06 on the live hub:
 * 1125 scanned, 121 rebuilt, 601 refused with "camera is not attached", because
 * cameras run `detectionMode: 'on-motion'`. `runStatelessStep` resolves the
 * step from the catalog instead, so any capable node can serve any track.
 */
import type { RunStatelessStepInput, RunStatelessStepResult } from '@camstack/types'
import type { RebuildEmbedOutcome, RebuildSource } from './embedding-rebuild.js'

/** The one step a rebuild runs. */
export const REBUILD_DETAIL_STEP_ID = 'clip-embedding'

/** The `frameJpeg` half of a rebuild source — a key frame is required to build a request. */
type RebuildSourceWithKeyFrame = Omit<RebuildSource, 'keyFrame' | 'bbox'> & {
  readonly keyFrame: Buffer
  readonly bbox: NonNullable<RebuildSource['bbox']>
}

/**
 * Build the `runStatelessStep` request for one stored track.
 *
 * `modelId` is a required argument and not a default resolved in here: it is
 * pinned ONCE for a whole pass and sent with every request, so that a pass
 * spread across several nodes cannot mix two encoders into one index. A default
 * would let a caller forget, and forgetting is silent.
 */
export function buildRebuildStepInput(
  source: RebuildSourceWithKeyFrame,
  modelId: string,
): RunStatelessStepInput {
  return {
    stepId: REBUILD_DETAIL_STEP_ID,
    modelId,
    frameJpeg: source.keyFrame.toString('base64'),
    bbox: source.bbox,
    className: source.className,
    // Diagnostics + log tags on the executing node. NOT `deviceId`: that name
    // is read as a routing pin and would drag the call back to the camera's
    // owning node, which is the constraint this path exists to remove.
    sourceDeviceId: source.deviceId,
  }
}

/**
 * What one node's answer means.
 *
 * Two tiers, and keeping them apart is the whole reason this is a union and not
 * a nullable vector:
 *
 * - **`node-unfit`** — this node can never serve this pass. The SAME track
 *   should be retried elsewhere and the node removed from the rotation. Folding
 *   it into `failed` would burn one refusal per track per node forever while
 *   reporting an engine problem that does not exist.
 * - everything else is a {@link RebuildEmbedOutcome} — a verdict about the
 *   TRACK, which another node would reach identically.
 */
export type RebuildStepVerdict = RebuildEmbedOutcome | NodeUnfitVerdict

/** The executing node is out of the running for the rest of the pass. */
export interface NodeUnfitVerdict {
  readonly kind: 'node-unfit'
  readonly reason: string
}

/**
 * Turn one `runStatelessStep` answer into a verdict.
 *
 * `pinnedModelId` is compared against what the node says it ran. The node
 * already refuses a model it cannot serve, so a mismatch means a node ignored
 * the pin — version skew, or a future change that reintroduces substitution.
 * Accepting the vector would put a foreign feature space in the index with
 * nothing in the data to show it, which is exactly the failure D52 closed one
 * level up. So a mismatch retires the node instead.
 */
export function readRebuildStepOutcome(
  result: RunStatelessStepResult,
  pinnedModelId: string,
): RebuildStepVerdict {
  if (result.kind === 'refused') {
    switch (result.reason) {
      case 'unknown-step':
      case 'model-not-servable':
        return { kind: 'node-unfit', reason: `${result.nodeId}: ${result.detail}` }
      case 'unreadable-frame':
        // A property of the STORED MEDIA, not of the engine — another node
        // reproduces it exactly, so retrying elsewhere only costs time.
        return { kind: 'not-runnable', reason: `${result.nodeId}: ${result.detail}` }
      case 'execution-failed':
        return { kind: 'failed', reason: `${result.nodeId}: ${result.detail}` }
    }
  }
  if (result.modelId !== pinnedModelId) {
    return {
      kind: 'node-unfit',
      reason: `node ${result.nodeId} ran "${result.modelId}" for a pass pinned to "${pinnedModelId}" — its vectors would not be comparable with the rest of the index`,
    }
  }
  const embedding = result.details.find(
    (d) => d.stepId === REBUILD_DETAIL_STEP_ID && d.embedding !== undefined,
  )?.embedding
  if (embedding === undefined) {
    return {
      kind: 'failed',
      reason: `${result.nodeId}: the step ran but returned no ${REBUILD_DETAIL_STEP_ID} embedding (${result.details.length} detail(s))`,
    }
  }
  return { kind: 'embedded', embeddingBase64: embedding }
}

/** Narrowing helper — a source without a key frame can never build a request. */
export function hasKeyFrame(source: RebuildSource): source is RebuildSourceWithKeyFrame {
  return source.keyFrame !== null && source.bbox !== null
}

export type { RebuildSourceWithKeyFrame }
