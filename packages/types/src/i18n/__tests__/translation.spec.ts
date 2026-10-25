import { describe, expect, it } from 'vitest'
import { CamstackError, readErrorI18n, userError } from '../camstack-error.js'
import {
  CatalogFileSchema,
  interpolate,
  localizeConfigTree,
  splitTranslationRef,
  type CatalogLookup,
} from '../translation.js'

const IT: Record<string, string> = {
  'demo:host.label': 'Server',
  'demo:host.description': 'Nome host o IP',
  'demo:sec.title': 'Connessione',
}
const lookupIt: CatalogLookup = (ns, key) => IT[`${ns}:${key}`]

describe('interpolate', () => {
  it('fills known placeholders and leaves unknown ones as written', () => {
    expect(interpolate('Device {id} on {node}', { id: 7 })).toBe('Device 7 on {node}')
    expect(interpolate('no params {id}')).toBe('no params {id}')
  })
})

describe('splitTranslationRef', () => {
  it('splits ns:key and refuses a bare key', () => {
    expect(splitTranslationRef('reolink:creation.host.label')).toEqual({
      ns: 'reolink',
      key: 'creation.host.label',
    })
    expect(splitTranslationRef('nokey')).toBeNull()
    expect(splitTranslationRef(':x')).toBeNull()
    expect(splitTranslationRef('x:')).toBeNull()
  })
})

describe('CatalogFileSchema', () => {
  it('accepts a flat string map and rejects anything else', () => {
    expect(CatalogFileSchema.safeParse({ a: 'b' }).success).toBe(true)
    expect(CatalogFileSchema.safeParse({ a: { b: 'c' } }).success).toBe(false)
    expect(CatalogFileSchema.safeParse(['a']).success).toBe(false)
  })
})

describe('localizeConfigTree', () => {
  const schema = {
    sections: [
      {
        id: 'sec',
        title: 'Connection',
        titleKey: 'demo:sec.title',
        fields: [
          {
            key: 'host',
            label: 'Server',
            labelKey: 'demo:host.label',
            description: 'Host name or IP',
            descriptionKey: 'demo:host.description',
          },
          { key: 'port', label: 'Port', labelKey: 'demo:port.label' },
          { key: 'legacy', label: 'Legacy' },
        ],
      },
    ],
  }

  it('substitutes every key the catalog holds', () => {
    const out = localizeConfigTree(schema, lookupIt)
    expect(JSON.stringify(out)).toContain('"title":"Connessione"')
    expect(JSON.stringify(out)).toContain('"description":"Nome host o IP"')
  })

  it('keeps the English text for an unknown key and for a field without keys', () => {
    const out = JSON.stringify(localizeConfigTree(schema, lookupIt))
    expect(out).toContain('"label":"Port"')
    expect(out).toContain('"label":"Legacy"')
  })

  it('returns the same object when nothing resolves, and never mutates the input', () => {
    const before = JSON.stringify(schema)
    expect(localizeConfigTree(schema, () => undefined)).toBe(schema)
    localizeConfigTree(schema, lookupIt)
    expect(JSON.stringify(schema)).toBe(before)
  })
})

describe('CamstackError', () => {
  it('is an Error whose message is the English fallback', () => {
    const err = userError('device.not-found', { id: 3 }, 'Device 3 not found')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CamstackError)
    expect(err.message).toBe('Device 3 not found')
  })

  it('is found through a cause chain, by duck typing', () => {
    const inner = userError('auth.admin-required', undefined, 'Admin required')
    const outer = new Error('wrapped', { cause: inner })
    expect(readErrorI18n(outer)).toEqual({ code: 'auth.admin-required' })
    expect(readErrorI18n({ i18nCode: 'a.b', i18nParams: { n: 1 } })).toEqual({
      code: 'a.b',
      params: { n: 1 },
    })
  })

  it('ignores errors without a well-formed code', () => {
    expect(readErrorI18n(new Error('plain'))).toBeNull()
    expect(readErrorI18n({ i18nCode: 'NOT A CODE' })).toBeNull()
    expect(readErrorI18n(null)).toBeNull()
  })
})
