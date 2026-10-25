import { describe, it, expect } from 'vitest'
import { formatUa } from '../format-ua'

describe('formatUa', () => {
  it('parses Chrome on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    expect(formatUa(ua)).toBe('Chrome/macOS')
  })

  it('parses Safari on iOS', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    expect(formatUa(ua)).toBe('Safari/iOS')
  })

  it('parses Firefox on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
    expect(formatUa(ua)).toBe('Firefox/Windows')
  })

  it('parses Edge over Chrome (Edg token wins)', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
    expect(formatUa(ua)).toBe('Edge/Windows')
  })

  it('parses Chrome on Android', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    expect(formatUa(ua)).toBe('Chrome/Android')
  })

  it('returns the browser alone when the OS is unknown', () => {
    expect(formatUa('Chrome/120')).toBe('Chrome')
  })

  it('truncates an unparseable UA to ~24 chars with an ellipsis', () => {
    const ua = 'SomeWeirdCustomAgent/9.9.9 (extra long suffix here)'
    const out = formatUa(ua)
    expect(out).toBe('SomeWeirdCustomAgent/9.9…')
    expect(out.length).toBeLessThanOrEqual(25)
  })

  it('returns a short unparseable UA verbatim', () => {
    expect(formatUa('curl/8.4')).toBe('curl/8.4')
  })

  it('returns an empty string for empty/whitespace input', () => {
    expect(formatUa('')).toBe('')
    expect(formatUa('   ')).toBe('')
  })
})
