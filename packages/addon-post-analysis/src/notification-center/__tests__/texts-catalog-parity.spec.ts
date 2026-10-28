/**
 * The notification text catalogs: Italian must carry exactly the English keys,
 * the same placeholders, and no sentence left in English. A string identical to
 * its English twin is allowed only when it holds no words of its own (pure
 * placeholders and punctuation) or is a named loanword below.
 */
import { describe, expect, it } from 'vitest'

import en from '../texts/en.json'
import it_ from '../texts/it.json'

type CatalogValue = string | { readonly [form: string]: CatalogValue }
type Catalog = Readonly<Record<string, CatalogValue>>

/** Plural-form objects become `key.form` entries so every string is compared. */
function flatten(catalog: Catalog): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = (prefix: string, value: CatalogValue): void => {
    if (typeof value === 'string') {
      out[prefix] = value
      return
    }
    for (const [form, inner] of Object.entries(value)) walk(`${prefix}.${form}`, inner)
  }
  for (const [key, value] of Object.entries(catalog)) walk(key, value)
  return out
}

const EN = flatten(en)
const IT = flatten(it_)

/**
 * Keys whose Italian text may equal the English one: `in` is the same word in
 * both languages, and the singular `camera` is the loanword the plural
 * (`camere`) is built on.
 */
const LOANWORD_ALLOW_LIST: readonly string[] = ['detection.inZones', 'summary.body.cameras.one']

/** The keys that once shipped untranslated; each must now differ. */
const FORMERLY_ENGLISH: readonly string[] = [
  'system.device-offline.title',
  'system.stream-offline.title',
  'system.storage-location-ok.title',
  'timelapse.title',
  'summary.line.wrapper-update',
  'test.prefix',
]

function placeholders(text: string): readonly string[] {
  return (text.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? []).toSorted()
}

function hasOwnWords(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\{\{[^}]*\}\}/g, ''))
}

describe('notification texts catalogs', () => {
  it('it.json carries exactly the keys of en.json', () => {
    expect(Object.keys(IT).toSorted()).toEqual(Object.keys(EN).toSorted())
  })

  it('every key keeps its placeholders', () => {
    for (const key of Object.keys(EN)) {
      expect(placeholders(IT[key] ?? ''), key).toEqual(placeholders(EN[key] ?? ''))
    }
  })

  it('no Italian text with words of its own is left identical to English', () => {
    const untranslated = Object.keys(EN).filter(
      (key) =>
        EN[key] === IT[key] && hasOwnWords(EN[key] ?? '') && !LOANWORD_ALLOW_LIST.includes(key),
    )
    expect(untranslated).toEqual([])
  })

  it('the formerly English labels are translated', () => {
    for (const key of FORMERLY_ENGLISH) {
      expect(IT[key], key).not.toBe(EN[key])
    }
  })
})
