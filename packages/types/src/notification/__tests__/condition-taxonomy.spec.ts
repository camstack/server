/**
 * Hoisted from the viewer along with the module itself: the grouping logic is
 * now shared by the admin UI and the viewer, so its tests belong beside it.
 */
import { describe, it, expect } from 'vitest'
import {
  isAudioClassName,
  knownValues,
  pickerForCondition,
  pickerForRuleClasses,
} from '../condition-taxonomy.js'
import type { NcTaxonomy } from '../../catalogs/nc-taxonomy.js'

const TAXONOMY: NcTaxonomy = {
  videoClasses: [
    { kind: 'person', label: 'Person', parentKind: null },
    { kind: 'vehicle', label: 'Vehicle', parentKind: null },
    { kind: 'car', label: 'Car', parentKind: 'vehicle' },
    { kind: 'truck', label: 'Truck', parentKind: 'vehicle' },
    { kind: 'animal', label: 'Animal', parentKind: null },
    { kind: 'dog', label: 'Dog', parentKind: 'animal' },
  ],
  audioKinds: [
    { kind: 'audio-scream', label: 'Scream / Shout', parentKind: 'audio' },
    { kind: 'audio-glass_breaking', label: 'Glass Breaking', parentKind: 'audio' },
  ],
  labels: [
    { kind: 'contact', label: 'Contact', parentKind: 'sensor' },
    { kind: 'doorbell', label: 'Doorbell', parentKind: 'control' },
    { kind: 'lock', label: 'Lock', parentKind: 'control' },
  ],
}

describe('pickerForCondition', () => {
  it('returns null when taxonomy is absent', () => {
    expect(pickerForCondition('classes', undefined)).toBeNull()
  })

  it('returns null for free-text conditions (identities, tokens, zones)', () => {
    for (const id of [
      'identities',
      'identitiesExclude',
      'labelEquals',
      'eventTypeTokens',
      'zonesExclude',
    ]) {
      expect(pickerForCondition(id, TAXONOMY)).toBeNull()
    }
  })

  it('groups video classes by macro and appends an audio group for classes', () => {
    const picker = pickerForCondition('classes', TAXONOMY)
    expect(picker).not.toBeNull()
    const keys = picker!.groups.map((g) => g.key)
    expect(keys).toEqual(['person', 'vehicle', 'animal', 'audio'])

    const vehicle = picker!.groups.find((g) => g.key === 'vehicle')!
    expect(vehicle.fallbackLabel).toBe('Vehicle')
    // The macro itself leads its group, followed by its subs.
    expect(vehicle.options.map((o) => o.value)).toEqual(['vehicle', 'car', 'truck'])

    const audio = picker!.groups.find((g) => g.key === 'audio')!
    expect(audio.options.map((o) => o.value)).toEqual(['audio-scream', 'audio-glass_breaking'])
  })

  it('classesExclude uses the same class picker as classes', () => {
    const a = pickerForCondition('classes', TAXONOMY)
    const b = pickerForCondition('classesExclude', TAXONOMY)
    expect(b?.groups.map((g) => g.key)).toEqual(a?.groups.map((g) => g.key))
  })

  it('groups sensorKinds labels by sensor/control category', () => {
    const picker = pickerForCondition('sensorKinds', TAXONOMY)
    expect(picker).not.toBeNull()
    expect(picker!.groups.map((g) => g.key)).toEqual(['sensor', 'control'])
    const control = picker!.groups.find((g) => g.key === 'control')!
    expect(control.options.map((o) => o.value)).toEqual(['doorbell', 'lock'])
  })

  it('offers occupancy ONLY the macro classes — a sub-type can never be counted', () => {
    const picker = pickerForCondition('occupancy', TAXONOMY)
    expect(picker).not.toBeNull()
    // One flat group: the occupancy widget renders a single <Select>, and the
    // macro rows are the whole vocabulary anyway.
    expect(picker!.groups).toHaveLength(1)
    expect(picker!.groups[0]!.options.map((o) => o.value)).toEqual(['person', 'vehicle', 'animal'])
  })

  it('never offers occupancy a sub class or an audio kind', () => {
    const known = knownValues(pickerForCondition('occupancy', TAXONOMY)!)
    expect(known.has('car')).toBe(false)
    expect(known.has('truck')).toBe(false)
    expect(known.has('dog')).toBe(false)
    expect(known.has('audio-scream')).toBe(false)
  })

  it('knownValues enumerates every option value across groups', () => {
    const picker = pickerForCondition('classes', TAXONOMY)!
    const known = knownValues(picker)
    expect(known.has('car')).toBe(true)
    expect(known.has('audio-scream')).toBe(true)
    expect(known.has('doorbell')).toBe(false)
  })
})

/**
 * R13 (D690): a DETECTION rule's class scope never lists a sound. The legacy
 * picker put the audio kinds beside person / vehicle, and a detection rule
 * that picked one broke itself; sounds are authored on a Sound rule.
 */
describe('pickerForRuleClasses', () => {
  it('is the class picker without the audio group', () => {
    const picker = pickerForRuleClasses(TAXONOMY)
    expect(picker?.groups.map((g) => g.key)).toEqual(['person', 'vehicle', 'animal'])
    expect(knownValues(picker!).has('audio-scream')).toBe(false)
  })

  it('is null when there is no taxonomy, like every picker', () => {
    expect(pickerForRuleClasses(undefined)).toBeNull()
  })

  it('is null when the taxonomy holds only sounds', () => {
    expect(pickerForRuleClasses({ ...TAXONOMY, videoClasses: [] })).toBeNull()
  })
})

describe('isAudioClassName', () => {
  it('recognises an audio kind whatever its case or padding', () => {
    expect(isAudioClassName('audio-scream')).toBe(true)
    expect(isAudioClassName(' Audio-Glass_Breaking ')).toBe(true)
  })

  it('does not mistake a video class for one', () => {
    expect(isAudioClassName('person')).toBe(false)
    expect(isAudioClassName('audiobook')).toBe(false)
  })
})
