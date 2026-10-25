/**
 * The D276 vocabulary, as a pure unit.
 *
 * Both of the rules in `media-provenance.ts` are here because both are silent
 * when broken: a badge that renders on everything looks exactly like one that
 * renders on the right things, and a miss reason that swallows an unknown token
 * looks exactly like a track that closed cleanly.
 */
import { describe, expect, it } from 'vitest'
import { describePreviewMiss, isMediaProvenance, provenanceBadge } from '../media-provenance.js'

describe('provenanceBadge', () => {
  it('badges a stand-in and a raster crop, and says which is worse', () => {
    expect(provenanceBadge('standin')?.label).toBe('stand-in')
    expect(provenanceBadge('standin')?.tone).toBe('warning')
    expect(provenanceBadge('raster')?.label).toBe('low-res')
    expect(provenanceBadge('raster')?.tone).toBe('info')
  })

  it('says NOTHING for native, and nothing for a tile it was told nothing about', () => {
    // The two are one answer on purpose: a pre-column row ranks `native`
    // BECAUSE it cannot be classified, so badging it would turn "we cannot
    // tell" into an accusation across the whole pre-column history.
    expect(provenanceBadge('native')).toBeNull()
    expect(provenanceBadge(undefined)).toBeNull()
  })
})

describe('isMediaProvenance', () => {
  it('accepts the three ranks and refuses anything else', () => {
    expect(isMediaProvenance('native')).toBe(true)
    expect(isMediaProvenance('raster')).toBe(true)
    expect(isMediaProvenance('standin')).toBe(true)
    // A fourth rank from a newer addon reads as ABSENT, never as a value.
    expect(isMediaProvenance('holographic')).toBe(false)
    expect(isMediaProvenance(undefined)).toBe(false)
  })
})

describe('describePreviewMiss', () => {
  it('turns the leading token into a sentence and splits the rest', () => {
    const out = describePreviewMiss('no-key-frame tile=standin capture=keyframe:native-missx4')
    expect(out?.sentence).toMatch(/No key frame existed at close/)
    expect(out?.detail).toEqual([
      { key: 'tile', value: 'standin' },
      { key: 'capture', value: 'keyframe:native-missx4' },
    ])
  })

  it('keeps the raw line verbatim — it is what an operator greps the log for', () => {
    const raw = 'derive-returned-null tile=standin'
    expect(describePreviewMiss(raw)?.raw).toBe(raw)
  })

  it('falls back to the token itself for a reason this build does not know', () => {
    expect(describePreviewMiss('lease-died-mid-close x=1')?.sentence).toBe('lease-died-mid-close')
  })

  it('is null for absent and for blank — both mean "nothing to say"', () => {
    expect(describePreviewMiss(undefined)).toBeNull()
    expect(describePreviewMiss('   ')).toBeNull()
  })
})
