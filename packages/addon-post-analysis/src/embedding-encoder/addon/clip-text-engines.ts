/**
 * The text towers the encoder holds, one per CLIP model, built from the model's
 * catalog metadata.
 *
 * More than one because a model switch keeps the old index searchable: while
 * the cluster moves from MobileCLIP to SigLIP2, a search may name either model
 * (`searchObjectEvents({ modelId })`), and rebuilding a Python engine on every
 * alternate query would cost seconds each time. Bounded, least-recently-used:
 * the third model disposes the coldest engine.
 *
 * The output is checked against the model's declared dimension and REFUSED on a
 * mismatch. The previous code sliced any longer output to the meta's length,
 * which is what turned a 768-d SigLIP2 query into 512 dims of noise under
 * MobileCLIP's fallback meta.
 */
import type { ClipModelMeta, IScopedLogger, ModelCatalogEntry } from '@camstack/types'
import type { ClipModel, ClipModelRegistry } from '../../shared/clip/clip-model-registry.js'
import type { CrashBudget } from './crash-budget.js'
import { PermanentRequirementsFailure, type RequirementsGate } from './model-requirements.js'

/** At most this many text towers stay loaded (SigLIP2's is ~565 MB). */
const MAX_TEXT_ENGINES = 2

/**
 * A tower unused this long is disposed ({@link ClipTextEngines.evictIdle}) —
 * EXCEPT the tower of the model the cluster row names, which stays loaded for
 * the life of the process exactly as it did before D649: the steady-state
 * search must not pay a Python spawn plus a model load after a quiet quarter
 * hour. Only the OTHER towers (SigLIP2 after a comparison, the old model after
 * a flip) are let go when idle. When the active model is unknown (the row was
 * never read), nothing is evicted — the side that keeps memory as before.
 * The encoder is `placement: any-node` and cannot tell locally whether it is
 * the node that answers text queries, so towers are loaded ON DEMAND — never
 * prefetched on a model flip (565 MB on every node). The first query after a
 * flip pays the load; if it fails, the search fails loudly rather than reading
 * as "no results".
 */
export const TEXT_ENGINE_IDLE_MS = 15 * 60_000

/** What the encoder needs from one text tower — the Python engine in production. */
export interface ClipTextEngine {
  /** The ENGINE stage (spawn, load, ready) — the holder's call, see `model-requirements.ts`. */
  initialize(): Promise<void>
  encode(text: string): Promise<Float32Array>
  /** False once the process died (crash, OOM kill) — the holder rebuilds. */
  isAlive(): boolean
  dispose(): Promise<void>
  getPid(): number | null
  getRequestCount(): number
}

/** Everything a builder needs to load one text tower. */
export interface ClipTextEngineSpec {
  readonly model: ClipModel
  readonly textEntry: ModelCatalogEntry
  readonly meta: ClipModelMeta
}

export interface ClipTextEnginesDeps {
  readonly registry: ClipModelRegistry
  readonly textCatalog: readonly ModelCatalogEntry[]
  /** Requirements + construction, NO process: `initialize()` is the holder's call. */
  readonly build: (spec: ClipTextEngineSpec) => Promise<ClipTextEngine>
  readonly maxEngines?: number
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  readonly now?: () => number
  /**
   * The model the encoder currently follows (the cluster row, via
   * `ActiveClipModel.known()`), or `null` while unknown. Its tower is never
   * evicted as idle; while it is `null`, no tower is.
   */
  readonly activeModelId: () => string | null
  /** Bounds respawns per model (D6): a crash or a failed `initialize()` spends it. */
  readonly budget: CrashBudget
  /** Refuses by name, and never spends the budget, when `build` itself throws. */
  readonly requirements: RequirementsGate
}

/** One encoded query, with the model that produced it. */
export interface ClipTextEncoding {
  readonly vector: Float32Array
  readonly model: ClipModel
}

export class ClipTextEngines {
  /** Insertion order is recency: a hit is re-inserted at the end. */
  private readonly engines = new Map<string, ClipTextEngine>()
  /** Single-flight per model: two concurrent first queries spawn one engine. */
  private readonly inflight = new Map<string, Promise<ClipTextEngine>>()
  /**
   * Encodes in flight per model. An engine with any is NEVER evicted: disposing
   * it would fail a search that is already running. When every held engine is
   * busy the set goes over `maxEngines` temporarily and shrinks when one drains.
   */
  private readonly busy = new Map<string, number>()
  /** When each held tower last finished an encode (or was built). */
  private readonly lastUsed = new Map<string, number>()
  /** Bumped by {@link disposeAll}: a build landing after it is disposed on arrival. */
  private generation = 0

  constructor(private readonly deps: ClipTextEnginesDeps) {}

  /** Resolve a model id to its CLIP model, or throw naming the id. */
  requireModel(modelId: string): ClipModel {
    const model = this.deps.registry.resolve(modelId)
    if (model === null) {
      throw new Error(`EmbeddingEncoder: "${modelId}" has no CLIP metadata — not a CLIP model`)
    }
    return model
  }

  async encode(modelId: string, text: string): Promise<ClipTextEncoding> {
    const model = this.requireModel(modelId)
    this.busy.set(modelId, (this.busy.get(modelId) ?? 0) + 1)
    let vector: Float32Array
    try {
      const engine = await this.engineFor(model)
      vector = await engine.encode(text)
    } finally {
      const left = (this.busy.get(modelId) ?? 1) - 1
      if (left > 0) this.busy.set(modelId, left)
      else this.busy.delete(modelId)
      if (this.engines.has(modelId)) this.lastUsed.set(modelId, this.now())
      // A drained engine may be the one that lets an over-limit set shrink.
      // SCHEDULED, not awaited: a slow or failing dispose must never delay or
      // replace this encode's own result or error.
      this.scheduleEviction()
    }
    if (vector.length !== model.meta.embeddingDim) {
      throw new Error(
        `EmbeddingEncoder: ${model.meta.textModelId} produced ${String(vector.length)} dims, ` +
          `its metadata declares ${String(model.meta.embeddingDim)} — refusing the query rather than truncating it`,
      )
    }
    return { vector, model }
  }

  /**
   * Dispose every IDLE tower unused for {@link TEXT_ENGINE_IDLE_MS} (a timer in
   * the addon calls this), except the active model's. Returns the evicted
   * model ids; each is logged. An unknown active model evicts nothing.
   */
  async evictIdle(idleMs: number = TEXT_ENGINE_IDLE_MS): Promise<readonly string[]> {
    const active = this.deps.activeModelId()
    // Unknown is not "none": evicting could dispose the steady-state tower.
    if (active === null) return []
    const now = this.now()
    // DOUBLE-GUARDED busy filter: this pass picks the candidates, the per-tower
    // re-check inside the loop protects a tower a query reached after this
    // pass and before its turn (each `restart` awaits a dispose). Measured
    // (D649 round 4): removing THIS filter alone keeps
    // `encoder-follows-cluster-row.spec.ts` green — the re-check catches
    // everything it catches; the re-check has its own test ("re-checks busy
    // RIGHT before each eviction") and goes red alone. Removing both goes red.
    const idle = [...this.engines.keys()].filter(
      (id) =>
        id !== active &&
        (this.busy.get(id) ?? 0) === 0 &&
        now - (this.lastUsed.get(id) ?? now) >= idleMs,
    )
    const evicted: string[] = []
    for (const modelId of idle) {
      // The armed half of the double guard — see the filter above.
      if ((this.busy.get(modelId) ?? 0) > 0 || !this.engines.has(modelId)) continue
      evicted.push(modelId)
      this.deps.logger.info('CLIP text tower evicted — idle', {
        meta: { modelId, idleMs: now - (this.lastUsed.get(modelId) ?? now) },
      })
      await this.restart(modelId)
    }
    return evicted
  }

  /** Live engines, for the memory watchdog. */
  live(): ReadonlyMap<string, ClipTextEngine> {
    return this.engines
  }

  /** Dispose one engine; the next query rebuilds it. */
  async restart(modelId: string): Promise<void> {
    const engine = this.engines.get(modelId)
    if (engine === undefined) return
    this.engines.delete(modelId)
    this.lastUsed.delete(modelId)
    await engine.dispose()
  }

  /** Dispose every tower AND cancel the builds in flight (disposed as they land). */
  async disposeAll(): Promise<void> {
    this.generation += 1
    const all = [...this.engines.values()]
    this.engines.clear()
    this.lastUsed.clear()
    await Promise.all(all.map((e) => e.dispose()))
    await Promise.allSettled(this.inflight.values())
  }

  private async engineFor(model: ClipModel): Promise<ClipTextEngine> {
    const held = this.engines.get(model.modelId)
    if (held !== undefined && held.isAlive()) {
      this.engines.delete(model.modelId)
      this.engines.set(model.modelId, held)
      return held
    }
    if (held !== undefined) {
      // The process died under us (OOM kill, crash). Keeping it would make
      // every query fail against a dead pipe; drop it — synchronously, so a
      // concurrent query cannot count the same death twice — and rebuild,
      // within the crash budget.
      this.deps.logger.warn('CLIP text tower died — dropping it and rebuilding', {
        meta: { modelId: model.modelId, textModelId: model.meta.textModelId },
      })
      this.engines.delete(model.modelId)
      this.lastUsed.delete(model.modelId)
      this.deps.budget.record(model.modelId, 'process died after loading')
      void held.dispose().catch(() => {
        /* already dead — nothing to release */
      })
    }
    const pending = this.inflight.get(model.modelId)
    if (pending !== undefined) return pending
    // A model in `failed` is refused by name BEFORE anything is spawned; one
    // inside its requirements cooldown (or terminally unmeetable) likewise,
    // and BEFORE any download.
    this.deps.budget.check(model.modelId)
    this.deps.requirements.check(model.modelId)

    const textEntry = this.deps.textCatalog.find((e) => e.id === model.meta.textModelId)
    if (textEntry === undefined) {
      // Not in the catalog: no retry changes that — a permanent requirements failure.
      throw this.deps.requirements.refuse(
        model.modelId,
        new PermanentRequirementsFailure(
          `EmbeddingEncoder: text model "${model.meta.textModelId}" (for ${model.modelId}) is not in the text catalog`,
        ),
      )
    }
    const generation = this.generation
    const build = this.buildAndLoad(model, textEntry)
    this.inflight.set(model.modelId, build)
    try {
      const engine = await build
      if (this.generation !== generation) {
        // disposeAll (shutdown) ran while this built: nobody holds it.
        await engine.dispose()
        throw new Error(`text tower for "${model.modelId}" cancelled: disposed while building`)
      }
      this.engines.set(model.modelId, engine)
      this.lastUsed.set(model.modelId, this.now())
      this.deps.logger.info('CLIP text tower loaded', {
        meta: { modelId: model.modelId, textModelId: model.meta.textModelId },
      })
      this.scheduleEviction()
      return engine
    } finally {
      this.inflight.delete(model.modelId)
    }
  }

  /**
   * Two stages, two owners (`model-requirements.ts`): `build` resolves files
   * and runtime and constructs the tower — a throw there is refused by name
   * and spends nothing; `initialize()` spawns and loads — a throw there is a
   * load failure and spends the crash budget.
   */
  private async buildAndLoad(
    model: ClipModel,
    textEntry: ModelCatalogEntry,
  ): Promise<ClipTextEngine> {
    let engine: ClipTextEngine
    try {
      engine = await this.deps.build({ model, textEntry, meta: model.meta })
    } catch (err: unknown) {
      throw this.deps.requirements.refuse(model.modelId, err)
    }
    this.deps.requirements.satisfied(model.modelId)
    try {
      await engine.initialize()
    } catch (err: unknown) {
      // A load that fails spends the budget — it used to retry per query.
      this.deps.budget.record(
        model.modelId,
        `load failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
    return engine
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Fire-and-log: eviction errors never reach an encode. */
  private scheduleEviction(): void {
    this.evictBeyond(this.deps.maxEngines ?? MAX_TEXT_ENGINES).catch((err: unknown) => {
      this.deps.logger.warn('CLIP text tower eviction failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  /** Evict the coldest IDLE engines until at most `max` remain, or none is idle. */
  private async evictBeyond(max: number): Promise<void> {
    while (this.engines.size > max) {
      const coldestIdle = [...this.engines.keys()].find((id) => (this.busy.get(id) ?? 0) === 0)
      if (coldestIdle === undefined) return // every engine is serving — shrink later
      await this.restart(coldestIdle)
    }
  }

  /** Encodes in flight on a model — exposed for the eviction tests. */
  inFlight(modelId: string): number {
    return this.busy.get(modelId) ?? 0
  }
}
