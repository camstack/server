import { describe, it, expect } from 'vitest'
import {
  RETIRED_TRACKING_KEYS,
  resolveTrackingSettings,
  TRACKING_DEFAULTS,
  TrackingSettingsSchema,
} from '../tracking-settings.js'

describe('resolveTrackingSettings', () => {
  it('returns all defaults for an empty blob', () => {
    expect(resolveTrackingSettings({})).toEqual(TRACKING_DEFAULTS)
  })

  it('honours valid overrides and keeps defaults for the rest', () => {
    const r = resolveTrackingSettings({ iouThreshold: 0.5, classGating: false })
    expect(r.iouThreshold).toBe(0.5)
    expect(r.classGating).toBe(false)
    expect(r.maxMissedMs).toBe(TRACKING_DEFAULTS.maxMissedMs)
    expect(r.predictiveCoasting).toBe(TRACKING_DEFAULTS.predictiveCoasting)
  })

  it('exposes safe defaults for the false-positive knobs', () => {
    const r = resolveTrackingSettings({})
    expect(r.classVotingEnabled).toBe(true)
    expect(r.classVoteMinFraction).toBe(0.5)
    expect(r.perClassMinScoreEnabled).toBe(true)
    expect(r.minScorePerson).toBe(0)
    expect(r.minScoreAnimal).toBe(0.45)
    expect(r.minScoreVehicle).toBe(0.45)
    expect(r.confirmBypassEnabled).toBe(false)
    expect(r.confirmBypassScore).toBe(0.9)
  })

  it('honours per-camera overrides of the false-positive knobs, falling back per-field on bad values', () => {
    const r = resolveTrackingSettings({
      classVotingEnabled: false,
      minScoreAnimal: 0.6,
      confirmBypassEnabled: true,
      classVoteMinFraction: 2, // out of [0,1] → default
      minScoreVehicle: 'nope', // wrong type → default
    })
    expect(r.classVotingEnabled).toBe(false)
    expect(r.minScoreAnimal).toBe(0.6)
    expect(r.confirmBypassEnabled).toBe(true)
    expect(r.classVoteMinFraction).toBe(TRACKING_DEFAULTS.classVoteMinFraction)
    expect(r.minScoreVehicle).toBe(TRACKING_DEFAULTS.minScoreVehicle)
  })

  it('falls back per-field on invalid values', () => {
    const r = resolveTrackingSettings({
      iouThreshold: 5, // out of [0,1]
      maxMissedMs: -1, // must be >= 0
      dedupSpawnIou: 'no', // wrong type
      classGating: 'yes', // wrong type
      dropoutMaxSkipFrames: 1.5, // must be int
    })
    expect(r.iouThreshold).toBe(TRACKING_DEFAULTS.iouThreshold)
    expect(r.maxMissedMs).toBe(TRACKING_DEFAULTS.maxMissedMs)
    expect(r.dedupSpawnIou).toBe(TRACKING_DEFAULTS.dedupSpawnIou)
    expect(r.classGating).toBe(TRACKING_DEFAULTS.classGating)
    expect(r.dropoutMaxSkipFrames).toBe(TRACKING_DEFAULTS.dropoutMaxSkipFrames)
  })
})

describe('resolveTrackingSettings — D665 per-camera switches', () => {
  it('low-score continuation is ON by default and can be turned off', () => {
    expect(TRACKING_DEFAULTS.lowScoreContinuationEnabled).toBe(true)
    const off = resolveTrackingSettings({ lowScoreContinuationEnabled: false })
    expect(off.lowScoreContinuationEnabled).toBe(false)
    // A bad value falls back to the default rather than throwing.
    expect(
      resolveTrackingSettings({ lowScoreContinuationEnabled: 'no' }).lowScoreContinuationEnabled,
    ).toBe(true)
  })
})

describe('D683 retired tracking settings', () => {
  it('the schema carries none of the retired keys', () => {
    for (const key of RETIRED_TRACKING_KEYS) {
      expect(Object.keys(TrackingSettingsSchema.shape)).not.toContain(key)
    }
  })

  it('a stored blob that still has them resolves, and they are ignored', () => {
    const resolved = resolveTrackingSettings({
      resurrectionWindowMs: 12_000,
      dedupMergeFrames: 9,
      maxTrackLifetimeSec: 60,
      iouThreshold: 0.4,
    })
    expect(resolved.iouThreshold).toBe(0.4)
    expect(Object.keys(resolved)).not.toContain('resurrectionWindowMs')
  })

  it('survives the real production merge shape — readDeviceSettings does resolve({ ...globalRaw, ...deviceRaw })', () => {
    // index.ts's readDeviceSettings (the admin UI's actual per-camera read
    // path) merges the global addon-settings row and the per-camera device
    // row with a plain object spread, device overriding global, THEN hands
    // the merged blob to resolveTrackingSettings. Retired keys can linger in
    // either row independently (a global override set long ago, a per-camera
    // blob that predates this retirement) — this proves the merge itself
    // does not resurrect or poison anything, on either side.
    const globalRaw: Record<string, unknown> = {
      resurrectionWindowMs: 5000, // retired, stale GLOBAL override
      occlusionEnabled: true, // retired, stale GLOBAL override
      iouThreshold: 0.25, // live GLOBAL override
    }
    const deviceRaw: Record<string, unknown> = {
      dedupMergeFrames: 3, // retired, stale PER-CAMERA value
      maxTrackLifetimeSec: 120, // retired, stale PER-CAMERA value
      classGating: false, // live PER-CAMERA override
    }
    const merged = resolveTrackingSettings({ ...globalRaw, ...deviceRaw })

    // Retired keys from BOTH rows are silently ignored — never surface on
    // the resolved object.
    for (const key of [
      'resurrectionWindowMs',
      'occlusionEnabled',
      'dedupMergeFrames',
      'maxTrackLifetimeSec',
    ]) {
      expect(Object.keys(merged)).not.toContain(key)
    }
    // The live override from each row survives the merge untouched.
    expect(merged.iouThreshold).toBe(0.25)
    expect(merged.classGating).toBe(false)
    // Every other field still resolves to its plain default — the retired
    // keys sitting in either row did not poison the rest of the parse.
    expect(merged.maxMissedMs).toBe(TRACKING_DEFAULTS.maxMissedMs)
    expect(merged.dedupSpawnIou).toBe(TRACKING_DEFAULTS.dedupSpawnIou)
  })

  it('lists exactly the retired keys of spec §7', () => {
    expect([...RETIRED_TRACKING_KEYS].sort()).toEqual(
      [
        'byteTrackEnabled',
        'byteTrackHighThreshold',
        'dedupMergeFrames',
        'dedupMergeIou',
        'lowScoreContinuationMaxMs',
        'maxMissedFrames',
        'maxTrackLifetimeSec',
        'occlusionContainment',
        'occlusionEnabled',
        'occlusionMaxMissedFrames',
        'occlusionMaxMissedMs',
        'rescueCentroidFactor',
        'rescueIouThreshold',
        'resurrectionTimeScaled',
        'resurrectionWindowMs',
        'stationarySpeedPx',
      ].sort(),
    )
  })
})
