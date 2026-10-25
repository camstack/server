/**
 * PipelineModelManager — maps (stepId, modelId) ↔ pool model index.
 *
 * Multi-slot semantics: each `stepId` (e.g. `object-detection`) can host
 * multiple loaded models simultaneously. One of them is the *active*
 * model — the one returned to lookups that don't specify a modelId
 * (the camera-runtime hot path). The others are "warm" extras held
 * for benchmark / override use.
 *
 * Without this, the bench's override model would replace the runtime
 * model in the same slot, and the next camera dispatch would replace
 * it back — burning ~1.4s of `replaceModel` per ping-pong cycle on
 * coreml (measured by a bench investigation script, since deleted with
 * the actions it drove — D646).
 *
 * LRU policy:
 *  - At most `maxModelsPerStep` models live per stepId (default 4).
 *  - Eviction picks the least-recently-touched non-active entry.
 *  - The active model is NEVER evicted — that would tank live cameras.
 *  - Touch happens on `getVariant` / `getPoolIndex` lookups.
 */
import type {
  IInferenceEngine,
  IScopedLogger,
  PoolModelConfig,
  PipelineDefaultStep,
} from '@camstack/types'
import { PoolModelLoadError, type SharedInferencePool } from './shared-inference-pool.js'
import { flattenEnabledVideoSteps } from './step-utils.js'
import {
  poolDecodeSettingsEqual,
  poolDecodeSettingsOf,
  type PoolDecodeSettings,
} from './pool-decode-settings.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A (step, model) load the pool rejected — carrying the pool's failure class
 * (`compile-timeout`, …) so the provider can count a timeout against THAT
 * model without parsing a message (D653).
 */
export class StepVariantLoadError extends Error {
  readonly stepId: string
  readonly modelId: string
  readonly poolIndex: number
  readonly reason: string | null
  /** The model's file stem as the pool names it (`camstack-yunet-2023mar`). */
  readonly poolModel: string | null

  constructor(stepId: string, modelId: string, poolIndex: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'StepVariantLoadError'
    this.stepId = stepId
    this.modelId = modelId
    this.poolIndex = poolIndex
    this.reason = cause instanceof PoolModelLoadError ? cause.reason : null
    this.poolModel = cause instanceof PoolModelLoadError ? cause.model : null
  }
}

/**
 * One resident `(step, model)` variant: the handle bound to its pool index and
 * the model LOADED at that index. The tree stamps `modelId` from here, so the
 * stamp and the engine can never name two models (D658).
 */
export interface StepVariantHandle {
  readonly engine: IInferenceEngine
  readonly modelId: string
  readonly poolIndex: number
}

/** A dispatched step's operator settings (`PipelineDefaultStep.settings`). */
export type StepSettings = Readonly<Record<string, unknown>>

/**
 * How the manager turns a `(step, model, settings)` triple into pool commands.
 *
 * Two functions, deliberately, because they run on different paths:
 *  - `buildConfig` is LOAD-time. It reads the model's label file off disk and
 *    resolves the whole catalog entry — far too expensive for the per-dispatch
 *    path that runs once per camera frame.
 *  - `resolveDecode` is that per-dispatch diff. Pure, fs-free, and derived from
 *    the SAME `resolvePoolDecodeSettings` primitive `buildConfig` uses, so the
 *    diff can never believe a value the load did not send. `null` ⇒ the pair
 *    cannot be resolved at all; the caller falls through to `buildConfig`,
 *    whose throw carries the operator-actionable message.
 */
export interface PoolModelSource {
  readonly buildConfig: (
    stepId: string,
    modelId: string,
    settings?: StepSettings,
  ) => PoolModelConfig
  readonly resolveDecode: (
    stepId: string,
    modelId: string,
    settings?: StepSettings,
  ) => PoolDecodeSettings | null
}

interface LoadedStep {
  readonly stepId: string
  readonly modelId: string
  readonly poolIndex: number
  /**
   * The model FILE the slot was loaded from. The same `(step, model)` can be
   * served by more than one file — a Coral build compiled alone or as a member
   * of a co-compiled set (D724) — so "resident" is not "resident from the
   * file the pool should now use" (`reloadChangedPaths`).
   */
  readonly path: string
  /** The operator settings of the load, re-sent when the slot is reloaded from another file. */
  readonly settings?: StepSettings
  /** Monotonic LRU counter — bumped on every `getVariant`/`getPoolIndex`. */
  lruTick: number
  /**
   * Decode-scoped settings the pool slot is ACTUALLY running, taken from the
   * config that was sent — never re-derived. The diff that decides whether to
   * `reconfigure` compares against this.
   */
  decode: PoolDecodeSettings
}

interface StepDiff {
  readonly added: readonly PipelineDefaultStep[]
  readonly removed: readonly LoadedStep[]
  readonly modelChanged: readonly { step: PipelineDefaultStep; oldModelId: string }[]
  readonly unchanged: readonly { entry: LoadedStep; step: PipelineDefaultStep }[]
}

export interface PipelineModelManagerOptions {
  /** Hard cap on warm models per stepId (active + extras). Default 4. */
  readonly maxModelsPerStep?: number
  /**
   * `<backend>:<device>` of the pool this manager loads into — on every load
   * failure line, because a pool index alone names no accelerator (D653).
   */
  readonly deviceKey?: string
}

// ---------------------------------------------------------------------------
// PipelineModelManager
// ---------------------------------------------------------------------------

export class PipelineModelManager {
  /** stepId → modelId → loaded entry. */
  private readonly loaded = new Map<string, Map<string, LoadedStep>>()
  /** stepId → currently-active modelId (the runtime choice). */
  private readonly activeByStep = new Map<string, string>()
  /** Monotonic counter feeding the LRU tick on every touch. */
  private lruClock = 0
  private readonly log: IScopedLogger
  private readonly maxModelsPerStep: number
  private readonly deviceKey: string | null
  /**
   * Loads issued and not yet answered, keyed `stepId::modelId`. A second
   * caller for the same pair JOINS the pending load instead of issuing its own
   * (D653): on 2026-09-26 43 identical YuNet loads queued behind one hung GPU
   * compile, each allocating a pool index of its own.
   */
  private readonly pendingLoads = new Map<string, Promise<LoadedStep>>()

  constructor(
    private readonly pool: SharedInferencePool,
    private readonly source: PoolModelSource,
    logger: IScopedLogger,
    options?: PipelineModelManagerOptions,
  ) {
    this.log = logger
    this.maxModelsPerStep = options?.maxModelsPerStep ?? 4
    this.deviceKey = options?.deviceKey ?? null
  }

  /**
   * Apply a new pipeline configuration — driven by the runtime config
   * (camera-serving pipeline). Rewrites the *active* model per step,
   * keeping prior actives warm in extra slots up to `maxModelsPerStep`.
   *
   * Steps that disappear from `newSteps` get fully unloaded (every
   * model variant for that stepId).
   */
  async applyConfig(newSteps: readonly PipelineDefaultStep[]): Promise<void> {
    const enabledSteps = flattenEnabledVideoSteps(newSteps)
    const diff = this.computeDiff(enabledSteps)

    // Unload removed steps entirely (every model variant).
    for (const removed of diff.removed) {
      await this.unloadEntry(removed)
      this.log.info('Unloading step', {
        meta: { step: removed.stepId, modelId: removed.modelId, poolIndex: removed.poolIndex },
      })
    }

    // Load brand-new steps — first model becomes the active one.
    for (const added of diff.added) {
      await this.ensureLoaded(added.addonId, added.modelId, added.settings)
      this.activeByStep.set(added.addonId, added.modelId)
      this.log.info('Step loaded', {
        meta: { step: added.addonId, modelId: added.modelId, active: true },
      })
    }

    // Active model swap for already-loaded steps.
    for (const { step, oldModelId } of diff.modelChanged) {
      await this.ensureLoaded(step.addonId, step.modelId, step.settings)
      this.activeByStep.set(step.addonId, step.modelId)
      this.log.info('Active model switched', {
        meta: { step: step.addonId, fromModelId: oldModelId, toModelId: step.modelId },
      })
      // Old active is now eviction-eligible; LRU sweep below trims if needed.
      await this.enforceLruCap(step.addonId)
    }

    // Same step, same model, RETUNED. Without this the operator's decode knobs
    // (`nmsIouThreshold`) only ever reached a pool slot that happened to be
    // loading for another reason — which is how the slider stayed dead through
    // every config save (D214).
    for (const { entry, step } of diff.unchanged) {
      await this.reconcileDecode(entry, step.settings)
    }
  }

  /**
   * The warm variant that runs `(stepId, modelId)` — its handle AND the model
   * loaded at that pool index, which is the only honest answer to "which model
   * produced this output" (D658).
   *
   * No active-variant fallback, deliberately. The step-only lookup this
   * replaces (`getHandle(stepId)`, deleted) answered the step's ACTIVE
   * variant — the first one loaded after boot — and a tree that paired that
   * handle with the step's REQUESTED id stamped SigLIP2 on MobileCLIP vectors
   * for twenty minutes on 2026-09-27. A pair that is not resident throws,
   * naming both.
   */
  getVariant(stepId: string, modelId: string): StepVariantHandle {
    const entry = this.loaded.get(stepId)?.get(modelId)
    if (entry === undefined) {
      throw new Error(
        `Step "${stepId}" has no warm variant for model "${modelId}" in the inference pool — refusing rather than running another variant`,
      )
    }
    this.touch(entry)
    return {
      engine: this.pool.getHandle(entry.poolIndex),
      modelId: entry.modelId,
      poolIndex: entry.poolIndex,
    }
  }

  /** True iff the step has any model loaded. */
  isLoaded(stepId: string): boolean {
    return this.loaded.has(stepId) && (this.loaded.get(stepId)?.size ?? 0) > 0
  }

  /** True iff the specific (stepId, modelId) pair is resident. */
  isLoadedWithModel(stepId: string, modelId: string): boolean {
    return this.loaded.get(stepId)?.has(modelId) ?? false
  }

  /**
   * Does the pool NOT yet reflect this step? True when the (step, model) pair
   * is absent, and also when it is resident with different decode-scoped
   * settings — the case `isLoadedWithModel` cannot see.
   *
   * This is the per-dispatch skip gate: callers that short-circuit on
   * "already loaded" were the reason a saved threshold never reached a
   * running pool. Cheap by contract — `resolveDecode` never touches the fs.
   */
  needsPoolUpdate(step: PipelineDefaultStep): boolean {
    const entry = this.loaded.get(step.addonId)?.get(step.modelId)
    if (!entry) return true
    const desired = this.source.resolveDecode(step.addonId, step.modelId, step.settings)
    // Unresolvable while resident (a custom model deregistered mid-flight):
    // report "needs update" so the load path runs and throws the real,
    // operator-actionable message instead of this returning a quiet `false`.
    if (desired === null) return true
    return !poolDecodeSettingsEqual(entry.decode, desired)
  }

  /** ModelId currently designated as active for the step. */
  getLoadedModelId(stepId: string): string | undefined {
    return this.activeByStep.get(stepId)
  }

  /**
   * Pool index for exactly `(stepId, modelId)`, or `null` when that pair is not
   * warm. Used by the inference fast paths that bypass `getVariant` and call
   * `pool.inferBatch` directly. The model is REQUIRED: the active-variant
   * fallback this had timed a benchmark on whichever variant was active (D658).
   */
  getPoolIndex(stepId: string, modelId: string): number | null {
    const entry = this.loaded.get(stepId)?.get(modelId)
    if (entry === undefined) return null
    this.touch(entry)
    return entry.poolIndex
  }

  /**
   * Direct access to the underlying pool — exposed so the provider can
   * call `inferBatch` without re-fetching individual handles. Pool
   * lifetime is owned by `EngineFactory`, so callers must not dispose.
   */
  getPool(): SharedInferencePool {
    return this.pool
  }

  /**
   * Snapshot of every (stepId, modelId, poolIndex) currently resident.
   * Used by the `Warm instances` UI tab + cap-level `listLoadedEngines`
   * to surface both the runtime model and the warm extras.
   */
  getLoadedSteps(): readonly {
    readonly stepId: string
    readonly modelId: string
    readonly poolIndex: number
    readonly active: boolean
  }[] {
    const out: { stepId: string; modelId: string; poolIndex: number; active: boolean }[] = []
    for (const [stepId, models] of this.loaded) {
      const activeModelId = this.activeByStep.get(stepId)
      for (const entry of models.values()) {
        out.push({
          stepId: entry.stepId,
          modelId: entry.modelId,
          poolIndex: entry.poolIndex,
          active: entry.modelId === activeModelId,
        })
      }
    }
    return out
  }

  /**
   * Load extra models without touching the active runtime model.
   * Idempotent — already-loaded (stepId, modelId) pairs are no-op'd.
   * If `maxModelsPerStep` is exceeded, the LRU non-active variant is
   * evicted (NOT the active one — that would knock the runtime cameras
   * offline). The "active" designation is unchanged: callers without
   * a `modelId` argument keep hitting the runtime model.
   */
  async loadAdditional(steps: readonly PipelineDefaultStep[]): Promise<void> {
    for (const step of steps) {
      // No `isLoadedWithModel` short-circuit: `ensureLoaded` is idempotent for
      // a resident pair and is ALSO where a retuned decode setting is applied.
      // Skipping here would drop the operator's new threshold on the floor for
      // every pair that happens to already be warm — i.e. all of them.
      await this.ensureLoaded(step.addonId, step.modelId, step.settings)
      // First-ever model for this step becomes the active one — covers
      // the case where the bench is the first caller after boot.
      if (!this.activeByStep.has(step.addonId)) {
        this.activeByStep.set(step.addonId, step.modelId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private — load / evict / lookup
  // -------------------------------------------------------------------------

  /**
   * Load `(stepId, modelId)` into the pool if not already resident.
   * Honors `maxModelsPerStep` — evicts a non-active LRU variant first
   * when the cap would otherwise be exceeded.
   */
  private async ensureLoaded(
    stepId: string,
    modelId: string,
    settings?: StepSettings,
  ): Promise<LoadedStep> {
    let perStep = this.loaded.get(stepId)
    if (!perStep) {
      perStep = new Map<string, LoadedStep>()
      this.loaded.set(stepId, perStep)
    }
    const existing = perStep.get(modelId)
    if (existing) {
      this.touch(existing)
      await this.reconcileDecode(existing, settings)
      return existing
    }
    const key = `${stepId}::${modelId}`
    const pending = this.pendingLoads.get(key)
    if (pending) {
      // Joined: the pool is already compiling exactly this. A rejection
      // reaches this caller too — it was logged once, where it happened.
      const joined = await pending
      await this.reconcileDecode(joined, settings)
      return joined
    }
    const load = this.issueLoad(perStep, stepId, modelId, settings)
    this.pendingLoads.set(key, load)
    try {
      return await load
    } finally {
      this.pendingLoads.delete(key)
    }
  }

  /** Evict if at capacity, then send ONE load command and record the result. */
  private async issueLoad(
    perStep: Map<string, LoadedStep>,
    stepId: string,
    modelId: string,
    settings?: StepSettings,
  ): Promise<LoadedStep> {
    // Make room if at capacity.
    while (perStep.size >= this.maxModelsPerStep) {
      const evicted = this.pickEvictionTarget(stepId)
      if (!evicted) break
      await this.unloadEntry(evicted)
      this.log.info('LRU evicted warm model', {
        meta: {
          step: stepId,
          modelId: evicted.modelId,
          poolIndex: evicted.poolIndex,
          cap: this.maxModelsPerStep,
        },
      })
    }
    const config = this.source.buildConfig(stepId, modelId, settings)
    const decode = poolDecodeSettingsOf(config)
    const index = this.pool.allocateIndex()
    this.log.info('Loading step variant', {
      meta: { step: stepId, modelId, poolIndex: index, deviceKey: this.deviceKey, ...decode },
    })
    let loadMs: number
    try {
      ;({ loadMs } = await this.pool.loadModel(index, config))
    } catch (err) {
      // A rejected load is never silent (D653): it looked exactly like a load
      // still in progress, 43 times. The index goes back so a retry reuses it
      // instead of walking toward the pool's 254-slot ceiling.
      this.pool.releaseIndex(index)
      this.log.error('Step variant load failed', {
        meta: {
          step: stepId,
          modelId,
          poolIndex: index,
          deviceKey: this.deviceKey,
          reason: err instanceof PoolModelLoadError ? err.reason : null,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      throw new StepVariantLoadError(stepId, modelId, index, err)
    }
    this.log.info('Step variant loaded', {
      meta: { step: stepId, modelId, poolIndex: index, loadMs },
    })
    const entry: LoadedStep = {
      stepId,
      modelId,
      poolIndex: index,
      path: config.path,
      ...(settings !== undefined ? { settings } : {}),
      lruTick: ++this.lruClock,
      decode,
    }
    perStep.set(modelId, entry)
    return entry
  }

  /**
   * Reload every resident slot whose model FILE is no longer the one
   * `buildConfig` names — a Coral pool that switched co-compiled set (D724).
   * The new slot is loaded BEFORE the old one is unloaded and the entry is
   * replaced in between, so a lookup always finds a loaded index. Returns the
   * `(step, model)` pairs reloaded. A failed reload keeps the old slot (it
   * still serves, from the file it was loaded from) and is logged.
   */
  async reloadChangedPaths(): Promise<readonly { stepId: string; modelId: string }[]> {
    const reloaded: { stepId: string; modelId: string }[] = []
    for (const [stepId, perStep] of this.loaded) {
      // Replacing the value of a key being iterated is safe for a Map.
      for (const entry of perStep.values()) {
        const config = this.source.buildConfig(stepId, entry.modelId, entry.settings)
        if (config.path === entry.path) continue
        const index = this.pool.allocateIndex()
        try {
          await this.pool.loadModel(index, config)
        } catch (err) {
          this.pool.releaseIndex(index)
          this.log.error(
            'Step variant reload from another model file failed — the old file keeps serving',
            {
              meta: {
                step: stepId,
                modelId: entry.modelId,
                deviceKey: this.deviceKey,
                from: entry.path,
                to: config.path,
                error: err instanceof Error ? err.message : String(err),
              },
            },
          )
          continue
        }
        perStep.set(entry.modelId, {
          ...entry,
          poolIndex: index,
          path: config.path,
          decode: poolDecodeSettingsOf(config),
        })
        await this.pool.unloadModel(entry.poolIndex)
        this.log.info('Step variant reloaded from another model file', {
          meta: {
            step: stepId,
            modelId: entry.modelId,
            deviceKey: this.deviceKey,
            from: entry.path,
            to: config.path,
            poolIndex: index,
          },
        })
        reloaded.push({ stepId, modelId: entry.modelId })
      }
    }
    return reloaded
  }

  /**
   * Push a retuned decode setting into ONE already-loaded slot.
   *
   * Scope is the point: `reconfigure` names a single pool index, so a slider
   * moved on `object-detection/yolo26n` never disturbs the face detector, the
   * classifiers, or the same step's warm benchmark variants — and it never
   * costs a session reload (see `SharedInferencePool.reconfigureModel`).
   *
   * A no-op when nothing moved: this runs on the per-dispatch path, so the
   * common case must send zero commands.
   */
  private async reconcileDecode(entry: LoadedStep, settings?: StepSettings): Promise<void> {
    const desired = this.source.resolveDecode(entry.stepId, entry.modelId, settings)
    if (desired === null) return
    if (poolDecodeSettingsEqual(entry.decode, desired)) return
    const previous = entry.decode
    await this.pool.reconfigureModel(entry.poolIndex, desired)
    entry.decode = desired
    this.log.info('Decode settings retuned in place — no model reload', {
      meta: {
        step: entry.stepId,
        modelId: entry.modelId,
        poolIndex: entry.poolIndex,
        previousNmsIouThreshold: previous.nmsIouThreshold,
        ...desired,
      },
    })
    this.reportContention(entry, previous, desired)
  }

  /** Decode values each (step, model) pair has already run, so a value
   *  RETURNING can be told apart from a value being changed. */
  private readonly decodeHistory = new Map<string, Set<number>>()
  private readonly contentionReported = new Set<string>()

  /**
   * A pool slot is NODE-level; the settings driving it arrive per dispatch, so
   * two cameras with different per-camera overrides for the same (step, model)
   * pull the same slot back and forth. That is not expressible — one of them is
   * always decoding with the other's threshold — and it is invisible from the
   * outside, so it is reported the first time a pair flip-flops BACK to a value
   * it already ran. One steady retune (the operator moving a slider) never
   * trips it; alternating writers do, immediately.
   */
  private reportContention(
    entry: LoadedStep,
    previous: PoolDecodeSettings,
    desired: PoolDecodeSettings,
  ): void {
    const key = `${entry.stepId}::${entry.modelId}`
    let seen = this.decodeHistory.get(key)
    if (!seen) {
      seen = new Set<number>([previous.nmsIouThreshold])
      this.decodeHistory.set(key, seen)
    }
    const returning = seen.has(desired.nmsIouThreshold)
    seen.add(desired.nmsIouThreshold)
    if (!returning || this.contentionReported.has(key)) return
    this.contentionReported.add(key)
    this.log.warn(
      'Two dispatches disagree on this step’s decode settings — the pool slot is node-level, so one of them always decodes with the other’s value',
      {
        meta: {
          step: entry.stepId,
          modelId: entry.modelId,
          poolIndex: entry.poolIndex,
          valuesSeen: [...seen].sort((a, b) => a - b),
          hint: 'a per-camera override of a decode-scoped knob cannot be honoured on a shared pool — keep this knob at the node level',
        },
      },
    )
  }

  private async unloadEntry(entry: LoadedStep): Promise<void> {
    await this.pool.unloadModel(entry.poolIndex)
    const perStep = this.loaded.get(entry.stepId)
    perStep?.delete(entry.modelId)
    if (perStep && perStep.size === 0) {
      this.loaded.delete(entry.stepId)
      this.activeByStep.delete(entry.stepId)
    }
  }

  /** Select the LRU non-active entry for a step. Returns null when only the active one is present. */
  private pickEvictionTarget(stepId: string): LoadedStep | null {
    const perStep = this.loaded.get(stepId)
    if (!perStep) return null
    const activeModelId = this.activeByStep.get(stepId)
    let oldest: LoadedStep | null = null
    for (const entry of perStep.values()) {
      if (entry.modelId === activeModelId) continue
      if (!oldest || entry.lruTick < oldest.lruTick) oldest = entry
    }
    return oldest
  }

  /** Trim the step down to `maxModelsPerStep` entries, evicting LRU non-actives. */
  private async enforceLruCap(stepId: string): Promise<void> {
    const perStep = this.loaded.get(stepId)
    if (!perStep) return
    while (perStep.size > this.maxModelsPerStep) {
      const evicted = this.pickEvictionTarget(stepId)
      if (!evicted) break
      await this.unloadEntry(evicted)
    }
  }

  private touch(entry: LoadedStep): void {
    entry.lruTick = ++this.lruClock
  }

  // -------------------------------------------------------------------------
  // Diff (active-model granularity — bench extras don't enter the diff)
  // -------------------------------------------------------------------------

  /** Compute diff between currently-active steps and desired steps. */
  private computeDiff(desiredSteps: readonly PipelineDefaultStep[]): StepDiff {
    const desiredMap = new Map<string, PipelineDefaultStep>()
    for (const step of desiredSteps) desiredMap.set(step.addonId, step)

    const added: PipelineDefaultStep[] = []
    const removed: LoadedStep[] = []
    const modelChanged: { step: PipelineDefaultStep; oldModelId: string }[] = []
    // Carries the desired STEP alongside the resident entry: "same model" is
    // not "same configuration" — the step's settings may have been retuned.
    const unchanged: { entry: LoadedStep; step: PipelineDefaultStep }[] = []

    // Walk the active (runtime) set — `loaded` may carry warm extras
    // that aren't part of the runtime config and shouldn't enter the
    // diff. The diff drives runtime swaps; warm extras live alongside
    // and are pruned only by LRU.
    for (const [stepId, activeModelId] of this.activeByStep) {
      const activeEntry = this.loaded.get(stepId)?.get(activeModelId)
      if (!activeEntry) continue
      const desired = desiredMap.get(stepId)
      if (!desired) {
        // Step no longer wanted at runtime → remove every variant.
        const perStep = this.loaded.get(stepId)
        if (perStep) for (const entry of perStep.values()) removed.push(entry)
      } else if (desired.modelId !== activeModelId) {
        modelChanged.push({ step: desired, oldModelId: activeModelId })
      } else {
        unchanged.push({ entry: activeEntry, step: desired })
      }
    }

    for (const [stepId, step] of desiredMap) {
      if (!this.activeByStep.has(stepId)) added.push(step)
    }

    return { added, removed, modelChanged, unchanged }
  }
}
