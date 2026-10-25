/**
 * The catalog's EDIT-SURFACE projection (Phase 2) — pure.
 *
 * Phase 1 built a chain that resolves ONE key at a time and answers a finished
 * string. An editor needs the opposite: every key at once, each one carrying
 * WHICH layer answered it, so an operator can see at a glance what he has
 * changed and what is still the shipped wording. These tests pin exactly that:
 *
 *  - provenance is reported, not guessed — `shipped` / `fallback` / `override`;
 *  - the override layer WINS and says so, and the shipped text is still carried
 *    alongside it (otherwise "reset to shipped" has nothing to reset TO);
 *  - a plural key flattens to its `other` variant and DECLARES its categories,
 *    because a single text box cannot express a plural and an operator must be
 *    told that before he flattens one by accident;
 *  - placeholders are derived from the SHIPPED text — they are the producer's
 *    vocabulary, not the operator's, and a legend built from an override would
 *    shrink every time someone dropped a variable;
 *  - the patch is a PATCH: `null` and blank both mean "reset to shipped", a
 *    language whose last override was reset loses its key entirely, and nothing
 *    is ever mutated in place.
 */

import { describe, expect, it } from 'vitest'
import { templatePlaceholders } from '../render-template.js'
import type { NcTextBundle, NcTextOverrides } from '../text-catalog.js'
import {
  applyNcTextOverridePatch,
  buildNcTextCatalogView,
  unknownNcTextKeys,
} from '../text-catalog-view.js'

const BUNDLES: Readonly<Record<'en' | 'it', NcTextBundle>> = {
  en: {
    'detection.body': '{{subject}} on {{camera}}{{inZones}}',
    'detection.inZones': ' in {{zones}}',
    'class.person': { one: 'person', other: 'people' },
    'system.only.en': 'English only',
  },
  it: {
    'detection.body': '{{subject}} su {{camera}}{{inZones}}',
    'detection.inZones': ' in {{zones}}',
    'class.person': { one: 'persona', other: 'persone' },
  },
}

function view(language: 'en' | 'it', overrides: NcTextOverrides = {}) {
  return buildNcTextCatalogView({
    language,
    activeLanguage: 'it',
    overrides,
    bundles: BUNDLES,
  })
}

function entry(language: 'en' | 'it', key: string, overrides: NcTextOverrides = {}) {
  const found = view(language, overrides).entries.find((e) => e.key === key)
  if (found === undefined) throw new Error(`no entry for ${key}`)
  return found
}

describe('templatePlaceholders', () => {
  it('lists every {{var}} once, in order of first appearance', () => {
    expect(templatePlaceholders('{{a}} and {{b}} and {{a}}')).toEqual(['a', 'b'])
  })

  it('answers empty for a text with no variables', () => {
    expect(templatePlaceholders('visit ended')).toEqual([])
  })

  it('tolerates the spaced form the renderer accepts', () => {
    expect(templatePlaceholders('{{ camera }}')).toEqual(['camera'])
  })
})

describe('buildNcTextCatalogView', () => {
  it('carries the viewed language, the ACTIVE one, and every shipped language', () => {
    const v = view('en')
    expect(v.language).toBe('en')
    expect(v.activeLanguage).toBe('it')
    expect(v.languages).toEqual(['en', 'it'])
  })

  it('covers every key of every bundle — a locale-only key is not lost', () => {
    expect(view('it').entries.map((e) => e.key)).toEqual([
      'detection.body',
      'detection.inZones',
      'class.person',
      'system.only.en',
    ])
  })

  it("a key the language ships reads from that language's file", () => {
    const e = entry('it', 'detection.body')
    expect(e.shipped).toBe('{{subject}} su {{camera}}{{inZones}}')
    expect(e.shippedLanguage).toBe('it')
    expect(e.source).toBe('shipped')
    expect(e.override).toBeNull()
    expect(e.effective).toBe(e.shipped)
  })

  it('a key the language does NOT ship falls back to English and SAYS so', () => {
    const e = entry('it', 'system.only.en')
    expect(e.shipped).toBe('English only')
    expect(e.shippedLanguage).toBe('en')
    expect(e.source).toBe('fallback')
  })

  it('an override wins, is reported as such, and keeps the shipped text beside it', () => {
    const e = entry('it', 'detection.body', { it: { 'detection.body': 'ciao' } })
    expect(e.effective).toBe('ciao')
    expect(e.override).toBe('ciao')
    expect(e.source).toBe('override')
    // The reset target — without it the row has nothing to go back to.
    expect(e.shipped).toBe('{{subject}} su {{camera}}{{inZones}}')
  })

  it("another language's override never leaks into this one", () => {
    const e = entry('it', 'detection.body', { en: { 'detection.body': 'hello' } })
    expect(e.override).toBeNull()
    expect(e.source).toBe('shipped')
  })

  it('a plural key flattens to `other` and declares its categories', () => {
    const e = entry('it', 'class.person')
    expect(e.shipped).toBe('persone')
    expect(e.pluralCategories).toEqual(['one', 'other'])
  })

  it('a flat key declares no categories', () => {
    expect(entry('it', 'detection.inZones').pluralCategories).toEqual([])
  })

  it('placeholders come from the SHIPPED text, not from the override', () => {
    const e = entry('it', 'detection.body', { it: { 'detection.body': 'niente' } })
    expect(e.placeholders).toEqual(['subject', 'camera', 'inZones'])
  })

  it('a plural key advertises the union of its variants placeholders', () => {
    const v = buildNcTextCatalogView({
      language: 'en',
      activeLanguage: 'en',
      overrides: {},
      bundles: {
        en: { 'x.plural': { one: '{{a}} thing', other: '{{a}} things in {{b}}' } },
        it: {},
      },
    })
    expect(v.entries[0]?.placeholders).toEqual(['a', 'b'])
  })
})

describe('unknownNcTextKeys', () => {
  it('answers the keys no bundle carries', () => {
    expect(unknownNcTextKeys(['detection.body', 'nope', 'system.only.en'], BUNDLES)).toEqual([
      'nope',
    ])
  })

  it('a key only one language ships is KNOWN', () => {
    expect(unknownNcTextKeys(['system.only.en'], BUNDLES)).toEqual([])
  })
})

describe('applyNcTextOverridePatch', () => {
  it('adds a key without touching the other language', () => {
    const before: NcTextOverrides = { en: { 'detection.body': 'hello' } }
    const after = applyNcTextOverridePatch(before, 'it', { 'detection.body': 'ciao' })
    expect(after).toEqual({
      en: { 'detection.body': 'hello' },
      it: { 'detection.body': 'ciao' },
    })
  })

  it('never mutates what it was given', () => {
    const before: NcTextOverrides = { it: { 'detection.body': 'ciao' } }
    applyNcTextOverridePatch(before, 'it', { 'detection.inZones': ' a {{zones}}' })
    expect(before).toEqual({ it: { 'detection.body': 'ciao' } })
  })

  it('null resets one key to the shipped text', () => {
    const before: NcTextOverrides = { it: { a: '1', b: '2' } }
    expect(applyNcTextOverridePatch(before, 'it', { a: null })).toEqual({ it: { b: '2' } })
  })

  it('a blank value resets too — a blank override would render nothing at all', () => {
    const before: NcTextOverrides = { it: { a: '1', b: '2' } }
    expect(applyNcTextOverridePatch(before, 'it', { b: '   ' })).toEqual({ it: { a: '1' } })
  })

  it('a value with meaningful leading space is kept VERBATIM', () => {
    // `detection.inZones` ships as " in {{zones}}" — trimming it would glue the
    // fragment to the word before it in every notification that uses it.
    const after = applyNcTextOverridePatch({}, 'it', { 'detection.inZones': ' a {{zones}}' })
    expect(after).toEqual({ it: { 'detection.inZones': ' a {{zones}}' } })
  })

  it('the language disappears once its last override is reset', () => {
    const before: NcTextOverrides = { it: { a: '1' } }
    expect(applyNcTextOverridePatch(before, 'it', { a: null })).toEqual({})
  })

  it('resetting a key that was never overridden is a no-op, not an error', () => {
    expect(applyNcTextOverridePatch({}, 'en', { a: null })).toEqual({})
  })

  it('applies adds and resets in one pass', () => {
    const before: NcTextOverrides = { it: { a: '1', b: '2' } }
    expect(applyNcTextOverridePatch(before, 'it', { a: null, c: '3' })).toEqual({
      it: { b: '2', c: '3' },
    })
  })
})
