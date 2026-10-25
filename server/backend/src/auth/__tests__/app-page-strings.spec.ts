import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { IUserPasskeysProvider } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { HandoffCodeService, pkceChallenge } from '../../core/auth/handoff-code.service.js'
import { appConfirmPage, appConfirmRefusalPage } from '../app-confirm-page.js'
import { registerAppConfirmRoutes } from '../app-confirm-routes.js'
import { AppConfirmations } from '../app-confirmations.js'
import { APP_PAGE_STYLE } from '../app-page-shell.js'
import {
  APP_PAGE_STRINGS,
  langFromAcceptLanguage,
  resolveAppPageLang,
} from '../app-page-strings.js'
import { appPasskeyPage } from '../app-passkey-page.js'
import { registerAppPasskeyRoutes } from '../app-passkey-routes.js'
import { registerAppRefusedRoute } from '../app-refused-route.js'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../auth-network-policy.js'
import { createRateLimiter } from '../auth-rate-limit.js'

/** The app landing pages speak English and Italian (D858). */

const hash = (text: string): string =>
  `'sha256-${createHash('sha256').update(text).digest('base64')}'`
const scriptOf = (html: string): string | undefined => /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
const styleOf = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''

const FLOW = {
  code_challenge: pkceChallenge('p'.repeat(64)),
  code_challenge_method: 'S256',
  state: 'app-state-0123456789',
  purpose: 'new-session',
}
const QUERY = new URLSearchParams(FLOW).toString()

let open: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(open.map((f) => f.close()))
  open = []
})

function boot() {
  const fastify = Fastify()
  open.push(fastify)
  const confirmations = new AppConfirmations()
  const provider = {
    beginDiscoverableAuthentication: async () => ({ optionsJSON: { challenge: 'Y2g' } }),
    finishDiscoverableAuthentication: async () => ({ verified: true, userId: 'u-alice' }),
  } as unknown as IUserPasskeysProvider
  const network = DEFAULT_AUTH_NETWORK_POLICY
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1_000 })
  const logger = { warn: () => undefined, error: () => undefined }
  registerAppPasskeyRoutes(fastify, {
    passkeys: () => provider,
    secondFactors: async () => [],
    minter: {
      findUser: async (id: string) => ({ id, username: 'alice', isAdmin: false }),
    } as never,
    confirmations,
    network,
    limiter,
    logger,
  })
  registerAppConfirmRoutes(fastify, {
    confirmations,
    handoffCodes: new HandoffCodeService(),
    network,
    limiter,
    logger,
  })
  registerAppRefusedRoute(fastify)
  return { fastify, confirmations }
}

const accept = (value: string) => ({ 'accept-language': value })

describe('the strings module', () => {
  const leaves = (value: unknown, prefix = ''): string[] =>
    typeof value === 'string'
      ? [prefix]
      : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
          leaves(v, prefix === '' ? k : `${prefix}.${k}`),
        )

  it('has exactly the same keys in English and Italian, none empty', () => {
    expect(leaves(APP_PAGE_STRINGS.it).sort()).toEqual(leaves(APP_PAGE_STRINGS.en).sort())
    const empty = (value: unknown): boolean =>
      typeof value === 'string'
        ? value.length === 0
        : Object.values(value as Record<string, unknown>).some(empty)
    expect(empty(APP_PAGE_STRINGS.en)).toBe(false)
    expect(empty(APP_PAGE_STRINGS.it)).toBe(false)
  })

  it('every Italian sentence is actually translated (differs from the English)', () => {
    const flat = (value: unknown, prefix = ''): Array<[string, string]> =>
      typeof value === 'string'
        ? [[prefix, value]]
        : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
            flat(v, prefix === '' ? k : `${prefix}.${k}`),
          )
    const en = new Map(flat(APP_PAGE_STRINGS.en))
    for (const [key, value] of flat(APP_PAGE_STRINGS.it)) {
      if (en.get(key)?.trim().length === 1) continue // punctuation
      expect(value, key).not.toBe(en.get(key))
    }
  })

  it('no page file renders an English literal of its own (grep-style)', () => {
    const files = [
      'app-confirm-page.ts',
      'app-passkey-page.ts',
      'app-refused-route.ts',
      '../api/oauth2/consent-page.ts',
    ]
    const prose = /[A-Z][a-z]+(?:'[a-z]+)? [a-z]+/
    for (const file of files) {
      const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
      const literals =
        source.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []
      const offenders = literals.filter((l) => prose.test(l) && !l.includes('import'))
      expect(offenders, file).toEqual([])
    }
  })
})

describe('choosing the language', () => {
  it.each([
    ['it-IT', 'it'],
    ['it', 'it'],
    ['en-US,it;q=0.8', 'en'],
    ['de-DE,it;q=0.5,en;q=0.4', 'it'],
    ['fr-FR, it-CH;q=0.9', 'it'],
    ['it;q=0, en', 'en'],
    ['de-DE', undefined],
    ['*', undefined],
    ['', undefined],
  ] as const)('Accept-Language %j -> %s', (header, expected) => {
    expect(langFromAcceptLanguage(header)).toBe(expected)
  })

  it('lang wins over Accept-Language; junk lang falls through; nothing -> en', () => {
    expect(resolveAppPageLang({ lang: 'en', acceptLanguage: 'it-IT' })).toBe('en')
    expect(resolveAppPageLang({ lang: 'it', acceptLanguage: 'en-US' })).toBe('it')
    expect(resolveAppPageLang({ lang: 'xx', acceptLanguage: 'it-IT' })).toBe('it')
    expect(resolveAppPageLang({ lang: '<script>', acceptLanguage: 'de' })).toBe('en')
    expect(resolveAppPageLang({})).toBe('en')
  })
})

describe('the pages in both languages', () => {
  it('passkey page: it via Accept-Language, en by lang override, en for unknown', async () => {
    const { fastify } = boot()
    const get = (qs: string, headers: Record<string, string>) =>
      fastify.inject({ method: 'GET', url: `/auth/app/passkey?${QUERY}${qs}`, headers })
    const it = await get('', accept('it-IT'))
    expect(it.body).toContain('<html lang="it">')
    expect(it.body).toContain('<title>Accedi con una passkey</title>')
    expect(it.body).toContain('>Annulla</a>')
    expect(it.body).toContain('data-s-passkey-cancelled="La richiesta della passkey')
    const en = await get('&lang=en', accept('it-IT'))
    expect(en.body).toContain('<html lang="en">')
    expect(en.body).toContain('<title>Sign in with a passkey</title>')
    const unknown = await get('', accept('de-DE'))
    expect(unknown.body).toContain('<html lang="en">')
    const none = await get('', {})
    expect(none.body).toContain('<html lang="en">')
  })

  it('never reflects the raw lang param or header into a page', async () => {
    const { fastify } = boot()
    const res = await fastify.inject({
      method: 'GET',
      url: `/auth/app/passkey?${QUERY}&lang=%3Cscript%3Ealert(1)%3C/script%3E`,
      headers: accept('xx-<img src=x>'),
    })
    expect(res.body).not.toContain('alert(1)')
    expect(res.body).not.toContain('<img')
    expect(res.body).toContain('<html lang="en">')
  })

  it('passkey refusal (a bad request) is translated, in every reason', async () => {
    const { fastify } = boot()
    const res = await fastify.inject({
      method: 'GET',
      url: `/auth/app/passkey?${QUERY.replace('S256', 'plain')}&lang=it`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('<html lang="it">')
    expect(res.body).toContain('È supportato solo il metodo PKCE S256.')
    expect(res.body).toContain('Richiesta di accesso rifiutata')
  })

  it('start-refusal page: every reason code in both languages; unknown is generic', async () => {
    const { fastify } = boot()
    for (const lang of ['en', 'it'] as const) {
      for (const [reason, message] of Object.entries(APP_PAGE_STRINGS[lang].refused.reasons)) {
        const res = await fastify.inject({
          method: 'GET',
          url: `/auth/app/refused?reason=${reason}&lang=${lang}`,
        })
        expect(res.statusCode).toBe(400)
        expect(res.body).toContain(`<html lang="${lang}">`)
        expect(res.body).toContain(message.replace(/'/g, '&#39;'))
      }
    }
    const it = await fastify.inject({
      method: 'GET',
      url: '/auth/app/refused?reason=%3Cb%3E',
      headers: accept('it-IT'),
    })
    expect(it.body).toContain('La richiesta di accesso è stata rifiutata.')
    expect(it.body).not.toContain('<b>')
  })

  it('lang survives the passkey finish to the confirmation page (and beats Accept-Language)', async () => {
    const { fastify } = boot()
    const finish = await fastify.inject({
      method: 'POST',
      url: '/auth/app/passkey/finish',
      payload: { response: { id: 'c' }, ...FLOW, lang: 'it' },
    })
    const next = finish.json<{ confirm: string }>().confirm
    const cookie = [finish.headers['set-cookie']].flat().map(String)[0]?.split(';')[0] ?? ''
    const page = await fastify.inject({
      method: 'GET',
      url: `/auth/app/${next}`,
      headers: { cookie, ...accept('en-US') },
    })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('<html lang="it">')
    expect(page.body).toContain('Continua</button>')
    expect(page.body).toContain('<strong>alice</strong>')
    expect(page.body).toContain('data-s-confirm-expired="Questa conferma è scaduta.')
  })

  it('an expired confirmation falls back to Accept-Language', async () => {
    const { fastify } = boot()
    const it = await fastify.inject({
      method: 'GET',
      url: '/auth/app/confirm?confirm=gone',
      headers: accept('it-IT'),
    })
    expect(it.statusCode).toBe(400)
    expect(it.body).toContain('<title>Conferma scaduta</title>')
    const en = await fastify.inject({ method: 'GET', url: '/auth/app/confirm?confirm=gone' })
    expect(en.body).toContain('<title>Confirmation expired</title>')
  })

  it('the script (and so its CSP hash) is the same in both languages; style hash matches', () => {
    const cancel = 'camstack://auth-callback?error=cancelled'
    const pairs = [
      [appPasskeyPage(cancel, 'en'), appPasskeyPage(cancel, 'it')],
      [
        appConfirmPage({ lang: 'en', username: 'a', token: 't', cancelHref: cancel }),
        appConfirmPage({ lang: 'it', username: 'a', token: 't', cancelHref: cancel }),
      ],
    ] as const
    for (const [en, it] of pairs) {
      expect(scriptOf(en)).toBeDefined()
      expect(scriptOf(it)).toBe(scriptOf(en))
      expect(styleOf(it)).toBe(APP_PAGE_STYLE)
      expect(hash(scriptOf(it) ?? '')).toBe(hash(scriptOf(en) ?? ''))
    }
    expect(appConfirmRefusalPage('it')).not.toContain('<script>')
  })

  it('the CSP header of a served page matches the served script and style, in Italian', async () => {
    const { fastify } = boot()
    const res = await fastify.inject({
      method: 'GET',
      url: `/auth/app/passkey?${QUERY}&lang=it`,
    })
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain(`script-src ${hash(scriptOf(res.body) ?? '')}`)
    expect(csp).toContain(`style-src ${hash(styleOf(res.body))}`)
  })

  it('no Italian page carries a leftover English sentence', () => {
    const cancel = 'camstack://auth-callback?error=cancelled'
    const it = [
      appPasskeyPage(cancel, 'it'),
      appConfirmPage({ lang: 'it', username: 'a', token: 't', cancelHref: cancel }),
      appConfirmRefusalPage('it'),
    ].join('')
    const en = APP_PAGE_STRINGS.en
    for (const english of [
      en.passkey.body,
      en.passkey.button,
      en.confirm.heading,
      en.confirm.hint,
      en.confirmExpired.body,
      en.script.confirmExpired,
      en.script.passkeyCancelled,
    ]) {
      expect(it).not.toContain(english)
    }
  })
})
