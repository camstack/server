/**
 * EngineFactory — creates and manages inference engines for the pipeline.
 *
 * Detection is Python-only: every engine runs in the SharedInferencePool
 * (embedded portable Python; coreml / openvino / onnxruntime) via
 * PipelineModelManager. The former Node.js onnxruntime-node path has been
 * removed so the platform ships no Node ONNX runtime.
 */
import type {
  IScopedLogger,
  PipelineEngineChoice,
  PipelineDefaultStep,
  PoolModelConfig,
  ModelFormat,
  ModelCatalogEntry,
} from '@camstack/types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import {
  SharedInferencePool,
  type PoolCompileFinishedLate,
  type PoolDeathCause,
  type PoolTuning,
  type PoolWorkerMemStats,
} from './shared-inference-pool.js'
import {
  PipelineModelManager,
  type StepSettings,
  type StepVariantHandle,
} from './pipeline-model-manager.js'
import { resolvePoolDecodeSettings, type PoolDecodeSettings } from './pool-decode-settings.js'
import { resolveEffectivePostprocessorForEntry } from '../registry/effective-postprocessor.js'
import { labelsForDecoder } from './labels-for-decoder.js'
import { resolveModelDefaultConfidence } from '../registry/effective-confidence.js'
import { collectClassMapDropWarning } from '../registry/model-knob-applicability.js'
import { getStepDefinition } from '../registry/step-definitions.js'
import { deviceKeyOf } from './resolve-device-engine.js'
import {
  resolvePoolProvisioning,
  type PoolProvisioning,
  type PoolProvisioningOverride,
} from './pool-provisioning.js'
import {
  CoralSetPlanner,
  type CoralPlacementChange,
  type CoralSetSelection,
  type PlacedModel,
} from './coral-cocompiled-set.js'
import { EDGETPU_COCOMPILED_SETS, type CoCompiledSet } from '../registry/edgetpu-cocompiled-sets.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PoolRuntime = 'coreml' | 'openvino' | 'onnxruntime' | 'edgetpu'

interface EngineFactoryOptions {
  readonly engine: PipelineEngineChoice
  readonly modelsDir: string
  /**
   * Path to the Python interpreter used by the inference pool. Required:
   * the addon resolves it once via `ctx.deps.ensurePython()` and threads it
   * through. No PATH lookup here — the embedded portable Python is the single
   * source of truth.
   */
  readonly pythonPath: string
  readonly logger: IScopedLogger
  /**
   * OPERATOR OVERRIDE ONLY. The concurrency / worker count / batch tuning of
   * this pool come from `pool-provisioning`, keyed by `engine`'s OWN runtime;
   * this field carries nothing but the operator's explicit deviations, and an
   * absent field means "use the runtime's registry value".
   *
   * It must never be filled with the node default's registry values: that is
   * exactly the defect this replaced — a per-device `openvino` pool inherited
   * the node's `onnx` concurrency of 4.
   */
  readonly provisioning?: PoolProvisioningOverride
  /**
   * Detector NMS IoU threshold forwarded to the Python inference pool for the
   * object-detection family (#4). Undefined ⇒ the historical 0.45 literal
   * (byte-identical to today). A global (per-node) value; per-camera NMS
   * would need a pool rebuild and is deliberately out of v1 scope.
   */
  readonly nmsIouThreshold?: number
  /**
   * CUSTOM-model lookup for `(stepId, modelId)` pairs that are NOT in the
   * static step catalog — operator-registered models from the
   * `custom-model-registry` collection cap. The provider passes a snapshot
   * reader over its custom-models cache. Absent ⇒ static catalog only
   * (byte-identical to the historical behaviour, and the reason a selected
   * custom model used to fail the WHOLE pool applyConfig with
   * `Model "X" not found in step "Y" catalog`).
   */
  readonly resolveCustomModel?: CustomModelResolver
  /** A compile that outlived its soft bound came back (D653) — see SharedInferencePoolOptions. */
  readonly onCompileFinishedLate?: (event: PoolCompileFinishedLate) => void
  /** The co-compiled Edge TPU sets a Coral pool may load (D724). Absent ⇒ the published registry. */
  readonly coCompiledSets?: readonly CoCompiledSet[]
}

/** Sync lookup of an operator-registered model for a step. */
export type CustomModelResolver = (stepId: string, modelId: string) => ModelCatalogEntry | undefined

// ---------------------------------------------------------------------------
// Runtime → Pool runtime mapping
// ---------------------------------------------------------------------------

export const BACKEND_TO_POOL_RUNTIME: Record<string, PoolRuntime> = {
  coreml: 'coreml',
  openvino: 'openvino',
  onnx: 'onnxruntime',
  cpu: 'onnxruntime',
  cuda: 'onnxruntime',
  edgetpu: 'edgetpu',
}

const RUNTIME_TO_FORMAT: Record<string, ModelFormat> = {
  coreml: 'coreml',
  openvino: 'openvino',
  onnxruntime: 'onnx',
  edgetpu: 'tflite',
}

/**
 * Steps whose detections are re-filtered downstream by the executor's per-macro
 * `minConfidence*` sliders (`macroFilterVerdict` runs on EVERY root, keyed by
 * the detection's macro class). Their pool-side floor must stay BELOW those
 * sliders or it silently pre-empts them.
 *
 * `package-detection` joined on 2026-08-07, when it gained a
 * `minConfidencePackage` slider: while it kept `defaultConfidence` (0.5) as its
 * pool floor, every sub-0.5 position of that brand-new slider was dead on
 * arrival — the same foot-gun this constant was introduced to remove for
 * object-detection. A step with NO operator-facing threshold keeps its own
 * `def.defaultConfidence`; adding one without adding the id here ships a
 * control that lies below its default.
 */
const PER_MACRO_REFILTERED_STEP_IDS: ReadonlySet<string> = new Set([
  'object-detection',
  'package-detection',
])

/**
 * Pool-side confidence FLOOR for a step the executor re-filters (#4 foot-gun
 * fix).
 *
 * The pool used to receive `def.defaultConfidence` (0.5) as its floor and drop
 * every box < 0.5 BEFORE the executor's per-macro `minConfidence*` sliders run —
 * so a slider set below 0.5 was a silent no-op. Lower the pool floor to a small
 * constant so the operator-visible per-macro sliders are the authoritative
 * filter across their full 0–1 range. The per-macro slider DEFAULTS stay at 0.5
 * (see `step-definitions.ts` getConfigSchema), so default UI behaviour is
 * unchanged; only sub-0.5 sliders start having an effect. */
const PER_MACRO_POOL_CONFIDENCE_FLOOR = 0.05

/** Re-exported from `pool-decode-settings`, which owns the whole
 *  step-settings → pool derivation. Two copies of this literal is exactly how
 *  the diff and the load command come to disagree. */
export { NMS_IOU_DEFAULT } from './pool-decode-settings.js'

/**
 * Resolve the pool-side confidence FLOOR for a step (#4). A step in
 * {@link PER_MACRO_REFILTERED_STEP_IDS} gets the small
 * {@link PER_MACRO_POOL_CONFIDENCE_FLOOR} so its per-macro `minConfidence*`
 * slider (applied downstream by the executor) is the authoritative filter;
 * every other step keeps its own `defaultConfidence`.
 */
export function resolvePoolConfidenceFloor(stepId: string, defaultConfidence: number): number {
  return PER_MACRO_REFILTERED_STEP_IDS.has(stepId)
    ? PER_MACRO_POOL_CONFIDENCE_FLOOR
    : defaultConfidence
}

/**
 * Load a model's runtime label list from its `-labels.json` extraFile, if any.
 *
 * Accepts BOTH on-disk shapes:
 *   - a flat `string[]` (legacy label files), and
 *   - a `{ "labels": string[], ... }` metadata object (the newer format the
 *     animal / bird / vehicle classifiers ship, which also carries preprocess /
 *     license metadata alongside the label array).
 *
 * Returns `undefined` when the model declares no `-labels.json`, the file is
 * absent, or its contents are not a recognised label shape — the caller then
 * falls back to the step's `def.labels`.
 */
const LabelsFileSchema = z.union([
  z.array(z.string()).readonly(),
  z.object({ labels: z.array(z.string()).readonly() }),
])

export function readModelLabels(
  modelsDir: string,
  modelEntry: ModelCatalogEntry,
): readonly string[] | undefined {
  const labelsFile = modelEntry.extraFiles?.find((f) => f.filename.endsWith('-labels.json'))
  if (!labelsFile) return undefined
  const labelsPath = path.join(modelsDir, labelsFile.filename)
  if (!fs.existsSync(labelsPath)) return undefined
  const parsed = LabelsFileSchema.safeParse(JSON.parse(fs.readFileSync(labelsPath, 'utf8')))
  if (!parsed.success) return undefined
  const data = parsed.data
  return 'labels' in data ? data.labels : data
}

// ---------------------------------------------------------------------------
// EngineFactory
// ---------------------------------------------------------------------------

export class EngineFactory {
  private pool: SharedInferencePool | null = null
  private poolManager: PipelineModelManager | null = null
  private readonly log: IScopedLogger
  private readonly opts: EngineFactoryOptions
  /**
   * `<backend>:<device>` — on EVERY log line this factory writes. A pool that
   * logs anonymously cannot be told apart from another pool of the same runtime
   * on a different accelerator.
   */
  private readonly deviceKey: string
  /**
   * Resolved at CONSTRUCTION, not at pool spawn, so it is inspectable without
   * starting Python and so a pool that fails to spawn still logs what it was
   * trying to be.
   */
  private readonly resolvedProvisioning: PoolProvisioning
  /**
   * A Coral pool's placement and the co-compiled set it loads (D724); `null`
   * on every other runtime. Lives exactly as long as this factory — a new
   * pool starts from nothing placed.
   */
  private readonly coralSets: CoralSetPlanner | null

  constructor(opts: EngineFactoryOptions) {
    this.opts = opts
    this.log = opts.logger
    this.deviceKey = deviceKeyOf(opts.engine)
    this.resolvedProvisioning = resolvePoolProvisioning(opts.engine, opts.provisioning)
    this.coralSets =
      BACKEND_TO_POOL_RUNTIME[opts.engine.backend] === 'edgetpu'
        ? new CoralSetPlanner(opts.coCompiledSets ?? EDGETPU_COCOMPILED_SETS)
        : null
  }

  /**
   * Record the models a dispatch places on this pool. On a Coral pool the
   * answer says whether the co-compiled set it loads from changed; on any
   * other pool nothing is placed and nothing changes.
   */
  notePlacement(models: readonly PlacedModel[]): CoralPlacementChange {
    return this.coralSets?.note(models) ?? { kind: 'unchanged' }
  }

  /** The co-compiled set this pool loads from, or why none (`null`: not a Coral pool). */
  coralSetSelection(): CoralSetSelection | null {
    return this.coralSets?.selection() ?? null
  }

  /**
   * The catalog entry as THIS pool must download and load it: on a Coral pool
   * whose set stands for the model, the `tflite` build is the set's file.
   * Every other entry is returned unchanged.
   */
  entryForPool(stepId: string, entry: ModelCatalogEntry): ModelCatalogEntry {
    return this.coralSets?.entryFor(stepId, entry) ?? entry
  }

  /**
   * Reload every resident model whose file this pool no longer names — after
   * the Coral set changed. The caller has already downloaded the new files.
   */
  async reloadChangedModelFiles(): Promise<readonly { stepId: string; modelId: string }[]> {
    return this.poolManager?.reloadChangedPaths() ?? []
  }

  /**
   * The provisioning this factory's pool runs with — resolved from the pool's
   * OWN runtime plus any operator override. Read by the effective-tuning
   * readout and by the tests that pin the per-runtime behaviour.
   */
  get provisioning(): PoolProvisioning {
    return this.resolvedProvisioning
  }

  /** Detection always uses the Python pool. */
  get usesPythonPool(): boolean {
    return true
  }

  /**
   * Initialize the engine layer and apply initial pipeline config.
   */
  async initialize(steps: readonly PipelineDefaultStep[]): Promise<void> {
    await this.initPythonPool(steps)
  }

  /**
   * Apply a new pipeline config (hot swap).
   * Only loads/unloads models that changed.
   */
  async applyConfig(steps: readonly PipelineDefaultStep[]): Promise<void> {
    if (!this.poolManager) {
      throw new Error('EngineFactory not initialized')
    }
    await this.poolManager.applyConfig(steps)
  }

  /**
   * The resident variant for exactly `(stepId, modelId)`, with the model it
   * runs — never the step's active variant in its place (D658). The executable
   * tree is built from this, and a result's model stamp comes from it.
   *
   * @throws if that exact pair is not warm.
   */
  getStepVariant(stepId: string, modelId: string): StepVariantHandle {
    if (!this.poolManager) {
      throw new Error('EngineFactory not initialized')
    }
    return this.poolManager.getVariant(stepId, modelId)
  }

  /** Check if a step is loaded (any variant). */
  isLoaded(stepId: string): boolean {
    return this.poolManager?.isLoaded(stepId) ?? false
  }

  /** Check if a specific (stepId, modelId) variant is resident. */
  isLoadedWithModel(stepId: string, modelId: string): boolean {
    return this.poolManager?.isLoadedWithModel(stepId, modelId) ?? false
  }

  /**
   * Does the pool still owe this step something — a load, or a retune of its
   * decode-scoped settings? The skip gate every dispatch path must use instead
   * of `isLoadedWithModel`, which cannot see a changed threshold (D214).
   */
  needsPoolUpdate(step: PipelineDefaultStep): boolean {
    return this.poolManager?.needsPoolUpdate(step) ?? true
  }

  /**
   * List every loaded (stepId, modelId) variant — the pool surfaces each
   * warm slot independently (including bench overrides).
   */
  listLoaded(): readonly {
    stepId: string
    modelId: string
    active: boolean
  }[] {
    if (!this.poolManager) return []
    return this.poolManager.getLoadedSteps().map((l) => ({
      stepId: l.stepId,
      modelId: l.modelId,
      active: l.active,
    }))
  }

  /**
   * Is this factory's pool alive and able to answer?
   *
   * `SharedInferencePool.isReady()` and `PoolWorker.isReady()` have always
   * existed; this factory surfaced `getPoolPids()` and `getPoolBacklog()` and
   * **not** readiness, so the one signal every caller needed sat one layer
   * below all of them and was never lifted. That is why a pool whose Python
   * worker was SIGABRT'd 1.3 s after `Pool ready` was handed back to 370 000
   * consecutive dispatches over 31 hours: `resolveDeviceFactory` had nothing
   * to ask.
   *
   * A factory that never initialised answers `false` — a pool that is not
   * there cannot serve a frame, and the caller's job is the same either way.
   */
  isReady(): boolean {
    return this.pool?.isReady() ?? false
  }

  /**
   * Why this factory's pool stopped being usable while its process was alive —
   * a compile that never returned, or a worker that answered nothing (D653) —
   * or `null`. A pool that merely crashed says nothing here; its `Worker
   * process exited` line already names the signal.
   */
  getDeathCause(): PoolDeathCause | null {
    return this.pool?.getDeathCause() ?? null
  }

  /** Native pid of the underlying Python pool, if any. */
  getPoolPid(): number | null {
    return this.pool?.getPid() ?? null
  }

  /** All live worker pids of the underlying Python pool (memory watchdog). */
  getPoolPids(): readonly number[] {
    return (this.pool?.getPids() ?? []).filter((pid): pid is number => pid !== null)
  }

  /** Summed backlog / shed / dropped across the pool's workers — the cheap
   *  internals the memory watchdog attaches to its periodic `pool memory`
   *  line so a leak (RSS up, work flat) is separable from load. */
  getPoolBacklog(): {
    readonly inFlight: number
    readonly shed: number
    readonly dropped: number
    readonly deadlineExpired: number
    readonly timedOut: number
  } {
    if (!this.pool) return { inFlight: 0, shed: 0, dropped: 0, deadlineExpired: 0, timedOut: 0 }
    const backlog = this.pool.getBacklog()
    return {
      ...backlog,
      dropped: this.pool.getDroppedResponseCount(),
      // The dead-work subset of `dropped` (D350): requests whose deadline had
      // already passed when they would have run. Rising under load = the pool
      // refusing work nobody would read — the 2026-09-04 storm, prevented.
      deadlineExpired: this.pool.getDeadlineExpiredShedCount(),
      timedOut: this.pool.getTimedOutCount(),
    }
  }

  /** Python-side per-worker memory diagnostics (see SharedInferencePool). */
  async getPoolMemStats(): Promise<readonly PoolWorkerMemStats[]> {
    if (!this.pool) return []
    return this.pool.getMemStats()
  }

  /**
   * Whether this factory exposes the batched fast path (`batchInferRaw`).
   */
  supportsBatch(): boolean {
    return this.poolManager !== null
  }

  /**
   * Run N raw-frame inferences against the same loaded step in a
   * single IPC round-trip. Returns the structured Python detection
   * dicts in input order. Throws when this factory has no pool path.
   *
   * Used by `runPipelineBatch` for fair batched benchmarking — N frames
   * in one IPC round-trip, amortising the per-call envelope overhead.
   */
  async batchInferRaw(
    stepId: string,
    items: readonly {
      readonly raw: Buffer
      readonly width: number
      readonly height: number
      readonly format: 'rgb' | 'bgr' | 'gray'
    }[],
    modelId: string,
    frameId = 0,
  ): Promise<readonly Record<string, unknown>[]> {
    if (!this.poolManager) {
      throw new Error('EngineFactory.batchInferRaw: pool not initialized')
    }
    const idx = this.poolManager.getPoolIndex(stepId, modelId)
    if (idx === null) {
      throw new Error(
        `EngineFactory.batchInferRaw: step "${stepId}" (model "${modelId}") is not loaded`,
      )
    }
    const pool = this.poolManager.getPool()
    // `frameId` (0 = untagged) pins the batch to the pool's bench preprocess
    // cache so a repeated benchmark frame is decoded+preprocessed once.
    return pool.inferBatch(idx, items, frameId)
  }

  // ── Bench frame cache (Python-side) ──────────────────────────────

  async cacheFrameInPool(
    raw: Buffer,
    width: number,
    height: number,
    format: 'rgb' | 'bgr' | 'gray',
  ): Promise<{ frameId: number; width: number; height: number }> {
    if (!this.poolManager) throw new Error('cacheFrameInPool: pool not available')
    return this.poolManager.getPool().cacheFrame(raw, width, height, format)
  }

  async inferCached(
    stepId: string,
    frameId: number,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.poolManager) throw new Error('inferCached: pool not available')
    const idx = this.poolManager.getPoolIndex(stepId, modelId)
    if (idx === null)
      throw new Error(`inferCached: step "${stepId}" (model "${modelId}") not loaded`)
    return this.poolManager.getPool().inferCached(idx, frameId)
  }

  async uncacheFrame(frameId: number): Promise<void> {
    if (!this.poolManager) return
    await this.poolManager.getPool().uncacheFrame(frameId)
  }

  /** Load additional models without unloading existing ones (for benchmark/test). */
  async loadAdditional(steps: readonly PipelineDefaultStep[]): Promise<void> {
    if (this.poolManager) {
      await this.poolManager.loadAdditional(steps)
    }
  }

  /** Shut down all engines and the pool process. */
  async dispose(): Promise<void> {
    if (this.pool) {
      await this.pool.dispose()
      this.pool = null
      this.poolManager = null
    }
  }

  // -------------------------------------------------------------------------
  // Private: Python pool initialization
  // -------------------------------------------------------------------------

  /**
   * The one pool-init log line. `deviceKey` / `device` are the reason it
   * exists: the default pool used to log neither, so an operator reading a
   * day of logs could not tell whether the NPU was idle or was simply the
   * anonymous default pool.
   *
   * `overriddenFields` replaces the old `source` field. `source` claimed
   * `'auto-default' | 'user-override'` about the CONCURRENCY TUNING but read as
   * the provenance of the device/engine choice, and was `'user-override'` on
   * every pool because the addon always passed explicit tuning. This lists the
   * fields the operator actually overrode — empty means pure registry.
   */
  private logProvisioning(): void {
    const p = this.resolvedProvisioning
    this.log.info('Python inference pool', {
      meta: {
        deviceKey: this.deviceKey,
        backend: this.opts.engine.backend,
        device: this.opts.engine.device ?? null,
        runtime: p.runtime,
        concurrency: p.concurrency,
        numWorkers: p.numWorkers,
        overriddenFields: p.overriddenFields,
        tuning: {
          batchMode: p.batchMode,
          windowMs: p.windowMs,
          maxBatchSize: p.maxBatchSize,
          numStreams: p.numStreams,
          intraOpThreads: p.intraOpThreads,
        },
      },
    })
  }

  private async initPythonPool(steps: readonly PipelineDefaultStep[]): Promise<void> {
    // Logged BEFORE the guards below so a pool that never spawns still says
    // which device it was for and what it would have run with.
    this.logProvisioning()
    const pythonPath = this.opts.pythonPath
    if (!pythonPath) {
      throw new Error(
        'EngineFactory: pythonPath is required — the addon must call ' +
          'ctx.deps.ensurePython() and pass the result. The embedded portable Python download ' +
          'likely failed; check the addon logs for the download error.',
      )
    }
    const poolRuntime = BACKEND_TO_POOL_RUNTIME[this.opts.engine.backend]
    if (!poolRuntime) {
      throw new Error(`No pool runtime mapping for backend "${this.opts.engine.backend}"`)
    }

    // Concurrency / worker count / batch tuning all come from
    // `pool-provisioning`, keyed by THIS pool's runtime (never the node's
    // default) with the operator override on top. The per-runtime numbers and
    // the precedence rule live in one place — see that module.
    const { concurrency, numWorkers } = this.resolvedProvisioning
    const resolvedTuning: PoolTuning = {
      batchMode: this.resolvedProvisioning.batchMode,
      windowMs: this.resolvedProvisioning.windowMs,
      maxBatchSize: this.resolvedProvisioning.maxBatchSize,
      numStreams: this.resolvedProvisioning.numStreams,
      intraOpThreads: this.resolvedProvisioning.intraOpThreads,
    }
    this.pool = new SharedInferencePool(pythonPath, poolRuntime, this.log.child('pool'), {
      concurrency,
      tuning: resolvedTuning,
      numWorkers,
      // Pool-level device — needed BEFORE model load for edgetpu (the libedgetpu
      // delegate is bound to one Coral at pool init). `usb`, `usb:1`, … select
      // which physical Coral this pool drives when several are attached.
      ...(this.opts.engine.device ? { device: this.opts.engine.device } : {}),
      ...(this.opts.onCompileFinishedLate
        ? { onCompileFinishedLate: this.opts.onCompileFinishedLate }
        : {}),
    })

    this.poolManager = new PipelineModelManager(
      this.pool,
      {
        buildConfig: (stepId, modelId, settings) =>
          this.buildPoolModelConfig(stepId, modelId, poolRuntime, settings),
        resolveDecode: (stepId, modelId, settings) => this.resolveDecode(stepId, modelId, settings),
      },
      this.log.child('model-mgr'),
      { deviceKey: this.deviceKey },
    )

    // Start pool with empty models — then load via manager for clean index tracking
    await this.pool.initialize([])
    await this.poolManager.applyConfig(steps)
  }

  /** (step, model) pairs whose classMap-drop warning already logged — the
   *  pool reloads models on every applyConfig; the fact doesn't change. */
  private readonly classMapDropLogged = new Set<string>()

  /**
   * The fs-free half of {@link PoolModelSource} — the effective decode-scoped
   * settings for a `(step, model, settings)` triple. Runs on the per-dispatch
   * path, so it must resolve the catalog entry and nothing more; the label
   * file, the format build and the model path are load-time concerns.
   *
   * `null` when the pair resolves to no model at all — the caller routes that
   * to `buildConfig`, which throws the message naming the step and the model.
   */
  private resolveDecode(
    stepId: string,
    modelId: string,
    settings?: StepSettings,
  ): PoolDecodeSettings | null {
    const def = getStepDefinition(stepId)
    const modelEntry =
      def.models.find((m) => m.id === modelId) ?? this.opts.resolveCustomModel?.(stepId, modelId)
    if (!modelEntry) return null
    return resolvePoolDecodeSettings({
      def,
      modelEntry,
      settings,
      fallbackNmsIouThreshold: this.opts.nmsIouThreshold,
    })
  }

  private buildPoolModelConfig(
    stepId: string,
    modelId: string,
    poolRuntime: PoolRuntime,
    stepSettings?: StepSettings,
  ): PoolModelConfig {
    return buildPoolModelConfigForStep({
      stepId,
      modelId,
      poolRuntime,
      modelsDir: this.opts.modelsDir,
      nmsIouThreshold: this.opts.nmsIouThreshold,
      stepSettings,
      device: this.opts.engine.device,
      resolveCustomModel: this.opts.resolveCustomModel,
      entryForPool: (sid, entry) => this.entryForPool(sid, entry),
      onClassMapDrop: ({ stepId: sid, modelId: mid, unmappedLabels }) => {
        const key = `${sid}::${mid}`
        if (this.classMapDropLogged.has(key)) return
        this.classMapDropLogged.add(key)
        this.log.warn('Model labels dropped by step classMap — unreachable by any setting', {
          meta: {
            step: sid,
            modelId: mid,
            unmappedLabels: [...unmappedLabels],
            hint: 'these classes are removed before enabledMacroClasses / minConfidence* run; only labels in the step classMap are tracked',
          },
        })
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Pool model config (pure — exported for tests and the factory above)
// ---------------------------------------------------------------------------

export interface PoolModelConfigInputs {
  readonly stepId: string
  readonly modelId: string
  readonly poolRuntime: PoolRuntime
  readonly modelsDir: string
  /**
   * Node-level FALLBACK IoU threshold. The dispatched step's own
   * `stepSettings` wins over it; this stays for a caller with no step settings
   * at all (and an absent value is the historical 0.45 literal).
   */
  readonly nmsIouThreshold?: number
  /**
   * The dispatched step's operator settings (`PipelineDefaultStep.settings`).
   * The channel D214 found missing: without it every pool slot loaded with the
   * default threshold no matter what the operator saved. Applicability is
   * enforced in `resolvePoolDecodeSettings` — a fused-NMS model IGNORES the
   * value rather than shipping one its decode cannot consult.
   */
  readonly stepSettings?: StepSettings
  /** Engine device selector (`opts.engine.device`); coreml defaults to 'all'. */
  readonly device?: string
  /** Custom-model lookup — see {@link CustomModelResolver}. */
  readonly resolveCustomModel?: CustomModelResolver
  /**
   * The entry as the pool loads it — a Coral pool points a set member's
   * `tflite` build at the co-compiled file (D724). Absent ⇒ the entry as
   * resolved.
   */
  readonly entryForPool?: (stepId: string, entry: ModelCatalogEntry) => ModelCatalogEntry
  /**
   * Invoked when the resolved model declares labels the step's dropping
   * classMap removes upstream of every operator setting (D214) — a plus catalog
   * labelmap's `deer`/`fox`/native `package` on object-detection. Dropped work
   * must never be silent; the factory wires this to a warn line, deduped per
   * (step, model).
   */
  readonly onClassMapDrop?: (info: {
    readonly stepId: string
    readonly modelId: string
    readonly unmappedLabels: readonly string[]
  }) => void
}

/**
 * Build the Python-pool model config for `(stepId, modelId)`.
 *
 * Resolution order: static step catalog first, then the injected
 * custom-model resolver (operator-registered models from the
 * `custom-model-registry` cap). A model found in NEITHER throws — that step
 * cannot load.
 */
export function buildPoolModelConfigForStep(inputs: PoolModelConfigInputs): PoolModelConfig {
  const { stepId, modelId, poolRuntime, modelsDir } = inputs
  const def = getStepDefinition(stepId)
  const staticEntry = def.models.find((m) => m.id === modelId)
  const resolvedEntry = staticEntry ?? inputs.resolveCustomModel?.(stepId, modelId)
  if (!resolvedEntry) {
    throw new Error(
      `Model "${modelId}" not found in step "${stepId}" catalog (static or custom registry)`,
    )
  }
  const modelEntry = inputs.entryForPool?.(stepId, resolvedEntry) ?? resolvedEntry

  const format = RUNTIME_TO_FORMAT[poolRuntime]
  if (!format) {
    throw new Error(`No format mapping for pool runtime "${poolRuntime}"`)
  }

  // D214 — a custom labelmap's classes the step classMap drops are removed
  // upstream of every operator setting; report them at load time, never
  // silently (the discard trail answers "what", not "why zero forever").
  const dropWarning = collectClassMapDropWarning(def, modelEntry)
  if (dropWarning !== null) {
    inputs.onClassMapDrop?.({
      stepId,
      modelId,
      unmappedLabels: dropWarning.unmappedLabels,
    })
  }

  const formatEntry = modelEntry.formats[format]
  if (!formatEntry) {
    throw new Error(
      `Model "${modelId}" has no ${format} format. Available: ${Object.keys(modelEntry.formats).join(', ')}`,
    )
  }

  // Derive model file path from URL (same logic as existing model download service)
  const urlParts = formatEntry.url.split('/')
  const filename = urlParts[urlParts.length - 1] ?? `${modelId}.${format}`
  const modelPath = `${modelsDir}/${filename}`

  // Explicit width/height + channels threaded to the Python preprocess.
  // `inputSize` (the max side) stays for backward compat + as the square
  // fallback; non-square recognizers (plate-OCR VGG 384×64) and grayscale
  // CTC models (inputChannels: 1) need the real dims/channel count so the
  // preprocess doesn't square the crop into a 3-channel RGB tensor.
  const inputWidth = modelEntry.inputSize.width
  const inputHeight = modelEntry.inputSize.height
  const inputSize = Math.max(inputWidth, inputHeight)
  const inputChannels = modelEntry.inputChannels ?? 3

  // Load labels. Precedence:
  //   1. the per-model `-labels.json` (extraFiles) — a classifier step hosts
  //      models with DIFFERENT class sets under one slot (a custom classifier
  //      beside the 8-class `animal-classifier`), so the
  //      model's own label file wins over the step's `def.labels`;
  //   2. the entry's OWN non-empty `labels` array — the only label channel a
  //      CUSTOM model has (a plus catalog model must decode with plus catalog labels,
  //      not the step's COCO-80 fallback);
  //   3. the step's `def.labels`, except an `ssd` model with no list of its
  //      own: those stay unset so Python keeps COCO-90. The step list is
  //      COCO-80, a different index space (`labelsForDecoder`).
  const entryLabels = modelEntry.labels.length > 0 ? modelEntry.labels.map((l) => l.id) : undefined
  const modelLabels = readModelLabels(modelsDir, modelEntry) ?? entryLabels
  const effectivePostprocessor = resolveEffectivePostprocessorForEntry(def, modelEntry)
  const labels = labelsForDecoder(effectivePostprocessor, modelLabels, def.labels)

  return {
    path: modelPath,
    inputSize,
    inputWidth,
    inputHeight,
    inputChannels,
    preprocessMode: modelEntry.preprocessMode ?? 'letterbox',
    // Per-model pixel normalization + output-op, threaded so the Python pool
    // preprocess/postprocess honour a model that diverges from the imagenet-
    // NCHW-logits norm — e.g. the AIY `bird-classifier` (norm 'none', softmax
    // baked in-graph) must NOT get imagenet mean/std NOR a second softmax.
    inputNormalization: modelEntry.inputNormalization,
    outputProbabilities: modelEntry.outputProbabilities,
    // An IR the GPU must not run at its default f16 (catalog data, D738).
    ...(modelEntry.gpuInferencePrecision !== undefined
      ? { gpuInferencePrecision: modelEntry.gpuInferencePrecision }
      : {}),
    // Per-model postprocessor override (falls back to the step's own).
    // A step can host models with different raw output layouts under one
    // slot — e.g. object-detection is 'yolo', but a Coral SSD MobileNet
    // build emits the TFLite_Detection_PostProcess 4-tensor layout ('ssd').
    // Entry-based so a CUSTOM model's override (plus catalog `yolonas`) applies too.
    postprocessor: effectivePostprocessor,
    // Per-step confidence floor forwarded to the Python inference pool.
    // The executor continues to apply `macroFilterVerdict` and the
    // per-macro `minConfidence*` sliders on top of whatever survives
    // the pool-side floor, so user-facing filters remain the single
    // source of semantic truth. For the object-detection step the floor is
    // dropped to a small constant (#4) so those per-macro sliders are the
    // authoritative filter across their full range (see the constant doc).
    // The MODEL's default before the step's (D662): YuNet loads at its own
    // 0.85, SCRFD at the step's 0.5.
    confidence: resolvePoolConfidenceFloor(stepId, resolveModelDefaultConfidence(def, modelEntry)),
    // Detector NMS IoU threshold forwarded to the Python pool. The operator's
    // step setting wins; the node fallback and then the historical 0.45
    // literal stand behind it, and a model whose decode fuses NMS pins the
    // fallback (see `resolvePoolDecodeSettings`).
    nmsIouThreshold: resolvePoolDecodeSettings({
      def,
      modelEntry,
      settings: inputs.stepSettings,
      fallbackNmsIouThreshold: inputs.nmsIouThreshold,
    }).nmsIouThreshold,
    labels,
    charset: def.charset,
    // Format-aware plate-OCR rescoring + plausibility gate — forwarded to the
    // Python CTC postprocessor exactly like `charset`. Static per-step values
    // (the operator-facing defaults declared in step-definitions.ts); the pool
    // is rebuilt per node, so these are node-level, mirroring `nmsIouThreshold`.
    plateRegion: def.plateRegion,
    minTextLength: def.minTextLength,
    minTextConfidence: def.minTextConfidence,
    // The fixed-slot reader's plausibility gate. Same node-level plumbing as
    // the three above; the `ctc` postprocessor ignores it and `plate-slots`
    // ignores `minTextLength`, so one step can carry both readers' gates
    // without either reading the other's knob.
    minCharProbability: def.minCharProbability,
    numClasses: labels?.length,
    strides: def.postprocessor === 'scrfd' ? [8, 16, 32] : undefined,
    maskThreshold: def.postprocessor === 'saliency' ? 0.5 : undefined,
    device: inputs.device ?? (poolRuntime === 'coreml' ? 'all' : undefined),
  }
}
