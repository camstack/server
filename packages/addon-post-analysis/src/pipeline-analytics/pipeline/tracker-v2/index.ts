/** Tracker v2 (D683): the public surface. Everything else under `tracker-v2/` is internal. */
export { LINK_WINDOW_MS } from './constants.js'
export { confirmedPredecessorRejections, type RejectedPredecessor } from './linker.js'
export { TrackerV2, type TrackerV2Deps } from './tracker-v2.js'
export {
  DEFAULT_TRACKER_V2_CONFIG,
  type ClockStepFacts,
  type FrameOrder,
  type Lineage,
  type OutOfOrderFrameFacts,
  type LinkCandidateFacts,
  type LinkDecisionFacts,
  type LinkRecognition,
  type LinkRejection,
  type TrackerV2Config,
  type TrackerV2Emission,
  type TrackerV2FrameContext,
  type TrackerV2Observers,
  type TrackFusion,
  type TrackletEndedFacts,
  type TrackletEndReason,
  type TrackletSplitFacts,
  TRACK_DROP_REASONS,
  type TrackDropReason,
} from './types.js'
