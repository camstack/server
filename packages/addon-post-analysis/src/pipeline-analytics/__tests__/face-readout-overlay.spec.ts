/**
 * The face matching form's derived suggestion floor is served by ONE helper, on the scoped
 * overlay hook and on the legacy `getGlobalSettings` override alike. A threshold the operator
 * stored (or is previewing) moves the sentence beside it; nothing is stored.
 *
 * Disarm: return `{}` from `faceSuggestionReadoutOverlay` — the readout assertions fail.
 */
import { describe, expect, it } from 'vitest'
import {
  faceSuggestionReadoutOverlay,
  formatSuggestionThresholdReadout,
  SUGGESTION_THRESHOLD_READOUT_KEY,
} from '../settings-schema.js'
import { resolveFaceSettings } from '../face-settings.js'

describe('faceSuggestionReadoutOverlay', () => {
  it('derives the readout from the stored similarity threshold', () => {
    const stored = { similarityThreshold: 0.5 }
    expect(faceSuggestionReadoutOverlay(stored)).toEqual({
      [SUGGESTION_THRESHOLD_READOUT_KEY]: formatSuggestionThresholdReadout(0.5),
    })
  })

  it('an unset threshold reads as the default one, and a preview moves it', () => {
    const fallback = resolveFaceSettings({}).similarityThreshold
    expect(faceSuggestionReadoutOverlay({})[SUGGESTION_THRESHOLD_READOUT_KEY]).toBe(
      formatSuggestionThresholdReadout(fallback),
    )
    expect(faceSuggestionReadoutOverlay({ similarityThreshold: 0.8 })).not.toEqual(
      faceSuggestionReadoutOverlay({ similarityThreshold: 0.4 }),
    )
  })
})
