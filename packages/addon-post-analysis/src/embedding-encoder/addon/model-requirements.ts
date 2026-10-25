/**
 * The stage BEFORE the engine: the model files, the embedded Python and its
 * requirements. A failure here is infrastructure — a hub or registry outage, a
 * half-downloaded sibling, a Python download that never landed — and it must
 * not spend the crash budget (`crash-budget.ts`): a 30 s outage used to burn
 * the three attempts in seconds and leave CLIP `failed` until an operator
 * reset it, for a model that had never been spawned once.
 *
 * So a build is two stages with two owners. `build(modelId)` resolves the
 * requirements and constructs the engine WITHOUT a process behind it; the slot
 * (`model-engine-slot.ts`, `clip-text-engines.ts`) then calls
 * `engine.initialize()`, which spawns, loads and reports ready. Only the second
 * stage can spend the budget, and the split is structural — the slot knows
 * which stage threw because it made the calls — rather than a marker every
 * builder must remember to attach.
 *
 * But "not a crash" is not "retry on every request either" (round 5): a
 * caller asking at request rate (the embedding dispatcher at track rate, when
 * the image leg had a build) made every ask a fresh download attempt against a
 * hub that was down. So:
 *
 * - a failed attempt starts a COOLDOWN before the next one — doubling from
 *   {@link REQUIREMENTS_COOLDOWN_BASE_MS} to {@link REQUIREMENTS_COOLDOWN_MAX_MS},
 *   consulted ON DEMAND by {@link RequirementsGate.check} before a build, never
 *   a timer. A request inside it is refused at once by name
 *   (`EMBEDDING_REQUIREMENTS_UNAVAILABLE`) and downloads nothing;
 * - a requirement that can NEVER be met — an id the catalog does not know, an
 *   entry with no onnx build, a URL answering 404/410, a declared sibling that is not there, each marked
 *   {@link PermanentRequirementsFailure} by the ONE place that can tell — goes
 *   terminally `requirements-failed` after {@link MAX_REQUIREMENTS_ATTEMPTS}
 *   PERMANENT failures (D6's bound, which round 4 had removed for this path;
 *   transient attempts in the same episode cool down but never count toward
 *   it): refused by name
 *   (`EMBEDDING_REQUIREMENTS_FAILED`), ONE error logged, listed beside
 *   `failedModels` with its node, cleared by the same `resetFailedModels` or
 *   model change. A transient failure never goes terminal — it only cools down;
 * - a build that gets its engine clears everything for that model, and the
 *   recovery is logged once with how many requests were refused meanwhile.
 *
 * Logging is per TRANSITION, never per request: one warn when a model's
 * requirements stop being met, one error when it goes terminal, one info when
 * a build next succeeds. The detail plane counts the refusals per camera.
 */
import type {
  EmbeddingFailedRequirement,
  EmbeddingModelFailure,
  EmbeddingTower,
  IScopedLogger,
} from '@camstack/types'
import {
  embeddingRequirementsFailedError,
  embeddingRequirementsUnavailableError,
} from '@camstack/types'

/** First cooldown after a failed attempt; doubles per failure up to the cap. */
export const REQUIREMENTS_COOLDOWN_BASE_MS = 5_000
export const REQUIREMENTS_COOLDOWN_MAX_MS = 5 * 60_000
/** Failed attempts at a PERMANENTLY unmeetable requirement before it is terminal. */
export const MAX_REQUIREMENTS_ATTEMPTS = 3

/**
 * Thrown by the requirements stage when a retry can never help: the catalog
 * does not know the id, the server said the file does not exist (404/410), a
 * declared sibling is missing. Same process as the gate, so the class is the
 * marker; the gate never matches wording.
 */
export class PermanentRequirementsFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentRequirementsFailure'
  }
}

function isPermanentRequirementsFailure(err: unknown): err is PermanentRequirementsFailure {
  return err instanceof PermanentRequirementsFailure
}

interface Unavailable {
  readonly sinceMs: number
  readonly reason: string
  /** Requests refused since `sinceMs`, attempts included. */
  readonly refused: number
  /** Builds that failed since `sinceMs`, transient and permanent — drives the cooldown. */
  readonly attempts: number
  /**
   * Of those, the PERMANENT ones — the only count the terminal bound reads. A
   * transient failure (an outage) says nothing about whether the requirement
   * can ever be met, so it must not bring a later 404 closer to terminal.
   */
  readonly permanentAttempts: number
  /** No build before this instant; a request inside is refused at once. */
  readonly cooldownUntilMs: number
  /** Set once the model is terminally `requirements-failed`. */
  readonly terminal: EmbeddingFailedRequirement | null
}

export interface RequirementsGateDeps {
  readonly tower: EmbeddingTower
  /** The node this process runs on — stamped on every row and refusal. */
  readonly nodeId: () => string
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'error'>
  readonly now?: () => number
  readonly cooldownBaseMs?: number
  readonly cooldownMaxMs?: number
  readonly maxAttempts?: number
}

export class RequirementsGate {
  private readonly unavailable = new Map<string, Unavailable>()

  constructor(private readonly deps: RequirementsGateDeps) {}

  /**
   * Consulted BEFORE a build. Throws the named refusal — and downloads nothing
   * — while the model is terminal or inside its cooldown. Returns otherwise.
   */
  check(modelId: string): void {
    const state = this.unavailable.get(modelId)
    if (state === undefined) return
    if (state.terminal !== null) {
      this.unavailable.set(modelId, { ...state, refused: state.refused + 1 })
      throw embeddingRequirementsFailedError(state.terminal)
    }
    const now = this.now()
    if (now >= state.cooldownUntilMs) return
    this.unavailable.set(modelId, { ...state, refused: state.refused + 1 })
    throw embeddingRequirementsUnavailableError(
      this.on(modelId),
      `retry in ${String(Math.ceil((state.cooldownUntilMs - now) / 1000))}s — ${state.reason}`,
    )
  }

  /**
   * A build failed before any process existed. Starts (or doubles) the
   * cooldown; a PERMANENT failure past the bound makes the model terminal.
   * Logs at the transitions only and returns the named refusal to throw.
   */
  refuse(modelId: string, err: unknown): Error {
    const reason = err instanceof Error ? err.message : String(err)
    const now = this.now()
    const prior = this.unavailable.get(modelId)
    const attempts = (prior?.attempts ?? 0) + 1
    const permanent = isPermanentRequirementsFailure(err)
    const permanentAttempts = (prior?.permanentAttempts ?? 0) + (permanent ? 1 : 0)
    const cooldownMs = Math.min(
      this.deps.cooldownMaxMs ?? REQUIREMENTS_COOLDOWN_MAX_MS,
      (this.deps.cooldownBaseMs ?? REQUIREMENTS_COOLDOWN_BASE_MS) * 2 ** (attempts - 1),
    )
    const base: Unavailable = {
      sinceMs: prior?.sinceMs ?? now,
      reason,
      refused: (prior?.refused ?? 0) + 1,
      attempts,
      permanentAttempts,
      cooldownUntilMs: now + cooldownMs,
      terminal: null,
    }
    if (prior === undefined) {
      this.deps.logger.warn(
        'CLIP model requirements unavailable — requests refused until they are; the crash budget is untouched',
        {
          meta: { modelId, tower: this.deps.tower, nodeId: this.deps.nodeId(), reason, cooldownMs },
        },
      )
    }
    if (permanent && permanentAttempts >= (this.deps.maxAttempts ?? MAX_REQUIREMENTS_ATTEMPTS)) {
      const terminal: EmbeddingFailedRequirement = {
        ...this.on(modelId),
        attempts: permanentAttempts,
        sinceMs: now,
        lastReason: reason,
      }
      this.unavailable.set(modelId, { ...base, terminal })
      this.deps.logger.error(
        'CLIP model requirements can never be met — terminally failed, requests refused until reset',
        { meta: { ...terminal, refusedSoFar: base.refused } },
      )
      return embeddingRequirementsFailedError(terminal)
    }
    this.unavailable.set(modelId, base)
    return embeddingRequirementsUnavailableError(this.on(modelId), reason)
  }

  /** A build got its engine: the requirements are met again. Logs the recovery once. */
  satisfied(modelId: string): void {
    const prior = this.unavailable.get(modelId)
    if (prior === undefined) return
    this.unavailable.delete(modelId)
    this.deps.logger.info('CLIP model requirements available again', {
      meta: {
        modelId,
        tower: this.deps.tower,
        nodeId: this.deps.nodeId(),
        unavailableMs: this.now() - prior.sinceMs,
        refused: prior.refused,
        attempts: prior.attempts,
        lastReason: prior.reason,
      },
    })
  }

  /** Models terminally `requirements-failed` on this node, as `getInfo` reports them. */
  failed(): readonly EmbeddingFailedRequirement[] {
    return [...this.unavailable.values()]
      .map((s) => s.terminal)
      .filter((t): t is EmbeddingFailedRequirement => t !== null)
  }

  /**
   * Clear one model (or all): terminal state AND cooldown. Returns the ids
   * that were TERMINAL — a cooldown is not a state an operator is told about.
   */
  reset(modelId?: string, why = 'operator'): readonly string[] {
    const ids = modelId !== undefined ? [modelId] : [...this.unavailable.keys()]
    const cleared = ids.filter(
      (id) => this.unavailable.get(id)?.terminal !== null && this.unavailable.has(id),
    )
    for (const id of ids) this.unavailable.delete(id)
    if (cleared.length > 0) {
      this.deps.logger.info('CLIP model requirements-failed state cleared', {
        meta: { tower: this.deps.tower, nodeId: this.deps.nodeId(), cleared, why },
      })
    }
    return cleared
  }

  /** Models currently refused (cooldown or terminal) — exposed for tests. */
  pending(): readonly string[] {
    return [...this.unavailable.keys()]
  }

  private on(modelId: string): EmbeddingModelFailure {
    return { modelId, tower: this.deps.tower, nodeId: this.deps.nodeId() }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
