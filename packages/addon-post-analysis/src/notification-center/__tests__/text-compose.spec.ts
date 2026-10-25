/**
 * The composite variables — the ONE level of composition the catalog allows.
 *
 * Each is a phrase built from fragment keys and injected into the final render
 * as a plain string: `{{subject}}`, `{{inZones}}`, `{{op}}` and
 * `{{detectionSummary}}`. The tests below pin (a) the words in both languages,
 * (b) the plural category chosen by the LANGUAGE's rules and not by `n === 1`,
 * (c) the `class.other` fallback for a class no locale names, and (d) the depth
 * bound: a fragment cannot reach a composite, and a composite is never
 * re-scanned.
 */

import { describe, expect, it } from 'vitest'
import { NcTextCatalog } from '../text-catalog.js'
import {
  ncClassNoun,
  ncDetectionSummary,
  ncInZonesText,
  ncOccupancyOp,
  ncSentenceCaseBody,
  ncSubjectText,
} from '../text-compose.js'

const enTexts = (): NcTextCatalog => new NcTextCatalog()
const itTexts = (): NcTextCatalog => new NcTextCatalog({ language: 'it' })

describe('ncClassNoun', () => {
  it('names a known class, singular and plural, in both languages', () => {
    expect(ncClassNoun(enTexts(), 'person', 1)).toBe('person')
    expect(ncClassNoun(enTexts(), 'person', 3)).toBe('people')
    expect(ncClassNoun(itTexts(), 'person', 1)).toBe('persona')
    expect(ncClassNoun(itTexts(), 'person', 3)).toBe('persone')
    expect(ncClassNoun(itTexts(), 'vehicle', 2)).toBe('veicoli')
    expect(ncClassNoun(itTexts(), 'car', 1)).toBe('auto')
  })

  it('normalises case and whitespace before looking a class up', () => {
    expect(ncClassNoun(enTexts(), '  Person ', 1)).toBe('person')
  })

  it('uses EVENT_KIND_LABELS (lowercased for NC) when the NC catalog has no class.* key', () => {
    // `cat` is a taxonomy sub, not a `class.cat` fragment — same map the
    // viewer filters speak, folded to lowercase for notification placeholders.
    expect(ncClassNoun(enTexts(), 'cat', 1)).toBe('cat')
    expect(ncClassNoun(itTexts(), 'cat', 1)).toBe('gatto')
  })

  it('falls back to class.other — the RAW name — for an unknown class', () => {
    expect(ncClassNoun(enTexts(), 'forklift', 1)).toBe('forklift')
    expect(ncClassNoun(itTexts(), 'forklift', 5)).toBe('forklift')
  })

  it('renders an empty class as the empty string, never a stray noun', () => {
    expect(ncClassNoun(enTexts(), '', 1)).toBe('')
  })
})

describe('ncSubjectText', () => {
  it('is the class noun, and gains the label in parentheses when there is one', () => {
    expect(ncSubjectText(enTexts(), { className: 'person' })).toBe('person')
    expect(ncSubjectText(enTexts(), { className: 'person', label: 'John' })).toBe('person (John)')
    expect(ncSubjectText(itTexts(), { className: 'person', label: 'John' })).toBe('persona (John)')
  })

  it('promotes a classification label to the subject noun (not class (species))', () => {
    // animal-classifier writes subLabel `cat` with no labelKind — the species
    // replaces the coarse class rather than sitting in parentheses beside it.
    expect(ncSubjectText(enTexts(), { className: 'animal', label: 'cat' })).toBe('cat')
    expect(ncSubjectText(itTexts(), { className: 'animal', label: 'cat' })).toBe('gatto')
    expect(ncSubjectText(itTexts(), { className: 'animal', label: 'dog' })).toBe('cane')
  })

  it('leaves a recognised identity / plate verbatim', () => {
    expect(
      ncSubjectText(itTexts(), { className: 'person', label: 'Mario', labelKind: 'identity' }),
    ).toBe('Mario')
    expect(
      ncSubjectText(itTexts(), { className: 'vehicle', label: 'AB123CD', labelKind: 'plate' }),
    ).toBe('veicolo AB123CD')
  })

  it('is singular — one detection is one subject', () => {
    expect(ncSubjectText(itTexts(), { className: 'vehicle' })).toBe('veicolo')
  })
})

describe('ncInZonesText', () => {
  it('is EMPTY with no zones, so the body never ends in a dangling preposition', () => {
    expect(ncInZonesText(enTexts(), [])).toBe('')
  })

  it('carries its own leading space, in both languages', () => {
    expect(ncInZonesText(enTexts(), ['gate'])).toBe(' in gate')
    expect(ncInZonesText(enTexts(), ['gate', 'drive'])).toBe(' in gate, drive')
    expect(ncInZonesText(itTexts(), ['cancello'])).toBe(' in cancello')
  })
})

describe('ncOccupancyOp', () => {
  it('is the edge polarity, in the hub language', () => {
    expect(ncOccupancyOp(enTexts(), true)).toBe('occupied')
    expect(ncOccupancyOp(enTexts(), false)).toBe('free')
    expect(ncOccupancyOp(itTexts(), true)).toBe('occupata')
    expect(ncOccupancyOp(itTexts(), false)).toBe('libera')
  })
})

describe('ncSentenceCaseBody', () => {
  it('lifts only the first letter — catalogs stay lowercase', () => {
    expect(ncSentenceCaseBody('gatto su camera front door in aiuola')).toBe(
      'Gatto su camera front door in aiuola',
    )
    expect(ncSentenceCaseBody('Animale su front door')).toBe('Animale su front door')
    expect(ncSentenceCaseBody('')).toBe('')
  })
})

describe('ncDetectionSummary', () => {
  it('is empty when nothing was counted', () => {
    expect(ncDetectionSummary(enTexts(), [])).toBe('')
    expect(ncDetectionSummary(enTexts(), [{ className: 'person', count: 0 }])).toBe('')
  })

  it('joins 1 / 2 / 3 classes with the language conjunction', () => {
    const counts = [
      { className: 'person', count: 1 },
      { className: 'vehicle', count: 2 },
      { className: 'animal', count: 3 },
    ]
    expect(ncDetectionSummary(itTexts(), counts.slice(0, 1))).toBe('1 persona')
    expect(ncDetectionSummary(itTexts(), counts.slice(0, 2))).toBe('1 persona e 2 veicoli')
    expect(ncDetectionSummary(itTexts(), counts)).toBe('1 persona, 2 veicoli e 3 animali')
    expect(ncDetectionSummary(enTexts(), counts)).toBe('1 person, 2 vehicles, and 3 animals')
  })

  it('drops the zero classes and keeps the order it was given', () => {
    expect(
      ncDetectionSummary(itTexts(), [
        { className: 'vehicle', count: 3 },
        { className: 'person', count: 0 },
        { className: 'animal', count: 1 },
      ]),
    ).toBe('3 veicoli e 1 animale')
  })

  it('keeps an unnamed class in the count, under its raw name', () => {
    expect(ncDetectionSummary(enTexts(), [{ className: 'forklift', count: 2 }])).toBe('2 forklift')
  })
})

describe('the depth bound', () => {
  it('a fragment that names a COMPOSITE renders it empty — composites are not fragment vars', () => {
    const texts = new NcTextCatalog({
      overrides: { en: { 'detection.subject': '{{classNoun}}{{inZones}}' } },
    })
    expect(ncSubjectText(texts, { className: 'person' })).toBe('person')
  })

  it('a class noun cannot reach the scalar vocabulary either', () => {
    const texts = new NcTextCatalog({
      overrides: { en: { 'class.person': 'person on {{camera}}' } },
    })
    expect(ncClassNoun(texts, 'person', 1)).toBe('person on ')
  })

  it('a composite whose value LOOKS like a placeholder survives verbatim', () => {
    const texts = new NcTextCatalog({ overrides: { en: { 'class.other': '{{name}}' } } })
    // `{{camera}}` is the class NAME here — it resolves through `{{name}}` once
    // and is then a plain string forever.
    expect(ncClassNoun(texts, '{{camera}}', 1)).toBe('{{camera}}')
  })
})
