/**
 * face-rescore-job — rescore EVERY unassigned face against the gallery, once,
 * as a paced single-flight job (D866).
 *
 * `face.rescoreTrack` answers "what does the gallery say NOW?" for one face the
 * operator is looking at. This is the same question asked of the whole buffer.
 * It does not re-implement the answer: every face goes through
 * `buildFaceRescoreReport` (the verdict), `persistRescoreResult` (the one gate
 * that refuses a `model-mismatch` and decides raise / clear) and
 * `decideRescorePersistence` — the batch only changes WHEN the write lands
 * (collected, then one transaction per batch) not WHAT is written.
 *
 * ## The result is the truth for the current gallery: a suggestion may be
 * LOWERED or CLEARED
 *
 * A suggestion is a photograph of the gallery at detection time. When the
 * gallery moved (a sample removed, a person deleted, a threshold raised) the
 * photograph can be wrong in the OTHER direction: it points at somebody the
 * gallery no longer supports. Keeping it would show the operator a confident
 * "this is Anna" that no longer follows from anything. So a comparable report
 * with nothing to offer CLEARS the stored suggestion, and a weaker best match
 * LOWERS it. The only faces never touched are the incomparable ones
 * (`model-mismatch`): "did not look" must not erase what a previous look found.
 *
 * ## One gallery, taken once
 *
 * The gallery and the identity names are read once at the start. Faces enrolled
 * mid-run are visible to the NEXT run (the change detector sees them), never to
 * half of this one — a run whose first and second halves disagree about who is
 * in the gallery produces a table nobody can reason about.
 *
 * ## Never holding `hub/sqlite-settings` (D447)
 *
 * That thread is synchronous. The job therefore (1) snapshots the id list with
 * one indexed read, (2) pages by ids — never by offset against a table the
 * recognizer is writing — {@link RESCORE_BATCH_SIZE} at a time, (3) writes each
 * batch as ONE transaction of narrow two-column updates, only for faces whose
 * suggestion actually changed, (4) measures the store time of every batch and
 * (5) pauses {@link RESCORE_PAUSE_FACTOR}× that time (clamped) before the next,
 * so the store is busy at most about a third of the run. The dot products run in
 * this process between the awaits.
 */
import type { IScopedLogger } from '@camstack/types'
import { createHash } from 'node:crypto'
import {
  buildFaceRescoreReport,
  decideRescorePersistence,
  type FaceRescoreParams,
  persistRescoreResult,
  type RescoreSuggestion,
} from './face-rescore.js'
import type { FaceRescoreJobStatus } from './face-rescore-job-status.js'
import type { GallerySample } from './pipeline/face-matcher.js'
export type { FaceRescoreJobState, FaceRescoreJobStatus } from './face-rescore-job-status.js'
import type {
  PendingFaceMarker,
  RescoreBatch,
  RescoreBatchRow,
  SuggestionUpdate,
} from './store/face-store.js'
import type { GalleryManifestEntry } from './store/identity-store.js'

/** Faces per batch: ~200 narrow updates in one transaction is tens of ms. */
export const RESCORE_BATCH_SIZE = 200
/** Pause after a batch = this × the batch's store time, clamped below. */
const RESCORE_PAUSE_FACTOR = 2
const RESCORE_PAUSE_MIN_MS = 25
const RESCORE_PAUSE_MAX_MS = 500
/** Two scores closer than this are the same score (REAL round trip). */
const SCORE_EPSILON = 1e-6

// ─────────────────────────────────────────────────────────────────────────
// Change classification
// ─────────────────────────────────────────────────────────────────────────

export type RescoreChange = 'unchanged' | 'new' | 'raised' | 'lowered' | 'cleared'

/**
 * How the fresh answer relates to what the row holds. A switch to another
 * identity counts by its score: higher ⇒ raised, otherwise lowered (a tie with
 * a different person is `raised` — it is a change and must be written).
 */
export function classifyRescoreChange(
  stored: RescoreSuggestion | null,
  next: RescoreSuggestion | null,
): RescoreChange {
  if (stored === null && next === null) return 'unchanged'
  if (stored === null) return 'new'
  if (next === null) return 'cleared'
  const delta = next.score - stored.score
  if (next.identityId === stored.identityId && Math.abs(delta) <= SCORE_EPSILON) return 'unchanged'
  return delta >= 0 ? 'raised' : 'lowered'
}

function storedSuggestion(row: RescoreBatchRow): RescoreSuggestion | null {
  return row.suggestedIdentityId === undefined
    ? null
    : { identityId: row.suggestedIdentityId, score: row.suggestedMatchScore ?? 0 }
}

// ─────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────

export interface RescoreFingerprint {
  /** Hash of every gallery sample (id, identity, model) + the cluster model. */
  readonly gallery: string
  /** Unassigned-face count and newest timestamp. */
  readonly pending: string
  /** What the change detector compares. */
  readonly combined: string
}

function sha(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Pure. The gallery part changes when a sample is added, removed or restamped
 * to another model, or the cluster model flips; the pending part when a face
 * arrives, leaves or is assigned. Sorted, so read order cannot move it.
 */
export function computeRescoreFingerprint(input: {
  readonly manifest: readonly GalleryManifestEntry[]
  readonly marker: PendingFaceMarker
  readonly clusterModelId: string
}): RescoreFingerprint {
  const lines = input.manifest
    .map((m) => `${m.sampleId}|${m.identityId}|${m.modelId}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const gallery = sha([`cluster:${input.clusterModelId}`, ...lines])
  const pending = `${String(input.marker.count)}@${String(input.marker.maxTimestamp ?? 'none')}`
  return { gallery, pending, combined: sha([gallery, pending]) }
}

// ─────────────────────────────────────────────────────────────────────────
// Report / status
// ─────────────────────────────────────────────────────────────────────────

const IDLE_STATUS: FaceRescoreJobStatus = {
  jobId: null,
  state: 'idle',
  scanned: 0,
  total: 0,
  changed: 0,
  newlySuggested: 0,
  raised: 0,
  lowered: 0,
  cleared: 0,
  modelMismatch: 0,
  noVector: 0,
  batches: 0,
  maxBatchStoreMs: 0,
  durationMs: 0,
  galleryFingerprint: '',
  fingerprint: '',
  startedAt: null,
}

// ─────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────

export interface FaceRescorePorts {
  readonly resolveClusterModelId: () => Promise<string | null>
  readonly galleryManifest: () => Promise<readonly GalleryManifestEntry[]>
  readonly pendingMarker: () => Promise<PendingFaceMarker>
  readonly loadGallery: () => Promise<readonly GallerySample[]>
  readonly identityNames: () => Promise<ReadonlyMap<string, string>>
  readonly paramsForDevice: (deviceId: number) => Promise<FaceRescoreParams>
  readonly listPendingFaceIds: () => Promise<readonly string[]>
  readonly loadRescoreBatch: (ids: readonly string[]) => Promise<RescoreBatch>
  readonly applySuggestionBatch: (updates: readonly SuggestionUpdate[]) => Promise<void>
  /** Persist a COMPLETED run (fingerprint + report) in the addon's own store. */
  readonly recordCompletion: (status: FaceRescoreJobStatus) => Promise<void>
  readonly pause: (ms: number) => Promise<void>
  readonly now: () => number
  readonly newJobId: () => string
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
}

/** The fingerprint of NOW, plus the cluster model it was taken under. */
export async function readRescoreFingerprint(
  ports: Pick<FaceRescorePorts, 'resolveClusterModelId' | 'galleryManifest' | 'pendingMarker'>,
): Promise<{ readonly fingerprint: RescoreFingerprint; readonly clusterModelId: string } | null> {
  const clusterModelId = await ports.resolveClusterModelId()
  if (clusterModelId === null) return null
  const [manifest, marker] = await Promise.all([ports.galleryManifest(), ports.pendingMarker()])
  return {
    fingerprint: computeRescoreFingerprint({ manifest, marker, clusterModelId }),
    clusterModelId,
  }
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: (readonly T[])[] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function pauseFor(storeMs: number): number {
  return Math.min(
    RESCORE_PAUSE_MAX_MS,
    Math.max(RESCORE_PAUSE_MIN_MS, Math.round(storeMs * RESCORE_PAUSE_FACTOR)),
  )
}

// ─────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────

export class FaceRescoreJob {
  private current: FaceRescoreJobStatus = IDLE_STATUS
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly ports: FaceRescorePorts) {}

  /** Progress of the running job, else the last finished one, else idle. */
  status(): FaceRescoreJobStatus {
    return this.current
  }

  isRunning(): boolean {
    return this.running !== null
  }

  /** Resolves when no job is running. Never rejects: failure is in `status()`. */
  async whenSettled(): Promise<void> {
    await this.running
  }

  /** Ask a running job to stop after its current batch (addon shutdown). */
  stop(): void {
    this.stopped = true
  }

  /**
   * Start a job — or return the one already running (single-flight). The
   * returned status is a snapshot; poll {@link status} for progress.
   */
  start(): FaceRescoreJobStatus {
    if (this.running !== null) return this.current
    this.stopped = false
    const startedAt = this.ports.now()
    this.current = { ...IDLE_STATUS, jobId: this.ports.newJobId(), state: 'running', startedAt }
    this.running = this.run(startedAt).finally(() => {
      this.running = null
    })
    return this.current
  }

  private patch(change: Partial<FaceRescoreJobStatus>): void {
    this.current = { ...this.current, ...change }
  }

  private async run(startedAt: number): Promise<void> {
    try {
      await this.runBatches(startedAt)
      this.patch({ state: 'completed', durationMs: this.ports.now() - startedAt })
      this.logSummary('face rescore job finished')
      // Manual and scheduled runs both land here, so the change detector sees
      // an operator's run as done and does not repeat it.
      await this.recordCompletion()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.patch({ state: 'failed', error, durationMs: this.ports.now() - startedAt })
      this.ports.logger.warn('face rescore job FAILED — rows written so far stay written', {
        meta: { ...this.summaryMeta(), error },
      })
    }
  }

  private async recordCompletion(): Promise<void> {
    try {
      await this.ports.recordCompletion(this.current)
    } catch (err) {
      this.ports.logger.warn(
        'face rescore result could not be recorded — the next tick may rerun',
        {
          meta: {
            jobId: this.current.jobId,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
    }
  }

  private summaryMeta(): Record<string, unknown> {
    const s = this.current
    return {
      jobId: s.jobId,
      scanned: s.scanned,
      total: s.total,
      changed: s.changed,
      newlySuggested: s.newlySuggested,
      raised: s.raised,
      lowered: s.lowered,
      cleared: s.cleared,
      modelMismatch: s.modelMismatch,
      noVector: s.noVector,
      batches: s.batches,
      maxBatchStoreMs: s.maxBatchStoreMs,
      durationMs: s.durationMs,
      galleryFingerprint: s.galleryFingerprint,
    }
  }

  private logSummary(message: string): void {
    this.ports.logger.info(message, { meta: this.summaryMeta() })
  }

  private async runBatches(startedAt: number): Promise<void> {
    const observed = await readRescoreFingerprint(this.ports)
    if (observed === null) {
      throw new Error('the cluster face-embedding model could not be resolved')
    }
    const { clusterModelId, fingerprint } = observed
    // ONE gallery for the whole run.
    const [gallery, identityNames] = await Promise.all([
      this.ports.loadGallery(),
      this.ports.identityNames(),
    ])
    const ids = await this.ports.listPendingFaceIds()
    this.patch({
      total: ids.length,
      galleryFingerprint: fingerprint.gallery,
      fingerprint: fingerprint.combined,
    })

    const paramsByDevice = new Map<number, FaceRescoreParams>()
    for (const batchIds of chunk(ids, RESCORE_BATCH_SIZE)) {
      if (this.stopped) throw new Error('stopped before completion')
      const storeStart = this.ports.now()
      const batch = await this.ports.loadRescoreBatch(batchIds)
      const readMs = this.ports.now() - storeStart

      const outcome = await this.scoreBatch(batch.rows, {
        gallery,
        identityNames,
        clusterModelId,
        paramsByDevice,
      })

      const writeStart = this.ports.now()
      await this.ports.applySuggestionBatch(outcome.updates)
      const storeMs = readMs + (this.ports.now() - writeStart)

      const s = this.current
      this.patch({
        scanned: s.scanned + batchIds.length,
        changed: s.changed + outcome.updates.length,
        newlySuggested: s.newlySuggested + outcome.tally.new,
        raised: s.raised + outcome.tally.raised,
        lowered: s.lowered + outcome.tally.lowered,
        cleared: s.cleared + outcome.tally.cleared,
        modelMismatch: s.modelMismatch + outcome.modelMismatch,
        noVector: s.noVector + batch.noVector,
        batches: s.batches + 1,
        maxBatchStoreMs: Math.max(s.maxBatchStoreMs, storeMs),
        durationMs: this.ports.now() - startedAt,
      })
      this.ports.logger.debug('face rescore batch', {
        meta: { jobId: s.jobId, size: batchIds.length, written: outcome.updates.length, storeMs },
      })
      // Yield the store (and this process) before the next batch.
      await this.ports.pause(pauseFor(storeMs))
    }
  }

  private async scoreBatch(
    rows: readonly RescoreBatchRow[],
    ctx: {
      readonly gallery: readonly GallerySample[]
      readonly identityNames: ReadonlyMap<string, string>
      readonly clusterModelId: string
      readonly paramsByDevice: Map<number, FaceRescoreParams>
    },
  ): Promise<{
    readonly updates: readonly SuggestionUpdate[]
    readonly tally: Record<'new' | 'raised' | 'lowered' | 'cleared', number>
    readonly modelMismatch: number
  }> {
    const updates: SuggestionUpdate[] = []
    const tally = { new: 0, raised: 0, lowered: 0, cleared: 0 }
    let modelMismatch = 0
    for (const row of rows) {
      let params = ctx.paramsByDevice.get(row.deviceId)
      if (params === undefined) {
        params = await this.ports.paramsForDevice(row.deviceId)
        ctx.paramsByDevice.set(row.deviceId, params)
      }
      const report = buildFaceRescoreReport({
        probe: { embedding: row.embedding, modelId: row.modelId },
        gallery: ctx.gallery,
        identityNames: ctx.identityNames,
        clusterModelId: ctx.clusterModelId,
        params,
      })
      // The SAME gate as `face.rescoreTrack`; the port only COLLECTS, the
      // batch writes. A `model-mismatch` returns 'not-comparable' before the
      // port is ever called.
      const captured: { value: RescoreSuggestion | null } = { value: null }
      const outcome = await persistRescoreResult(row.id, report, {
        setSuggestion: (_id, suggestion) => {
          captured.value = suggestion
          return Promise.resolve()
        },
      })
      if (outcome === 'not-comparable') {
        modelMismatch += 1
        continue
      }
      const change = classifyRescoreChange(storedSuggestion(row), captured.value)
      if (change === 'unchanged') continue
      tally[change] += 1
      updates.push({ faceId: row.id, suggestion: captured.value })
      this.ports.logger.debug('face rescore changed a suggestion', {
        tags: { deviceId: row.deviceId },
        meta: {
          faceId: row.id,
          change,
          from: row.suggestedIdentityId ?? null,
          fromScore: row.suggestedMatchScore ?? null,
          to: decideRescorePersistence(report)?.identityId ?? null,
        },
      })
    }
    return { updates, tally, modelMismatch }
  }
}
