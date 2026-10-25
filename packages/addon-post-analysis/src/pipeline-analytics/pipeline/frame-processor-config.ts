/**
 * Settings → the three configs a `FrameProcessor` is built from. ONE place,
 * called by `getOrCreateProcessor` and by the tracking bench's replay (D681),
 * so a replayed tracker is production's tracker built from the recorded
 * settings — never a second mapping that can drift.
 *
 * Moved verbatim from `getOrCreateProcessor` (origin/main of 2026-09-29); the spec
 * next door pins it key by key.
 */
import type { DetectionSource } from '@camstack/types'
import type { DetectionSensitivitySettings } from '../detection-sensitivity-settings.js'
import type { TrackingSettings } from '../tracking-settings.js'
import type { EventEmitterConfig } from './events/event-filter.js'
import { FrameProcessor, type FrameProcessorDeps } from './frame-processor.js'
import type { StateAnalyzerConfig } from './tracker/state-analyzer.js'
import { DEFAULT_TRACKER_V2_CONFIG, type TrackerV2Config } from './tracker-v2/index.js'

export interface FrameProcessorInputs {
  readonly sensitivity: DetectionSensitivitySettings
  readonly tracking: TrackingSettings
  /** The camera's calibrated still bar; absent = not calibrated. */
  readonly stillSpeedFracPerSec?: number | undefined
}

export interface FrameProcessorConfig {
  readonly tracker: TrackerV2Config
  readonly state: Partial<StateAnalyzerConfig>
  readonly emitter: Partial<EventEmitterConfig>
}

/** Resolved settings → tracker v2 config (D683 §7). One mapping, used live and in replay. */
export function trackerV2ConfigFrom(inputs: FrameProcessorInputs): TrackerV2Config {
  const trk = inputs.tracking
  return {
    minHits: inputs.sensitivity.minHits,
    iouThreshold: trk.iouThreshold,
    maxMissedMs: trk.maxMissedMs,
    predictiveCoasting: trk.predictiveCoasting,
    classGating: trk.classGating,
    classGroupAssoc: trk.classGroupAssoc,
    animalOverPersonMaxScore: trk.animalOverPersonMaxScore,
    animalOverPersonIou: trk.animalOverPersonIou,
    personAnimalDedup: trk.personAnimalDedup,
    dedupEnabled: trk.dedupEnabled,
    dedupSpawnIou: trk.dedupSpawnIou,
    classVotingEnabled: trk.classVotingEnabled,
    classVoteMinFraction: trk.classVoteMinFraction,
    perClassMinScoreEnabled: trk.perClassMinScoreEnabled,
    classMinScores: {
      person: trk.minScorePerson,
      animal: trk.minScoreAnimal,
      vehicle: trk.minScoreVehicle,
    },
    minSpawnAreaEnabled: trk.minSpawnAreaEnabled,
    classSpawnAreaFracs: {
      person: trk.minSpawnAreaFracPerson,
      animal: trk.minSpawnAreaFracAnimal,
      vehicle: trk.minSpawnAreaFracVehicle,
    },
    confirmBypassEnabled: trk.confirmBypassEnabled,
    confirmBypassScore: trk.confirmBypassScore,
    lowScoreContinuationEnabled: trk.lowScoreContinuationEnabled,
    lowScoreIouThreshold: trk.byteTrackLowIouThreshold,
    // A constant, not a setting (no new settings, §7): off until Task 23
    // calibrates it. Required by `TrackerV2Config` — review 2 M5b.
    appearanceResolvesAmbiguity: DEFAULT_TRACKER_V2_CONFIG.appearanceResolvesAmbiguity,
  }
}

export function buildFrameProcessorConfig(inputs: FrameProcessorInputs): FrameProcessorConfig {
  const { stationaryThresholdSec, minTrackAge, cooldownSec } = inputs.sensitivity
  const trk = inputs.tracking
  const still = inputs.stillSpeedFracPerSec
  return {
    tracker: trackerV2ConfigFrom(inputs),
    state: {
      stationaryThresholdSec,
      ...(still !== undefined ? { stillSpeedFracPerSec: still } : {}),
    },
    emitter: { minTrackAge, cooldownSec, minTrackAgeMs: trk.minTrackAgeMs },
  }
}

export function createFrameProcessor(
  deviceId: number,
  source: DetectionSource,
  inputs: FrameProcessorInputs,
  deps: FrameProcessorDeps = {},
): FrameProcessor {
  const cfg = buildFrameProcessorConfig(inputs)
  return new FrameProcessor(deviceId, cfg.tracker, cfg.state, cfg.emitter, source, deps)
}
