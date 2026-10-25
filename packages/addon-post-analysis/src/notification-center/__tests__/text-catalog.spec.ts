/**
 * NcTextCatalog — resolution chain, plural selection, list joins and the
 * DEPTH BOUND that keeps a composite from re-entering the renderer.
 *
 * The chain under test, in order: a rule's own template → the hub override for
 * the active language → the shipped file for that language → the shipped
 * English file. Every step is asserted with a case that FAILS if the step above
 * it is skipped, because a fallback chain that is never exercised is a chain
 * nobody knows the order of.
 */

import { describe, expect, it } from 'vitest'
import { NC_LANGUAGES, NC_TEXT_BUNDLES, NcTextCatalog, type NcTextBundle } from '../text-catalog.js'

describe('NcTextCatalog — shipped bundles', () => {
  it('defaults to English and reads the shipped file', () => {
    const texts = new NcTextCatalog()
    expect(texts.language).toBe('en')
    expect(texts.raw('detection.body')).toBe('{{subject}} on {{camera}}{{inZones}}')
  })

  it('ships exactly the two languages, both non-empty', () => {
    expect([...NC_LANGUAGES]).toEqual(['en', 'it'])
    for (const lang of NC_LANGUAGES) {
      expect(Object.keys(NC_TEXT_BUNDLES[lang]).length).toBeGreaterThan(50)
    }
  })

  it('serves the Italian file when the hub language is it', () => {
    const texts = new NcTextCatalog({ language: 'it' })
    expect(texts.raw('detection.body')).toBe('{{subject}} su {{camera}}{{inZones}}')
  })
})

describe('NcTextCatalog — plural selection', () => {
  it('picks the English variant by Intl.PluralRules at 0 / 1 / N', () => {
    const texts = new NcTextCatalog()
    expect(texts.raw('class.person', 0)).toBe('people')
    expect(texts.raw('class.person', 1)).toBe('person')
    expect(texts.raw('class.person', 4)).toBe('people')
  })

  it('picks the Italian variant by Intl.PluralRules at 0 / 1 / N', () => {
    const texts = new NcTextCatalog({ language: 'it' })
    expect(texts.raw('class.person', 0)).toBe('persone')
    expect(texts.raw('class.person', 1)).toBe('persona')
    expect(texts.raw('class.person', 4)).toBe('persone')
  })

  it('falls back to `other` when no count is supplied', () => {
    expect(new NcTextCatalog().raw('class.person')).toBe('people')
  })

  it('renders the count into a plural phrase, in both languages', () => {
    const enTexts = new NcTextCatalog()
    const itTexts = new NcTextCatalog({ language: 'it' })
    expect(
      enTexts.text({ key: 'timelapse.body.denseRanges', count: 1, vars: { events: '1' } }),
    ).toBe('1 stretch filmed at a dense cadence')
    expect(
      enTexts.text({ key: 'timelapse.body.denseRanges', count: 3, vars: { events: '3' } }),
    ).toBe('3 stretches filmed at a dense cadence')
    expect(
      itTexts.text({ key: 'timelapse.body.denseRanges', count: 1, vars: { events: '1' } }),
    ).toBe('1 intervallo ripreso a cadenza fitta')
    expect(
      itTexts.text({ key: 'timelapse.body.denseRanges', count: 3, vars: { events: '3' } }),
    ).toBe('3 intervalli ripresi a cadenza fitta')
  })
})

describe('NcTextCatalog — resolution order', () => {
  it('a hub override BEATS the shipped file for that language', () => {
    const texts = new NcTextCatalog({
      language: 'it',
      overrides: { it: { 'occupancy.op.free': 'vuota' } },
    })
    expect(texts.raw('occupancy.op.free')).toBe('vuota')
    // …and leaves every other key alone.
    expect(texts.raw('occupancy.op.occupied')).toBe('occupata')
  })

  it('an override for ANOTHER language is not read', () => {
    const texts = new NcTextCatalog({
      language: 'en',
      overrides: { it: { 'occupancy.op.free': 'vuota' } },
    })
    expect(texts.raw('occupancy.op.free')).toBe('free')
  })

  it('a rule template WINS over every catalog layer', () => {
    const texts = new NcTextCatalog({
      language: 'it',
      overrides: { it: { 'detection.body': 'override' } },
    })
    expect(
      texts.text({
        key: 'detection.body',
        template: 'mio testo {{camera}}',
        vars: { camera: 'Gate' },
      }),
    ).toBe('mio testo Gate')
  })

  it('a BLANK rule template is not a template — the catalog answers', () => {
    const texts = new NcTextCatalog()
    expect(texts.text({ key: 'occupancy.op.free', template: '   ' })).toBe('free')
  })

  it('falls back to the English file when the language file lacks the key', () => {
    // The CI guard forbids this state in the shipped files, so it is exercised
    // with bundles that reproduce it — the chain must still have the step, for
    // the day a locale pack ships incomplete.
    const bundles: Readonly<Record<'en' | 'it', NcTextBundle>> = {
      en: { 'only.in.en': 'English text' },
      it: {},
    }
    const texts = new NcTextCatalog({ language: 'it', bundles })
    expect(texts.raw('only.in.en')).toBe('English text')
  })

  it('answers null for a key no bundle carries, and renders it empty', () => {
    const texts = new NcTextCatalog()
    expect(texts.raw('no.such.key')).toBeNull()
    expect(texts.text({ key: 'no.such.key' })).toBe('')
    expect(texts.has('no.such.key')).toBe(false)
    expect(texts.has('detection.body')).toBe(true)
  })
})

describe('NcTextCatalog — rendering', () => {
  it('renders a missing var EMPTY, never the braces', () => {
    const texts = new NcTextCatalog()
    expect(texts.text({ key: 'detection.body', vars: { camera: 'Gate' } })).toBe(' on Gate')
  })

  it('does NOT re-render an injected value — the depth bound', () => {
    // A var whose VALUE looks like a placeholder is injected verbatim. This is
    // the property that makes "composites first, then one pass" safe: a
    // composite can never smuggle a second substitution round.
    const texts = new NcTextCatalog()
    expect(
      texts.text({
        key: 'detection.body',
        vars: { subject: '{{camera}}', camera: 'Gate', inZones: '' },
      }),
    ).toBe('{{camera}} on Gate')
  })

  it('applies a new snapshot in place', () => {
    const texts = new NcTextCatalog()
    expect(texts.raw('occupancy.op.free')).toBe('free')
    texts.apply({ language: 'it', overrides: {} })
    expect(texts.language).toBe('it')
    expect(texts.raw('occupancy.op.free')).toBe('libera')
    expect(texts.snapshot).toEqual({ language: 'it', overrides: {} })
  })
})

describe('NcTextCatalog — list joins', () => {
  it('joins 1 / 2 / 3 items with the language conjunction', () => {
    const enTexts = new NcTextCatalog()
    const itTexts = new NcTextCatalog({ language: 'it' })
    expect(enTexts.join([])).toBe('')
    expect(enTexts.join(['1 person'])).toBe('1 person')
    expect(enTexts.join(['1 person', '2 vehicles'])).toBe('1 person and 2 vehicles')
    expect(enTexts.join(['1 person', '2 vehicles', '3 animals'])).toBe(
      '1 person, 2 vehicles, and 3 animals',
    )
    expect(itTexts.join(['1 persona'])).toBe('1 persona')
    expect(itTexts.join(['1 persona', '2 veicoli'])).toBe('1 persona e 2 veicoli')
    expect(itTexts.join(['1 persona', '2 veicoli', '3 animali'])).toBe(
      '1 persona, 2 veicoli e 3 animali',
    )
  })
})
