// ---------------------------------------------------------------------------
// Scene scoring — pure comparators for the similarity check mode
// ---------------------------------------------------------------------------
//
// Two pure functions the scene engine composes:
//   - scoreStates: condition-filtered, model-version-gated cosine matching
//     (Math.max across the surviving reference subset per state).
//   - stepHysteresis: count-based debounce (N consecutive agreeing checks
//     before a flip; resets on disagreement) — lifted verbatim from the
//     retired scene-state-worker.

import type { SceneCondition, SceneMonitorState, SceneReference } from '@camstack/types'

export interface ScoreResult {
  readonly bestStateId: string | null
  /**
   * `null` means **nothing was comparable at all** — no state had a reference
   * for this condition, or every reference was gated out by the model/dimension
   * check. That is a different fact from `0`, which means "compared, and it did
   * not match". Only the second is divergence; the first is `unknown`, and a
   * model change must never read as a theft.
   */
  readonly bestScore: number | null
}

/** Cosine similarity of two equal-length embeddings. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Per-call scoring policy. */
export interface ScoreOptions {
  /**
   * Score against EVERY reference when the current condition has none of its
   * own — the opt-in behind a scene's `onUncoveredCondition: 'judge-anyway'`.
   *
   * Off by default and it must stay that way: see `selectConditionRefs`. It is
   * offered because on some cameras it is genuinely true (a floodlit driveway,
   * an always-white-light doorbell, an indoor scene under a lamp that never
   * goes off), and there the alternative — sitting out every night — costs the
   * operator the coverage they actually have.
   */
  readonly crossConditionFallback: boolean
}

/**
 * Select the references a live crop is scored against for a given condition —
 * **exact condition match, and by default NO fallback.**
 *
 * There used to be an unconditional silent fallback to every reference when the
 * current condition had none. For a named-states monitor that was a defensible
 * "better than blind". For a latched alarm it is a false positive every single
 * night: the day reference is compared against an IR frame, the cosine
 * collapses, the scene latches `diverged`, and the operator is told the bin was
 * taken at 21:40. Cross-condition cosines are not comparable, so the honest
 * answer to "I have never seen this scene in this light" is *I don't know* —
 * never a guess in the direction that raises an alarm.
 *
 * The fallback survives only as an explicit per-scene opt-in, and even then it
 * is a LAST resort: when the exact condition has references of its own they
 * win outright, so opting in never widens a comparison the operator already
 * covered properly.
 */
function selectConditionRefs(
  references: readonly SceneReference[],
  currentCondition: SceneCondition,
  crossConditionFallback: boolean,
): readonly SceneReference[] {
  const exact = references.filter((r) => r.condition === currentCondition)
  if (exact.length > 0 || !crossConditionFallback) return exact
  return references
}

/** A reference is comparable only when its `modelId` equals the live encoder's
 *  model AND its dimension equals the encoder's embedding dim (face-matcher
 *  precedent — never trust dimension alone). */
function comparable(r: SceneReference, encoderModelId: string, encoderDim: number): boolean {
  return r.modelId === encoderModelId && r.embedding.length === encoderDim
}

/**
 * Score each state's condition-filtered, model-version-gated references against
 * the live embedding and return the best-matching state. `Math.max` across the
 * surviving subset; a state with no comparable reference contributes nothing.
 *
 * Returns `{ bestStateId: null, bestScore: null }` when NOTHING was comparable
 * — see `ScoreResult.bestScore`.
 */
export function scoreStates(
  states: readonly SceneMonitorState[],
  liveEmbedding: readonly number[],
  currentCondition: SceneCondition,
  encoderModelId: string,
  encoderDim: number,
  options?: ScoreOptions,
): ScoreResult {
  let bestStateId: string | null = null
  let bestScore: number | null = null
  const crossConditionFallback = options?.crossConditionFallback === true

  for (const s of states) {
    const refs = selectConditionRefs(s.references, currentCondition, crossConditionFallback)
    let stateScore: number | null = null
    for (const r of refs) {
      if (!comparable(r, encoderModelId, encoderDim)) continue
      const sim = cosineSimilarity(liveEmbedding, r.embedding)
      if (stateScore === null || sim > stateScore) stateScore = sim
    }
    if (stateScore !== null && (bestScore === null || stateScore > bestScore)) {
      bestScore = stateScore
      bestStateId = s.id
    }
  }

  return { bestStateId, bestScore }
}

/**
 * Which conditions this scene can actually judge in — the set behind the UI's
 * coverage line ("day ✓ · ir ✓ · dusk ✗"). That single line is what converts
 * the silent-fallback bug this file used to have into an operator-visible fact,
 * so it is computed from the SAME comparability gate the scorer uses rather
 * than from a naive `references.map(r => r.condition)`: a reference the encoder
 * can no longer read does not cover anything.
 */
export function coveredConditions(
  states: readonly SceneMonitorState[],
  encoderModelId: string,
  encoderDim: number,
): ReadonlySet<SceneCondition> {
  const covered = new Set<SceneCondition>()
  for (const s of states) {
    for (const r of s.references) {
      if (comparable(r, encoderModelId, encoderDim)) covered.add(r.condition)
    }
  }
  return covered
}

export interface HysteresisState {
  readonly currentStateId: string | null
  readonly pendingStateId: string | null
  readonly pendingCount: number
}

export interface HysteresisStep extends HysteresisState {
  /** True on the check that actually flipped `currentStateId`. */
  readonly transitioned: boolean
}

/**
 * Count-based hysteresis debounce. A candidate state must be observed on
 * `hysteresisCount` CONSECUTIVE checks before it flips `currentStateId`; any
 * disagreeing check resets the pending run. Pure — returns a new state.
 */
export function stepHysteresis(
  prev: HysteresisState,
  candidateStateId: string,
  hysteresisCount: number,
): HysteresisStep {
  const pendingStateId = candidateStateId
  const pendingCount = candidateStateId === prev.pendingStateId ? prev.pendingCount + 1 : 1

  if (pendingCount < hysteresisCount) {
    return {
      currentStateId: prev.currentStateId,
      pendingStateId,
      pendingCount,
      transitioned: false,
    }
  }
  if (candidateStateId === prev.currentStateId) {
    // Already the active state — confirmed but not a transition.
    return {
      currentStateId: prev.currentStateId,
      pendingStateId,
      pendingCount,
      transitioned: false,
    }
  }
  // Flip: the candidate has held for the full window.
  return {
    currentStateId: candidateStateId,
    pendingStateId: null,
    pendingCount: 0,
    transitioned: true,
  }
}
