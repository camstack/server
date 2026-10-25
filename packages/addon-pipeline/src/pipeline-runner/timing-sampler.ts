import type { IScopedLogger } from '@camstack/types'
import { BelowFloorAccumulator, type BelowFloorTally } from './below-floor-tally.js'
import { MotionWithoutInferenceDetector } from './motion-without-inference.js'

const REPORT_INTERVAL_MS = 10_000

/**
 * Audio sample shape consumed by the timing sampler. Pushed by the runner's
 * audio subscription handler so that the periodic timing log includes audio
 * classification stats alongside motion + detection stats.
 */
export interface AudioSample {
  readonly classifyMs: number
  readonly dbfs: number
  readonly topLabel: string | null
  readonly topScore: number
}

/**
 * Runtime info labels for the timing sampler: which engine and which models
 * produced the timings on the same line.
 *
 * NOT cosmetic — the previous word here, while nothing ever assigned this
 * object and every line logged `null` (D463). An inference figure cannot be
 * read without them: 300 ms means one thing on a CPU fallback and another on
 * an NPU. `pipeline-runner/index.ts` refreshes it; an unreadable half omits
 * only its own field.
 */
export interface RuntimeInfo {
  readonly pipelineRuntime?: string
  readonly pipelineModels?: readonly string[]
  readonly motionAddon?: string
  readonly audioEngine?: string
}

/**
 * Reader for a device's CUMULATIVE dropped-frames counter — the runner
 * registers one per camera pointing at its detection `FrameQueue`'s
 * monotonically-increasing `droppedFrames` getter. The sampler snapshots
 * it every report interval and logs the DELTA since the previous
 * snapshot as the `dropped` field of the `pipeline stats` line.
 */
export type DroppedFramesSource = () => number

/** The camera's elected inference `deviceKey`, or null when the node's default pool serves it. */
export type ElectedDeviceKeyResolver = (deviceId: number) => string | null

interface PhaseSample {
  /** ms waiting in queue before being picked */
  queueWait: number
  /** ms waiting to acquire semaphore */
  semaphoreWait: number
  /** ms for the full processFrame call (IPC + inference) */
  inference: number
  /** ms from result ready to event emitted */
  resultToEmit: number
  /** wall-clock pipeline latency: enqueue → event emitted */
  endToEnd: number
  /** wall-clock frame age when picked for inference: pickedAt − frame.capturedAt
   *  (how stale the analyzed frame is vs when it entered the shm ring). -1 if unknown. */
  frameAge: number
  /** number of detections returned */
  detections: number
  /** This frame's `below-threshold` discards, per class and score band
   *  (D665). Absent = the caller did not tally; `{}` = nothing dropped. */
  belowFloor?: BelowFloorTally
}

/**
 * Periodic timing-stats sampler. Accumulates per-camera samples for the
 * detection pipeline (capture → enqueue → semaphore → inference → emit),
 * motion analysis, and audio classification, and logs aggregated stats
 * every REPORT_INTERVAL_MS.
 */
export class PipelineTimingSampler {
  private readonly detSamples = new Map<number, PhaseSample[]>()
  private readonly motSamples = new Map<number, { ms: number; frameAge: number }[]>()
  /** See {@link MotionWithoutInferenceDetector} — the two-incident signature. */
  private readonly motionStall = new MotionWithoutInferenceDetector()
  private readonly audioSamples = new Map<number, AudioSample[]>()
  /** Per-device cumulative dropped-frames readers (see {@link DroppedFramesSource}). */
  private readonly droppedSources = new Map<number, DroppedFramesSource>()
  /** Cumulative value seen at the previous report — the delta base. */
  private readonly lastDroppedCumulative = new Map<number, number>()
  /** Boxes the operator's class floor dropped since the last report (D665). */
  private readonly belowFloor = new BelowFloorAccumulator()
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private log: IScopedLogger | null = null
  private electedDeviceKey: ElectedDeviceKeyResolver | null = null
  runtimeInfo: RuntimeInfo = {}

  setLogger(logger: IScopedLogger): void {
    this.log = logger
  }

  /** Who answers "which device serves this camera" for the per-camera line. */
  setElectedDeviceKeyResolver(resolver: ElectedDeviceKeyResolver): void {
    this.electedDeviceKey = resolver
  }

  start(): void {
    if (this.reportTimer) return
    this.reportTimer = setInterval(() => this.report(), REPORT_INTERVAL_MS)
  }

  stop(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer)
      this.reportTimer = null
    }
  }

  addSample(deviceId: number, s: PhaseSample): void {
    if (!this.detSamples.has(deviceId)) this.detSamples.set(deviceId, [])
    this.detSamples.get(deviceId)!.push(s)
    if (s.belowFloor !== undefined) this.belowFloor.add(deviceId, s.belowFloor)
  }

  /**
   * Moving average inference time (ms) per camera over the current
   * accumulation window — the same `inf` samples the `pipeline stats` log
   * line aggregates (see {@link report}'s `inf` computation). Consumed by
   * the {@link FrameGovernor} recompute tick as `CameraLoadSample.avgInferenceMs`.
   * The window resets on every {@link report} call (every REPORT_INTERVAL_MS),
   * so a camera with zero completed inferences since the last report is
   * simply absent from the returned map — callers supply their own default.
   */
  avgInferenceMsByCamera(): ReadonlyMap<number, number> {
    const result = new Map<number, number>()
    for (const [deviceId, samples] of this.detSamples) {
      if (samples.length === 0) continue
      const total = samples.reduce((sum, s) => sum + s.inference, 0)
      result.set(deviceId, total / samples.length)
    }
    return result
  }

  addMotionSample(deviceId: number, ms: number, frameAge = -1): void {
    if (!this.motSamples.has(deviceId)) this.motSamples.set(deviceId, [])
    this.motSamples.get(deviceId)!.push({ ms, frameAge })
  }

  addAudioSample(deviceId: number, s: AudioSample): void {
    if (!this.audioSamples.has(deviceId)) this.audioSamples.set(deviceId, [])
    this.audioSamples.get(deviceId)!.push(s)
  }

  /**
   * Register the cumulative dropped-frames reader for a device. The
   * baseline snapshot is taken immediately so the first report after
   * registration only covers drops that happened AFTER registration.
   */
  setDroppedFramesSource(deviceId: number, source: DroppedFramesSource): void {
    this.droppedSources.set(deviceId, source)
    this.lastDroppedCumulative.set(deviceId, source())
  }

  clearDroppedFramesSource(deviceId: number): void {
    this.droppedSources.delete(deviceId)
    this.lastDroppedCumulative.delete(deviceId)
  }

  /**
   * Snapshot the device's cumulative dropped counter and return the
   * delta since the previous snapshot. Guarded to never go negative
   * (a replaced/reset queue restarts its counter at 0).
   */
  private sampleDroppedDelta(deviceId: number): number {
    const source = this.droppedSources.get(deviceId)
    if (!source) return 0
    const cumulative = source()
    const previous = this.lastDroppedCumulative.get(deviceId) ?? 0
    this.lastDroppedCumulative.set(deviceId, cumulative)
    return Math.max(0, cumulative - previous)
  }

  private report(): void {
    if (!this.log) return

    const avg = (arr: number[]): number =>
      arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
    const max = (arr: number[]): number => (arr.length > 0 ? Math.round(Math.max(...arr)) : 0)
    const p95 = (arr: number[]): number => {
      if (arr.length === 0) return 0
      const sorted = [...arr].toSorted((a, b) => a - b)
      return Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]!)
    }

    const rt = this.runtimeInfo

    // Devices with completed inferences OR a registered drop source. Under
    // full overload (inference slower than the report interval) a device can
    // have ZERO completed samples in a window while still shedding frames —
    // the drop-only stats line is exactly the overload signal.
    const statDeviceIds = new Set<number>([
      ...this.detSamples.keys(),
      ...this.droppedSources.keys(),
    ])

    for (const deviceId of statDeviceIds) {
      const det = this.detSamples.get(deviceId) ?? []
      // Per-interval delta of the detection queue's cumulative dropped
      // counter (latest-frame-only queue: every enqueue over a live frame
      // is a real shed). Replaces the dead `addDrop()` plumbing that left
      // `dropped` pinned at 0 regardless of load.
      const dropped = this.sampleDroppedDelta(deviceId)
      if (det.length === 0 && dropped === 0) continue
      const e2e = det.map((s) => s.endToEnd)
      const inf = det.map((s) => s.inference)
      const frameAge = det.map((s) => s.frameAge).filter((v) => v >= 0)
      const totalDet = det.reduce((s, d) => s + d.detections, 0)

      this.log.info('pipeline stats', {
        tags: { deviceId },
        meta: {
          frames: det.length,
          intervalSec: REPORT_INTERVAL_MS / 1000,
          // enqueue → emit, in ms. Stage breakdown (avg) exposes WHERE the
          // latency sits: queue backlog vs semaphore contention vs inference
          // vs result-emit. inference is usually the floor (model chain).
          e2e: { avg: avg(e2e), p95: p95(e2e), max: max(e2e) },
          // Frame age (capture→inference-pick): if large, the analyzed frame is
          // already stale (decoder/ring behind), which delays the overlay
          // regardless of how fast the result is delivered.
          frameAge: { avg: avg(frameAge), p95: p95(frameAge), max: max(frameAge) },
          stagesMs: {
            queueWait: avg(det.map((s) => s.queueWait)),
            semaphoreWait: avg(det.map((s) => s.semaphoreWait)),
            inference: avg(inf),
            resultToEmit: avg(det.map((s) => s.resultToEmit)),
          },
          inference: { avg: avg(inf), p95: p95(inf) },
          detections: totalDet,
          // Boxes the per-class confidence floor took from the tracker this
          // interval, class → score band → count (D665). `{}` is measured zero.
          belowFloor: this.belowFloor.drain(deviceId),
          dropped,
          // The device THIS camera was elected onto (null = default pool);
          // `pipelineRuntime` names every pool resident on the node.
          deviceKey: this.electedDeviceKey?.(deviceId) ?? null,
          pipelineRuntime: rt.pipelineRuntime ?? null,
          pipelineModels: rt.pipelineModels ?? null,
        },
      })
    }
    // MOTION WITHOUT INFERENCE — the signature that cost two incidents.
    // Evaluated here because this is the one place holding BOTH series for the
    // same interval. A camera with motion and zero DETECTIONS is ordinary; a
    // camera with motion and zero inference FRAMES is the 65-minute outage of
    // 2026-07-30, which nothing reported at the time.
    const devicesSeen = new Set<number>([...this.detSamples.keys(), ...this.motSamples.keys()])
    for (const deviceId of devicesSeen) {
      const verdict = this.motionStall.observe(deviceId, {
        motionFrames: this.motSamples.get(deviceId)?.length ?? 0,
        inferenceFrames: this.detSamples.get(deviceId)?.length ?? 0,
      })
      if (verdict.kind === 'stalled') {
        this.log.warn('motion is flowing but NOTHING is being inferred', {
          tags: { deviceId },
          meta: {
            intervals: verdict.intervals,
            forSec: (verdict.intervals * REPORT_INTERVAL_MS) / 1000,
            motionFrames: this.motSamples.get(deviceId)?.length ?? 0,
          },
        })
      } else if (verdict.kind === 'recovered') {
        this.log.info('inference resumed after a motion-without-inference stall', {
          tags: { deviceId },
          meta: {
            intervals: verdict.intervals,
            lastedSec: (verdict.intervals * REPORT_INTERVAL_MS) / 1000,
          },
        })
      }
    }

    this.detSamples.clear()

    for (const [deviceId, mot] of this.motSamples) {
      if (mot.length === 0) continue
      const ms = mot.map((s) => s.ms)
      const frameAge = mot.map((s) => s.frameAge).filter((v) => v >= 0)
      this.log.info('motion stats', {
        tags: { deviceId },
        meta: {
          frames: mot.length,
          intervalSec: REPORT_INTERVAL_MS / 1000,
          avg: avg(ms),
          p95: p95(ms),
          max: max(ms),
          // Frame age at motion analysis (capture→analysis). Large = stale
          // input frame (decoder/ring behind) → motion box lags real movement.
          frameAge: { avg: avg(frameAge), p95: p95(frameAge), max: max(frameAge) },
        },
      })
    }
    this.motSamples.clear()

    for (const [deviceId, aud] of this.audioSamples) {
      if (aud.length === 0) continue
      const classifyTimes = aud.filter((a) => a.classifyMs > 0).map((a) => a.classifyMs)
      const classified = aud.filter((a) => a.topLabel !== null)
      const topLabels = new Map<string, number>()
      for (const a of classified) {
        if (a.topLabel) topLabels.set(a.topLabel, (topLabels.get(a.topLabel) ?? 0) + 1)
      }
      const topSummary = [...topLabels.entries()]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([l, c]) => `${l}×${c}`)
        .join(', ')
      const avgDbfs = avg(aud.map((a) => Math.round(a.dbfs)))

      this.log.info('audio stats', {
        tags: { deviceId },
        meta: {
          chunks: aud.length,
          intervalSec: REPORT_INTERVAL_MS / 1000,
          classified: classified.length,
          classifyAvgMs: classifyTimes.length > 0 ? avg(classifyTimes) : 0,
          avgDbfs,
          topLabels: topSummary,
          audioEngine: rt.audioEngine ?? null,
        },
      })
    }
    this.audioSamples.clear()
  }
}
