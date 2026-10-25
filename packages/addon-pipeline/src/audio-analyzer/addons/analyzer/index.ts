import type {
  AudioAnalyzerGlobalConfig,
  AudioBackendChoice,
  AudioChunkInput,
  AudioAnalysisResult,
  AudioAnalysisSettings,
  IAudioAnalyzer,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  ProviderRegistration,
} from '@camstack/types'
import {
  AUDIO_BACKEND_CHOICES,
  BaseAddon,
  DEFAULT_AUDIO_ANALYZER_CONFIG,
  EventCategory,
  audioAnalysisCapability,
  audioAnalyzerCapability,
  errMsg,
  hydrateSchema,
  mapAudioLabelToMacro,
} from '@camstack/types'
import type { AudioClassificationResult, AudioClassifyOutcome } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import type {
  AudioBackend,
  AudioClassificationResult as AudioPipelineResult,
  IAudioPipeline,
} from '../../audio-pipeline.js'
import { createAudioPipeline } from '../../audio-pipeline.js'
import type { AudioAttachRequest } from '../../audio-device-attachments.js'
import { AudioDeviceAttachments } from '../../audio-device-attachments.js'
import type { AudioClassifySubmission } from '../../audio-classify-queue.js'
import { AudioClassifyQueue } from '../../audio-classify-queue.js'
import { AudioBackendExitedError } from '../../audio-subprocess-channel.js'
import { pickNodePlatformArch } from '../../../shared/node-topology-platform.js'
import { readProcessMemory } from '../../../shared/process-memory.js'
import {
  PoolMemoryWatchdog,
  resolvePoolMemoryPolicy,
  type PoolMemoryTelemetry,
} from '@camstack/types'

/**
 * AudioAnalyzerProvider — implements IAudioAnalyzer.
 *
 * Computes dB/RMS on every chunk and classifies via the in-process
 * IAudioPipeline (YAMNet ONNX / Apple SoundAnalysis). No tRPC roundtrip
 * to a separate audio-classifier addon.
 */

// Suppress repeated classify-error logs. Timeouts are expected during
// pipeline startup or under CPU pressure — log once, then silence for 30s.
const CLASSIFY_ERROR_SUPPRESS_MS = 30_000

// Bound on ONE inference (D660 round 1). A 1 s YAMNet window takes ~33 ms on
// the hub (7.5% of one core serving ~2.3 windows/s, 2026-09-27 — ONNX pinned
// to one thread); Apple SoundAnalysis is of the same order. 5 s is ~150× that
// and 5 window-lengths: past it the backend is hung, not slow, and because
// every camera on the node waits behind this one inference the bound must be
// short. The spawn + model load (`ensurePipeline`) is NOT under this bound.
const INFERENCE_TIMEOUT_MS = 5_000

/** An inference that did not answer within {@link INFERENCE_TIMEOUT_MS}. */
class AudioInferenceTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`audio inference did not answer within ${timeoutMs} ms`)
    this.name = 'AudioInferenceTimeoutError'
  }
}

// How often the per-camera classify accounting is reported (D660): one line
// per camera per period, and only for a camera that lost a window.
const CLASSIFY_ACCOUNTING_PERIOD_MS = 60_000

// Near-miss watch (D660). Macro classes an operator's audio rules are known to
// watch, logged when the model heard them BELOW the camera's floor. A fixed
// list on purpose: the analyzer cannot know which labels the Notification
// Center's rules watch without a cross-addon read, and a new transport for a
// diagnostic line is not worth it. YAMNet only reports a raw label at ≥ 0.05
// (`yamnet_audio.py` MIN_SCORE), so any appearance is already a real signal.
const NEAR_MISS_WATCHED_MACROS: ReadonlySet<string> = new Set(['crying', 'scream'])
// One near-miss line per camera per this window; the rest are counted.
const NEAR_MISS_LOG_INTERVAL_MS = 60_000

// Idle-dispose window. If no classify call lands for this long, tear the
// inference subprocess (YAMNet Python / Apple SoundAnalysis CLI, resident model
// ~100+MB) down and free the model; the next classify lazily re-spawns it.
// Generous so a briefly-quiet camera never thrashes the subprocess.
const PIPELINE_IDLE_DISPOSE_MS = 5 * 60_000

// Sentinel key used when no deviceId is supplied (legacy callers).
const GLOBAL_DEVICE_KEY = -1

/** Near-miss rate limit state, per camera. */
interface NearMissLogState {
  readonly lastLoggedMs: number
  readonly suppressed: number
}

/** The labels a window cleared the camera's floor (and allow-list) with. */
function labelsAboveFloor(
  result: AudioClassificationResult,
  settings: AudioAnalysisSettings,
): AudioClassificationResult['labels'] {
  const allowed =
    settings.allowedClasses.length > 0
      ? new Set(settings.allowedClasses.map((c) => c.toLowerCase()))
      : null
  return result.labels.filter(
    (c) =>
      c.score >= settings.minConfidence &&
      (allowed === null || allowed.has(c.className.toLowerCase())),
  )
}

/** The stream parameters one device's windows arrive with. */
interface WindowFormat {
  readonly sampleRate: number
  readonly channels: number
}

/** What the classifier consumes natively; anything else is resampled next to it. */
const CLASSIFIER_SAMPLE_RATE = 16000
const CLASSIFIER_CHANNELS = 1

/**
 * Reconstruct a Float32 view over f32le PCM bytes carried in a Uint8Array.
 *
 * `@msgpack/msgpack` decodes a binary blob into a Uint8Array that is a subview
 * of its internal decode buffer, whose `byteOffset` is NOT guaranteed to be
 * 4-byte aligned (observed e.g. 9). `new Float32Array(buf, offset, …)` then
 * throws "start offset of Float32Array should be a multiple of 4". When the
 * offset is misaligned we copy into a fresh 0-offset buffer; the aligned
 * fast-path reuses the existing view with no copy.
 */
function float32FromBytes(raw: Uint8Array): Float32Array {
  const bytes = raw.byteOffset % 4 === 0 ? raw : new Uint8Array(raw)
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
}

export class AudioAnalyzerProvider implements IAudioAnalyzer {
  private readonly log: IScopedLogger
  private classifyCallCount = 0
  private lastClassifyErrorMs = 0
  private suppressedClassifyErrors = 0
  private classifyCount = 0
  private backendName = 'unknown'
  /** When true, logs a raw-label sample every 100 classifications (opt-in
   *  debug aid). Off by default — the watchdog heartbeat covers liveness. */
  private readonly debugClassifySamples = false
  /** The one line every camera's windows wait in for the single pipeline (D660).
   *  Key = deviceId (or GLOBAL_DEVICE_KEY for legacy callers). */
  private readonly classifyQueue = new AudioClassifyQueue<AudioClassificationResult>()
  /** Periodic per-camera classify accounting (D660). */
  private readonly accountingTimer: ReturnType<typeof setInterval>
  /** Near-miss line rate limit, per camera (D660). */
  private readonly nearMissLog = new Map<number, NearMissLogState>()
  /** Last window format seen per camera — the first and every change is logged (D450). */
  private readonly windowFormats = new Map<number, WindowFormat>()
  // Apple SA and YAMNet are single-channel: both backends hold ONE
  // pendingResolve slot, so two overlapping classify() calls clobber each
  // other. `classifyQueue` runs exactly one inference at a time, above the
  // backend — it WAITS the others instead of discarding them (D660).

  /** Live inference pipeline. LAZY: null until the first classify() spawns it
   *  (see `ensurePipeline`); idle-disposed back to null after a long quiet
   *  window so a node hosting the addon with no consumer never keeps the
   *  YAMNet Python / Apple SoundAnalysis subprocess resident. */
  private pipeline: IAudioPipeline | null = null
  /** Single-flight guard for the lazy spawn — concurrent first-calls await the
   *  same build instead of spawning the subprocess twice. */
  private pipelineInitPromise: Promise<IAudioPipeline> | null = null
  /** Backend the NEXT lazy init will build (kept in sync with the operator's
   *  effective choice via `reconfigureBackend`). */
  private desiredBackend: AudioBackend
  /** Idle-dispose timer — (re)armed after every classify. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Set on `dispose()` (addon stop) so a late classify/idle-timer never
   *  re-spawns the subprocess after teardown. */
  private disposed = false

  constructor(
    logger: IScopedLogger,
    /** Builds + initializes a fresh pipeline for the given backend. The addon
     *  passes its own `buildPipeline`; the provider calls it lazily on the
     *  first classify() and again on an in-place backend swap. */
    private readonly pipelineFactory: (backend: AudioBackend) => Promise<IAudioPipeline>,
    /** The effective backend picked by the addon's `resolveAudioBackend()`
     *  (operator override or platform default). Seeds `desiredBackend` and the
     *  `engine:` log tag; the actual subprocess is spawned lazily. */
    initialBackend: AudioBackend,
    private readonly deviceSettingsResolver: (
      deviceId: number,
    ) => Promise<AudioAnalysisSettings | null>,
    private readonly deviceContributionResolver: (
      deviceId: number,
    ) => Promise<ConfigUISchemaWithValues | null>,
    private readonly deviceSettingsPatcher: (
      deviceId: number,
      patch: Record<string, unknown>,
    ) => Promise<void>,
    private readonly reprobeImpl: () => Promise<{ backend: string }>,
    /**
     * This analyzer's own broker subscriptions (D461). The audio no longer
     * arrives as an `analyseChunk` push from a relay that only buffered it —
     * this process pulls it, windows it and analyses it without the bytes
     * crossing hub-main a second and third time.
     */
    private readonly attachments: AudioDeviceAttachments,
  ) {
    this.log = logger
    this.backendName = initialBackend
    this.desiredBackend = initialBackend
    // RSS bound + periodic memory line for the audio inference subprocess
    // (YAMNet Python / Apple SA CLI) — the same shared watchdog the detection
    // pools use (2026-08-18 OOM audit). Sweeps no-op while the pipeline is
    // idle-disposed; a watchdog restart is exactly the idle-dispose path, and
    // the next classify lazily re-spawns — no second lifecycle.
    this.memoryGuard = new PoolMemoryWatchdog({
      policy: resolvePoolMemoryPolicy(process.env),
      log: this.log.child('pool-memory'),
      sample: () => this.samplePipelineMemory(),
      restart: () => this.restartPipelineForMemory(),
    })
    this.memoryGuard.start()
    this.accountingTimer = setInterval(
      () => this.reportClassifyAccounting(),
      CLASSIFY_ACCOUNTING_PERIOD_MS,
    )
    if (typeof this.accountingTimer.unref === 'function') this.accountingTimer.unref()
  }

  /**
   * One line per camera that lost a window since the last report (D660):
   * how many were classified, superseded by the camera's own newer window,
   * failed, or cut off by shutdown. Never one line per window, and nothing
   * for a camera that lost none.
   */
  reportClassifyAccounting(): void {
    for (const a of this.classifyQueue.takeAccounting()) {
      const lost = a.superseded + a.errors + a.disposed
      if (lost === 0) continue
      this.log.info('audio classify accounting', {
        tags: a.key === GLOBAL_DEVICE_KEY ? undefined : { deviceId: a.key },
        meta: {
          classified: a.classified,
          superseded: a.superseded,
          errors: a.errors,
          disposed: a.disposed,
          periodMs: CLASSIFY_ACCOUNTING_PERIOD_MS,
        },
      })
    }
  }

  /** Memory watchdog for the inference subprocess (see constructor). */
  private readonly memoryGuard: PoolMemoryWatchdog

  private async samplePipelineMemory(): Promise<readonly PoolMemoryTelemetry[]> {
    const live = this.pipeline
    const pid = live?.getPid() ?? null
    if (!live || pid === null) return [] // idle-disposed / not yet spawned — nothing to bound
    const mem = await readProcessMemory(pid)
    if (!mem) {
      // A subprocess the watchdog cannot read is a bound that quietly
      // stopped existing — say so instead of skipping silently.
      this.log.warn('audio pipeline memory sample dropped', {
        meta: { pid, backend: this.backendName },
      })
      return []
    }
    const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))
    return [
      {
        key: 'audio',
        pids: [pid],
        rssBytes: mem.rssBytes,
        meta: {
          backend: this.backendName,
          vmMb: mb(mem.vmBytes),
          peakRssMb: mb(mem.hwmBytes),
          swapMb: mb(mem.swapBytes),
          threads: mem.threads,
          classifyCount: this.classifyCount,
        },
      },
    ]
  }

  /** Watchdog restart: tear the subprocess down NOW; the next classify
   *  re-spawns lazily (same recovery as an idle-dispose). An in-flight
   *  classify fails once and is handled by the existing classify error
   *  path — a bounded gap, unlike the kernel's OOM alternative. */
  private async restartPipelineForMemory(): Promise<void> {
    if (this.disposed) return
    const live = this.pipeline
    if (!live) return
    this.pipeline = null
    await live.dispose()
  }

  /**
   * Lazily spawn + initialize the inference pipeline on first use. The
   * subprocess (YAMNet Python / Apple SoundAnalysis CLI, resident model) is NOT
   * booted at addon start — only when the first classify() actually lands, so a
   * node hosting the addon with no audio-classification consumer never spawns
   * it. Concurrent first-calls single-flight through `pipelineInitPromise` so
   * the subprocess is spawned exactly once.
   */
  private async ensurePipeline(): Promise<IAudioPipeline> {
    if (this.disposed) throw new Error('audio-analyzer: provider disposed')
    const live = this.pipeline
    if (live) return live
    if (this.pipelineInitPromise) return this.pipelineInitPromise

    const backend = this.desiredBackend
    const init = (async (): Promise<IAudioPipeline> => {
      this.log.info('audio pipeline lazy init (first classify)', { meta: { backend } })
      const built = await this.pipelineFactory(backend)
      // Disposed while we were building — tear the fresh pipeline down instead
      // of leaking a subprocess past shutdown.
      if (this.disposed) {
        await built.dispose().catch(() => {
          /* provider torn down mid-init — best-effort cleanup */
        })
        throw new Error('audio-analyzer: provider disposed during init')
      }
      this.pipeline = built
      this.backendName = backend
      return built
    })()
    this.pipelineInitPromise = init
    try {
      return await init
    } finally {
      this.pipelineInitPromise = null
    }
  }

  /** (Re)arm the idle-dispose timer. Called after every classify. */
  private scheduleIdleDispose(): void {
    if (this.disposed) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const timer = setTimeout(() => {
      this.idleTimer = null
      void this.disposeIdlePipeline()
    }, PIPELINE_IDLE_DISPOSE_MS)
    // Don't keep the event loop alive solely for the idle sweep.
    if (typeof timer.unref === 'function') timer.unref()
    this.idleTimer = timer
  }

  /**
   * Tear the inference subprocess down after a long idle window, freeing the
   * resident model. The next classify lazily re-spawns it. No-op (and re-arms)
   * if a classify is in flight; no-op if nothing is spawned.
   */
  private async disposeIdlePipeline(): Promise<void> {
    if (this.disposed) return
    if (this.classifyQueue.busy || this.pipelineInitPromise) {
      // Work landed between the timer firing and now — re-arm, don't dispose.
      this.scheduleIdleDispose()
      return
    }
    const live = this.pipeline
    if (!live) return
    this.pipeline = null
    try {
      await live.dispose()
      this.log.info('audio pipeline idle-disposed — freed inference subprocess', {
        meta: { backend: this.backendName, idleMs: PIPELINE_IDLE_DISPOSE_MS },
      })
    } catch (err: unknown) {
      this.log.warn('audio pipeline idle-dispose failed', { meta: { error: errMsg(err) } })
    }
  }

  // ── Device-details aggregator contribution ──────────────────────────────

  async getDeviceSettingsContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return this.deviceContributionResolver(input.deviceId)
  }

  async getDeviceLiveContribution(_input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return null
  }

  async applyDeviceSettingsPatch(input: {
    deviceId: number
    patch: Record<string, unknown>
  }): Promise<{ success: true }> {
    await this.deviceSettingsPatcher(input.deviceId, input.patch)
    return { success: true as const }
  }

  /**
   * Return the effective per-device audio-analyzer settings, resolved via
   * the kernel's 3-level settings resolver (schema default → global →
   * device override). Orchestrator consumers call this method so they
   * never need to know the audio-analyzer schema field names.
   */
  async resolveDeviceSettings({
    deviceId,
  }: {
    deviceId: number
  }): Promise<AudioAnalysisSettings | null> {
    return this.deviceSettingsResolver(deviceId)
  }

  /**
   * Start pulling this camera's audio from the broker, in THIS process (D461).
   * Thin delegate — the attachment registry owns the poller, the window and
   * the result event; this method exists so the orchestrator can express the
   * policy it still owns ("this camera's audio runs, on this node") without
   * owning the bytes.
   */
  async attachDevice(input: AudioAttachRequest): Promise<{
    attached: boolean
    replaced: boolean
  }> {
    return this.attachments.attach(input)
  }

  /** Stop pulling this camera's audio and release the broker subscription. */
  async detachDevice({ deviceId }: { deviceId: number }): Promise<{ detached: boolean }> {
    return this.attachments.detach(deviceId)
  }

  async analyseChunk({
    chunk,
    settings,
  }: {
    chunk: AudioChunkInput
    settings: AudioAnalysisSettings
  }): Promise<AudioAnalysisResult | null> {
    // AudioChunkInput.data carries raw f32le bytes (4 bytes per sample).
    // Reconstruct the Float32Array view here — do NOT iterate the Uint8Array
    // directly, because each byte (0–255) is NOT a sample value.
    // MsgPack decodes the blob into a Uint8Array that is a subview of its
    // internal buffer, whose byteOffset is NOT guaranteed 4-byte aligned
    // (e.g. 9) — `new Float32Array(buf, offset, …)` then throws "start offset
    // … multiple of 4". Copy into a fresh 0-offset buffer when misaligned
    // (fast-path reuses the view when already aligned).
    const samples = float32FromBytes(chunk.data)
    this.reportWindowFormat(chunk, samples.length)

    // ── Compute dB/RMS levels (always) ──
    let sumSquares = 0
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i]! * samples[i]!
    }
    const rms = Math.sqrt(sumSquares / samples.length)
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -96

    const level = {
      rms: Math.round(rms * 10000) / 10000,
      dbfs: Math.round(dbfs * 10) / 10,
    }

    // ── Classification (in-process pipeline, one queue for every camera) ──
    const { classification, classifyOutcome } = await this.classifyForAnalysis(chunk, settings)
    return { level, classification, classifyOutcome, timestamp: chunk.timestamp }
  }

  /**
   * Run one window through the shared queue and apply the camera's floor.
   * Every exit names whether the model RAN (`classifyOutcome`, D660): a window
   * superseded by the camera's newer one, or whose inference failed, is
   * `not-classified` — never an empty classification.
   */
  private async classifyForAnalysis(
    chunk: AudioChunkInput,
    settings: AudioAnalysisSettings,
  ): Promise<{
    classification: AudioAnalysisResult['classification']
    classifyOutcome: AudioClassifyOutcome
  }> {
    let submission: AudioClassifySubmission<AudioClassificationResult>
    try {
      submission = await this.classifyWindow(chunk)
    } catch (err: unknown) {
      const timedOut = err instanceof AudioInferenceTimeoutError
      // A timeout already wrote its own line, tagged, when it tripped.
      if (!timedOut) this.reportClassifyError(chunk, err)
      return {
        classification: undefined,
        classifyOutcome: { state: 'not-classified', reason: timedOut ? 'timeout' : 'error' },
      }
    }
    if (!submission.ran) {
      // Counted per camera by the queue and reported by
      // `reportClassifyAccounting` — one line a minute, not one per window.
      return {
        classification: undefined,
        classifyOutcome: { state: 'not-classified', reason: submission.reason },
      }
    }
    const result = submission.value
    this.logClassifySample(chunk, result, settings)
    this.reportNearMiss(chunk, result, settings)
    const filtered = labelsAboveFloor(result, settings)
    return {
      classification:
        filtered.length > 0 ? { labels: filtered, inferenceMs: result.inferenceMs } : undefined,
      classifyOutcome: { state: 'classified' },
    }
  }

  /** First-three debug samples + the per-window debug line (unchanged behaviour). */
  private logClassifySample(
    chunk: AudioChunkInput,
    result: AudioClassificationResult,
    settings: AudioAnalysisSettings,
  ): void {
    const tags = chunk.deviceId !== undefined ? { deviceId: chunk.deviceId } : undefined
    if (this.classifyCallCount < 3) {
      this.log.info('classify debug sample', {
        tags,
        meta: {
          index: this.classifyCallCount,
          labelCount: result.labels.length,
          top: result.labels
            .slice(0, 5)
            .map((l) => `${l.className}(${(l.score * 100).toFixed(0)}%)`)
            .join(', '),
          inferenceMs: result.inferenceMs,
          minConf: settings.minConfidence,
          allowedClasses: settings.allowedClasses,
        },
      })
    }
    this.classifyCallCount++

    // Audio classification observability — any meaningful (non-silence ≥15%)
    // classification, at debug: this fires per window per camera.
    const meaningful = result.labels.filter(
      (l) => l.score >= 0.15 && l.className.toLowerCase() !== 'silence',
    )
    if (meaningful.length > 0) {
      this.log.debug('audio classification', {
        tags,
        meta: {
          top: meaningful
            .slice(0, 4)
            .map((l) => `${l.className}(${(l.score * 100).toFixed(0)}%)`)
            .join(', '),
          inferenceMs: result.inferenceMs,
        },
      })
    }
  }

  /**
   * A watched macro (crying, scream) the model heard BELOW this camera's
   * floor — one line per camera per {@link NEAR_MISS_LOG_INTERVAL_MS}, the
   * rest counted into the next line (D660). This is the line that tells an
   * operator whose rule never fires whether the sound was heard at all.
   */
  private reportNearMiss(
    chunk: AudioChunkInput,
    result: AudioClassificationResult,
    settings: AudioAnalysisSettings,
  ): void {
    const miss = result.labels.find(
      (l) => NEAR_MISS_WATCHED_MACROS.has(l.className) && l.score < settings.minConfidence,
    )
    if (miss === undefined) return
    const key = chunk.deviceId ?? GLOBAL_DEVICE_KEY
    const now = Date.now()
    const prev = this.nearMissLog.get(key) ?? null
    if (prev !== null && now - prev.lastLoggedMs < NEAR_MISS_LOG_INTERVAL_MS) {
      this.nearMissLog.set(key, { ...prev, suppressed: prev.suppressed + 1 })
      return
    }
    this.nearMissLog.set(key, { lastLoggedMs: now, suppressed: 0 })
    this.log.info('audio near-miss below floor', {
      tags: chunk.deviceId !== undefined ? { deviceId: chunk.deviceId } : undefined,
      meta: {
        label: miss.className,
        originalClass: miss.originalClass,
        score: miss.score,
        floor: settings.minConfidence,
        suppressedSince: prev?.suppressed ?? 0,
        intervalMs: NEAR_MISS_LOG_INTERVAL_MS,
      },
    })
  }

  /** Rate-limited classify-failure line (unchanged behaviour). */
  private reportClassifyError(chunk: AudioChunkInput, err: unknown): void {
    const now = Date.now()
    if (now - this.lastClassifyErrorMs < CLASSIFY_ERROR_SUPPRESS_MS) {
      this.suppressedClassifyErrors++
      return
    }
    const suppressed = this.suppressedClassifyErrors
    this.suppressedClassifyErrors = 0
    this.lastClassifyErrorMs = now
    this.log.warn('Audio classification failed', {
      tags: chunk.deviceId !== undefined ? { deviceId: chunk.deviceId } : undefined,
      meta: {
        error: errMsg(err),
        stack: err instanceof Error ? err.stack : undefined,
        suppressedSince: suppressed > 0 ? suppressed : undefined,
      },
    })
  }

  /**
   * Say what this camera's windows arrive as — once, and again on every
   * change. The plane carries the source rate (8 kHz for G.711 since D450,
   * 16 kHz for AAC through the codec session), and the classifier resamples
   * anything that is not 16 kHz mono next to the model. A camera whose
   * format flips mid-subscription (a broker redeploy) is visible here, and
   * a consumer that stopped receiving what it expected is never silent
   * (D427).
   */
  private reportWindowFormat(chunk: AudioChunkInput, sampleCount: number): void {
    const key = chunk.deviceId ?? GLOBAL_DEVICE_KEY
    const format: WindowFormat = { sampleRate: chunk.sampleRate, channels: chunk.channels }
    const previous = this.windowFormats.get(key) ?? null
    if (
      previous !== null &&
      previous.sampleRate === format.sampleRate &&
      previous.channels === format.channels
    ) {
      return
    }
    this.windowFormats.set(key, format)
    const channels = chunk.channels > 0 ? chunk.channels : 1
    const windowMs =
      chunk.sampleRate > 0 ? Math.round((sampleCount / channels / chunk.sampleRate) * 1000) : null
    this.log.info('audio window format', {
      tags: chunk.deviceId !== undefined ? { deviceId: chunk.deviceId } : undefined,
      meta: {
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        bytes: chunk.data.byteLength,
        windowMs,
        classifierResamples:
          chunk.sampleRate !== CLASSIFIER_SAMPLE_RATE || chunk.channels !== CLASSIFIER_CHANNELS,
        previous,
      },
    })
  }

  /**
   * The cap's `classify`: one window through the same queue every camera
   * uses. A window that never reached the model is an ERROR here, not an
   * empty result — the caller asked for a classification and did not get one.
   */
  async classify(chunk: AudioChunkInput): Promise<AudioClassificationResult> {
    const submission = await this.classifyWindow(chunk)
    if (!submission.ran) {
      throw new Error(`audio classify not run: ${submission.reason}`)
    }
    return submission.value
  }

  /**
   * Queue one window for the single pipeline (D660). Per camera at most one
   * waits; a newer window from the same camera supersedes it and takes its
   * place in line. Cameras are served in arrival order. Rejects with the
   * inference's own error.
   */
  private classifyWindow(
    chunk: AudioChunkInput,
  ): Promise<AudioClassifySubmission<AudioClassificationResult>> {
    return this.classifyQueue.submit(chunk.deviceId ?? GLOBAL_DEVICE_KEY, () =>
      this.runInference(chunk),
    )
  }

  /** One inference on the live pipeline. Only ever called by the queue — never two at once. */
  private async runInference(chunk: AudioChunkInput): Promise<AudioClassificationResult> {
    try {
      // Lazily spawn the inference subprocess on first use (single-flight),
      // reuse the live one thereafter. The queue serialises inferences, so at
      // most one spawn is ever in flight.
      const pipeline = await this.ensurePipeline()

      // AudioChunkInput.data carries raw f32le bytes — reconstruct Float32Array
      // before passing to the pipeline (YAMNet/Apple SoundAnalysis need floats).
      // See float32FromBytes: msgpack-decoded Uint8Arrays may be 4-byte-misaligned.
      const f32Data = float32FromBytes(chunk.data)
      const result = await this.boundedInference(pipeline, chunk, f32Data)

      // Log raw labels at regular intervals — opt-in debug only.
      if (this.debugClassifySamples && (this.classifyCount < 3 || this.classifyCount % 100 === 0)) {
        const rawTop = result.classifications
          .slice(0, 5)
          .map((c) => `"${c.className}"(${(c.score * 100).toFixed(0)}%)`)
          .join(', ')
        this.log.info('classify debug sample', {
          tags: chunk.deviceId !== undefined ? { deviceId: chunk.deviceId } : undefined,
          meta: {
            index: this.classifyCount,
            engine: this.backendName,
            rawLabelCount: result.classifications.length,
            top: rawTop,
            inferenceMs: result.inferenceMs,
          },
        })
      }
      this.classifyCount++

      // Map raw labels → macro classes, aggregate scores per macro class.
      const macroAccum = new Map<string, { score: number; rawTop: string }>()
      for (const c of result.classifications) {
        const macro = mapAudioLabelToMacro(c.className)
        if (!macro) continue
        const prev = macroAccum.get(macro)
        if (!prev || c.score > prev.score) {
          macroAccum.set(macro, { score: c.score, rawTop: c.className })
        }
      }

      // Sort by score descending
      const labels = [...macroAccum.entries()]
        .toSorted((a, b) => b[1].score - a[1].score)
        .map(([className, { score, rawTop }]) => ({ className, originalClass: rawTop, score }))

      // Raw backend-native labels (no macro aggregation), sorted by score descending.
      const rawLabels = [...result.classifications]
        .toSorted((a, b) => b.score - a.score)
        .map((c) => ({ className: c.className, originalClass: c.className, score: c.score }))

      return { labels, rawLabels, inferenceMs: result.inferenceMs }
    } finally {
      // Arm the long idle-dispose window off the last real classify.
      this.scheduleIdleDispose()
    }
  }

  /**
   * One inference under {@link INFERENCE_TIMEOUT_MS}. A backend that timed
   * out, exited or was disposed under the call is DROPPED (killed, and the
   * next window lazily respawns it) — a dead pipeline kept as `this.pipeline`
   * would answer every later window with the same error forever.
   */
  private async boundedInference(
    pipeline: IAudioPipeline,
    chunk: AudioChunkInput,
    data: Float32Array,
  ): Promise<AudioPipelineResult> {
    const inference = pipeline.classify({
      data,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
    })
    // Settled by the dispose below if the race is lost — never unhandled.
    inference.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AudioInferenceTimeoutError(INFERENCE_TIMEOUT_MS)),
        INFERENCE_TIMEOUT_MS,
      )
    })
    try {
      return await Promise.race([inference, timeout])
    } catch (err: unknown) {
      if (err instanceof AudioInferenceTimeoutError) {
        this.log.warn('audio inference timed out — killing the backend, next window respawns it', {
          tags: chunk.deviceId !== undefined ? { deviceId: chunk.deviceId } : undefined,
          meta: { timeoutMs: INFERENCE_TIMEOUT_MS, backend: this.backendName },
        })
        this.dropPipeline(pipeline)
      } else if (err instanceof AudioBackendExitedError) {
        this.dropPipeline(pipeline)
      }
      throw err
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** Forget (if still current) and dispose a pipeline that can no longer answer. */
  private dropPipeline(pipeline: IAudioPipeline): void {
    if (this.pipeline === pipeline) this.pipeline = null
    pipeline.dispose().catch((err: unknown) => {
      this.log.warn('audio pipeline dispose after failure threw', {
        meta: { error: errMsg(err), backend: this.backendName },
      })
    })
  }

  isReady(): boolean {
    // The analyzer accepts work as long as it hasn't been shut down. A null
    // `pipeline` here just means "idle / not yet used" (lazy) or "idle-
    // disposed", NOT "not ready" — the next classify re-spawns on demand.
    return !this.disposed
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.memoryGuard.stop()
    clearInterval(this.accountingTimer)
    // Windows still waiting are answered `disposed`, not left hanging.
    this.classifyQueue.close()
    this.reportClassifyAccounting()
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const live = this.pipeline
    this.pipeline = null
    if (live) await live.dispose()
  }

  /**
   * Apply a backend/model change. Records the backend the NEXT lazy init will
   * build; if a pipeline is already live it rebuilds IN PLACE (via
   * `swapPipeline`), otherwise the subprocess stays unspawned until the next
   * classify. Lets the audio engine settings apply without an addon restart,
   * mirroring the detection-pipeline's in-place engine swap.
   */
  async reconfigureBackend(next: AudioBackend): Promise<void> {
    this.desiredBackend = next
    if (!this.pipeline) {
      // Nothing running yet — the next classify lazily builds with `next`.
      this.backendName = next
      return
    }
    const rebuilt = await this.pipelineFactory(next)
    await this.swapPipeline(rebuilt, next)
  }

  /**
   * Swap the live pipeline in place (optimistic backend/model change) — disposes
   * the old pipeline AFTER the new one is wired in, so an in-flight classify
   * never sees a null pipeline. Lets the audio engine settings apply without an
   * addon restart, mirroring the detection-pipeline's in-place engine swap.
   */
  async swapPipeline(next: IAudioPipeline, nextBackend: string): Promise<void> {
    const prev = this.pipeline
    this.pipeline = next
    this.backendName = nextBackend
    if (prev && prev !== next) {
      try {
        await prev.dispose()
      } catch {
        /* disposing the superseded pipeline — ignore */
      }
    }
  }

  // Expose via the cap so the reprobe button in the UI reaches the
  // right worker. Delegates to the addon-owned reprobe (it touches
  // `ctx.settings.writeAddonStore` which only the addon has access to).
  async reprobeAudioEngine(): Promise<{ backend: string }> {
    return this.reprobeImpl()
  }
}

/**
 * Audio Analyzer addon — provides the `audio-analyzer` capability.
 *
 * Owns the IAudioPipeline directly — no tRPC roundtrip to a separate
 * audio-classifier addon.
 */
export class AudioAnalyzerAddon extends BaseAddon<AudioAnalyzerGlobalConfig> {
  readonly id = 'audio-analyzer'

  private provider: AudioAnalyzerProvider | null = null
  /** Backend the provider's pipeline is configured for — drives the optimistic
   *  in-place rebuild in `onConfigChanged` (rebuild only when it genuinely
   *  flips). The provider owns the (lazy) pipeline itself. */
  private activeBackend: AudioBackend | null = null
  /**
   * This node's live audio attachments (D461). Held on the ADDON rather than
   * only inside the provider because shutdown must release the broker's FIFOs
   * even if the provider never came up — an orphaned audio subscription is
   * broker DEMAND, not merely a leak.
   */
  private attachments: AudioDeviceAttachments | null = null

  constructor() {
    super(DEFAULT_AUDIO_ANALYZER_CONFIG)
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return {
      sections: [
        {
          id: 'audio-engine',
          title: 'Audio',
          // Co-located with detection-pipeline's `engine` section under
          // a single "Engine" tab. Both sections handle inference-engine
          // selection but for different modalities — distinct purposes
          // are conveyed through section titles ("Detection engine" vs
          // "Audio inference engine") and descriptions, not separate
          // tabs.
          tab: 'engine',
          // Renders after detection-pipeline's `engine` section
          // (`order: 0`) on the "Inference Engine" tab.
          order: 10,
          description:
            'The audio classifier. "Auto" uses Apple SoundAnalysis on macOS and YAMNet elsewhere. The backend choice is one value for the cluster (Cluster → Settings); the probed best is each node\'s own.',
          // Field order — `probedBest*` lives at the top so the operator
          // sees the auto-detected hint first and can compare it against
          // their override below at a glance. Same convention as the
          // detection-pipeline section.
          fields: [
            {
              type: 'text' as const,
              key: 'probedBestAudioBackend',
              label: 'Probed best',
              description:
                'Auto-detected best audio backend on this host. Click the refresh icon to re-run the probe.',
              readonlyField: true,
              default: '',
              // The probe result is a NODE fact — persisted node-scoped
              // (`probedBestAudioBackend@<nodeId>`) by the BaseAddon per-node
              // machinery. `audioBackend` stays cluster-shared.
              perNode: true,
              actions: [
                {
                  action: 'reprobe-audio-engine',
                  icon: 'refresh-cw',
                  tooltip: 'Re-probe audio engine',
                },
              ],
            },
            {
              type: 'select' as const,
              key: 'audioBackend',
              label: 'Audio backend',
              description:
                'One value for every node. Auto picks the best backend on each node; a choice a node cannot run falls back to Auto there.',
              options: AUDIO_BACKEND_CHOICES.map((o) => ({ value: o.value, label: o.label })),
              default: DEFAULT_AUDIO_ANALYZER_CONFIG.audioBackend,
              immediate: true,
            },
          ],
        },
      ],
    }
  }

  /**
   * Platform override — narrow the `audioBackend` options to the subset
   * that can actually run on the TARGET node.
   *
   * The base schema ships every backend (Auto + YAMNet + Apple SA); this
   * override drops Apple SoundAnalysis on a node that is not macOS, and
   * collapses a stored choice that is no longer runnable there back to
   * `auto` — so the form never offers, nor displays, an impossible
   * selection.
   *
   * `overlay` carries the operator's tentative choices for benchmark/
   *  preview mode (operator typed but didn't save yet) — same
   *  semantics detection-pipeline relies on.
   */
  override async getGlobalSettings(
    overlay?: Record<string, unknown>,
    _cap?: string,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues> {
    // Per-node projected store (base seam): `probedBestAudioBackend` carries
    // the TARGET node's scoped value on the bare key; the cluster-shared
    // fields pass through untouched. Never read the raw store here.
    const stored = await this.resolveGlobalStore(nodeId)
    const merged = overlay ? { ...stored, ...overlay } : stored

    // Apple SoundAnalysis is a macOS built-in — it does NOT exist on Linux/Intel
    // nodes. Gate it on the TARGET node's OS, resolved deterministically WITHOUT
    // the flaky platform-probe "hardware" cap. `addon-settings` is hub-centric:
    // the form for ANY node is served by the hub's audio-analyzer child (the
    // gateway resolves this any-node addon to the hub instance and passes
    // `nodeId` as data), so a bare `process.platform` would always reflect the
    // hub's OS and never offer Apple for a remote Mac. Instead read the node's
    // registration-reported platform from the in-memory cluster topology
    // (`nodes.topology`) — a hub-LOCAL read (no remote round-trip, no probe).
    // YAMNet (ONNX) is cross-platform and is therefore ALWAYS offered.
    const isDarwin = (await this.resolveNodePlatform(nodeId)) === 'darwin'

    // Offered backends: drop Apple SoundAnalysis on non-darwin nodes.
    const backendOptions = AUDIO_BACKEND_CHOICES.filter(
      (o) => o.value !== 'apple-soundanalysis' || isDarwin,
    )

    // An operator choice that's no longer valid for this node (e.g. a stored
    // 'apple-soundanalysis' on a node that's now Linux) collapses back to
    // 'auto' so the form never shows an impossible selection; 'auto' then
    // resolves to YAMNet at runtime on that node.
    const operatorChoiceRaw =
      typeof merged.audioBackend === 'string'
        ? merged.audioBackend
        : DEFAULT_AUDIO_ANALYZER_CONFIG.audioBackend
    const operatorChoice = backendOptions.some((o) => o.value === operatorChoiceRaw)
      ? operatorChoiceRaw
      : DEFAULT_AUDIO_ANALYZER_CONFIG.audioBackend

    const raw = { ...merged, audioBackend: operatorChoice }

    const schema = this.globalSettingsSchema()
    const patched: ConfigUISchema = {
      ...schema,
      sections: schema.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => {
          if (field.type === 'select' && field.key === 'audioBackend') {
            return {
              ...field,
              options: backendOptions.map((o) => ({ value: o.value, label: o.label })),
            }
          }
          return field
        }),
      })),
    }
    return hydrateSchema(patched, raw)
  }

  /**
   * Resolve the OS platform of the target node WITHOUT the flaky platform-probe
   * "hardware" cap. For the local node (or no nodeId) the running process is the
   * authority. For a remote node — the hub-centric settings form serves every
   * node from the hub child — read the node's registration-reported platform
   * from the in-memory cluster topology (`nodes.topology`): a hub-local read, no
   * remote round-trip, no probe. Falls back to this host's `process.platform`
   * when topology is unavailable so the form stays usable.
   */
  private async resolveNodePlatform(nodeId?: string): Promise<string> {
    const localNode = this.ctxIfReady?.kernel?.localNodeId
    if (!nodeId || nodeId === localNode) return process.platform
    try {
      const topo = await this.ctxIfReady?.api?.nodes?.topology.query()
      const { platform } = pickNodePlatformArch(topo, nodeId)
      if (platform) return platform
    } catch {
      /* topology unavailable — fall back to local platform */
    }
    return process.platform
  }

  /**
   * Re-run the platform probe and persist the detected backend into
   * `probedBestAudioBackend`. Operator `audioBackend` setting is not
   * touched — only the hint.
   */
  async reprobeAudioEngine(): Promise<{ backend: string }> {
    const backend: AudioBackend =
      process.platform === 'darwin' ? 'apple-soundanalysis' : 'yamnet-onnx'
    // Node-blind per-node write: the base scopes the perNode field to
    // `probedBestAudioBackend@<localNode>` (never the bare key) and
    // refreshes `this.config` from the scoped value.
    await this.updateGlobalSettings({ probedBestAudioBackend: backend })
    this.ctx.logger.info('reprobeAudioEngine: wrote probedBestAudioBackend', { meta: { backend } })
    return { backend }
  }

  /** Resolve the effective backend from the operator choice, falling back to the platform heuristic when 'auto'. */
  private resolveAudioBackend(): AudioBackend {
    const choice: AudioBackendChoice = this.config.audioBackend
    if (choice === 'apple-soundanalysis') return 'apple-soundanalysis'
    if (choice === 'yamnet-onnx') return 'yamnet-onnx'
    return process.platform === 'darwin' ? 'apple-soundanalysis' : 'yamnet-onnx'
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const logger = this.ctx.logger as IScopedLogger

    // Enable/disable is driven by the binding system (per-device
    // `audio-analysis` wrapper) + the pipeline tree
    // (`addonDefaults['audio-classifier'].enabled`). Consumers not bound /
    // not in the tree simply don't invoke `classify`.
    //
    // LAZY pipeline: we do NOT spawn the inference subprocess (YAMNet Python /
    // Apple SoundAnalysis CLI, resident model ~100+MB) here at addon boot. The
    // provider builds it on the FIRST classify() and idle-disposes it after a
    // long quiet window, so a node hosting this addon with no audio-
    // classification consumer never keeps an inference subprocess resident.
    const backend = this.resolveAudioBackend()
    this.activeBackend = backend

    // Auto-seed probedBestAudioBackend so the UI shows the effective
    // platform default on first boot (matches what we just booted).
    if (!this.config.probedBestAudioBackend) {
      this.reprobeAudioEngine().catch((err: unknown) => {
        logger.warn('audio: auto-reprobe failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }

    // Device settings resolver — pulls the audio-classifier step's
    // `settings` map from the orchestrator's resolved pipeline. The
    // settings live on the audio-classifier step (in
    // `agent.addonDefaults['audio-classifier'].settings` overlaid with
    // any per-device patch). No per-device store on this addon.
    const deviceSettingsResolver = async (
      deviceId: number,
    ): Promise<AudioAnalysisSettings | null> => {
      try {
        const resolved = await this.ctx.api.pipelineOrchestrator.resolvePipeline.query({ deviceId })
        const stepSettings = resolved.audio?.settings ?? {}
        const minConfidence =
          typeof stepSettings['minConfidence'] === 'number'
            ? (stepSettings['minConfidence'] as number)
            : 0.3
        const allowedClasses = Array.isArray(stepSettings['enabledAudioClasses'])
          ? (stepSettings['enabledAudioClasses'] as string[])
          : []
        return { minConfidence, allowedClasses }
      } catch (err) {
        logger.warn('audio: resolveDeviceSettings via orchestrator failed', {
          tags: { deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
    }

    const deviceContributionResolver = async (
      _deviceId: number,
    ): Promise<ConfigUISchemaWithValues | null> => {
      // No device-level surface — settings live on the audio-classifier
      // pipeline step (Orchestrator tab).
      return null
    }
    const deviceSettingsPatcher = async (
      _deviceId: number,
      _patch: Record<string, unknown>,
    ): Promise<void> => {
      // No-op: per-device audio settings moved to the audio-classifier step.
    }

    // The analyzer's own audio subscriptions (D461). Built BEFORE the
    // provider so `analyse` can read `this.provider` lazily rather than
    // closing over a value that does not exist yet — the two genuinely refer
    // to each other, and a deferred read is how that is expressed without a
    // non-null assertion.
    this.attachments = new AudioDeviceAttachments({
      api: () => this.ctx.api,
      localNodeId: () => this.ctx.kernel?.localNodeId ?? 'hub',
      logger: logger.child('audio-attach'),
      analyse: async (chunk, settings) => {
        const provider = this.provider
        if (!provider) return null
        return provider.analyseChunk({ chunk, settings })
      },
      emitResult: (deviceId, frame) => {
        const nodeId = this.ctx.kernel?.localNodeId ?? 'hub'
        this.ctx.eventBus.emit({
          id: `audio-inference-${deviceId}-${Date.now()}`,
          timestamp: new Date(),
          source: {
            type: 'device' as const,
            id: deviceId,
            nodeId,
            addonId: 'audio-analyzer',
            deviceId,
          },
          category: EventCategory.PipelineAudioInferenceResult,
          data: { deviceId, frame, nodeId },
        })
      },
    })

    this.provider = new AudioAnalyzerProvider(
      logger,
      (b: AudioBackend) => this.buildPipeline(b),
      backend,
      deviceSettingsResolver,
      deviceContributionResolver,
      deviceSettingsPatcher,
      () => this.reprobeAudioEngine(),
      this.attachments,
    )
    // Split registration mirrors stream-broker/camera-streams + snapshot/snapshot-provider:
    // - audio-analyzer (system): compute path (analyseChunk / classify / isReady / dispose)
    // - audio-analysis (device, wrapper defaultActive): per-device surface — resolveDeviceSettings,
    //   the three DeviceSettingsContribution methods and the onAudioLevel event.
    //   Every camera gets a binding row; operators disable per-device via setWrapperActive.
    return [
      { capability: audioAnalyzerCapability, provider: this.provider },
      {
        capability: audioAnalysisCapability,
        provider: this.provider,
      },
    ]
  }

  protected async onShutdown(): Promise<void> {
    // Release the broker subscriptions FIRST, and before anything that can
    // throw: a poller left running against a disposed pipeline would keep
    // pulling, and a FIFO left open on the broker keeps the source dial and
    // the decode session alive for as long as the broker lives (D461).
    this.attachments?.detachAll()
    this.attachments = null
    if (this.provider) {
      // Provider.dispose() tears down the lazy pipeline (if spawned) and cancels
      // the idle-dispose timer.
      await this.provider.dispose()
      this.provider = null
    }
    this.activeBackend = null
  }

  /**
   * Build + initialize an audio pipeline for `backend`. YAMNet runs in the
   * embedded portable Python (resolve interpreter + lazily install reqs); Apple
   * SoundAnalysis needs neither. Shared by `onInitialize` (first boot) and
   * `onConfigChanged` (in-place rebuild).
   */
  private async buildPipeline(backend: AudioBackend): Promise<IAudioPipeline> {
    const logger = this.ctx.logger as IScopedLogger
    const modelsDir = await this.resolveModelsDir()
    logger.info('audio-analyzer: resolving pipeline', {
      meta: {
        operatorChoice: this.config.audioBackend,
        effectiveBackend: backend,
      },
    })
    const pythonPath =
      backend === 'yamnet-onnx' ? ((await this.ctx.deps.ensurePython()) ?? undefined) : undefined
    const p = await createAudioPipeline(modelsDir, logger, {
      backend,
      pythonPath,
      installPythonRequirements: (f) => this.ctx.deps.installPythonRequirements(f),
    })
    await p.initialize()
    return p
  }

  /**
   * Optimistic settings apply — rebuild the pipeline IN PLACE when the effective
   * audio backend changes, instead of bouncing the whole addon. The audio engine
   * fields therefore drop `requiresRestart`: BaseAddon calls this after every
   * global-settings write; we rebuild only when the backend genuinely flips.
   */
  protected async onConfigChanged(): Promise<void> {
    if (!this.provider) return
    const backend = this.resolveAudioBackend()
    if (backend === this.activeBackend) return
    this.ctx.logger.info('audio backend changed — applying to pipeline', {
      meta: { from: this.activeBackend, to: backend },
    })
    // The provider owns the (lazy) pipeline: it rebuilds in place if one is
    // live, or simply records the new backend for the next lazy init when the
    // subprocess hasn't been spawned yet.
    await this.provider.reconfigureBackend(backend)
    this.activeBackend = backend
  }

  // ── Standard ICamstackAddon — three-level settings API ─────
  //
  // Per-device audio settings (audio class filter + minConfidence) moved
  // to the audio-classifier pipeline step's `getConfigSchema()` and the
  // orchestrator owns the audio node assignment (`audioNodeId`). No
  // device-level settings remain on this addon.

  buildDeviceSchema(): ConfigUISchema {
    return { sections: [] }
  }

  async getDeviceSettings(deviceId: number): Promise<ConfigUISchemaWithValues> {
    const raw = (await this.ctx?.settings?.readDeviceStore(deviceId)) ?? {}
    return hydrateSchema(this.buildDeviceSchema(), raw)
  }

  async updateDeviceSettings(deviceId: number, patch: Record<string, unknown>): Promise<void> {
    await this.ctx?.settings?.writeDeviceStore(deviceId, patch)
  }
}
