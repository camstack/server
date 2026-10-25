/**
 * When a pass that rewrites an index may pin a target model (D651 fix rounds).
 *
 * The pass rewrites every vector, so the model it pins must be the operator's
 * choice, not a read that happened to answer the registry default. The rule,
 * from D49: a read that fails changes nothing, and a read that would DESTROY
 * work needs a second read to agree. So a target is confirmed only by two
 * successful reads IN A ROW that name the same model — a second read, not a
 * timer wait.
 *
 * The read is the OWNER's answer (`pipelineOrchestrator.getClusterModelChoice`
 * through `readClusterModelPinStrict`). A key nobody wrote is a positive
 * answer, "the default by absence", and confirms like any other: two agreeing
 * reads. A stored choice and an absence never agree.
 *
 * The auto timer asks every minute; a steady refusal must not print sixty lines
 * an hour. The confirmer logs when its outcome CHANGES, at info. A refusal that
 * does not go away — the same reason for {@link PERSISTENT_REFUSAL_ESCALATE_AFTER}
 * consecutive reads — is escalated ONCE to warn: a stuck `invalid-stored` or
 * `method-unavailable` is an operator problem, not a transient. Each caller owns
 * its own confirmer so one caller's state never hides another's change.
 */
import type { ClusterPinRead, ClusterPinUnknownReason } from './cluster-model-pin.js'

/** The passes that pin a cluster model, each with its own confirmer. */
export type ClusterPinCaller = 'face-reembed-auto' | 'face-reembed-operator' | 'clip-rebuild'

/**
 * Consecutive refusals with the SAME reason before one warn line. On the auto
 * timer (one read a minute) that is half an hour: long enough for a deploy or
 * an orchestrator restart to pass, short enough that a stuck state is seen the
 * same evening.
 */
export const PERSISTENT_REFUSAL_ESCALATE_AFTER = 30

/** Why a confirmation refused. */
export type ClusterPinRefusalReason = ClusterPinUnknownReason | 'reads-disagree'

/** The outcome of one confirmation. */
export type ClusterPinConfirmation =
  | {
      readonly kind: 'confirmed'
      readonly modelId: string
      /** True when the cluster runs the default because no row was ever stored. */
      readonly byAbsence: boolean
    }
  | { readonly kind: 'refused'; readonly reason: ClusterPinRefusalReason }

/** A first read that answered: a model the caller may check for work. */
export type ClusterPinAnswer = Exclude<ClusterPinRead, { kind: 'unknown' }>

/** The outcome of {@link ClusterPinConfirmer.readFirst}. */
export type ClusterPinFirstRead =
  | { readonly kind: 'answer'; readonly answer: ClusterPinAnswer }
  | { readonly kind: 'refused'; readonly reason: ClusterPinRefusalReason }

export interface ClusterPinConfirmerDeps {
  /** One strict read of the cluster pin (`readClusterModelPinStrict`). */
  readonly readPin: () => Promise<ClusterPinRead>
  /** Names the caller in the state-change line (one confirmer per caller). */
  readonly label: string
  readonly logger: {
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => void
    warn: (message: string, extras?: { meta?: Record<string, unknown> }) => void
  }
}

export class ClusterPinConfirmer {
  private lastOutcome: string | null = null
  private refusalStreak: {
    reason: ClusterPinRefusalReason
    count: number
    warned: boolean
  } | null = null

  constructor(private readonly deps: ClusterPinConfirmerDeps) {}

  /** Two reads; a target only when both answer and agree. */
  async confirm(): Promise<ClusterPinConfirmation> {
    // The interim answer is not logged: the confirmation that follows is the
    // outcome of this call, and it logs on change like any other.
    const first = await this.readFirstReporting(false)
    if (first.kind === 'refused') return first
    return this.confirmAgainst(first.answer)
  }

  /**
   * The FIRST read alone. A refusal is reported (and counted); an answer is
   * returned so the caller can ask whether there is work BEFORE paying for the
   * second read — the steady state reads once. An answer is an OUTCOME too:
   * it replaces a refusal in `lastOutcome`, so a recovery logs one info line
   * and a relapse into the same refusal logs again instead of being read as
   * "still the same".
   */
  async readFirst(): Promise<ClusterPinFirstRead> {
    return this.readFirstReporting(true)
  }

  private async readFirstReporting(logAnswer: boolean): Promise<ClusterPinFirstRead> {
    const first = await this.deps.readPin()
    if (first.kind === 'unknown') {
      this.report({ kind: 'refused', reason: first.reason }, first.error)
      return { kind: 'refused', reason: first.reason }
    }
    this.refusalStreak = null
    this.noteAnswer(first, logAnswer)
    return { kind: 'answer', answer: first }
  }

  /**
   * Record a first read that answered. A confirmation of the SAME answer is
   * not a change (the steady state would otherwise flip between "answered"
   * and "confirmed" every tick); any other previous outcome is.
   */
  private noteAnswer(answer: ClusterPinAnswer, log: boolean): void {
    const key = `answered:${describe(answer)}`
    if (this.lastOutcome === key || this.lastOutcome === confirmedKey(answer)) return
    this.lastOutcome = key
    if (!log) return
    this.deps.logger.info(`${this.deps.label}: the owner answered the cluster model read`, {
      meta: { answer: describe(answer) },
    })
  }

  /** The SECOND read, which must agree with `first` for a target to stand. */
  async confirmAgainst(first: ClusterPinAnswer): Promise<ClusterPinConfirmation> {
    const second = await this.deps.readPin()
    if (second.kind === 'unknown') {
      return this.report({ kind: 'refused', reason: second.reason }, second.error)
    }
    const a = pinOf(first)
    const b = pinOf(second)
    // "Stored X" and "never stored, default X" are different answers even when
    // X is the same model: one of the two reads saw a write the other did not.
    if (first.kind !== second.kind || a !== b) {
      return this.report({ kind: 'refused', reason: 'reads-disagree' }, undefined, {
        first: describe(first),
        second: describe(second),
      })
    }
    return this.report({ kind: 'confirmed', modelId: a, byAbsence: first.kind === 'not-stored' })
  }

  private report(
    outcome: ClusterPinConfirmation,
    error?: string,
    reads?: Record<string, string>,
  ): ClusterPinConfirmation {
    const meta = {
      ...(outcome.kind === 'confirmed'
        ? { modelId: outcome.modelId, byAbsence: outcome.byAbsence }
        : { reason: outcome.reason }),
      ...(error !== undefined ? { error } : {}),
      ...(reads !== undefined ? { reads } : {}),
    }
    const key =
      outcome.kind === 'confirmed'
        ? confirmedKey(
            outcome.byAbsence
              ? { kind: 'not-stored', defaultModelId: outcome.modelId }
              : { kind: 'known', modelId: outcome.modelId },
          )
        : outcome.reason
    if (key !== this.lastOutcome) {
      this.lastOutcome = key
      this.deps.logger.info(
        outcome.kind === 'confirmed'
          ? `${this.deps.label}: cluster model confirmed by two agreeing reads of the owner's answer`
          : `${this.deps.label}: cluster model NOT confirmed — no pass starts, nothing changes`,
        { meta },
      )
    }
    if (outcome.kind === 'confirmed') {
      this.refusalStreak = null
      return outcome
    }
    this.countRefusal(outcome.reason, meta)
    return outcome
  }

  private countRefusal(reason: ClusterPinRefusalReason, meta: Record<string, unknown>): void {
    const streak =
      this.refusalStreak !== null && this.refusalStreak.reason === reason
        ? { ...this.refusalStreak, count: this.refusalStreak.count + 1 }
        : { reason, count: 1, warned: false }
    this.refusalStreak = streak
    if (streak.warned || streak.count < PERSISTENT_REFUSAL_ESCALATE_AFTER) return
    this.refusalStreak = { ...streak, warned: true }
    this.deps.logger.warn(
      `${this.deps.label}: cluster model refused ${streak.count} times in a row for the same reason — this is not a transient, no pass will run until it changes`,
      { meta: { ...meta, consecutive: streak.count } },
    )
  }
}

/** The model a known or not-stored read names. */
function pinOf(read: ClusterPinAnswer): string {
  return read.kind === 'known' ? read.modelId : read.defaultModelId
}

function describe(read: ClusterPinAnswer): string {
  return read.kind === 'known'
    ? `stored:${read.modelId}`
    : `default-by-absence:${read.defaultModelId}`
}

/** The `lastOutcome` key of a confirmation of `answer`. */
function confirmedKey(answer: ClusterPinAnswer): string {
  return `confirmed:${describe(answer)}`
}
