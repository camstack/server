// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncThemeColor, watchThemeColor } from '../theme-color'

const pkgRoot = path.resolve(__dirname, '../../..')
const themeCss = fs.readFileSync(
  path.join(pkgRoot, '../ui-library/src/tailwind/camstack-theme.css'),
  'utf-8',
)
const indexHtml = fs.readFileSync(path.join(pkgRoot, 'index.html'), 'utf-8')

function tokenOf(selector: '.dark' | '.light'): string {
  const block = themeCss.slice(themeCss.indexOf(`\n${selector} {`))
  const match = /--color-surface:\s*(#[0-9a-fA-F]{6})/.exec(block)
  if (!match?.[1]) throw new Error(`no --color-surface in ${selector}`)
  return match[1].toLowerCase()
}

function metaContent(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
}

function setSurface(value: string, themeClass: 'dark' | 'light'): void {
  document.documentElement.style.setProperty('--color-surface', value)
  document.documentElement.classList.remove('dark', 'light')
  document.documentElement.classList.add(themeClass)
}

describe('theme-color sync', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000" />'
    document.documentElement.removeAttribute('style')
    document.documentElement.className = ''
  })
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('copies the surface token onto the meta tag', () => {
    setSurface('#f5f5f4', 'light')
    syncThemeColor()
    expect(metaContent()).toBe('#f5f5f4')
  })

  it('leaves the meta tag alone while the token is unresolved', () => {
    syncThemeColor()
    expect(metaContent()).toBe('#000000')
  })

  it('creates the meta tag when it is missing', () => {
    document.head.innerHTML = ''
    setSurface('#1c1917', 'dark')
    syncThemeColor()
    expect(metaContent()).toBe('#1c1917')
  })

  it('follows a theme class change and stops after unsubscribe', async () => {
    setSurface('#1c1917', 'dark')
    const stop = watchThemeColor()
    expect(metaContent()).toBe('#1c1917')

    setSurface('#f5f5f4', 'light')
    await new Promise((r) => setTimeout(r, 0))
    expect(metaContent()).toBe('#f5f5f4')

    stop()
    setSurface('#1c1917', 'dark')
    await new Promise((r) => setTimeout(r, 0))
    expect(metaContent()).toBe('#f5f5f4')
  })
})

describe('index.html pre-paint literals', () => {
  it('mirror the --color-surface token of each theme', () => {
    expect(indexHtml).toContain(`'${tokenOf('.light')}'`)
    expect(indexHtml).toContain(`'${tokenOf('.dark')}'`)
    expect(indexHtml).toContain(`name="theme-color" content="${tokenOf('.dark')}"`)
  })

  it('lets iOS draw the status bar', () => {
    expect(indexHtml).toContain('apple-mobile-web-app-status-bar-style" content="default"')
  })
})
