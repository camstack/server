/**
 * @vitest-environment jsdom
 *
 * Info HTML must keep root-relative Connect links (session cookie) and
 * absolute https Console links (new tab) — stripping `/addon/…` hrefs made
 * "Connect Google" a dead span.
 */
import { describe, expect, it } from 'vitest'

import { sanitizeInfoHtml } from '../sanitize-info-html.js'

describe('sanitizeInfoHtml', () => {
  it('keeps root-relative href for same-tab navigation', () => {
    const out = sanitizeInfoHtml('<a href="/addon/google-services/oauth/start">Connect Google</a>')
    expect(out).toContain('href="/addon/google-services/oauth/start"')
    expect(out).not.toContain('target=')
  })

  it('keeps https href and opens in a new tab', () => {
    const out = sanitizeInfoHtml(
      '<a href="https://console.cloud.google.com/apis/credentials">Google Cloud Console</a>',
    )
    expect(out).toContain('href="https://console.cloud.google.com/apis/credentials"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('drops javascript: and protocol-relative hrefs', () => {
    expect(sanitizeInfoHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('href=')
    expect(sanitizeInfoHtml('<a href="//evil.example/x">x</a>')).not.toContain('href=')
  })
})
