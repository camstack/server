/**
 * face-rescore — score ONE face against the gallery AS IT IS RIGHT NOW.
 *
 * ## Why this exists: the suggestion on a track is stale by construction
 *
 * `Face.suggestedIdentityId` / `suggestedMatchScore` are not computed when you
 * look at a track. They are computed DURING live detection, frame by frame
 * (`face-recognizer.ts` — the suggestion band), and the per-track peak is
 * persisted when the track CLOSES. They are a photograph of what the gallery
 * said at that instant.
 *
 * So every enrolment after that instant is invisible to them. The operator's
 * real workflow is the exact case this breaks: assign ten faces to build a
 * person up, then open an older unassigned track and ask "does it match NOW?"
 * — and read a number that was decided before any of those ten existed. There
 * is no refresh on every assign, and there should not be one (the
 * gallery changes on every assign; re-scoring every buffered face each time is
 * work nobody asked for). Two answers exist instead. On demand: this module,
 * the single-face button, and the whole-archive button (`face-rescore-job.ts`).
 * And D866 added a SLOW, change-gated job (`face-rescore-scheduler.ts`): hourly
 * by default, and only when a fingerprint of the gallery and of the unassigned
 * faces differs from the last completed run's — so an idle archive costs two
 * narrow reads, not a rescore. That supersedes this header's earlier "there is
 * no background job" statement; the objection to per-assign refresh stands.
 *
 * ## What it does NOT do
 *
 * It does not run inference. The face's embedding is already persisted, and
 * matching is pure arithmetic over vectors — so a recompute is a read plus a
 * few thousand dot products, not a pipeline pass. Re-embedding is a SEPARATE,
 * explicitly-requested action (see the action's `reembed` flag): a button
 * labelled "recompute" must never silently spend GPU.
 *
 * ## The model gate is not an optimisation, it is the difference between a
 * number and noise
 *
 * A cosine between vectors from two different face models is a well-formed
 * float with no meaning. `face-matcher` has always refused to compare across
 * `modelId`, which means a face embedded before a model flip scores against
 * NOTHING — and the trap is that "nothing" renders identically to "no match".
 * This module names that state (`model-mismatch`) so the UI can say "this face
 * is in an old feature space" instead of showing 0% and letting the operator
 * conclude the person is not there.
 *
 * ## `buildFaceRescoreReport` stays pure — the CALLER persists
 *
 * This function never touches the store; every input is passed in and nothing
 * is read or written (see its own doc below). The operator asked for this
 * exact recompute, though, and wants the answer to stick — so the ACTION that
 * wraps this report (`rescoreFaceForTrack` in `pipeline-analytics/index.ts`)
 * writes the result onto `Face.suggestedIdentityId` / `suggestedMatchScore`,
 * through `decideRescorePersistence` / `persistRescoreResult` below. That is
 * still not a background job — it is the SAME explicitly-requested call,
 * writing once. A `model-mismatch` report (`comparable: false`) is never
 * written: see `persistRescoreResult`.
 */
import {
  type GallerySample,
  type IdentityScore,
  matchEmbedding,
  rankIdentities,
} from './pipeline/face-matcher.js'

/**
 * The matcher parameters in force, echoed back with every report.
 *
 * Carried rather than assumed: these are operator-overridable per field and the
 * live hub does NOT run the schema defaults (measured 2026-09-26:
 * `similarityThreshold` 0.40 against a 0.45 default). A UI that printed the
 * default beside a score computed with the override would be quietly wrong.
 */
export interface FaceRescoreParams {
  /** Cosine required for an auto-assignment. */
  readonly threshold: number
  /** Best − secondBest must reach this, else the probe is ambiguous. */
  readonly margin: number
  /** Samples an identity needs to be an auto-match target at all (#26.3). */
  readonly minIdentitySamples: number
  /**
   * Floor of the suggestion band — below this nothing is offered.
   *
   * DERIVED, never stored: `threshold × suggestionBandFactor` (D222). It is
   * reported rather than left to the reader to compute, and reported WITH its
   * factor, so the operator can see where it came from instead of hunting for
   * a setting that no longer exists.
   */
  readonly suggestionMinCosine: number
  /**
   * The fraction of `threshold` that {@link suggestionMinCosine} is. Present so
   * the report states the DERIVATION, not just its result: a floor that moves
   * whenever the threshold moves reads as a bug unless the rule is on screen
   * beside it.
   */
  readonly suggestionBandFactor: number
}

/**
 * What the gallery says about this face, in one word.
 *
 * `ambiguous` is deliberately distinct from `below-threshold`: they look the
 * same from outside (no assignment) and they mean opposite things. Below
 * threshold means "not enough evidence for anybody"; ambiguous means "enough
 * evidence for two people", which is fixed by enrolling more samples, not by
 * lowering a knob.
 */
export type FaceRescoreVerdict =
  /** Best eligible identity clears threshold AND margin — the pipeline would assign it. */
  | 'auto-assignable'
  /** Clears threshold but a runner-up is within `margin` — the matcher refuses. */
  | 'ambiguous'
  /** In [suggestionMinCosine, threshold) — offered, never auto-assigned. */
  | 'suggestion'
  /** Below the suggestion floor: the gallery does not know this face. */
  | 'below-threshold'
  /** Identities exist and are comparable, but none has `minIdentitySamples`. */
  | 'no-eligible-identity'
  /** No sample in the probe's model space and dimension — nothing to compare. */
  | 'empty-gallery'
  /** The probe is in a DIFFERENT feature space. Any score here is noise. */
  | 'model-mismatch'

/** One identity as the operator reads it: named, scored, and judged. */
export interface FaceRescoreIdentityRow {
  readonly identityId: string
  /** The identity's name, or its id when the name could not be resolved. */
  readonly name: string
  /** Raw cosine against this identity's best comparable sample. Formatting —
   *  percentages — belongs to the UI, so the wire stays in the matcher's units. */
  readonly score: number
  /** Comparable samples backing this score. */
  readonly sampleCount: number
  /** Has `minIdentitySamples` — may be an auto-match target at all. */
  readonly eligible: boolean
  /** `score >= threshold`, independent of eligibility and margin. */
  readonly meetsThreshold: boolean
  /** True for the ONE identity the matcher would actually assign, if any. */
  readonly wouldAutoAssign: boolean
}

export interface FaceRescoreReport {
  readonly verdict: FaceRescoreVerdict
  /** False only for `model-mismatch` — the one state where scores are not real. */
  readonly comparable: boolean
  /** The model that produced the probe vector. */
  readonly probeModelId: string
  /** The cluster's current `face-embedding` model — what the gallery speaks. */
  readonly clusterModelId: string
  readonly params: FaceRescoreParams
  /** Every comparable identity, best first. Empty when nothing is comparable. */
  readonly identities: readonly FaceRescoreIdentityRow[]
  /** best − secondBest among ELIGIBLE identities; absent below two of them.
   *  This is the quantity `margin` is compared against. */
  readonly runnerUpGap?: number
}

export interface BuildFaceRescoreReportInput {
  readonly probe: {
    readonly embedding: readonly number[]
    readonly modelId: string
  }
  readonly gallery: readonly GallerySample[]
  /** identityId → display name. A miss falls back to the id, never to "Unknown". */
  readonly identityNames: ReadonlyMap<string, string>
  readonly clusterModelId: string
  readonly params: FaceRescoreParams
}

/** The empty report every "cannot score" path returns, so shape never varies. */
function emptyReport(
  verdict: FaceRescoreVerdict,
  input: BuildFaceRescoreReportInput,
  comparable: boolean,
): FaceRescoreReport {
  return {
    verdict,
    comparable,
    probeModelId: input.probe.modelId,
    clusterModelId: input.clusterModelId,
    params: input.params,
    identities: [],
  }
}

/**
 * Decide the verdict from the ELIGIBLE ranking, using exactly the gates
 * `matchEmbedding` uses — it is called here rather than re-implemented, so the
 * "would auto-assign" claim is the matcher's own answer and cannot drift.
 */
function decide(
  eligible: readonly IdentityScore[],
  input: BuildFaceRescoreReportInput,
): { verdict: FaceRescoreVerdict; winnerId: string | null } {
  const best = eligible[0]
  if (best === undefined) return { verdict: 'no-eligible-identity', winnerId: null }

  const match = matchEmbedding(input.probe, input.gallery, {
    threshold: input.params.threshold,
    margin: input.params.margin,
    minIdentitySamples: input.params.minIdentitySamples,
  })
  if (match !== null) return { verdict: 'auto-assignable', winnerId: match.identityId }

  // The matcher refused. Which gate did it refuse on? Threshold first, because
  // a score under threshold is never ambiguous — it is simply absent.
  if (best.score >= input.params.threshold) return { verdict: 'ambiguous', winnerId: null }
  if (best.score >= input.params.suggestionMinCosine)
    return { verdict: 'suggestion', winnerId: null }
  return { verdict: 'below-threshold', winnerId: null }
}

/**
 * Score one probe against the gallery as it stands, and say what the pipeline
 * would do with it. Pure: every input is passed in, nothing is read or written.
 */
export function buildFaceRescoreReport(input: BuildFaceRescoreReportInput): FaceRescoreReport {
  // D196 / `face-matcher`'s oldest invariant: across model spaces there is no
  // comparison to make. Refuse BEFORE ranking so no number is ever produced
  // that a caller could render as a percentage.
  if (input.probe.modelId !== input.clusterModelId) {
    return emptyReport('model-mismatch', input, false)
  }

  const ranked = rankIdentities(input.probe, input.gallery, input.params.minIdentitySamples)
  if (ranked.length === 0) return emptyReport('empty-gallery', input, true)

  const eligible = ranked.filter((r) => r.eligible)
  const { verdict, winnerId } = decide(eligible, input)

  const identities: FaceRescoreIdentityRow[] = ranked.map((r) => ({
    identityId: r.identityId,
    name: input.identityNames.get(r.identityId) ?? r.identityId,
    score: r.score,
    sampleCount: r.sampleCount,
    eligible: r.eligible,
    meetsThreshold: r.score >= input.params.threshold,
    wouldAutoAssign: r.identityId === winnerId,
  }))

  const [best, second] = eligible
  return {
    verdict,
    comparable: true,
    probeModelId: input.probe.modelId,
    clusterModelId: input.clusterModelId,
    params: input.params,
    identities,
    ...(best !== undefined && second !== undefined
      ? { runnerUpGap: best.score - second.score }
      : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence — the CALLER writes, this file only decides what
// ─────────────────────────────────────────────────────────────────────────

/** A `Face.suggestedIdentityId` / `suggestedMatchScore` write, in the shape
 *  `FaceStore.setSuggestion` accepts. */
export interface RescoreSuggestion {
  readonly identityId: string
  readonly score: number
}

/**
 * What `face.rescoreTrack` should PERSIST for a COMPARABLE report, decided as
 * its own pure function so the rule is directly testable — separated from the
 * class that owns the store I/O (`rescoreFaceForTrack` in
 * `pipeline-analytics/index.ts`), which only wires this answer to
 * `FaceStore.setSuggestion`.
 *
 * `null` covers every verdict OTHER than `auto-assignable` / `suggestion`, and
 * also an `auto-assignable` / `suggestion` verdict whose best-ranked row is
 * not itself ELIGIBLE (`identities` is ranked by raw score across every
 * comparable identity, eligible or not — see `buildFaceRescoreReport`). Every
 * one of those is a genuine "nothing to suggest right now": never an
 * assignment, and never the winner of an `ambiguous` verdict — the matcher
 * refused to pick one, so this function does not pick one either.
 *
 * Callers MUST gate on `report.comparable` before calling this — a
 * `model-mismatch` report has no verdict worth acting on; see
 * {@link persistRescoreResult}, which does that gating and is the one thing
 * `rescoreFaceForTrack` actually calls.
 */
export function decideRescorePersistence(report: FaceRescoreReport): RescoreSuggestion | null {
  if (report.verdict !== 'auto-assignable' && report.verdict !== 'suggestion') return null
  const candidate = report.identities.find((row) => row.eligible)
  return candidate === undefined
    ? null
    : { identityId: candidate.identityId, score: candidate.score }
}

/** The store seam {@link persistRescoreResult} writes through — exactly
 *  `FaceStore.setSuggestion`, named narrowly so this module stays store-free. */
export interface RescorePersistPorts {
  readonly setSuggestion: (faceId: string, suggestion: RescoreSuggestion | null) => Promise<void>
}

/**
 * `written`        — a single eligible candidate was found and persisted.
 * `cleared`        — the report was comparable but genuinely had nothing to
 *                     offer: persisted as an explicit "no suggestion" (both
 *                     columns cleared).
 * `not-comparable` — `model-mismatch`: refused BEFORE any store call. This is
 *                     "did not look", never rendered the same as `cleared`'s
 *                     "looked, found nothing" — see this module's header doc.
 */
export type RescorePersistOutcome = 'written' | 'cleared' | 'not-comparable'

/**
 * Persist `face.rescoreTrack`'s result onto the SUGGESTED tier — the ONE
 * write this explicitly-requested action makes, and the only place that
 * decides whether it happens at all.
 *
 * A non-comparable report (`model-mismatch`) short-circuits BEFORE
 * `ports.setSuggestion` is ever called: a cosine across model spaces is
 * well-formed noise, and persisting it would look exactly like a fresh,
 * meaningful read to every future reader of the row. This is the single most
 * load-bearing branch in this file — the regression it guards against writes
 * garbage that reads as data.
 */
export async function persistRescoreResult(
  faceId: string,
  report: FaceRescoreReport,
  ports: RescorePersistPorts,
): Promise<RescorePersistOutcome> {
  if (!report.comparable) return 'not-comparable'
  const candidate = decideRescorePersistence(report)
  await ports.setSuggestion(faceId, candidate)
  return candidate !== null ? 'written' : 'cleared'
}
