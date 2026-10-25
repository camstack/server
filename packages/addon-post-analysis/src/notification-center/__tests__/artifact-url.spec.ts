import { describe, it, expect } from 'vitest'
import {
  buildArtifactUrl,
  pickArtifactBaseUrl,
  signArtifact,
  verifyArtifactSignature,
  type ArtifactEndpoint,
} from '../artifact-url.js'

const SECRET = 'test-secret-not-a-real-one'

const endpoint = (
  baseUrl: string,
  kind: ArtifactEndpoint['kind'],
  priority: number,
): ArtifactEndpoint => ({ baseUrl, kind, priority })

describe('pickArtifactBaseUrl', () => {
  it('prefers the public tunnel over LAN', () => {
    expect(
      pickArtifactBaseUrl([
        endpoint('https://lan.local:4443', 'lan-ipv4', 0),
        endpoint('https://tunnel.example', 'public', 100),
      ]),
    ).toBe('https://lan.local:4443')
  })

  it('follows the ranking, not the array order', () => {
    expect(
      pickArtifactBaseUrl([
        endpoint('https://c', 'lan-ipv4', 30),
        endpoint('https://a', 'public', 5),
        endpoint('https://b', 'lan-ipv4', 10),
      ]),
    ).toBe('https://a')
  })

  // A notification advertising media on 127.0.0.1 arrives with a link nobody
  // can open — worse than arriving with no link at all. This is the Alexa
  // `hubUrl: localhost` failure in another costume.
  it('REFUSES loopback rather than shipping an unopenable link', () => {
    expect(pickArtifactBaseUrl([endpoint('https://127.0.0.1:4443', 'loopback', 1000)])).toBeNull()
    expect(pickArtifactBaseUrl([])).toBeNull()
  })

  it('skips loopback when a real endpoint exists', () => {
    expect(
      pickArtifactBaseUrl([
        endpoint('https://127.0.0.1:4443', 'loopback', 0),
        endpoint('https://lan.local:4443', 'lan-ipv4', 50),
      ]),
    ).toBe('https://lan.local:4443')
  })
})

describe('artifact signatures', () => {
  it('round-trips a freshly signed url', () => {
    const exp = 10_000
    const sig = signArtifact(SECRET, 'abc', exp)
    expect(verifyArtifactSignature({ secret: SECRET, id: 'abc', exp, sig, nowMs: 5_000 })).toBe(
      true,
    )
  })

  it('rejects an expired link even with a VALID signature', () => {
    const exp = 10_000
    const sig = signArtifact(SECRET, 'abc', exp)
    expect(verifyArtifactSignature({ secret: SECRET, id: 'abc', exp, sig, nowMs: 10_001 })).toBe(
      false,
    )
  })

  it('rejects a tampered id, exp or signature', () => {
    const exp = 10_000
    const sig = signArtifact(SECRET, 'abc', exp)
    const now = 5_000
    expect(verifyArtifactSignature({ secret: SECRET, id: 'other', exp, sig, nowMs: now })).toBe(
      false,
    )
    expect(
      verifyArtifactSignature({ secret: SECRET, id: 'abc', exp: exp + 1, sig, nowMs: now }),
    ).toBe(false)
    expect(
      verifyArtifactSignature({
        secret: SECRET,
        id: 'abc',
        exp,
        sig: `${sig.slice(0, -1)}0`,
        nowMs: now,
      }),
    ).toBe(false)
  })

  it('rejects a signature made with another secret', () => {
    const exp = 10_000
    const sig = signArtifact('other-secret', 'abc', exp)
    expect(verifyArtifactSignature({ secret: SECRET, id: 'abc', exp, sig, nowMs: 5_000 })).toBe(
      false,
    )
  })

  it('rejects a malformed exp', () => {
    expect(
      verifyArtifactSignature({ secret: SECRET, id: 'abc', exp: Number.NaN, sig: 'x', nowMs: 1 }),
    ).toBe(false)
  })

  it('builds a url the verifier accepts, with no double slash', () => {
    const url = buildArtifactUrl({
      baseUrl: 'https://tunnel.example/',
      routePrefix: '/addon/pipeline-analytics/nc-artifact',
      id: 'art-1',
      secret: SECRET,
      expMs: 10_000,
    })
    expect(
      url.startsWith('https://tunnel.example/addon/pipeline-analytics/nc-artifact/art-1?'),
    ).toBe(true)
    const parsed = new URL(url)
    expect(
      verifyArtifactSignature({
        secret: SECRET,
        id: 'art-1',
        exp: Number(parsed.searchParams.get('exp')),
        sig: parsed.searchParams.get('sig') ?? '',
        nowMs: 5_000,
      }),
    ).toBe(true)
  })
})
