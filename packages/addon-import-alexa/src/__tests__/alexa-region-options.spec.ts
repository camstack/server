import { describe, it, expect } from 'vitest'
import { alexaRegionOptions } from '../alexa-region-options.js'

describe('alexaRegionOptions', () => {
  it.each([
    ['amazon.it', 'it-IT', 'it_IT'],
    ['amazon.de', 'de-DE', 'de_DE'],
    ['amazon.co.uk', 'en-GB', 'en_GB'],
    ['amazon.fr', 'fr-FR', 'fr_FR'],
    ['amazon.es', 'es-ES', 'es_ES'],
    ['amazon.ca', 'en-CA', 'en_CA'],
    ['amazon.com.au', 'en-AU', 'en_AU'],
    ['amazon.co.jp', 'ja-JP', 'ja_JP'],
    ['amazon.in', 'en-IN', 'en_IN'],
    ['amazon.com.br', 'pt-BR', 'pt_BR'],
    ['amazon.com.mx', 'es-MX', 'es_MX'],
    ['amazon.com', 'en-US', 'en_US'],
  ])('%s -> %s / %s, login page on the chosen region', (domain, accept, proxyLang) => {
    expect(alexaRegionOptions(domain)).toEqual({
      baseAmazonPage: domain,
      amazonPage: domain,
      acceptLanguage: accept,
      amazonPageProxyLanguage: proxyLang,
    })
  })
  it('falls back to amazon.com / en-US for an empty or unknown domain', () => {
    expect(alexaRegionOptions('')).toMatchObject({
      baseAmazonPage: 'amazon.com',
      acceptLanguage: 'en-US',
    })
    expect(alexaRegionOptions('amazon.xx')).toMatchObject({
      baseAmazonPage: 'amazon.xx',
      amazonPageProxyLanguage: 'en_US',
    })
  })
})
