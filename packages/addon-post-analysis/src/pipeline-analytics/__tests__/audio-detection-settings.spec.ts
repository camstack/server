import { describe, it, expect } from 'vitest'
import {
  resolveAudioDetectionSettings,
  AUDIO_DETECTION_DEFAULTS,
} from '../audio-detection-settings'

describe('resolveAudioDetectionSettings', () => {
  it('returns defaults for an empty store', () => {
    expect(resolveAudioDetectionSettings({})).toEqual(AUDIO_DETECTION_DEFAULTS)
  })

  it('overrides only provided keys and ignores out-of-range / wrong-type values', () => {
    const r = resolveAudioDetectionSettings({
      classificationMinScore: 0.8,
      levelDeviationDb: 'nope',
      levelMaxWaitSec: -5,
      levelWindowSec: 15,
    })
    expect(r.classificationMinScore).toBe(0.8)
    expect(r.levelWindowSec).toBe(15)
    expect(r.levelDeviationDb).toBe(AUDIO_DETECTION_DEFAULTS.levelDeviationDb) // wrong type → default
    expect(r.levelMaxWaitSec).toBe(AUDIO_DETECTION_DEFAULTS.levelMaxWaitSec) // <=0 → default
  })

  it('ships audio-episode hysteresis ON with conservative knobs', () => {
    expect(AUDIO_DETECTION_DEFAULTS.audioEpisodeEnabled).toBe(true)
    expect(AUDIO_DETECTION_DEFAULTS.audioEpisodeOpenHoldSec).toBe(1.5)
    expect(AUDIO_DETECTION_DEFAULTS.audioEpisodeCloseGapSec).toBe(12)
    // The minimum spacing between two synthetic events of the SAME sound on
    // one camera. 60 s, not 30 — operator floor set 2026-09-03.
    expect(AUDIO_DETECTION_DEFAULTS.audioEpisodeCooldownSec).toBe(60)
    expect(AUDIO_DETECTION_DEFAULTS.audioConfirmHits).toBe(2)
    expect(AUDIO_DETECTION_DEFAULTS.audioConfirmWindowSec).toBe(10)
  })

  it('overrides episode knobs field-by-field', () => {
    const r = resolveAudioDetectionSettings({
      audioEpisodeEnabled: false,
      audioEpisodeOpenHoldSec: 3,
      audioEpisodeCloseGapSec: 20,
      audioEpisodeCooldownSec: 60,
    })
    expect(r.audioEpisodeEnabled).toBe(false)
    expect(r.audioEpisodeOpenHoldSec).toBe(3)
    expect(r.audioEpisodeCloseGapSec).toBe(20)
    expect(r.audioEpisodeCooldownSec).toBe(60)
  })
})
