import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAuthPair } from '../auth.js'

describe('createAuthPair', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('signs and verifies a token with matching sessionId', () => {
    const { signer, verifier } = createAuthPair()
    const expiry = Date.now() + 60_000
    const token = signer.sign('session-abc', expiry)

    const result = verifier.verify(token, 'session-abc')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sessionId).toBe('session-abc')
      expect(result.expiresAt).toBe(expiry)
    }
  })

  it('rejects tokens for a different session', () => {
    const { signer, verifier } = createAuthPair()
    const token = signer.sign('session-abc', Date.now() + 60_000)
    const result = verifier.verify(token, 'session-xyz')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('wrong-session')
  })

  it('rejects expired tokens', () => {
    const { signer, verifier } = createAuthPair()
    const token = signer.sign('session-abc', Date.now() + 1_000)
    vi.advanceTimersByTime(2_000)
    const result = verifier.verify(token, 'session-abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('rejects tokens with tampered signature', () => {
    const { signer, verifier } = createAuthPair()
    const token = signer.sign('session-abc', Date.now() + 60_000)
    // Flip one byte of the signature portion (after the second '.').
    // The replacement is DERIVED from the byte it replaces, never a fixed
    // letter: the signature is base64, so a hard-coded 'X' left the token
    // untouched on the ~1-in-64 runs whose signature already started with 'X',
    // the verification then legitimately succeeded, and this security test
    // failed at random. A test that reddens by chance gets dismissed as the
    // flaky one, which is worse than not having it.
    const lastDot = token.lastIndexOf('.')
    const original = token[lastDot + 1]
    const tampered =
      token.slice(0, lastDot + 1) + (original === 'X' ? 'Y' : 'X') + token.slice(lastDot + 2)
    const result = verifier.verify(tampered, 'session-abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['bad-signature', 'malformed']).toContain(result.reason)
  })

  it('rejects tokens signed with a different secret', () => {
    const pair1 = createAuthPair()
    const pair2 = createAuthPair()
    const token = pair1.signer.sign('session-abc', Date.now() + 60_000)
    const result = pair2.verifier.verify(token, 'session-abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad-signature')
  })

  it('rejects malformed tokens', () => {
    const { verifier } = createAuthPair()
    expect(verifier.verify('garbage', 'session').ok).toBe(false)
    expect(verifier.verify('a.b', 'session').ok).toBe(false)
    expect(verifier.verify('a.b.c.d', 'session').ok).toBe(false)
  })

  it('refuses to sign sessionId containing the separator', () => {
    const { signer } = createAuthPair()
    expect(() => signer.sign('bad.session', Date.now() + 1_000)).toThrow(/must not contain/)
  })
})
