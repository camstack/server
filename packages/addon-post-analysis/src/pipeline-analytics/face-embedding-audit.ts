/**
 * Does each enrolled face sample's STORED vector come from the model it is
 * stamped with? A forced, read-only audit (D658).
 *
 * ## Why it exists
 *
 * Until D658 the runner fetched a step's engine by STEP id, which answers the
 * pool's ACTIVE variant (the first loaded after boot), and stamped the model
 * the dispatch REQUESTED. A runner that booted inside the owner's restart
 * window ran the registry default first — ArcFace for `face-embedding` until
 * D651 — and so ran ArcFace for its whole life while stamping `auraface-r100`.
 * ArcFace and AuraFace are both 512-d: no dimension guard sees the difference,
 * and the matcher's same-model gate trusts the stamp. The gallery samples
 * stamped `auraface-r100` may therefore hold ArcFace vectors. Plausible, not
 * proven — this measures it.
 *
 * ## How
 *
 * Per sample: re-embed its stored ALIGNED template through
 * `pipelineRunner.runStatelessStep` pinned to the audited model (the same
 * embedder the re-embed pass uses — `FaceReembedEmbedder`, whole frame, no
 * second warp), and take the cosine against the stored vector. The same model
 * over the same pixels answers ~1 (the template is a JPEG of the crop that was
 * embedded, so not exactly 1); another model's vector answers far lower.
 *
 * ## What it never does
 *
 * Write. No restamp, no re-embed, no removal: it reports. Re-embedding is a
 * separate, operator-run action — and note that `embedding.reembedFaces`
 * SKIPS a sample already stamped with the target model, so it cannot repair a
 * sample this audit accuses; `faceGallery.reembedSamples` (the forced,
 * sample-list re-embed in `face-sample-reembed.ts`) does.
 */
import type { FaceReembedOutcome, FaceReembedSample } from './face-reembed-pass.js'

/** At or above: the stored vector is this model's. */
export const AUDIT_OK_MIN_COSINE = 0.98
/** Below: the stored vector is NOT this model's. Between the two: inconclusive. */
export const AUDIT_MISMATCH_MAX_COSINE = 0.9
/** The model the audit pins when the caller names none: the D651 default. */
export const DEFAULT_AUDITED_FACE_MODEL = 'auraface-r100'

export type FaceEmbeddingAuditVerdict = 'ok' | 'mismatch' | 'inconclusive' | 'unmeasurable'

export type FaceEmbeddingUnmeasurableReason =
  | 'stamped-other-model'
  | 'no-pixels'
  | 'no-stored-vector'
  | 'embed-failed'
  | 'no-capable-node'
  | 'dimension-differs'

export interface FaceEmbeddingAuditRow {
  readonly sampleId: string
  readonly identityId: string
  readonly identityName: string
  readonly stampedModelId: string
  readonly verdict: FaceEmbeddingAuditVerdict
  /** Present when measured. */
  readonly cosine?: number
  readonly reason?: FaceEmbeddingUnmeasurableReason
  readonly detail?: string
}

export interface FaceEmbeddingAuditReport {
  readonly auditedModelId: string
  readonly total: number
  readonly ok: number
  readonly mismatch: number
  readonly inconclusive: number
  readonly unmeasurable: number
  /** False when `maxSamples` stopped the walk. */
  readonly complete: boolean
  readonly rows: readonly FaceEmbeddingAuditRow[]
}

export interface FaceEmbeddingAuditDeps {
  listSamples(): Promise<readonly FaceReembedSample[]>
  /** The stored vectors, by sample id; a missing id has none. */
  loadStoredVectors(sampleIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>
  /** The stored aligned template; `null` when its blob is gone. Never throws. */
  loadAlignedCrop(sample: FaceReembedSample): Promise<Buffer | null>
  /** Embed the template with the audited model, pinned. */
  embed(sample: FaceReembedSample, alignedCropJpeg: Buffer): Promise<FaceReembedOutcome>
}

export interface FaceEmbeddingAuditOptions {
  readonly auditedModelId: string
  /** Only this identity's samples. */
  readonly identityId?: string
  /** Stop after this many MEASURED samples. */
  readonly maxSamples?: number
}

/** Cosine of two vectors of equal length; `null` when either has no length. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return null
  return dot / Math.sqrt(na * nb)
}

/** The verdict a measured cosine earns. Pure. */
export function verdictOf(c: number): Exclude<FaceEmbeddingAuditVerdict, 'unmeasurable'> {
  if (c >= AUDIT_OK_MIN_COSINE) return 'ok'
  if (c < AUDIT_MISMATCH_MAX_COSINE) return 'mismatch'
  return 'inconclusive'
}

function rowBase(
  s: FaceReembedSample,
): Pick<FaceEmbeddingAuditRow, 'sampleId' | 'identityId' | 'identityName' | 'stampedModelId'> {
  return {
    sampleId: s.sampleId,
    identityId: s.identityId,
    identityName: s.identityName,
    stampedModelId: s.modelId,
  }
}

async function measure(
  deps: FaceEmbeddingAuditDeps,
  sample: FaceReembedSample,
  stored: readonly number[] | undefined,
): Promise<FaceEmbeddingAuditRow> {
  const base = rowBase(sample)
  if (stored === undefined) {
    return { ...base, verdict: 'unmeasurable', reason: 'no-stored-vector' }
  }
  const crop = await deps.loadAlignedCrop(sample)
  if (crop === null) return { ...base, verdict: 'unmeasurable', reason: 'no-pixels' }
  const outcome = await deps.embed(sample, crop)
  if (outcome.kind === 'failed') {
    return { ...base, verdict: 'unmeasurable', reason: 'embed-failed', detail: outcome.reason }
  }
  if (outcome.kind === 'no-capable-node') {
    return { ...base, verdict: 'unmeasurable', reason: 'no-capable-node', detail: outcome.reason }
  }
  if (outcome.embedding.length !== stored.length) {
    // A different LENGTH already proves another model — but it is reported as
    // what was observed, not scored: a cosine over mismatched lengths is noise.
    return {
      ...base,
      verdict: 'unmeasurable',
      reason: 'dimension-differs',
      detail: `stored ${stored.length}-d, re-embedded ${outcome.embedding.length}-d`,
    }
  }
  const c = cosine(outcome.embedding, stored)
  if (c === null) {
    return { ...base, verdict: 'unmeasurable', reason: 'no-stored-vector', detail: 'zero vector' }
  }
  return { ...base, verdict: verdictOf(c), cosine: Math.round(c * 10_000) / 10_000 }
}

/**
 * Audit every sample stamped with `auditedModelId`. Read-only; bounded by
 * `maxSamples`; a pass-terminal `no-capable-node` stops measuring and reports
 * the rest as unmeasurable rather than asking again per sample.
 */
export async function auditFaceEmbeddings(
  deps: FaceEmbeddingAuditDeps,
  options: FaceEmbeddingAuditOptions,
): Promise<FaceEmbeddingAuditReport> {
  const all = await deps.listSamples()
  const samples =
    options.identityId === undefined ? all : all.filter((s) => s.identityId === options.identityId)
  const inSpace = samples.filter((s) => s.modelId === options.auditedModelId)
  const stored = await deps.loadStoredVectors(inSpace.map((s) => s.sampleId))
  const budget = options.maxSamples ?? Number.POSITIVE_INFINITY

  const rows: FaceEmbeddingAuditRow[] = []
  let measured = 0
  let complete = true
  let noNode: string | null = null
  for (const sample of samples) {
    if (sample.modelId !== options.auditedModelId) {
      rows.push({ ...rowBase(sample), verdict: 'unmeasurable', reason: 'stamped-other-model' })
      continue
    }
    if (measured >= budget) {
      complete = false
      continue
    }
    if (noNode !== null) {
      rows.push({
        ...rowBase(sample),
        verdict: 'unmeasurable',
        reason: 'no-capable-node',
        detail: noNode,
      })
      continue
    }
    const row = await measure(deps, sample, stored.get(sample.sampleId))
    if (row.reason === 'no-capable-node') noNode = row.detail ?? 'no capable node'
    if (row.cosine !== undefined) measured += 1
    rows.push(row)
  }
  const count = (v: FaceEmbeddingAuditVerdict): number => rows.filter((r) => r.verdict === v).length
  return {
    auditedModelId: options.auditedModelId,
    total: samples.length,
    ok: count('ok'),
    mismatch: count('mismatch'),
    inconclusive: count('inconclusive'),
    unmeasurable: count('unmeasurable'),
    complete,
    rows,
  }
}
