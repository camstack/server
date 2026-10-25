/**
 * face-reembed-wiring — the `embed` dependency `reembedFaceGallery` needs,
 * built over `pipelineRunner.runStatelessStep`.
 *
 * `face-reembed-pass.ts` is pure and says exactly what it wants: run
 * `face-embedding` ALONE over the stored aligned template, sent as the whole
 * frame with {@link FULL_IMAGE_BBOX}, ONE model pinned for the whole pass
 * (D54). This module is that sentence as code. It mirrors
 * `rebuild-step-dispatch.ts`'s placement rules — a node that cannot serve the
 * pin leaves the rotation and the SAME sample is retried elsewhere; a node
 * that echoes a different model than the pin is unfit, not a failure — but
 * stays a separate implementation because the outcome vocabulary is the
 * pass's (`FaceReembedOutcome`), not the CLIP rebuild's.
 */
import {
  FULL_IMAGE_BBOX,
  type RunStatelessStepInput,
  type RunStatelessStepResult,
} from '@camstack/types'
import type { FaceReembedOutcome, FaceReembedSample } from './face-reembed-pass.js'
import { PHOTO_ENROLL_DEVICE_ID, PHOTO_FACE_EMBEDDING_STEP_ID } from './photo-enrollment.js'
import { NodeRotation } from './rebuild-node-rotation.js'

export interface FaceReembedEmbedderDeps {
  /** Call `pipelineRunner.runStatelessStep` PINNED to `nodeId` (nodePin). */
  runStatelessStep(nodeId: string, input: RunStatelessStepInput): Promise<RunStatelessStepResult>
  readonly logger: {
    warn: (message: string, extras?: { meta?: Record<string, unknown> }) => void
  }
}

/** Decode the base64 little-endian float32 wire vector into a number[]. */
function decodeEmbeddingBase64(base64: string): number[] {
  const bytes = Buffer.from(base64, 'base64')
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  return Array.from(view)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The pass's `embed` dependency, holding one node rotation for its lifetime —
 * a node dropped on sample 3 stays dropped for sample 4.
 */
export class FaceReembedEmbedder {
  private readonly rotation: NodeRotation

  constructor(
    private readonly deps: FaceReembedEmbedderDeps,
    nodeIds: readonly string[],
    /** The cluster row's `face-embedding` model. Never re-resolved mid-pass. */
    private readonly targetModelId: string,
  ) {
    this.rotation = new NodeRotation(nodeIds)
  }

  async embed(sample: FaceReembedSample, alignedCropJpeg: Buffer): Promise<FaceReembedOutcome> {
    const input: RunStatelessStepInput = {
      stepId: PHOTO_FACE_EMBEDDING_STEP_ID,
      modelId: this.targetModelId,
      frameJpeg: alignedCropJpeg.toString('base64'),
      // The whole frame IS the aligned template — see the pass's docblock for
      // why any other rectangle would double-warp pixels that are already a
      // template.
      bbox: FULL_IMAGE_BBOX,
      className: 'face',
      sourceDeviceId: PHOTO_ENROLL_DEVICE_ID,
    }
    const attempted = new Set<string>()

    for (;;) {
      const nodeId = this.rotation.next()
      if (nodeId === null || attempted.has(nodeId)) {
        return {
          kind: 'no-capable-node',
          reason:
            this.rotation.dropped.length > 0
              ? `every candidate node left the rotation: ${this.rotation.dropped
                  .map((d) => `${d.nodeId} (${d.reason})`)
                  .join('; ')}`
              : 'no online node runs a pipeline runner that can serve face-embedding',
        }
      }
      attempted.add(nodeId)

      let result: RunStatelessStepResult
      try {
        result = await this.deps.runStatelessStep(nodeId, input)
      } catch (err: unknown) {
        this.drop(nodeId, `call failed: ${errorMessage(err)}`, sample)
        continue
      }

      if (result.kind === 'refused') {
        if (result.reason === 'unknown-step' || result.reason === 'model-not-servable') {
          // A property of the NODE, never of the sample — retry it elsewhere.
          this.drop(nodeId, result.detail, sample)
          continue
        }
        return { kind: 'failed', reason: `${result.nodeId}: ${result.detail}` }
      }
      if (result.modelId !== this.targetModelId) {
        this.drop(
          nodeId,
          `ran "${result.modelId}" for a pass pinned to "${this.targetModelId}"`,
          sample,
        )
        continue
      }
      const embedding = result.details.find(
        (d) => d.stepId === PHOTO_FACE_EMBEDDING_STEP_ID && d.embedding !== undefined,
      )?.embedding
      if (embedding === undefined) {
        return {
          kind: 'failed',
          reason: `${result.nodeId}: the step ran but returned no ${PHOTO_FACE_EMBEDDING_STEP_ID} embedding (${result.details.length} detail(s))`,
        }
      }
      const vector = decodeEmbeddingBase64(embedding)
      return { kind: 'embedded', embedding: vector, dim: vector.length, modelId: result.modelId }
    }
  }

  private drop(nodeId: string, reason: string, sample: FaceReembedSample): void {
    this.rotation.drop(nodeId, reason)
    this.deps.logger.warn('face gallery re-embed: node left the rotation', {
      meta: { nodeId, reason, sampleId: sample.sampleId, identity: sample.identityName },
    })
  }
}

/**
 * Should a pass start ON ITS OWN, right now?
 *
 * The cluster model row can be flipped from two UI surfaces and the API; a
 * per-surface "run the pass" hook would be three hooks, each forgettable. So
 * the addon decides server-side, periodically, from the one question that
 * matters: is there a sample OUTSIDE the cluster space that a pass could
 * still bring in? Convergent by construction — a sample the last pass probed
 * pixel-less does not count (its pixels do not come back), so a gallery of
 * pure strays triggers exactly one pass per boot, not one per tick.
 */
export function shouldAutoReembed(
  samples: readonly FaceReembedSample[],
  targetModelId: string | null,
  knownPixelless: ReadonlySet<string>,
  passRunning: boolean,
): boolean {
  if (passRunning || targetModelId === null || targetModelId === '') return false
  return samples.some(
    (s) =>
      s.modelId !== targetModelId && s.mediaId !== undefined && !knownPixelless.has(s.sampleId),
  )
}
