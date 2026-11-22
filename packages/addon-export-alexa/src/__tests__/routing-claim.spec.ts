/**
 * An Alexa-bound token carries the hub origin it was issued for as the `hubUrl` claim; the
 * skill Lambda routes on it. Option B (planning#378): a claim that no longer matches the
 * `publicEndpoint` role is NOT accepted - the verdict names why, so the directive route can
 * log it instead of answering a bare 401.
 */
import { describe, expect, it } from 'vitest'
import { NO_PUBLIC_ENDPOINT_REASON } from '../public-endpoint.js'
import { judgeRoutingClaim, readRoutingClaim } from '../routing-claim.js'

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`
}

const current = { ok: true, origin: 'https://hub.example.org' } as const

describe('readRoutingClaim', () => {
  it('reads the hubUrl claim', () => {
    expect(readRoutingClaim(jwt({ hubUrl: 'https://old.example.org' }))).toBe(
      'https://old.example.org',
    )
  })

  it('is null for a token without the claim, an empty claim or a non-JWT', () => {
    expect(readRoutingClaim(jwt({ sub: 'u' }))).toBeNull()
    expect(readRoutingClaim(jwt({ hubUrl: '' }))).toBeNull()
    expect(readRoutingClaim('not-a-jwt')).toBeNull()
  })
})

const known = (...origins: string[]) => ({ ok: true, origins: new Set(origins) }) as const
const unreadable = { ok: false } as const

describe('judgeRoutingClaim', () => {
  it('accepts a claim equal to the role, ignoring trailing slashes', () => {
    expect(judgeRoutingClaim('https://hub.example.org/', current, known())).toEqual({
      kind: 'current',
    })
  })

  it('accepts a token that carries no claim', () => {
    expect(judgeRoutingClaim(null, current, known())).toEqual({ kind: 'unclaimed' })
  })

  it('refuses a claim that matches no known origin, naming both origins', () => {
    expect(
      judgeRoutingClaim('https://old.example.org', current, known('http://192.168.1.9:4480')),
    ).toEqual({
      kind: 'stale',
      claim: 'https://old.example.org',
      current: 'https://hub.example.org',
    })
  })

  it('serves a claim naming a known origin that is not the resolved role (restart incident)', () => {
    const lan = { ok: true, origin: 'http://192.168.1.9:4480' } as const
    expect(
      judgeRoutingClaim(
        'https://hub.example.org/',
        lan,
        known('http://192.168.1.9:4480', 'https://hub.example.org'),
      ),
    ).toEqual({
      kind: 'known-elsewhere',
      claim: 'https://hub.example.org',
      current: 'http://192.168.1.9:4480',
    })
  })

  it('is unavailable, never stale, when the role resolves to nothing', () => {
    expect(
      judgeRoutingClaim(
        'https://old.example.org',
        { ok: false, reason: NO_PUBLIC_ENDPOINT_REASON },
        known(),
      ),
    ).toEqual({
      kind: 'unavailable',
      claim: 'https://old.example.org',
      reason: 'no-public-endpoint',
    })
  })

  it('is unavailable, never stale, when the palette cannot be read', () => {
    expect(judgeRoutingClaim('https://old.example.org', current, unreadable)).toEqual({
      kind: 'unavailable',
      claim: 'https://old.example.org',
      reason: 'palette-unreadable',
    })
  })
})
