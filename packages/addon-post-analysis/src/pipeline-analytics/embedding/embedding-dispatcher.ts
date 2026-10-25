import type {
  DecodedFrame,
  EmbeddingRefusal,
  EmbeddingRefusalCode,
  FrameHandle,
  IEventBus,
  IScopedLogger,
  TypedSystemEvent,
} from '@camstack/types'
import {
  createEvent,
  EMBEDDING_MODEL_FAILED,
  EMBEDDING_REQUIREMENTS_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  EventCategory,
  embeddingRefusalOf,
} from '@camstack/types'
import { extractCrop } from '../../shared/frame/crop-extractor.js'
import { resolveFrame } from '../../shared/frame/resolve-frame.js'
import type { EmbeddingConfig, EmbeddingStoredEvent } from './embedding-config.js'

/**
 * Cross-process embedding-encoder client. In `pipeline-analytics` the
 * embedding-encoder runs in a SEPARATE process, so the encoder surface is an
 * ASYNC cap client — `encode`/`getInfo` route over UDS/Moleculer via
 * `ctx.api.embeddingEncoder.*`. `embedding` crosses the wire as `number[]`
 * (Float32Array does not survive MsgPack). The dispatcher discards the vector
 * value itself (the encode call persists it as a side effect) and keeps only
 * `inferenceMs` + the model info for the emitted telemetry event.
 */
export interface EmbeddingEncoderClient {
  encode(
    crop: Uint8Array,
    width: number,
    height: number,
  ): Promise<{ embedding: number[]; inferenceMs: number }>
  getInfo(): Promise<{ modelId: string; embeddingDim: number; ready: boolean }>
}

interface PendingCrop {
  readonly trackId: string
  readonly deviceId: string
  readonly class: string
  readonly confidence: number
  readonly frameData: Buffer
  readonly frameWidth: number
  readonly frameHeight: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly receivedAt: number
}

type CropBbox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export function selectCropBbox(detection: {
  readonly bbox: CropBbox
  readonly refinedBbox?: CropBbox
}): CropBbox {
  return detection.refinedBbox ?? detection.bbox
}

/** Local narrow of a pipeline analysis result item (runtime shape from detection pipeline). */
interface PipelineAnalysisItem {
  readonly detection?: {
    readonly class: string
    readonly score: number
    readonly trackId?: string
    readonly bbox: {
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
    readonly refinedBbox?: {
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
  }
  readonly objectState?: {
    readonly state: string
  }
  readonly zoneEvents?: readonly {
    readonly zoneId: string
    readonly type: string
    readonly timestamp?: number
  }[]
}

export interface EmbeddingDispatcherDeps {
  readonly config: EmbeddingConfig
  readonly encoder: EmbeddingEncoderClient
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /**
   * Full-frame fetch by handle, routed to the owning runner
   * (`pipelineRunner.getNativeCrop` full-frame). No shm read (2026-07-16).
   * `deviceId` (S4) keys the injected CaptureScheduler's per-device lane —
   * the wrapper in `index.ts` routes this fetch through the scheduler, so a
   * `null` may also mean "dropped stale" (treated like a recycled frame).
   */
  readonly getRemoteFrame: (handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>
  /**
   * How long to accumulate "DetectionResult carried nothing to embed" before
   * emitting ONE line carrying the count. Defaults to
   * {@link DEFAULT_EMPTY_REPORT_INTERVAL_MS}. Injected only by tests.
   */
  readonly emptyReportIntervalMs?: number
  /**
   * How long to accumulate encoder refusals (a FAILED model, requirements not
   * met) before emitting ONE line per (camera, code, model) carrying the
   * count. Defaults to {@link DEFAULT_EMPTY_REPORT_INTERVAL_MS}. Injected only
   * by tests.
   */
  readonly refusalReportIntervalMs?: number
}

/**
 * Refusals of one (camera, code, model) triple since the last report, and when
 * that was. `reportedAt === 0` means never: the first refusal is reported at
 * once, because a tower going `failed` or a download starting to fail is a
 * transition the operator must see now, and every later one waits for the
 * interval.
 */
interface ModelRefusals extends EmbeddingRefusal {
  readonly deviceId: number
  readonly refused: number
  readonly reportedAt: number
}

/** The line and the recovery for each refusal code — one place, never prose-matched. */
const REFUSAL_REPORT: Readonly<
  Record<
    EmbeddingRefusalCode,
    { readonly message: string; readonly recovery: (r: EmbeddingRefusal) => string }
  >
> = {
  [EMBEDDING_MODEL_FAILED]: {
    message: 'Embedding refused — the encoder model is FAILED on its node',
    recovery: (r) =>
      `embeddingEncoder.resetFailedModels({ modelId: "${r.modelId}", nodeId: "${r.nodeId}" })`,
  },
  [EMBEDDING_REQUIREMENTS_UNAVAILABLE]: {
    message: 'Embedding refused — the encoder model requirements are unavailable on its node',
    recovery: () =>
      'the next request past the cooldown retries the download; check the node can reach the hub / model registry',
  },
  [EMBEDDING_REQUIREMENTS_FAILED]: {
    message: 'Embedding refused — the encoder model requirements can never be met on its node',
    recovery: (r) =>
      `fix the catalog entry or the model files, then embeddingEncoder.resetFailedModels({ modelId: "${r.modelId}", nodeId: "${r.nodeId}" })`,
  },
}

function refusalKey(deviceId: number, refusal: EmbeddingRefusal): string {
  return `${String(deviceId)}|${refusal.code}|${refusal.modelId}`
}

/**
 * A drop this frequent is reported as a COUNT, never per event.
 *
 * The empty branch is currently taken on 100% of `detection.result` events
 * (see {@link EmbeddingDispatcher.handleDetectionResult}), i.e. at frame rate
 * across every camera. One line per event would be tens of thousands per hour
 * — the same defect being fixed, moved into the logger. One line per five
 * minutes carrying `events` + a per-device breakdown answers both questions
 * ("is it still dead?", "which camera?") for ~288 lines a day.
 */
const DEFAULT_EMPTY_REPORT_INTERVAL_MS = 300_000

export class EmbeddingDispatcher {
  private readonly config: EmbeddingConfig
  private readonly encoder: EmbeddingEncoderClient
  private readonly eventBus: IEventBus
  private readonly logger: IScopedLogger
  private readonly getRemoteFrame: (
    handle: FrameHandle,
    deviceId: number,
  ) => Promise<DecodedFrame | null>

  private readonly lastEmbedTime = new Map<string, number>()
  /**
   * trackId -> the frame pinned for it. Each entry holds a WHOLE decoded RGB
   * frame (`PendingCrop.frameData`, ~0.7 MB), not a crop.
   *
   * Under the shipped `cropStrategy: 'first'` this doubles as the in-flight
   * DEDUPE FLAG — `'first'` gates on `!pendingCrops.has(trackId)` — and there
   * is no flush timer for that strategy, so nothing ever sweeps it. Until
   * 2026-08-25 the delete lived on `processOne`'s success path only: an
   * `extractCrop` throw or an `encoder.encode` rejection (a cross-process cap
   * over UDS, with no timeout) stranded the frame permanently AND made that
   * trackId un-embeddable forever. `processOne` now releases in a `finally`.
   */
  private readonly pendingCrops = new Map<string, PendingCrop>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null

  private _processedCount = 0
  private _totalInferenceMs = 0

  /** Rate-limit state for the "nothing to embed" report. See
   *  {@link DEFAULT_EMPTY_REPORT_INTERVAL_MS}. */
  private readonly emptyReportIntervalMs: number
  private readonly emptyEventsPerDevice = new Map<number, number>()
  private emptyEventCount = 0
  private emptyWindowStartedAt = 0

  /** Encoder refusals, per (camera, code, model). See {@link noteRefused}. */
  private readonly refusalReportIntervalMs: number
  private readonly modelRefusals = new Map<string, ModelRefusals>()

  constructor(deps: EmbeddingDispatcherDeps) {
    this.config = deps.config
    this.encoder = deps.encoder
    this.eventBus = deps.eventBus
    this.logger = deps.logger
    this.getRemoteFrame = deps.getRemoteFrame
    this.emptyReportIntervalMs = deps.emptyReportIntervalMs ?? DEFAULT_EMPTY_REPORT_INTERVAL_MS
    this.refusalReportIntervalMs = deps.refusalReportIntervalMs ?? DEFAULT_EMPTY_REPORT_INTERVAL_MS
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('EmbeddingDispatcher disabled')
      return
    }

    this.unsubscribe = this.eventBus.subscribe(
      { category: EventCategory.DetectionResult },
      (event) => {
        void this.handleDetectionResult(event)
      },
    )

    // Flush timer for best-confidence strategy
    if (this.config.cropStrategy === 'best-confidence') {
      this.flushTimer = setInterval(() => {
        void this.flushPending()
      }, 1000)
    }

    this.logger.info('EmbeddingDispatcher started', {
      meta: { strategy: this.config.cropStrategy, maxPerSec: this.config.maxPerSecPerCamera },
    })
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    // Flush remaining — and the refusal counts even if that rejects one day.
    try {
      await this.flushPending()
    } finally {
      this.flushModelRefusals()
    }
  }

  get processedCount(): number {
    return this._processedCount
  }
  get avgInferenceMs(): number {
    return this._processedCount > 0 ? this._totalInferenceMs / this._processedCount : 0
  }
  get queueDepth(): number {
    return this.pendingCrops.size
  }

  private async handleDetectionResult(event: TypedSystemEvent<'detection.result'>): Promise<void> {
    const data = event.data
    const deviceId = event.source.id !== undefined ? String(event.source.id) : ''
    if (!deviceId) return

    // ── Nothing to embed? Then fetch NOTHING. ────────────────────────
    // Everything below this line exists to serve the `for (const det of …)`
    // loop at the end of the method, and all of it is expensive: `resolveFrame`
    // pulls a WHOLE decoded frame across a process boundary (~1.4 MB of
    // `external` at 640, ~28 MB on the 4096px keyFrame path) and `Buffer.from`
    // copies it a second time. Paying that to then iterate an empty array is
    // pure waste, and it is not a corner case — it is what happens on 100% of
    // events today.
    //
    // The only emitter of `DetectionResult.analysisResults` in the repo is
    // `addon-pipeline-orchestrator`'s
    // `DetectionWiringController.handleInferenceResult`, and it emits a literal
    // `[]`: refinement (tracking, zone/state analysis) moved to
    // `pipeline-analytics`, which subscribes to `PipelineInferenceResult`
    // directly, and this field was left drained behind it. Measured: the
    // dispatcher's four skip branches below logged 0 lines in an hour while the
    // same addon logged 42 273 debug lines in 12 h — every event went straight
    // through, fetched a frame, copied it, and looped over nothing.
    //
    // The path is kept rather than deleted because the field is still part of
    // `DetectionResultPayload` and repopulating it upstream is a one-line
    // change — deleting the consumer would mean embeddings silently never
    // resume. What changes is that the frame is now paid for only when there is
    // work, and that the drop is AUDIBLE (a periodic count, below) instead of
    // looking like a feature that runs.
    const analysisResults = data.analysisResults ?? []
    if (analysisResults.length === 0) {
      this.noteNothingToEmbed(Number(deviceId))
      return
    }

    // analysisResults items are untyped pipeline outputs — narrow to local interface at boundary
    const detections = analysisResults as readonly PipelineAnalysisItem[]

    // Resolve the underlying frame once per event via the shm frame plane.
    // The handle's `nodeId` decides the path — local shm read when co-located
    // with the producing decoder, else a node-routed `decoder.getFrame` call.
    const handle = data.frameHandle
    if (!handle) {
      this.logger.debug('skip: no frameHandle on DetectionResult', {
        tags: { deviceId: Number(deviceId) },
        meta: { deviceId },
      })
      return
    }

    let decoded: DecodedFrame | null
    try {
      decoded = await resolveFrame(handle, {
        // Bind the device onto the injected fetch — the S4 wrapper needs it to
        // pick the CaptureScheduler's per-device lane.
        getRemoteFrame: (h) => this.getRemoteFrame(h, Number(deviceId)),
      })
    } catch (err) {
      this.logger.debug('skip: resolveFrame threw', {
        tags: { deviceId: Number(deviceId) },
        meta: { deviceId, shmId: handle.shmId, error: String(err) },
      })
      return
    }

    if (!decoded) {
      this.logger.debug('skip: frame recycled before resolve', {
        tags: { deviceId: Number(deviceId) },
        meta: { deviceId, shmId: handle.shmId },
      })
      return
    }

    // Defensive: the live detection stream is decoded as RGB by the pipeline
    // runner. `extractCrop` interprets the buffer as raw RGB — bail if not.
    if (decoded.format !== 'rgb') {
      this.logger.debug('skip: resolved frame is not RGB', {
        tags: { deviceId: Number(deviceId) },
        meta: { deviceId, format: decoded.format },
      })
      return
    }

    const frameData = Buffer.isBuffer(decoded.data) ? decoded.data : Buffer.from(decoded.data)
    const frameWidth = decoded.width
    const frameHeight = decoded.height

    for (const det of detections) {
      const detection = det.detection
      if (!detection) continue

      // Class filter
      if (this.config.classes.length > 0 && !this.config.classes.includes(detection.class)) continue

      // Confidence filter
      if (detection.score < this.config.minConfidence) continue

      // Rate limit
      const now = Date.now()
      const minInterval = 1000 / this.config.maxPerSecPerCamera
      const lastTime = this.lastEmbedTime.get(deviceId) ?? 0
      if (now - lastTime < minInterval) continue

      const trackId = detection.trackId ?? `${deviceId}-${now}`

      const pending: PendingCrop = {
        trackId,
        deviceId,
        class: detection.class,
        confidence: detection.score,
        frameData,
        frameWidth,
        frameHeight,
        bbox: selectCropBbox(detection),
        receivedAt: now,
      }

      switch (this.config.cropStrategy) {
        case 'first': {
          if (!this.pendingCrops.has(trackId)) {
            this.pendingCrops.set(trackId, pending)
            void this.processOne(pending)
          }
          break
        }
        case 'best-confidence': {
          const existing = this.pendingCrops.get(trackId)
          if (!existing || pending.confidence > existing.confidence) {
            this.pendingCrops.set(trackId, pending)
          }
          break
        }
        case 'track-end': {
          const state = det.objectState?.state
          if (state === 'leaving') {
            this.pendingCrops.set(trackId, pending)
            void this.processOne(pending)
          } else {
            const existing = this.pendingCrops.get(trackId)
            if (!existing || pending.confidence > existing.confidence) {
              this.pendingCrops.set(trackId, pending)
            }
          }
          break
        }
      }
    }
  }

  /**
   * Count a `detection.result` that carried no work, and report periodically.
   *
   * A branch that drops work says so (CLAUDE.md) — but at frame rate the only
   * honest way to say it is a number. One line per
   * {@link emptyReportIntervalMs} replaces one line per event.
   *
   * The line is deliberately NOT tagged with a single `deviceId`: it is not
   * about one camera, it is about all of them at once. The per-camera question
   * the tag exists to answer ("why is 102 different from 101?") is answered by
   * `meta.perDevice`, which carries the numeric id and count for every camera
   * in the window.
   */
  private noteNothingToEmbed(deviceId: number): void {
    this.emptyEventCount++
    this.emptyEventsPerDevice.set(deviceId, (this.emptyEventsPerDevice.get(deviceId) ?? 0) + 1)

    const now = Date.now()
    if (this.emptyWindowStartedAt === 0) {
      this.emptyWindowStartedAt = now
      return
    }
    const windowMs = now - this.emptyWindowStartedAt
    if (windowMs < this.emptyReportIntervalMs) return

    this.logger.info('EmbeddingDispatcher: nothing to embed — no frame was fetched', {
      meta: {
        events: this.emptyEventCount,
        windowMs,
        perDevice: Object.fromEntries(this.emptyEventsPerDevice),
        reason: 'DetectionResult.analysisResults was empty',
      },
    })

    this.emptyEventCount = 0
    this.emptyEventsPerDevice.clear()
    this.emptyWindowStartedAt = now
  }

  private async flushPending(): Promise<void> {
    const now = Date.now()
    const toFlush: PendingCrop[] = []

    for (const [trackId, pending] of this.pendingCrops) {
      if (now - pending.receivedAt > 3000) {
        toFlush.push(pending)
        this.pendingCrops.delete(trackId)
      }
    }

    await Promise.all(toFlush.map((p) => this.processOne(p)))
  }

  private async processOne(pending: PendingCrop): Promise<void> {
    try {
      const { crop, width, height } = await extractCrop(
        pending.frameData,
        pending.frameWidth,
        pending.frameHeight,
        pending.bbox,
      )

      // Single cross-process encoder cap — the collection is resolved
      // internally by the cap router (no in-process round-robin here). The
      // vector value is persisted as a side effect of `encode`; we keep only
      // `inferenceMs` + model info for the emitted telemetry event.
      const { embedding: _embedding, inferenceMs } = await this.encoder.encode(crop, width, height)
      const info = await this.encoder.getInfo()

      this._processedCount++
      this._totalInferenceMs += inferenceMs
      this.lastEmbedTime.set(pending.deviceId, Date.now())
      // A success on this camera ends its refusals (a reset, a recovered
      // download): what was counted since the last line is reported now, with
      // its real window, rather than lingering until stop().
      this.closeRefusals(Number(pending.deviceId))

      const embeddingId = `${pending.deviceId}/${pending.trackId}/${Date.now()}`

      const payload: EmbeddingStoredEvent = {
        deviceId: Number(pending.deviceId),
        trackId: pending.trackId,
        class: pending.class,
        embeddingId,
        modelId: info.modelId,
        embeddingDim: info.embeddingDim,
        inferenceMs,
        timestamp: Date.now(),
      }

      this.eventBus.emit(
        createEvent(
          EventCategory.EnrichmentEmbeddingStored,
          { type: 'addon', id: 'pipeline-analytics' },
          payload,
        ),
      )

      this.logger.debug('Embedded track', {
        tags: { deviceId: Number(pending.deviceId) },
        meta: {
          class: pending.class,
          trackId: pending.trackId,
          inferenceMs: Number(inferenceMs.toFixed(1)),
        },
      })
    } catch (err) {
      const refusal = embeddingRefusalOf(err)
      if (refusal !== null) {
        // The encoder refused BY NAME (D649, D6): a FAILED model, requirements
        // not met right now, or never. Every track on every camera gets the
        // same answer until it changes — counted, not logged per track.
        this.noteRefused(Number(pending.deviceId), refusal)
        return
      }
      this.logger.warn('Failed to embed track', {
        tags: { deviceId: Number(pending.deviceId) },
        meta: { trackId: pending.trackId, error: String(err) },
      })
    } finally {
      // ALWAYS release, on every exit — see the class note on `pendingCrops`.
      // Guarded on identity rather than key: `flushPending` deletes the key
      // BEFORE awaiting us, so by now a newer detection may have re-registered
      // this trackId with a fresher crop, and a blind delete would drop that
      // one instead of ours.
      if (this.pendingCrops.get(pending.trackId) === pending) {
        this.pendingCrops.delete(pending.trackId)
      }
    }
  }

  /**
   * Count a track the encoder refused by name, and report per (camera, code,
   * model): the first refusal at once, then one line per
   * {@link refusalReportIntervalMs} carrying the count. A branch that drops
   * work says so (CLAUDE.md), but at the live detail plane's rate one WARN per
   * track with the whole refusal text in it was the noise that hid the
   * transition; the line names the model, the tower, the node and the
   * recovery, and carries `tags.deviceId` so it groups per camera.
   */
  private noteRefused(deviceId: number, refusal: EmbeddingRefusal): void {
    const key = refusalKey(deviceId, refusal)
    const now = Date.now()
    const prior = this.modelRefusals.get(key)
    const refused = (prior?.refused ?? 0) + 1
    const reportedAt = prior?.reportedAt ?? 0
    if (reportedAt !== 0 && now - reportedAt < this.refusalReportIntervalMs) {
      this.modelRefusals.set(key, { ...refusal, deviceId, refused, reportedAt })
      return
    }
    this.reportRefusals({ ...refusal, deviceId, refused, reportedAt }, now)
    this.modelRefusals.set(key, { ...refusal, deviceId, refused: 0, reportedAt: now })
  }

  /** A camera embedded again: report and forget every refusal counted for it. */
  private closeRefusals(deviceId: number): void {
    const now = Date.now()
    for (const [key, entry] of this.modelRefusals) {
      if (entry.deviceId !== deviceId) continue
      if (entry.refused > 0) this.reportRefusals(entry, now, 'ended')
      this.modelRefusals.delete(key)
    }
  }

  /** Report what is still counted and unreported — nothing is lost at `stop()`. */
  private flushModelRefusals(): void {
    const now = Date.now()
    for (const entry of this.modelRefusals.values()) {
      if (entry.refused > 0) this.reportRefusals(entry, now, 'stopped')
    }
    this.modelRefusals.clear()
  }

  private reportRefusals(entry: ModelRefusals, now: number, closing?: 'ended' | 'stopped'): void {
    const report = REFUSAL_REPORT[entry.code]
    this.logger.warn(report.message, {
      tags: { deviceId: entry.deviceId },
      meta: {
        code: entry.code,
        modelId: entry.modelId,
        tower: entry.tower,
        nodeId: entry.nodeId,
        refused: entry.refused,
        windowMs: entry.reportedAt === 0 ? 0 : now - entry.reportedAt,
        ...(closing === undefined ? {} : { closing }),
        recovery: report.recovery(entry),
      },
    })
  }

  /**
   * Decoded frames currently pinned in {@link pendingCrops}.
   *
   * ~0.7 MB each (a whole RGB detection frame, not a crop), so this number IS
   * the dispatcher's memory footprint. Exposed because the entries are
   * invisible in every functional read: a stranded one looks exactly like a
   * track that was never detected.
   */
  pendingFrameCount(): number {
    return this.pendingCrops.size
  }
}
