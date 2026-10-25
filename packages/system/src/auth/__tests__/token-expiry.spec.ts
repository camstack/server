import { describe, it, expect } from 'vitest'
import { DEFAULT_TOKEN_EXPIRY } from '@camstack/types'
import { parseTokenExpiry } from '../token-expiry.js'

/**
 * `auth.tokenExpiry` is a free-text security control that reaches
 * `jwt.sign`. These pin the two failure modes it used to have: a value
 * `jsonwebtoken` throws on (which would 500 every login) and a bare number
 * (which `ms` reads as MILLISECONDS, so `3600` means 3.6 seconds).
 */
describe('parseTokenExpiry', () => {
  const defaultSeconds = 30 * 24 * 3600

  it('resolves the DOCUMENTED default when nothing is configured', () => {
    for (const absent of [undefined, null, '', '   ']) {
      const r = parseTokenExpiry(absent)
      expect(r.ok).toBe(true)
      expect(r.value).toBe(DEFAULT_TOKEN_EXPIRY)
      expect(r.seconds).toBe(defaultSeconds)
    }
  })

  it('accepts duration strings and converts them to seconds itself', () => {
    expect(parseTokenExpiry('1h')).toMatchObject({ ok: true, seconds: 3600, value: '1h' })
    expect(parseTokenExpiry('90m')).toMatchObject({ ok: true, seconds: 5400 })
    expect(parseTokenExpiry('7d')).toMatchObject({ ok: true, seconds: 7 * 86400 })
    expect(parseTokenExpiry(' 2 hours ')).toMatchObject({ ok: true, seconds: 7200 })
    expect(parseTokenExpiry('12H')).toMatchObject({ ok: true, seconds: 43200 })
  })

  it('REJECTS a bare number — `ms` would read it as milliseconds, not seconds', () => {
    const r = parseTokenExpiry('3600')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('malformed')
    expect(r.seconds).toBe(defaultSeconds)
  })

  it('rejects garbage rather than letting jwt.sign throw on it', () => {
    for (const bad of ['forever', '30 dayz', '1h30m', 'd', '-5d', '{}']) {
      const r = parseTokenExpiry(bad)
      expect(r.ok, bad).toBe(false)
      expect(r.value, bad).toBe(DEFAULT_TOKEN_EXPIRY)
    }
  })

  it('rejects a non-string', () => {
    expect(parseTokenExpiry(3600)).toMatchObject({ ok: false, reason: 'not-a-string' })
    expect(parseTokenExpiry({ d: 30 })).toMatchObject({ ok: false, reason: 'not-a-string' })
  })

  it('rejects a lifetime shorter than a minute', () => {
    expect(parseTokenExpiry('30s')).toMatchObject({ ok: false, reason: 'too-short' })
    expect(parseTokenExpiry('1m')).toMatchObject({ ok: true, seconds: 60 })
  })

  it('rejects an effectively-infinite lifetime instead of honouring it', () => {
    expect(parseTokenExpiry('10y')).toMatchObject({ ok: false, reason: 'too-long' })
    expect(parseTokenExpiry('366d')).toMatchObject({ ok: false, reason: 'too-long' })
    expect(parseTokenExpiry('365d')).toMatchObject({ ok: true })
  })

  it('never resolves to undefined or to an unbounded value on rejection', () => {
    for (const bad of ['forever', '3600', '10y', '1s', 42]) {
      const r = parseTokenExpiry(bad)
      expect(r.seconds).toBe(defaultSeconds)
      expect(typeof r.value).toBe('string')
    }
  })
})
