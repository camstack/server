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

describe('judgeRoutingClaim', () => {
  it('accepts a claim equal to the role, ignoring trailing slashes', () => {
    expect(judgeRoutingClaim('https://hub.example.org/', current)).toEqual({
      kind: 'current',
    })
  })

  it('accepts a token that carries no claim', () => {
    expect(judgeRoutingClaim(null, current)).toEqual({ kind: 'unclaimed' })
  })

  it('refuses a claim that differs from the role, naming both origins', () => {
    expect(judgeRoutingClaim('https://old.example.org', current)).toEqual({
      kind: 'stale',
      claim: 'https://old.example.org',
      current: 'https://hub.example.org',
    })
  })

  it('refuses with the typed reason when the role resolves to nothing', () => {
    expect(
      judgeRoutingClaim('https://old.example.org', {
        ok: false,
        reason: NO_PUBLIC_ENDPOINT_REASON,
      }),
    ).toEqual({
      kind: 'no-endpoint',
      claim: 'https://old.example.org',
      reason: NO_PUBLIC_ENDPOINT_REASON,
    })
  })
})
