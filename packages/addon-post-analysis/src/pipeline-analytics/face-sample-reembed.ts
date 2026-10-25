/**
 * Re-embed an operator-chosen LIST of face samples, forced (D658).
 *
 * `embedding.reembedFaces` brings samples INTO the cluster's space and skips
 * every sample already stamped with its target — which is exactly the sample
 * `faceGallery.auditEmbeddings` accuses: stamped `auraface-r100`, holding an
 * ArcFace vector a pre-D658 runner produced under that name. This repairs
 * those, and only those:
 *
 *  - exactly the named samples, sequentially, under a bound (the action caps
 *    the list), ONE pinned model per call (D54);
 *  - through the same pinned path as the audit (`FaceReembedEmbedder` →
 *    `runStatelessStep`), where a node that ran another model is refused
 *    `model-not-servable` and leaves the rotation;
 *  - the vector is REPLACED even when the stamp already names the model;
 *  - the stamp written is the model the node reported it RAN, never the pin
 *    echoed; an outcome that names none is refused;
 *  - the write is `IdentityStore.restampSample`: vector first, then the row,
 *    then a read-back (D58/D651) — the stamp never moves without its vector,
 *    and the D643 alignment stamp and the source fields are not touched;
 *  - every sample it could not do is NAMED with its reason.
 */
import type {
  FaceReembedOutcome,
  FaceReembedSample,
  FaceReembedWriteOutcome,
} from './face-reembed-pass.js'

export type FaceSampleReembedOutcome =
  | 'reembedded'
  | 'not-found'
  | 'duplicate'
  | 'no-pixels'
  | 'embed-failed'
  | 'no-capable-node'
  | 'no-model-stamp'
  | 'not-landed'

export interface FaceSampleReembedRow {
  readonly sampleId: string
  readonly outcome: FaceSampleReembedOutcome
  /** The stamp before the call, when the sample exists. */
  readonly previousModelId?: string
  /** The stamp written, on `reembedded`. */
  readonly modelId?: string
  readonly detail?: string
}

export interface FaceSampleReembedResult {
  readonly pinnedModelId: string
  readonly requested: number
  readonly reembedded: number
  readonly failed: number
  readonly rows: readonly FaceSampleReembedRow[]
}

export interface FaceSampleReembedDeps {
  listSamples(): Promise<readonly FaceReembedSample[]>
  /** The stored aligned template; `null` when its blob is gone. Never throws. */
  loadAlignedCrop(sample: FaceReembedSample): Promise<Buffer | null>
  embed(sample: FaceReembedSample, alignedCropJpeg: Buffer): Promise<FaceReembedOutcome>
  /** `IdentityStore.restampSample`: vector first, row, read-back. */
  store(
    sample: FaceReembedSample,
    embedding: readonly number[],
    modelId: string,
    dim: number,
  ): Promise<FaceReembedWriteOutcome>
  pause(ms: number): Promise<void>
  readonly logger: {
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => void
    warn: (message: string, extras?: { meta?: Record<string, unknown> }) => void
  }
}

export interface FaceSampleReembedOptions {
  readonly sampleIds: readonly string[]
  readonly modelId: string
  readonly pacingMs?: number
}

/** Pacing between samples — off hub-main's thread, not a throttle. */
const DEFAULT_FACE_SAMPLE_REEMBED_PACING_MS = 25

async function reembedOne(
  deps: FaceSampleReembedDeps,
  sample: FaceReembedSample,
  pinned: string,
): Promise<FaceSampleReembedRow> {
  const base = { sampleId: sample.sampleId, previousModelId: sample.modelId }
  const crop = await deps.loadAlignedCrop(sample)
  if (crop === null) return { ...base, outcome: 'no-pixels' }
  const outcome = await deps.embed(sample, crop)
  if (outcome.kind === 'failed') return { ...base, outcome: 'embed-failed', detail: outcome.reason }
  if (outcome.kind === 'no-capable-node') {
    return { ...base, outcome: 'no-capable-node', detail: outcome.reason }
  }
  // The stamp is what the node says it RAN. The embedder already refuses a node
  // that ran another model; an outcome that names no model is not written.
  if (outcome.modelId === undefined || outcome.modelId === '') {
    return { ...base, outcome: 'no-model-stamp', detail: 'the embed answered no model id' }
  }
  if (outcome.modelId !== pinned) {
    return {
      ...base,
      outcome: 'embed-failed',
      detail: `ran "${outcome.modelId}" for a call pinned to "${pinned}"`,
    }
  }
  const write = await deps.store(sample, outcome.embedding, outcome.modelId, outcome.dim)
  if (!write.landed) {
    return { ...base, outcome: 'not-landed', detail: write.reason ?? 'the write did not land' }
  }
  return { ...base, outcome: 'reembedded', modelId: outcome.modelId }
}

export async function reembedFaceSamples(
  deps: FaceSampleReembedDeps,
  options: FaceSampleReembedOptions,
): Promise<FaceSampleReembedResult> {
  const pinned = options.modelId
  const byId = new Map((await deps.listSamples()).map((s) => [s.sampleId, s]))
  const pacingMs = options.pacingMs ?? DEFAULT_FACE_SAMPLE_REEMBED_PACING_MS
  const seen = new Set<string>()
  const rows: FaceSampleReembedRow[] = []
  let noNode: string | null = null

  deps.logger.info('face sample re-embed starting', {
    meta: { pinnedModelId: pinned, requested: options.sampleIds.length },
  })
  for (const sampleId of options.sampleIds) {
    if (seen.has(sampleId)) {
      rows.push({ sampleId, outcome: 'duplicate' })
      continue
    }
    seen.add(sampleId)
    const sample = byId.get(sampleId)
    if (sample === undefined) {
      rows.push({ sampleId, outcome: 'not-found' })
      continue
    }
    if (noNode !== null) {
      // Terminal for the call: nothing in the cluster serves the pin, and
      // asking again per sample would only repeat the answer.
      rows.push({
        sampleId,
        previousModelId: sample.modelId,
        outcome: 'no-capable-node',
        detail: noNode,
      })
      continue
    }
    const row = await reembedOne(deps, sample, pinned)
    if (row.outcome === 'no-capable-node') noNode = row.detail ?? 'no capable node'
    if (row.outcome !== 'reembedded') {
      deps.logger.warn('face sample re-embed: sample NOT re-embedded', {
        meta: { sampleId, outcome: row.outcome, detail: row.detail ?? null, pinnedModelId: pinned },
      })
    }
    rows.push(row)
    await deps.pause(pacingMs)
  }
  const reembedded = rows.filter((r) => r.outcome === 'reembedded').length
  deps.logger.info('face sample re-embed finished', {
    meta: {
      pinnedModelId: pinned,
      requested: options.sampleIds.length,
      reembedded,
      failed: rows.length - reembedded,
    },
  })
  return {
    pinnedModelId: pinned,
    requested: options.sampleIds.length,
    reembedded,
    failed: rows.length - reembedded,
    rows,
  }
}
