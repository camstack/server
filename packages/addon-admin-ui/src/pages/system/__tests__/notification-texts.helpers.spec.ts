/**
 * The Texts tab's pure half.
 *
 * `addons.custom` is `z.unknown()` at the cap boundary, so everything the tab
 * believes about the reply is decided in `parseTextCatalog` — and a hub that
 * has not been deployed yet is the NORMAL case for a freshly shipped admin
 * bundle, not an edge one. These pin:
 *
 *  - a malformed / partial / old reply narrows to `null`, so the tab can say
 *    "not available" instead of rendering `undefined` into a text box an
 *    operator would then save;
 *  - a locale a newer hub ships and this bundle does not is SKIPPED, not fatal;
 *  - the draft → patch translation, whose one real rule is that a draft equal
 *    to the shipped text is a RESET, never a stored copy of the shipped text.
 */
import { describe, expect, it } from 'vitest'
import {
  buildOverridePatch,
  countPendingEdits,
  draftValue,
  filterTextEntries,
  parseTextCatalog,
  pluralWarning,
  type TextEntry,
  textsKeyVars,
} from '../notification-texts.helpers'

function entry(over: Partial<TextEntry> = {}): TextEntry {
  return {
    key: 'detection.body',
    shipped: '{{subject}} on {{camera}}',
    shippedLanguage: 'en',
    override: null,
    effective: '{{subject}} on {{camera}}',
    source: 'shipped',
    placeholders: ['subject', 'camera'],
    pluralCategories: [],
    ...over,
  }
}

function catalog(entries: readonly TextEntry[] = [entry()]): Record<string, unknown> {
  return { language: 'en', activeLanguage: 'en', languages: ['en', 'it'], entries }
}

describe('parseTextCatalog', () => {
  it('accepts a well-formed reply', () => {
    const parsed = parseTextCatalog(catalog())
    expect(parsed?.language).toBe('en')
    expect(parsed?.entries).toHaveLength(1)
    expect(parsed?.entries[0]?.key).toBe('detection.body')
  })

  it('accepts an entry carrying an override', () => {
    const parsed = parseTextCatalog(catalog([entry({ override: 'x', source: 'override' })]))
    expect(parsed?.entries[0]?.override).toBe('x')
  })

  it.each([
    ['nothing at all', undefined],
    ['a string', 'nope'],
    ['an array', []],
    ['an error envelope', { error: 'boom' }],
  ])('narrows %s to null', (_label, raw) => {
    expect(parseTextCatalog(raw)).toBeNull()
  })

  it('rejects a reply with no entries array', () => {
    expect(parseTextCatalog({ language: 'en', activeLanguage: 'en', languages: ['en'] })).toBeNull()
  })

  it('rejects an unknown active language rather than guessing', () => {
    expect(parseTextCatalog({ ...catalog(), activeLanguage: 'de' })).toBeNull()
  })

  it('rejects a row missing its provenance — the tab would show a lie', () => {
    const broken = { ...entry(), source: undefined }
    expect(parseTextCatalog(catalog([broken as unknown as TextEntry]))).toBeNull()
  })

  it('rejects a row whose override is neither a string nor null', () => {
    const broken = { ...entry(), override: 7 }
    expect(parseTextCatalog(catalog([broken as unknown as TextEntry]))).toBeNull()
  })

  it('SKIPS a locale this bundle does not know instead of blanking the tab', () => {
    const parsed = parseTextCatalog({ ...catalog(), languages: ['en', 'it', 'de'] })
    expect(parsed?.languages).toEqual(['en', 'it'])
  })
})

describe('draftValue', () => {
  it('shows the shipped text when nothing is overridden or typed', () => {
    expect(draftValue(entry(), new Map())).toBe('{{subject}} on {{camera}}')
  })

  it('shows the stored override over the shipped text', () => {
    expect(draftValue(entry({ override: 'mine' }), new Map())).toBe('mine')
  })

  it('shows the operator draft over everything', () => {
    expect(draftValue(entry({ override: 'mine' }), new Map([['detection.body', 'typing']]))).toBe(
      'typing',
    )
  })

  it('a deliberately emptied box stays empty — it is not re-filled under the cursor', () => {
    expect(draftValue(entry({ override: 'mine' }), new Map([['detection.body', '']]))).toBe('')
  })
})

describe('buildOverridePatch', () => {
  const rows = [
    entry(),
    entry({ key: 'detection.title', shipped: '{{rule}}', placeholders: ['rule'] }),
  ]

  it('an untouched table sends nothing', () => {
    expect(buildOverridePatch(rows, new Map())).toEqual({})
  })

  it('sends a new override', () => {
    expect(buildOverridePatch(rows, new Map([['detection.title', 'Alert']]))).toEqual({
      'detection.title': 'Alert',
    })
  })

  it('a blank box RESETS the key', () => {
    const withOverride = [entry({ override: 'mine', source: 'override' })]
    expect(buildOverridePatch(withOverride, new Map([['detection.body', '   ']]))).toEqual({
      'detection.body': null,
    })
  })

  it('typing the shipped text back in RESETS — it is not stored as an override', () => {
    const withOverride = [entry({ override: 'mine', source: 'override' })]
    expect(
      buildOverridePatch(withOverride, new Map([['detection.body', '{{subject}} on {{camera}}']])),
    ).toEqual({ 'detection.body': null })
  })

  it('a draft equal to the stored override is not sent at all', () => {
    const withOverride = [entry({ override: 'mine', source: 'override' })]
    expect(buildOverridePatch(withOverride, new Map([['detection.body', 'mine']]))).toEqual({})
  })

  it('clearing a key that was never overridden sends nothing', () => {
    expect(buildOverridePatch(rows, new Map([['detection.body', '']]))).toEqual({})
  })

  it('keeps meaningful leading whitespace — " in {{zones}}" must not be trimmed', () => {
    const zones = [entry({ key: 'detection.inZones', shipped: ' in {{zones}}' })]
    expect(buildOverridePatch(zones, new Map([['detection.inZones', ' a {{zones}}']]))).toEqual({
      'detection.inZones': ' a {{zones}}',
    })
  })

  it('a draft for a key not on the current page is ignored', () => {
    // The search box narrows the rows; a stale draft from a previous filter
    // must not be resurrected by a save.
    expect(buildOverridePatch([rows[0] as TextEntry], new Map([['other.key', 'x']]))).toEqual({})
  })

  it('counts exactly what it would send', () => {
    const drafts = new Map([
      ['detection.title', 'Alert'],
      ['detection.body', '{{subject}} on {{camera}}'],
    ])
    expect(countPendingEdits(rows, drafts)).toBe(1)
  })
})

describe('filterTextEntries', () => {
  const rows = [
    entry({ key: 'detection.body', shipped: '{{subject}} on {{camera}}' }),
    entry({ key: 'class.person', shipped: 'people' }),
    entry({ key: 'system.camera.offline', shipped: '{{camera}} went offline', override: 'giù' }),
  ]

  it('an empty query keeps everything', () => {
    expect(filterTextEntries(rows, '   ')).toHaveLength(3)
  })

  it('matches the key', () => {
    expect(filterTextEntries(rows, 'class').map((e) => e.key)).toEqual(['class.person'])
  })

  it('matches the shipped text, case-insensitively', () => {
    expect(filterTextEntries(rows, 'PEOPLE').map((e) => e.key)).toEqual(['class.person'])
  })

  it('matches the override — a customised row must be findable by its new words', () => {
    expect(filterTextEntries(rows, 'giù').map((e) => e.key)).toEqual(['system.camera.offline'])
  })

  it('two words NARROW: every one must match', () => {
    expect(filterTextEntries(rows, 'camera offline').map((e) => e.key)).toEqual([
      'system.camera.offline',
    ])
  })
})

describe('textsKeyVars', () => {
  it("the Texts tab builds its chips from the key's own placeholders", () => {
    expect(textsKeyVars({ placeholders: ['camera', 'rule'] } as const).map((d) => d.name)).toEqual([
      'camera',
      'rule',
    ])
  })

  it('a key with no placeholders offers no chips', () => {
    expect(textsKeyVars({ placeholders: [] })).toEqual([])
  })
})

describe('the per-key plural warning', () => {
  it('warns that an override flattens a plural', () => {
    expect(pluralWarning(entry({ pluralCategories: ['one', 'other'] }))).toContain('one, other')
  })

  it('says nothing about plurals on a flat key', () => {
    expect(pluralWarning(entry())).toBeNull()
  })
})
