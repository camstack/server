/**
 * The region-dependent options of an account: the login page host (`baseAmazonPage`),
 * the API host (`amazonPage`) and the languages.
 */
export interface AlexaRegionOptions {
  readonly baseAmazonPage: string
  readonly amazonPage: string
  /** HTTP `Accept-Language`, e.g. `it-IT`. */
  readonly acceptLanguage: string
  /** The Amazon `language=` query value, e.g. `it_IT`. */
  readonly amazonPageProxyLanguage: string
}

const DEFAULT_LOCALE = 'en-US'

const LOCALE_BY_DOMAIN: Readonly<Record<string, string>> = {
  'amazon.com': 'en-US',
  'amazon.it': 'it-IT',
  'amazon.de': 'de-DE',
  'amazon.co.uk': 'en-GB',
  'amazon.fr': 'fr-FR',
  'amazon.es': 'es-ES',
  'amazon.ca': 'en-CA',
  'amazon.com.au': 'en-AU',
  'amazon.co.jp': 'ja-JP',
  'amazon.in': 'en-IN',
  'amazon.com.br': 'pt-BR',
  'amazon.com.mx': 'es-MX',
}

export function alexaRegionOptions(amazonDomain: string): AlexaRegionOptions {
  const domain = amazonDomain.length > 0 ? amazonDomain : 'amazon.com'
  const locale = LOCALE_BY_DOMAIN[domain] ?? DEFAULT_LOCALE
  return {
    baseAmazonPage: domain,
    amazonPage: domain,
    acceptLanguage: locale,
    amazonPageProxyLanguage: locale.replace('-', '_'),
  }
}
