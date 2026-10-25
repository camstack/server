import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { darkColors, defaultTheme, lightColors } from '@camstack/ui-library/theme/tokens'
import { describe, expect, it } from 'vitest'
import { renderConsentPage } from '../../api/oauth2/consent-page.js'
import { appConfirmPage, appConfirmRefusalPage, APP_CONFIRM_CSP } from '../app-confirm-page.js'
import {
  APP_PAGE_LOGOS,
  APP_PAGE_STYLE,
  appPageCsp,
  escapeHtml,
  renderAppPage,
} from '../app-page-shell.js'
import { APP_PASSKEY_CSP, appPasskeyPage, appPasskeyRefusalPage } from '../app-passkey-page.js'
import { APP_REFUSED_CSP, appRefusedPage } from '../app-refused-route.js'

const repoRoot = path.resolve(__dirname, '../../../../..')

const hash = (text: string): string =>
  `'sha256-${createHash('sha256').update(text).digest('base64')}'`
const styleOf = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
const scriptOf = (html: string): string | undefined => /<script>([\s\S]*)<\/script>/.exec(html)?.[1]

const CANCEL = 'camstack://auth-callback?error=cancelled'

interface ServedPage {
  readonly name: string
  readonly html: string
  /** The CSP the route sends with this page. */
  readonly csp: string
}

const pagesFor = (lang: 'en' | 'it'): readonly ServedPage[] => [
  {
    name: `confirm ${lang}`,
    html: appConfirmPage({ lang, username: 'alice', token: 't0ken', cancelHref: CANCEL }),
    csp: APP_CONFIRM_CSP,
  },
  { name: `confirm refusal ${lang}`, html: appConfirmRefusalPage(lang), csp: appPageCsp() },
  { name: `passkey ${lang}`, html: appPasskeyPage(CANCEL, lang), csp: APP_PASSKEY_CSP },
  {
    name: `passkey refusal ${lang}`,
    html: appPasskeyRefusalPage('No.', lang),
    csp: appPageCsp(),
  },
  { name: `start refusal ${lang}`, html: appRefusedPage('bad-state', lang), csp: APP_REFUSED_CSP },
]
const PAGES: readonly ServedPage[] = [...pagesFor('en'), ...pagesFor('it')]

describe('the app page shell', () => {
  it.each(PAGES)('$name renders through the shell', ({ html }) => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain(
      'name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"',
    )
    expect(html).toContain('class="brand"')
    expect(html).toContain('class="card"')
    expect(styleOf(html)).toBe(APP_PAGE_STYLE)
  })

  it.each(PAGES)('$name: the CSP hashes are those of the style and script served', ({
    html,
    csp,
  }) => {
    expect(csp).toContain(`style-src ${hash(styleOf(html))}`)
    const script = scriptOf(html)
    if (script === undefined) expect(csp).not.toContain('script-src')
    else expect(csp).toContain(`script-src ${hash(script)}`)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe')
  })

  it('a stylesheet edited without its hash is refused (disarm: the CSP is not a constant)', () => {
    const served = renderAppPage({ lang: 'en', title: 't', heading: 'h', body: '' })
    const tampered = styleOf(served).replace('border-radius', 'border-radiusx')
    expect(tampered).not.toBe(styleOf(served))
    expect(appPageCsp()).not.toContain(hash(tampered))
    expect(appPageCsp()).toContain(hash(APP_PAGE_STYLE))
  })

  it('takes colours, radius and font from the theme tokens', () => {
    const [light, dark] = APP_PAGE_STYLE.split('@media (prefers-color-scheme:dark)')
    expect(light).toContain(`--color-primary:${lightColors.primary}`)
    expect(light).toContain(`--color-surface:${lightColors.surface}`)
    expect(dark).toContain(`--color-primary:${darkColors.primary}`)
    expect(dark).toContain(`--color-background:${darkColors.background}`)
    expect(APP_PAGE_STYLE).toContain(`--radius-xl:${defaultTheme.radius.xl}px`)
    expect(APP_PAGE_STYLE).toContain(defaultTheme.typography.fontFamily)
  })

  it('types no colour of its own: every hex in the stylesheet comes from the theme', () => {
    const themeValues = new Set(
      [...Object.values(lightColors), ...Object.values(darkColors)].filter(
        (value): value is string => typeof value === 'string',
      ),
    )
    const hexes = APP_PAGE_STYLE.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes.length).toBeGreaterThan(0)
    for (const hex of hexes) expect(themeValues.has(hex)).toBe(true)
  })

  it('carries the brand logo files, both schemes, inline and without an external asset', () => {
    const strip = (svg: string): string =>
      svg
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/>\s+</g, '><')
        .replace(/\s+/g, ' ')
        .trim()
    const brand = (file: string): string =>
      strip(readFileSync(path.join(repoRoot, 'packages/addon-admin-ui/public/brand', file), 'utf8'))
    const normalised = (svg: string): string =>
      strip(
        svg
          .replace(' class="logo logo-dark"', '')
          .replace(' class="logo logo-light"', '')
          .replace(' role="img" aria-label="CamStack"', ''),
      )
    expect(normalised(APP_PAGE_LOGOS.dark)).toBe(
      brand('logo-dark.svg').replace(/>\s*Cam<tspan/, '>Cam<tspan'),
    )
    expect(normalised(APP_PAGE_LOGOS.light)).toBe(
      brand('logo-light.svg').replace(/>\s*Cam<tspan/, '>Cam<tspan'),
    )
    for (const { html } of PAGES) expect(html).not.toMatch(/(src|href)="https?:/)
  })

  it('escapes what a caller hands it', () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;')
    const page = renderAppPage({ lang: 'en', title: '<b>', heading: '<i>', body: '' })
    expect(page).toContain('<title>&#60;b&#62;</title>')
    expect(page).toContain('<h1>&#60;i&#62;</h1>')
  })

  it('the consent screen is on the shell too, with a primary and a secondary choice', () => {
    const html = renderConsentPage({
      lang: 'en',
      displayName: 'Home <Assistant>',
      username: 'alice',
      scopeSummary: 'read cameras',
      redirectUri: 'https://ha.example/cb',
      hidden: { state: 'abc"def' },
    })
    expect(styleOf(html)).toBe(APP_PAGE_STYLE)
    expect(html).toContain('name="consent" value="allow"')
    expect(html).toContain('class="btn secondary" type="submit" name="consent" value="deny"')
    expect(html).toContain('value="abc&#34;def"')
    expect(html).not.toContain('Home <Assistant>')
  })

  it('the start refusal page names a known reason and never echoes an unknown one', () => {
    expect(appRefusedPage('bad-state', 'en')).toContain('no valid state')
    const page = appRefusedPage('<script>alert(1)</script>', 'en')
    expect(page).not.toContain('alert(1)')
    expect(page).toContain('The sign-in request was refused.')
  })
})
