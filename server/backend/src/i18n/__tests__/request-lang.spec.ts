import { describe, expect, it } from 'vitest'
import { requestLangInputFrom, resolveRequestLang } from '../request-lang.js'

describe('resolveRequestLang', () => {
  const matrix: readonly {
    readonly name: string
    readonly input: Parameters<typeof resolveRequestLang>[0]
    readonly want: 'en' | 'it'
  }[] = [
    { name: 'nothing asked -> en', input: {}, want: 'en' },
    {
      name: 'profile language wins over everything',
      input: { profileLanguage: 'it', explicitLang: 'en', acceptLanguage: 'en' },
      want: 'it',
    },
    {
      name: 'explicit app lang beats Accept-Language',
      input: { explicitLang: 'it', acceptLanguage: 'en-US,en;q=0.9' },
      want: 'it',
    },
    { name: 'explicit lang is case-insensitive', input: { explicitLang: 'IT' }, want: 'it' },
    {
      name: 'Accept-Language it-IT',
      input: { acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8' },
      want: 'it',
    },
    {
      name: 'Accept-Language ranked by q',
      input: { acceptLanguage: 'fr;q=0.9,it;q=0.8,en;q=0.1' },
      want: 'it',
    },
    {
      name: 'unsupported Accept-Language -> en',
      input: { acceptLanguage: 'de-DE,fr;q=0.8' },
      want: 'en',
    },
    {
      name: 'unknown explicit lang falls through to Accept-Language',
      input: { explicitLang: 'klingon', acceptLanguage: 'it' },
      want: 'it',
    },
    {
      name: 'a non-string profile language is ignored',
      input: { profileLanguage: 42, acceptLanguage: 'it' },
      want: 'it',
    },
    {
      name: 'an array Accept-Language header is read',
      input: { acceptLanguage: ['it', 'en'] },
      want: 'it',
    },
  ]
  for (const row of matrix) {
    it(row.name, () => {
      expect(resolveRequestLang(row.input)).toBe(row.want)
    })
  }
})

describe('requestLangInputFrom', () => {
  it('prefers the x-camstack-lang header, then the lang query, then the connection param', () => {
    expect(requestLangInputFrom({ 'x-camstack-lang': 'it' }, { lang: 'en' }).explicitLang).toBe(
      'it',
    )
    expect(requestLangInputFrom({}, { lang: 'it' }).explicitLang).toBe('it')
    expect(requestLangInputFrom({}, null, 'it').explicitLang).toBe('it')
  })

  it('carries Accept-Language through', () => {
    const input = requestLangInputFrom({ 'accept-language': 'it-IT' })
    expect(resolveRequestLang(input)).toBe('it')
  })
})
