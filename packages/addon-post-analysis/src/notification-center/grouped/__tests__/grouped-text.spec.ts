/**
 * The grouped SENTENCE (D692 §6.4) — names when known, count for the rest. The
 * sentence caps at two names and counts the remainder:
 *
 *     Bob, Dave e 1 altra persona
 *
 * Everything here is built out of `ncDetectionSummary` and the class nouns that
 * already ship with real CLDR plurals — the whole point of the design note is
 * that a SECOND sentence builder must not appear beside the first.
 *
 * The neutralisation that matters: a group of ONE must render exactly what
 * `ncSubjectText` renders today. If it does not, the feature is not free at
 * n=1 and cannot be the default.
 */

import { describe, expect, it } from 'vitest'
import { NcTextCatalog } from '../../text-catalog.js'
import { ncSubjectText } from '../../text-compose.js'
import { ncGroupSubjectText } from '../grouped-text.js'

function catalog(language: 'en' | 'it'): NcTextCatalog {
  const texts = new NcTextCatalog()
  texts.apply({ language, overrides: {} })
  return texts
}

const IT = catalog('it')
const EN = catalog('en')

function person(_trackId: string, label?: string) {
  return {
    className: 'person',
    ...(label !== undefined ? { label, labelKind: 'identity' as const } : {}),
  }
}

describe('ncGroupSubjectText — one member is today, byte for byte', () => {
  it('renders exactly what ncSubjectText renders for a nameless subject', () => {
    expect(ncGroupSubjectText(IT, { members: [person('t1')] })).toBe(
      ncSubjectText(IT, { className: 'person' }),
    )
  })

  it('renders exactly what ncSubjectText renders for a recognised subject', () => {
    expect(ncGroupSubjectText(IT, { members: [person('t1', 'Bob')] })).toBe(
      ncSubjectText(IT, { className: 'person', label: 'Bob', labelKind: 'identity' }),
    )
  })
})

describe('ncGroupSubjectText — nobody is named', () => {
  it('counts, with the language own plurals', () => {
    const members = [person('a'), person('b'), person('c')]
    expect(ncGroupSubjectText(IT, { members })).toBe('3 persone')
    expect(ncGroupSubjectText(EN, { members })).toBe('3 people')
  })

  it('says the MIXED composition a multi-class rule produced', () => {
    const members = [person('a'), person('b'), { className: 'animal' }]
    expect(ncGroupSubjectText(IT, { members })).toBe('2 persone e 1 animale')
    expect(ncGroupSubjectText(EN, { members })).toBe('2 people and 1 animal')
  })
})

describe('ncGroupSubjectText — names when known, count for the rest', () => {
  it('names two and counts the remainder — the operator sentence', () => {
    const members = [person('a', 'Bob'), person('b', 'Dave'), person('c')]
    expect(ncGroupSubjectText(IT, { members })).toBe('Bob, Dave e 1 altra persona')
    // English takes the serial comma from `Intl.ListFormat`, Italian does not —
    // which is the point of joining through the catalog instead of `', '`.
    expect(ncGroupSubjectText(EN, { members })).toBe('Bob, Dave, and 1 other person')
  })

  it('caps at two names however many are recognised', () => {
    const members = [person('a', 'Bob'), person('b', 'Dave'), person('c', 'Carol'), person('d')]
    // Carol is not dropped — he is counted. Two names is a lock-screen bound,
    // not a claim that only two people were identified.
    expect(ncGroupSubjectText(IT, { members })).toBe('Bob, Dave e 2 altre persone')
  })

  it('renders only the names when everybody has one', () => {
    const members = [person('a', 'Bob'), person('b', 'Dave')]
    expect(ncGroupSubjectText(IT, { members })).toBe('Bob e Dave')
    expect(ncGroupSubjectText(EN, { members })).toBe('Bob and Dave')
  })

  it('agrees the remainder with each class it counts', () => {
    const members = [person('a', 'Bob'), person('b'), { className: 'animal' }]
    // Italian gender agrees per class: "altra persona" (f) / "altro animale" (m) [another person / another animal].
    expect(ncGroupSubjectText(IT, { members })).toBe('Bob, 1 altra persona e 1 altro animale')
  })

  it('a plate is spoken through the plate SUBJECT phrase (D692 §6.4), not as a bare word', () => {
    const plate = { className: 'car', label: 'AB123CD', labelKind: 'plate' as const }
    const members = [plate, person('p1'), person('p2')]
    const platePhraseIt = ncSubjectText(IT, plate)
    const platePhraseEn = ncSubjectText(EN, plate)
    expect(platePhraseIt).toContain('AB123CD')
    expect(platePhraseIt).not.toBe('AB123CD')
    expect(ncGroupSubjectText(IT, { members })).toBe(`${platePhraseIt} e 2 altre persone`)
    expect(ncGroupSubjectText(EN, { members })).toBe(`${platePhraseEn} and 2 other people`)
  })

  it('an UNATTRIBUTED label is counted, not named — sentence order = tile order (§6.2)', () => {
    const members = [person('a', 'Person A'), { className: 'person', label: 'courier' }]
    expect(ncGroupSubjectText(IT, { members })).toBe('Person A e 1 altra persona')
  })

  it('the operator scenario reads "Person A e 1 altra persona" (D692 §6.4)', () => {
    const members = [person('a', 'Person A'), person('b')]
    expect(ncGroupSubjectText(IT, { members })).toBe('Person A e 1 altra persona')
    expect(ncGroupSubjectText(EN, { members })).toBe('Person A and 1 other person')
  })

  it('honours an explicit name cap', () => {
    const members = [person('a', 'Bob'), person('b', 'Dave'), person('c', 'Carol')]
    expect(ncGroupSubjectText(IT, { members, maxNames: 1 })).toBe('Bob e 2 altre persone')
  })
})
