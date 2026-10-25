import { describe, expect, it } from 'vitest'
import { readSessionLifetimes } from '../session-lifetimes.js'

const read = (values: Record<string, unknown>) => (key: string) => values[key]

describe('readSessionLifetimes', () => {
  it('defaults: a 30-day session, 2-hour access tokens', () => {
    expect(readSessionLifetimes(read({}))).toEqual({ sessionMs: 30 * 86_400_000, accessSec: 7200 })
  })

  it('honours both settings', () => {
    expect(
      readSessionLifetimes(read({ 'auth.tokenExpiry': '7d', 'auth.accessTokenExpiry': '30m' })),
    ).toEqual({ sessionMs: 7 * 86_400_000, accessSec: 1800 })
  })

  it('bounds the access token to [5 min, 24 h] and never past the session', () => {
    expect(readSessionLifetimes(read({ 'auth.accessTokenExpiry': '1m' })).accessSec).toBe(300)
    expect(readSessionLifetimes(read({ 'auth.accessTokenExpiry': '3d' })).accessSec).toBe(86_400)
    expect(
      readSessionLifetimes(read({ 'auth.tokenExpiry': '1h', 'auth.accessTokenExpiry': '2h' }))
        .accessSec,
    ).toBe(3600)
  })

  it('a value that does not parse falls back to the default, never longer', () => {
    expect(readSessionLifetimes(read({ 'auth.accessTokenExpiry': '9999' })).accessSec).toBe(7200)
  })

  it('a store that cannot answer yet reads as the defaults', () => {
    const throwing = () => {
      throw new Error('settings unavailable')
    }
    expect(readSessionLifetimes(throwing)).toEqual({ sessionMs: 30 * 86_400_000, accessSec: 7200 })
  })
})
