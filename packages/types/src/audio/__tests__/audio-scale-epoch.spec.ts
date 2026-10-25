import { describe, expect, it } from 'vitest'
import {
  AUDIO_SCALE_EPOCH_ISO,
  AUDIO_SCALE_EPOCH_MS,
  audioScaleEraOf,
  G711_SCALE_CORRECTION_DB,
  ituDbfsFromPreEpoch,
} from '../audio-scale-epoch.js'

describe('G711_SCALE_CORRECTION_DB', () => {
  it('is the exact factor, derived — not a rounded guess', () => {
    // The shipped decoder under-scaled μ-law by exactly 4 and A-law by exactly
    // 8, on every one of the 256 codes (ratio 4.000000 / 8.000000, min and max
    // alike). A gain of G in amplitude is 20·log10(G) in dB — so these two
    // numbers are arithmetic, not measurement, and this test is the derivation.
    expect(G711_SCALE_CORRECTION_DB.PCMU).toBeCloseTo(20 * Math.log10(4), 10)
    expect(G711_SCALE_CORRECTION_DB.PCMA).toBeCloseTo(20 * Math.log10(8), 10)
  })

  it('states them to the precision an operator will retype', () => {
    expect(G711_SCALE_CORRECTION_DB.PCMU).toBeCloseTo(12.041, 3)
    expect(G711_SCALE_CORRECTION_DB.PCMA).toBeCloseTo(18.062, 3)
  })

  it('names A-law as the larger correction — it lost a whole extra octave', () => {
    // A-law's magnitudes were computed on a 13-bit scale and never shifted to
    // 16: 8×, not 4×. Reading these two numbers as equal is the mistake this
    // assertion exists to stop.
    expect(G711_SCALE_CORRECTION_DB.PCMA - G711_SCALE_CORRECTION_DB.PCMU).toBeCloseTo(
      20 * Math.log10(2),
      10,
    )
  })
})

/**
 * The conversion D460 added, and the reason it is a function rather than a
 * number typed into each call site.
 *
 * Every absolute-dBFS threshold in this repo is one of two things, and the
 * difference is provenance, not arithmetic:
 *
 *  - a STATEMENT ABOUT THE SCALE — "-55 dBFS is near silence", "-25 dBFS is
 *    loud". True on the ITU-T scale before the epoch and after it. Nothing to
 *    convert; converting it would make a correct number wrong.
 *  - a MEASUREMENT TAKEN THROUGH THE OLD DECODER — a number someone read off
 *    a meter that under-reported by exactly 4× (PCMU) or 8× (PCMA). That
 *    number describes a sound that was really 12.04 / 18.06 dB louder, and
 *    this function is how it is restated without anybody doing the sum by eye.
 *
 * Doing the sum by eye is the whole reason this exists: `-55 + 12.04` typed
 * into a source file is indistinguishable, six months later, from a threshold
 * somebody simply preferred.
 */
describe('ituDbfsFromPreEpoch', () => {
  it('restates a PCMU-era measurement on the true scale', () => {
    // The one calibration in this repo with recorded provenance:
    // NC_AUDIO_DB_OFFERED's "real crying sits between -55 and -26 dBFS".
    expect(ituDbfsFromPreEpoch('PCMU', -55)).toBeCloseTo(-42.959, 3)
    expect(ituDbfsFromPreEpoch('PCMU', -26)).toBeCloseTo(-13.959, 3)
  })

  it('restates an A-law measurement by the larger, separate factor', () => {
    expect(ituDbfsFromPreEpoch('PCMA', -55)).toBeCloseTo(-36.938, 3)
  })

  it('moves a threshold UP, never down — the old meter read LOW', () => {
    // The sign is the entire risk. A pre-epoch reading of -55 described a
    // sound that was really -43: louder, so the equivalent gate is HIGHER on
    // the true scale. Getting this backwards produces -67, a gate that admits
    // the whole world, and it looks just as plausible in a diff.
    expect(ituDbfsFromPreEpoch('PCMU', -55)).toBeGreaterThan(-55)
    expect(ituDbfsFromPreEpoch('PCMA', -55)).toBeGreaterThan(ituDbfsFromPreEpoch('PCMU', -55))
  })

  it('is exactly the correction for that law — no rounding of its own', () => {
    for (const law of ['PCMU', 'PCMA'] as const) {
      expect(ituDbfsFromPreEpoch(law, -70) - -70).toBeCloseTo(G711_SCALE_CORRECTION_DB[law], 10)
      // Shift-invariant: it is an offset, not a scaling of the dBFS number.
      expect(ituDbfsFromPreEpoch(law, -70) - ituDbfsFromPreEpoch(law, -10)).toBeCloseTo(-60, 10)
    }
  })

  it('offers no conversion for a source that was never mis-decoded', () => {
    // AAC and Opus went through the `audio-codec` cap and were always ITU-T.
    // There is no factor for them because applying one would be inventing a
    // defect. The absence is the API: the only keys are the two G.711 laws.
    expect(Object.keys(G711_SCALE_CORRECTION_DB).sort()).toEqual(['PCMA', 'PCMU'])
  })
})

describe('audioScaleEraOf', () => {
  it('places a sample before the epoch on the quiet scale', () => {
    expect(audioScaleEraOf(AUDIO_SCALE_EPOCH_MS - 1)).toBe('pre-itu')
  })

  it('places the epoch instant itself, and everything after, on the ITU-T scale', () => {
    expect(audioScaleEraOf(AUDIO_SCALE_EPOCH_MS)).toBe('itu')
    expect(audioScaleEraOf(AUDIO_SCALE_EPOCH_MS + 1)).toBe('itu')
  })

  it('answers "unknown" for a timestamp that is not one — never silently "itu"', () => {
    // A missing or unparseable timestamp is not evidence that a reading is on
    // the current scale. Folding it into the present would make the oldest
    // rows look freshly calibrated, which is the direction that destroys the
    // ability to explain the step.
    expect(audioScaleEraOf(Number.NaN)).toBe('unknown')
    expect(audioScaleEraOf(0)).toBe('unknown')
    expect(audioScaleEraOf(-1)).toBe('unknown')
  })

  it('keeps the ISO spelling and the millisecond constant in agreement', () => {
    expect(Date.parse(AUDIO_SCALE_EPOCH_ISO)).toBe(AUDIO_SCALE_EPOCH_MS)
  })
})
