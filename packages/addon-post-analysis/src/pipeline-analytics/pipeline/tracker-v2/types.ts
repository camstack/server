/** Public types of tracker v2 (D683). */
import {
  APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT,
  type BoundingBox,
  type SpatialDetection,
  type TrackedDetection,
} from '@camstack/types'
import type { SpawnRefusalFacts } from '../tracker/spawn-refusal.js'

export type TrackletMode = 'active' | 'coasting'
/** `clock-step`: the frame clock stepped back past the stale-frame bound; every
 *  live tracklet ended at its own last sighting and nothing links across. */
export type TrackletEndReason = 'missed' | 'ambiguous' | 'dropped' | 'stationary' | 'clock-step'

/**
 * Why the processor ends a chain: its own drop (never linked), or a registry
 * promotion of a subject that moved (linkable at its last sighting, spec §5).
 * ONE list — the tape's drop record parses against it (review M3), so a new
 * reason cannot compile here and fail only when a tape is read.
 */
export const TRACK_DROP_REASONS = ['dropped', 'stationary'] as const
export type TrackDropReason = (typeof TRACK_DROP_REASONS)[number]

export type Lineage =
  | { readonly kind: 'birth' }
  | { readonly kind: 'split'; readonly from: readonly string[] }

export interface TrackerV2Config {
  readonly minHits: number
  readonly iouThreshold: number
  readonly maxMissedMs: number
  readonly predictiveCoasting: boolean
  readonly classGating: boolean
  readonly classGroupAssoc: boolean
  readonly animalOverPersonMaxScore: number
  readonly animalOverPersonIou: number
  readonly personAnimalDedup: boolean
  readonly dedupEnabled: boolean
  readonly dedupSpawnIou: number
  readonly classVotingEnabled: boolean
  readonly classVoteMinFraction: number
  readonly perClassMinScoreEnabled: boolean
  readonly classMinScores: Readonly<Record<string, number>>
  readonly minSpawnAreaEnabled: boolean
  readonly classSpawnAreaFracs: Readonly<Record<string, number>>
  readonly confirmBypassEnabled: boolean
  readonly confirmBypassScore: number
  readonly lowScoreContinuationEnabled: boolean
  readonly lowScoreIouThreshold: number
  /**
   * Appearance may resolve an L1 ambiguity, add to the L1/L2 cost, reject a
   * link, and be the only evidence for a contested piece. OFF until the
   * descriptor is calibrated on tapes that carry it (Task 23, review M9);
   * scenes that test the mechanism turn it on explicitly. The DEFAULT below
   * is `@camstack/types` `APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT` — the same
   * authority the runner's cost gate reads (fix round 1, D62): neither addon
   * holds its own copy of this decision.
   */
  readonly appearanceResolvesAmbiguity: boolean
}

export const DEFAULT_TRACKER_V2_CONFIG: TrackerV2Config = {
  minHits: 3,
  iouThreshold: 0.3,
  maxMissedMs: 4000,
  predictiveCoasting: true,
  classGating: true,
  classGroupAssoc: true,
  animalOverPersonMaxScore: 0.6,
  animalOverPersonIou: 0.2,
  personAnimalDedup: true,
  dedupEnabled: true,
  dedupSpawnIou: 0.6,
  classVotingEnabled: true,
  classVoteMinFraction: 0.5,
  perClassMinScoreEnabled: true,
  classMinScores: { animal: 0.45, vehicle: 0.45 },
  minSpawnAreaEnabled: true,
  classSpawnAreaFracs: { person: 0.0005 },
  confirmBypassEnabled: false,
  confirmBypassScore: 0.9,
  lowScoreContinuationEnabled: true,
  lowScoreIouThreshold: 0.2,
  appearanceResolvesAmbiguity: APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT,
}

export interface TrackerV2FrameContext {
  readonly frameWidth: number
  readonly frameHeight: number
  /** Indices of `detections` the stationary gate held weakly (D410). */
  readonly continuationOnly?: ReadonlySet<number>
  /** Sub-floor boxes (D665 selection), never mixed into `detections`. */
  readonly lowScore?: readonly SpatialDetection[]
  /** First-level box OBJECTS with ANY face detail inside — no size test (§4.4): the piece
   *  becomes face-bearing, and L2 waits for the recognizer's verdict on it. */
  readonly faceBearing?: ReadonlySet<BoundingBox>
}

export interface TrackerV2Emission extends TrackedDetection {
  readonly lineage: Lineage
  /** Past the tracker's own birth gate (`minHits`), set per tracklet (Task 8). */
  readonly confirmed: boolean
  readonly heldByLowScore?: true
}

export interface TrackFusion {
  readonly survivorId: string
  readonly absorbedId: string
  readonly members: readonly string[]
  readonly t: number
  readonly cost: number
  readonly gapMs: number
}

export interface TrackletEndedFacts {
  readonly trackletId: string
  readonly reason: TrackletEndReason
  readonly at: number
  readonly confirmed: boolean
  readonly hits: number
  readonly className: string
}

/**
 * A FRAME stamped before the latest frame the tracker already took (follow-up
 * 102, F1; fix round 1 H1): it is not associated at all — nothing binds,
 * spawns, splits or coasts on it. One fact per frame; `behindMs` =
 * `lastFrameT − t`, `detections` = the boxes it carried, all dropped.
 */
export interface OutOfOrderFrameFacts {
  readonly t: number
  readonly lastFrameT: number
  readonly behindMs: number
  readonly detections: number
  /** Past `maxMissedMs`: how many such frames in a row so far, this one
   *  included (a step needs `CLOCK_STEP_CONFIRM_FRAMES`); 0 = plain disorder. */
  readonly pendingClockStep: number
}

/** How the facade will take a frame: tracked, dropped, or as a clock step. */
export type FrameOrder = 'in-order' | 'out-of-order' | 'clock-step'

/**
 * The frame clock stepped BACK further than the stale-frame bound
 * (`maxMissedMs`; follow-up 102, fix round 2): the runner clock was corrected,
 * or the camera moved to a runner whose clock is behind. Every live tracklet
 * ended (`ended`), every piece L2 still held undecided was decided `new`, and
 * the tracker's clock was rebased onto the new one. `t` and `lastFrameT` are
 * in the frame clock the caller passes (the new one, and the old high mark).
 */
export interface ClockStepFacts {
  readonly t: number
  readonly lastFrameT: number
  readonly behindMs: number
  readonly ended: readonly string[]
}

export interface TrackletSplitFacts {
  readonly t: number
  readonly ended: readonly string[]
  readonly born: readonly string[]
  /** The group's boxes that could not become a piece (continuation-only, D410):
   *  the doubt ENDED its tracklets and nothing took these boxes' place (D391). */
  readonly refused: readonly BoundingBox[]
  readonly tests: readonly ('swap' | 'rival' | 'competitor')[]
}

/** Why an earlier piece, in time and of the same class, could not continue a later one (D391). */
export type LinkRejection =
  | 'unconfirmed'
  | 'dropped'
  | 'has-successor'
  | 'concurrent'
  | 'identity-conflict'
  | 'area'
  | 'reach'
  | 'appearance'
  | 'contested'
  | 'cost'

/** One arc a decision weighed: its cost when feasible, else why it was not. */
export interface LinkCandidateFacts {
  readonly from: string
  readonly to: string
  readonly gapMs: number
  readonly cost?: number
  readonly rejected?: LinkRejection
}

/** What recognition said about a committed arc (§4.4): both chains named the same
 *  person; both were face-bearing and the wait ran out unsettled; or it had no say. */
export type LinkRecognition = 'same-identity' | 'waited-unsettled' | 'none'

export interface LinkDecisionFacts {
  readonly t: number
  /** `disagreed`: a committed chain now carries two names (a verdict after the
   *  commit) — fusion is final, so it is reported, never undone (Task 11 logs it
   *  WARN with `deviceId`). `ignored`: a piece re-sent after its chain was pruned. */
  readonly kind: 'committed' | 'refused' | 'new' | 'disagreed' | 'ignored'
  readonly from?: string
  readonly to: string
  readonly cost?: number
  readonly gapMs?: number
  /** Why a piece was decided without a link (D391; review 2 L3: a single
   *  candidate that never became ready is not "ambiguous"). `unconfirmed`: the
   *  piece ended before the birth gate confirmed it — it never links.
   *  `face-unmatched`: past the recognition wait, exactly one side is named.
   *  `faceless-live`: a face-bearing chain may not absorb a live piece that has
   *  shown no face. `dropped`: the piece was dropped (never absorbed).
   *  `pruned` (kind `ignored`): its chain was already forgotten. */
  readonly reason?:
    | 'ambiguous'
    | 'no-candidate'
    | 'predecessor-live'
    | 'not-ready'
    | 'unconfirmed'
    | 'face-unmatched'
    | 'faceless-live'
    | 'dropped'
    | 'pruned'
    | 'clock-step'
  /** Every arc the decision weighed: into the piece (and, for a commit, the
   *  predecessor's other successors), with costs, or the rejection. */
  readonly candidates?: readonly LinkCandidateFacts[]
  /** For `committed`; for `disagreed`, the recognition of the commit that joined the two names. */
  readonly recognition?: LinkRecognition
  /** `disagreed`: the chain's root (its definitive id), its members, and every name it now carries. */
  readonly root?: string
  readonly members?: readonly string[]
  readonly identities?: readonly string[]
}

export interface TrackerV2Observers {
  readonly refusal?: (facts: SpawnRefusalFacts) => void
  readonly ended?: (facts: TrackletEndedFacts) => void
  readonly split?: (facts: TrackletSplitFacts) => void
  readonly link?: (facts: LinkDecisionFacts) => void
  readonly outOfOrder?: (facts: OutOfOrderFrameFacts) => void
  readonly clockStep?: (facts: ClockStepFacts) => void
}
