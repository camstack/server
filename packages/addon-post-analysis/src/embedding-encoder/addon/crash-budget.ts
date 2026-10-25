/**
 * A bounded respawn budget per model — D6 applied to the embedding towers.
 *
 * A model that crashes after it loads (an OOM on its first inference) or that
 * cannot load at all used to be rebuilt on EVERY request, forever: on the live
 * detail plane that is back-to-back 185–565 MB Python spawns. Here each crash
 * or load failure is recorded; {@link MAX_CRASHES} within {@link CRASH_WINDOW_MS}
 * puts the model in a terminal `failed` state:
 *
 * - every later request is refused BY NAME before anything is spawned — the
 *   ONE shared code `EMBEDDING_MODEL_FAILED` (`@camstack/types`), which the
 *   live detail plane classifies on;
 * - ONE error line is logged at the transition, with the count — not one per
 *   request;
 * - the state is surfaced (`failed()`, read by the encoder's `getInfo`) and
 *   every row names the node it lives on;
 * - it clears ONLY on an explicit operator action (`resetFailedModels`), on the
 *   cluster row naming THIS model anew (a model change), or with the process
 *   (it is in memory — a runner respawn starts from zero). Never on a timer: a
 *   timer is an infinite loop with a sleep in it.
 *
 * What spends the budget is the ENGINE stage only — a spawn that fails, a
 * process that dies before ready, a crash after load. A model whose FILES or
 * RUNTIME are not there (download, embedded Python, requirements) is refused
 * by another name and never counted here: see `model-requirements.ts`.
 */
import type { EmbeddingFailedModel, EmbeddingTower, IScopedLogger } from '@camstack/types'
import { embeddingModelFailedError } from '@camstack/types'

const MAX_CRASHES = 3
export const CRASH_WINDOW_MS = 10 * 60_000

/** One model in the terminal state, as `getInfo` reports it. */
export type FailedModel = EmbeddingFailedModel

export interface CrashBudgetDeps {
  /** Which tower this budget guards — named in every log line and refusal. */
  readonly tower: EmbeddingTower
  /** The node this process runs on — stamped on every row and refusal. */
  readonly nodeId: () => string
  readonly logger: Pick<IScopedLogger, 'info' | 'error'>
  readonly now?: () => number
  readonly maxCrashes?: number
  readonly windowMs?: number
}

export class CrashBudget {
  private readonly recent = new Map<string, number[]>()
  private readonly failedModels = new Map<string, FailedModel>()

  constructor(private readonly deps: CrashBudgetDeps) {}

  /** Throw the named refusal when the model is in `failed`. Spawns nothing. */
  check(modelId: string): void {
    const failed = this.failedModels.get(modelId)
    if (failed === undefined) return
    throw embeddingModelFailedError(failed)
  }

  /** Record one crash or load failure. Returns true when it made the model `failed`. */
  record(modelId: string, reason: string): boolean {
    if (this.failedModels.has(modelId)) return false
    const now = this.now()
    const windowMs = this.deps.windowMs ?? CRASH_WINDOW_MS
    const times = (this.recent.get(modelId) ?? []).filter((t) => now - t < windowMs)
    times.push(now)
    this.recent.set(modelId, times)
    if (times.length < (this.deps.maxCrashes ?? MAX_CRASHES)) return false
    const failed: FailedModel = {
      modelId,
      tower: this.deps.tower,
      nodeId: this.deps.nodeId(),
      crashes: times.length,
      windowMs,
      sinceMs: now,
      lastReason: reason,
    }
    this.failedModels.set(modelId, failed)
    this.recent.delete(modelId)
    this.deps.logger.error(
      'CLIP tower FAILED — crash budget exhausted, requests refused until reset',
      { meta: { ...failed } },
    )
    return true
  }

  failed(): readonly FailedModel[] {
    return [...this.failedModels.values()]
  }

  /** Clear one model (or all). Returns the ids that were failed. */
  reset(modelId?: string, why = 'operator'): readonly string[] {
    const ids = modelId !== undefined ? [modelId] : [...this.failedModels.keys()]
    const cleared = ids.filter((id) => this.failedModels.delete(id))
    for (const id of ids) this.recent.delete(id)
    if (cleared.length > 0) {
      this.deps.logger.info('CLIP tower failed state cleared', {
        meta: { tower: this.deps.tower, nodeId: this.deps.nodeId(), cleared, why },
      })
    }
    return cleared
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
