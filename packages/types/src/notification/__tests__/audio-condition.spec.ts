/**
 * The sustained-sound condition's authoring logic, asserted where it is SHARED.
 *
 * The four behaviours below are the ones an editor gets wrong silently, and
 * each has a live consequence rather than a cosmetic one:
 *
 *  - a dBFS threshold written positive is a threshold no sample can reach;
 *  - an audio condition naming neither a level nor a label is REFUSED by the
 *    engine, so an editor that does not say so ships a rule that never fires;
 *  - `audio-dog` and `dog` are one label, so a rule authored on one surface
 *    must read as authored on the other;
 *  - a stored label this build does not know must stay visible, never be
 *    rewritten away from under the operator.
 */
import { describe, expect, it } from 'vitest'
import { ituDbfsFromPreEpoch } from '../../audio/audio-scale-epoch.js'
import { NcAudioConditionSchema } from '../../capabilities/notification-rules.cap.js'
import { AUDIO_MACRO_LABELS } from '../../catalogs/audio-classmap.js'
import type { NcTaxonomy } from '../../catalogs/nc-taxonomy.js'
import {
  audioIsFailClosed,
  audioKindId,
  audioLabelChoices,
  audioModeOf,
  audioOrDefaults,
  isAudioLabelSelected,
  NC_AUDIO_DB_MAX,
  NC_AUDIO_DB_MIN,
  NC_AUDIO_DB_OFFERED,
  NC_AUDIO_DB_STEP,
  NC_AUDIO_DEFAULTS,
  normalizeAudioLabel,
  patchAudio,
  toggleAudioLabel,
} from '../audio-condition.js'

const TAXONOMY: NcTaxonomy = {
  videoClasses: [],
  audioKinds: [
    { kind: 'audio-dog', label: 'Cane', parentKind: null },
    { kind: 'audio-scream', label: 'Urlo', parentKind: null },
  ],
  labels: [],
}

describe('audio condition bounds', () => {
  it('mirrors the cap schema rather than restating it', () => {
    expect(NcAudioConditionSchema.parse({ dbThreshold: NC_AUDIO_DB_MIN }).dbThreshold).toBe(
      NC_AUDIO_DB_MIN,
    )
    expect(() => NcAudioConditionSchema.parse({ dbThreshold: NC_AUDIO_DB_MIN - 1 })).toThrow()
    expect(NcAudioConditionSchema.parse({ dbThreshold: NC_AUDIO_DB_MAX }).dbThreshold).toBe(
      NC_AUDIO_DB_MAX,
    )
    expect(() => NcAudioConditionSchema.parse({ dbThreshold: NC_AUDIO_DB_MAX + 1 })).toThrow()
    // The OFFERED value is a usable starting point, not the floor: a stepper
    // seeded at -96 needs thirty taps to reach a threshold that fires.
    expect(NC_AUDIO_DB_OFFERED).toBeGreaterThan(NC_AUDIO_DB_MIN)
    expect(NC_AUDIO_DB_OFFERED).toBeLessThan(NC_AUDIO_DB_MAX)
  })

  it('offers a level floor QUIET enough for the sounds this hub actually hears', () => {
    // Measured on the live hub: real crying sits between -55 and -26 dBFS. The
    // offered floor used to be -30, which excludes most of that band — the
    // operator turned the filter on and authored a rule that could not fire.
    //
    // ⚠ RE-ANCHORED, D460. This assertion used to read `toBeLessThanOrEqual(-55)`
    // and it went red the moment the constant moved to -43. That red was
    // CORRECT and the assertion was wrong, so it is the assertion that changed:
    // it had pinned the RAW MEASUREMENT, and that measurement was taken through
    // a decoder that under-reported by 12.04 dB (D459). Pinning a number read
    // off a broken meter is how a defect acquires a green test — the same shape
    // of failure D459 called out in the "the two implementations agree" check.
    //
    // What the intent actually was: "the offered floor sits at the QUIET end of
    // the band where real crying lives, so a fresh level rule can fire". That
    // survives the scale change; the literal did not. So the band is the anchor
    // now, restated on the true scale, and it is derived rather than typed.
    const [quietEnd, loudEnd] = [ituDbfsFromPreEpoch('PCMU', -55), ituDbfsFromPreEpoch('PCMU', -26)]
    expect(NC_AUDIO_DB_OFFERED).toBeLessThanOrEqual(Math.round(quietEnd))
    // ...and NOT below it: a floor dragged down toward -96 makes the filter
    // meaningless in the other direction, which is the failure the -30 seed had
    // in mirror image.
    expect(NC_AUDIO_DB_OFFERED).toBeGreaterThan(quietEnd - NC_AUDIO_DB_STEP)
    expect(NC_AUDIO_DB_OFFERED).toBeLessThan(loudEnd)
  })

  it('is an integer — the level control and patchAudio both round-trip through clampInt', () => {
    // The conversion is fractional (-42.959…). If the constant kept that, the
    // editor would show a seed that storage could never hold, and "what I was
    // offered" and "what got saved" would differ by 0.04 dB for no reason.
    expect(Number.isInteger(NC_AUDIO_DB_OFFERED)).toBe(true)
  })
})

/**
 * The two EXCLUSIVE modes (operator decision, 2026-08-14).
 *
 * A rule either names sounds (LABEL — fires on the first frame the classifier
 * labels, no window at all) or names a level (LEVEL — the sampling window).
 * The mode is not a stored field: it is which filter the rule carries, so
 * every rule authored before the decision migrates for free.
 */
describe('audioModeOf', () => {
  it('reads labels-without-a-threshold as LABEL mode', () => {
    expect(audioModeOf({ labels: ['crying', 'scream'], hitPercent: 60, samplingSeconds: 10 })).toBe(
      'label',
    )
  })

  it('reads a threshold-without-labels as LEVEL mode', () => {
    expect(audioModeOf({ dbThreshold: -55, hitPercent: 60, samplingSeconds: 10 })).toBe('level')
  })

  it('has NO mode when neither filter is named — the engine refuses it', () => {
    expect(audioModeOf({ hitPercent: 60, samplingSeconds: 10 })).toBeNull()
    expect(audioModeOf({ labels: [], hitPercent: 60, samplingSeconds: 10 })).toBeNull()
    expect(audioModeOf(undefined)).toBeNull()
  })

  it('resolves a LEGACY rule carrying both onto LABEL — the mode that fires', () => {
    // Only reachable from a rule authored before the modes existed: the editor
    // and `patchAudio` cannot produce this any more.
    expect(
      audioModeOf({ labels: ['dog'], dbThreshold: -30, hitPercent: 60, samplingSeconds: 10 }),
    ).toBe('label')
  })

  it('shows the schema defaults for an unset condition WITHOUT authoring them', () => {
    expect(audioOrDefaults(undefined)).toEqual(NC_AUDIO_DEFAULTS)
    expect(NcAudioConditionSchema.parse({})).toEqual(NC_AUDIO_DEFAULTS)
  })

  it('accepts a label confirm-count pair and leaves it optional', () => {
    const parsed = NcAudioConditionSchema.parse({
      labels: ['crying'],
      confirmHits: 2,
      confirmWindowSec: 5,
    })
    expect(parsed.confirmHits).toBe(2)
    expect(parsed.confirmWindowSec).toBe(5)
    expect(NcAudioConditionSchema.parse({ labels: ['crying'] }).confirmHits).toBeUndefined()
  })
})

describe('patchAudio', () => {
  it('clamps a positive threshold into the negative-going dBFS range', () => {
    expect(patchAudio(undefined, { dbThreshold: 60 }).dbThreshold).toBe(NC_AUDIO_DB_MAX)
    expect(patchAudio(undefined, { dbThreshold: -400 }).dbThreshold).toBe(NC_AUDIO_DB_MIN)
  })

  it('omits a cleared filter instead of writing an explicit undefined', () => {
    const withDb = patchAudio(undefined, { dbThreshold: -30 })
    const cleared = patchAudio(withDb, { dbThreshold: undefined })
    expect('dbThreshold' in cleared).toBe(false)
  })

  it('drops an empty label list to absent — the schema rejects []', () => {
    const cleared = patchAudio(
      { labels: ['dog'], hitPercent: 60, samplingSeconds: 10 },
      {
        labels: [],
      },
    )
    expect('labels' in cleared).toBe(false)
    expect(() => NcAudioConditionSchema.parse({ labels: [] })).toThrow()
  })

  it('always produces a value the cap schema accepts unchanged', () => {
    const patched = patchAudio(undefined, { hitPercent: 999, samplingSeconds: 0, labels: ['dog'] })
    expect(NcAudioConditionSchema.parse(patched)).toEqual(patched)
    expect(patched.hitPercent).toBe(100)
    expect(patched.samplingSeconds).toBe(1)
  })
})

/**
 * An editor cannot author the ambiguous combination. This is the half of the
 * exclusivity that is STRUCTURAL — `audioModeOf` resolves a legacy rule, but
 * nothing new can be written that needs resolving.
 */
describe('patchAudio — the modes are exclusive', () => {
  it('choosing sounds clears a stored level floor', () => {
    const level = patchAudio(undefined, { dbThreshold: -55 })
    const labels = patchAudio(level, { labels: ['crying'] })
    expect(labels.labels).toEqual(['crying'])
    expect('dbThreshold' in labels).toBe(false)
    expect(audioModeOf(labels)).toBe('label')
  })

  it('adding a level floor clears the sounds', () => {
    const labelled = patchAudio(undefined, { labels: ['crying'] })
    const level = patchAudio(labelled, { dbThreshold: -55 })
    expect(level.dbThreshold).toBe(-55)
    expect('labels' in level).toBe(false)
    expect(audioModeOf(level)).toBe('level')
  })

  it('switching to LEVEL mode seeds the offered floor so the rule can fire', () => {
    const labelled = patchAudio(undefined, { labels: ['crying'] })
    const level = patchAudio(labelled, { mode: 'level' })
    expect(level.dbThreshold).toBe(NC_AUDIO_DB_OFFERED)
    expect('labels' in level).toBe(false)
  })

  it('switching to LABEL mode keeps the sounds and drops the floor', () => {
    const both = patchAudio(undefined, { labels: ['crying'], dbThreshold: -55 })
    const labelled = patchAudio(both, { mode: 'label' })
    expect(labelled.labels).toEqual(['crying'])
    expect('dbThreshold' in labelled).toBe(false)
  })

  it('normalizes a LEGACY both-filters rule onto the mode that fires', () => {
    const legacy = { labels: ['crying'], dbThreshold: -30, hitPercent: 60, samplingSeconds: 10 }
    const patched = patchAudio(legacy, {})
    expect(patched.labels).toEqual(['crying'])
    expect('dbThreshold' in patched).toBe(false)
  })
})

describe('fail-closed warning', () => {
  it('flags a condition naming neither a level nor a label', () => {
    expect(audioIsFailClosed({ hitPercent: 60, samplingSeconds: 10 })).toBe(true)
    expect(audioIsFailClosed({ hitPercent: 60, samplingSeconds: 10, labels: ['dog'] })).toBe(false)
    expect(audioIsFailClosed({ hitPercent: 60, samplingSeconds: 10, dbThreshold: -30 })).toBe(false)
  })

  it('does not flag an ABSENT condition — a rule with no audio key is not an audio rule', () => {
    expect(audioIsFailClosed(undefined)).toBe(false)
  })
})

describe('label vocabulary', () => {
  it('treats the taxonomy spelling and the bare macro id as one label', () => {
    expect(normalizeAudioLabel('audio-dog')).toBe('dog')
    expect(normalizeAudioLabel('dog')).toBe('dog')
    expect(isAudioLabelSelected(['audio-dog'], 'dog')).toBe(true)
    expect(isAudioLabelSelected(['dog'], 'audio-dog')).toBe(true)
  })

  it('writes the BARE id and removes every stored spelling', () => {
    expect(toggleAudioLabel(undefined, 'audio-dog')).toEqual(['dog'])
    expect(toggleAudioLabel(['audio-dog', 'dog'], 'dog')).toBeUndefined()
    expect(toggleAudioLabel(['dog'], 'cat')).toEqual(['dog', 'cat'])
  })

  it('offers the local macro catalog, each class carrying its taxonomy icon id', () => {
    const { choices } = audioLabelChoices(undefined, undefined)
    expect(choices).toHaveLength(AUDIO_MACRO_LABELS.length)
    expect(choices.every((c) => !c.unknown)).toBe(true)
    // An ICON ID, never a glyph. The editors render it through their own
    // lucide set (`resolveEventKindIcon` on the web), so admin and viewer draw
    // the same icon the timeline and the events tree already use — the emoji
    // the choice used to carry could only ever be one vocabulary, and it was
    // not the one the rest of the product speaks.
    expect(choices.map((c) => c.iconId)).toEqual(AUDIO_MACRO_LABELS.map((l) => audioKindId(l.id)))
  })

  it("prefers the hub's words, derives the icon id, and normalizes its ids", () => {
    const { choices } = audioLabelChoices(TAXONOMY, undefined)
    expect(choices.map((c) => c.value)).toEqual(['dog', 'scream'])
    expect(choices[0]?.label).toBe('Cane')
    expect(choices[0]?.iconId).toBe('audio-dog')
  })

  it('keeps a stored label neither side knows, marked unknown but still drawable', () => {
    const { choices, unknownLabels } = audioLabelChoices(TAXONOMY, ['audio-didgeridoo'])
    expect(unknownLabels).toEqual(['didgeridoo'])
    const stored = choices.find((c) => c.value === 'didgeridoo')
    expect(stored?.unknown).toBe(true)
    // Namespaced all the same: `resolveEventKindIcon` falls back to the audio
    // glyph for an unmapped `audio-*`, so an unknown class renders as a sound
    // rather than as the generic tag.
    expect(stored?.iconId).toBe('audio-didgeridoo')
  })
})
