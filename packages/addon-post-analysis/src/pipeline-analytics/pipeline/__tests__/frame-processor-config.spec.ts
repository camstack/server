/**
 * The replay must build its processor exactly as production does, so the
 * mapping settings → configs moves out of `getOrCreateProcessor` into ONE pure
 * function (spec §6.3). This pins the mapping key by key, as it stood inline
 * on `origin/main` of 2026-09-29 — an extraction that renamed or dropped a key
 * would silently replay a different tracker.
 *
 * Disarm: in `trackerV2ConfigFrom`, write `maxMissedMs: trk.maxMissedMs * 10`
 * — the first test must fail (D683: the tracker half is tracker v2's config).
 *
 * Disarm: in `createFrameProcessor`, drop `deps` from `new FrameProcessor(…)`
 * — the third test must fail (a random id, not `replay-1`).
 */
import type { FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DETECTION_SENSITIVITY_DEFAULTS } from '../../detection-sensitivity-settings.js'
import { TRACKING_DEFAULTS } from '../../tracking-settings.js'
import {
  buildFrameProcessorConfig,
  createFrameProcessor,
  trackerV2ConfigFrom,
} from '../frame-processor-config.js'
import { sequentialTrackIdMinter } from '../track-id.js'
import { DEFAULT_TRACKER_V2_CONFIG } from '../tracker-v2/index.js'

const t = TRACKING_DEFAULTS
const s = DETECTION_SENSITIVITY_DEFAULTS

describe('buildFrameProcessorConfig', () => {
  it('maps the tracking and sensitivity settings exactly as getOrCreateProcessor did', () => {
    const cfg = buildFrameProcessorConfig({ sensitivity: s, tracking: t })
    // D683: the tracker's half is `trackerV2ConfigFrom` — ONE mapping for live
    // and replay — pinned here key by key so a renamed or dropped key fails.
    expect(cfg.tracker).toEqual(trackerV2ConfigFrom({ sensitivity: s, tracking: t }))
    expect(cfg.tracker).toEqual({
      minHits: s.minHits,
      iouThreshold: t.iouThreshold,
      maxMissedMs: t.maxMissedMs,
      predictiveCoasting: t.predictiveCoasting,
      classGating: t.classGating,
      classGroupAssoc: t.classGroupAssoc,
      animalOverPersonMaxScore: t.animalOverPersonMaxScore,
      animalOverPersonIou: t.animalOverPersonIou,
      personAnimalDedup: t.personAnimalDedup,
      dedupEnabled: t.dedupEnabled,
      dedupSpawnIou: t.dedupSpawnIou,
      classVotingEnabled: t.classVotingEnabled,
      classVoteMinFraction: t.classVoteMinFraction,
      perClassMinScoreEnabled: t.perClassMinScoreEnabled,
      classMinScores: {
        person: t.minScorePerson,
        animal: t.minScoreAnimal,
        vehicle: t.minScoreVehicle,
      },
      minSpawnAreaEnabled: t.minSpawnAreaEnabled,
      classSpawnAreaFracs: {
        person: t.minSpawnAreaFracPerson,
        animal: t.minSpawnAreaFracAnimal,
        vehicle: t.minSpawnAreaFracVehicle,
      },
      confirmBypassEnabled: t.confirmBypassEnabled,
      confirmBypassScore: t.confirmBypassScore,
      lowScoreContinuationEnabled: t.lowScoreContinuationEnabled,
      lowScoreIouThreshold: t.byteTrackLowIouThreshold,
      appearanceResolvesAmbiguity: DEFAULT_TRACKER_V2_CONFIG.appearanceResolvesAmbiguity,
    })
    expect(cfg.state).toEqual({ stationaryThresholdSec: s.stationaryThresholdSec })
    expect(cfg.emitter).toEqual({
      minTrackAge: s.minTrackAge,
      cooldownSec: s.cooldownSec,
      minTrackAgeMs: t.minTrackAgeMs,
    })
  })

  it('spreads the calibrated still-speed bar into the analyser, only when present', () => {
    const cfg = buildFrameProcessorConfig({
      sensitivity: s,
      tracking: t,
      stillSpeedFracPerSec: 0.02,
    })
    // Tracker v2 has no stationary judgement of its own (D683 round 4: a still
    // subject is the registry's), so the bar reaches only the analyser.
    expect('stillSpeedFracPerSec' in cfg.tracker).toBe(false)
    expect(cfg.state).toEqual({
      stationaryThresholdSec: s.stationaryThresholdSec,
      stillSpeedFracPerSec: 0.02,
    })
    const none = buildFrameProcessorConfig({
      sensitivity: s,
      tracking: t,
      stillSpeedFracPerSec: undefined,
    })
    expect('stillSpeedFracPerSec' in none.tracker).toBe(false)
    expect('stillSpeedFracPerSec' in none.state).toBe(false)
  })

  it('builds a processor for the plane with the injected deps', () => {
    // `minHits: 1` so ONE frame emits the track; the prefix is one the random
    // production minter never produces, so the id proves `deps` arrived.
    const p = createFrameProcessor(
      101,
      'onboard',
      { sensitivity: { ...s, minHits: 1 }, tracking: t },
      { mintTrackId: sequentialTrackIdMinter('replay-') },
    )
    expect(p.source).toBe('onboard')
    expect(p.deviceId).toBe(101)
    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f-0',
      deviceId: 101,
      timestamp: 10_000,
      width: 1280,
      height: 720,
      detections: [
        {
          id: 'walker-0',
          kind: 'first-level',
          macroClass: 'person',
          score: 0.9,
          labels: [],
          bbox: { x: 400, y: 200, width: 120, height: 320 },
        },
      ],
    }
    const r = p.process({ timestamp: frame.timestamp, frame })
    expect(r.tracked.map((d) => d.trackId)).toEqual(['replay-1'])
  })
})
