/**
 * ONE engine, for one model at a time, with a single-flight build KEYED BY MODEL.
 *
 * The image tower used to share one untyped in-flight promise: a caller for
 * model B awaited A's build, found A, disposed it and built B, while a second
 * B caller did the same — two B builds, one of them orphaned as a live Python
 * process nobody held. Here every build is registered under its model id:
 * concurrent callers for the same model share one build, a caller for another
 * model waits for it, then switches exactly once, and a build that finishes
 * after the slot moved on is disposed rather than leaked.
 *
 * Two guards, deliberately overlapping: the per-model in-flight map dedupes
 * same-model callers, and the switch chain serialises every build so a slot
 * is never torn down by two models at once. Either alone covers the races the
 * spec exercises; removing both lets two builds of one model run (red).
 */

import type { CrashBudget } from './crash-budget.js'
import type { RequirementsGate } from './model-requirements.js'

export interface DisposableEngine {
  /**
   * The ENGINE stage: spawn, load, report ready. Called by the slot, never by
   * the builder — the slot tells a requirements failure (no process, no budget)
   * from an engine failure (spends the budget) by which of its two calls threw
   * (`model-requirements.ts`).
   */
  initialize(): Promise<void>
  dispose(): Promise<void>
  /** False once the process died — the slot drops it and rebuilds. */
  isAlive(): boolean
}

export class ModelEngineSlot<E extends DisposableEngine> {
  private current: { readonly modelId: string; readonly engine: E } | null = null
  private readonly inflight = new Map<string, Promise<E>>()
  /** The last model asked for — a build for any other model is stale on arrival. */
  private wanted: string | null = null
  /** Serialises switches so two models never tear the slot down concurrently. */
  private switching: Promise<void> = Promise.resolve()
  /**
   * Bumped by {@link dispose}: a build that started before it is stale when it
   * lands and is disposed on arrival — shutdown leaves no process behind.
   */
  private generation = 0

  constructor(
    /** Requirements + construction, NO process: `initialize()` is the slot's call. */
    private readonly build: (modelId: string) => Promise<E>,
    /** Bounds respawns per model (D6): a crash or a failed `initialize()` spends it. */
    private readonly budget: CrashBudget,
    /** Refuses by name, and never spends the budget, when `build` itself throws. */
    private readonly requirements: RequirementsGate,
    /** Told when a held engine is found dead (crash / OOM kill) and dropped. */
    private readonly onDead: (modelId: string) => void = () => {},
  ) {}

  held(): { readonly modelId: string; readonly engine: E } | null {
    return this.current
  }

  async ensure(modelId: string): Promise<E> {
    this.wanted = modelId
    this.dropIfDead()
    if (this.current?.modelId === modelId) return this.current.engine
    // A model in `failed` is refused by name BEFORE anything is spawned.
    // DOUBLE-GUARDED with the check inside the switching chain below: this one
    // answers the caller at once, that one catches a model that went `failed`
    // while the caller waited its turn. Removing either alone keeps
    // `model-engine-slot.spec.ts` green; only removing both goes red (D649).
    this.budget.check(modelId)
    // Inside its cooldown, or terminally unmeetable: refused now, no download.
    this.requirements.check(modelId)
    const pending = this.inflight.get(modelId)
    if (pending !== undefined) return pending

    const generation = this.generation
    const run = this.switching.then(async () => {
      this.dropIfDead()
      if (this.current?.modelId === modelId) return this.current.engine
      // The second half of the double guard — see `ensure`'s first check.
      this.budget.check(modelId)
      this.requirements.check(modelId)
      await this.disposeCurrent()
      let engine: E
      try {
        engine = await this.build(modelId)
      } catch (err: unknown) {
        // Files or runtime missing: nothing was spawned, nothing to count.
        throw this.requirements.refuse(modelId, err)
      }
      this.requirements.satisfied(modelId)
      try {
        await engine.initialize()
      } catch (err: unknown) {
        // A load that fails spends the budget — it used to retry per request.
        this.budget.record(
          modelId,
          `load failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      }
      if (this.generation !== generation) {
        // The slot was disposed (shutdown / watchdog) while this built.
        await engine.dispose()
        throw new Error(`engine for "${modelId}" cancelled: the slot was disposed while building`)
      }
      if (this.wanted !== modelId) {
        // The slot moved on while this built: nobody holds it — dispose, never leak.
        await engine.dispose()
        throw new Error(`engine for "${modelId}" superseded while building`)
      }
      this.current = { modelId, engine }
      return engine
    })
    const guarded = run.finally(() => {
      this.inflight.delete(modelId)
    })
    this.inflight.set(modelId, guarded)
    this.switching = guarded.then(
      () => undefined,
      () => undefined,
    )
    return guarded
  }

  /**
   * Dispose the held engine AND cancel every build in flight: each is disposed
   * when it lands (see `generation`). Resolves once in-flight builds settled.
   */
  async dispose(): Promise<void> {
    this.generation += 1
    await this.disposeCurrent()
    await this.switching
  }

  private async disposeCurrent(): Promise<void> {
    const held = this.current
    this.current = null
    await held?.engine.dispose()
  }

  private dropIfDead(): void {
    const held = this.current
    if (held === null || held.engine.isAlive()) return
    this.current = null
    this.onDead(held.modelId)
    this.budget.record(held.modelId, 'process died after loading')
    void held.engine.dispose().catch(() => {
      /* already dead — nothing to release */
    })
  }
}
