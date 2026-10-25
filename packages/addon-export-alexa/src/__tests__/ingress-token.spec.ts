import { describe, it, expect } from 'vitest'
import {
  generateIngressToken,
  timingSafeEqualStr,
  verifyIngressToken,
  readIngressHeader,
  INGRESS_HEADER,
} from '../ingress-token.js'

describe('ingress-token', () => {
  describe('generateIngressToken', () => {
    it('produces a non-trivial base64url token', () => {
      const t = generateIngressToken()
      // 32 random bytes → 43 base64url chars (no padding).
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('produces a fresh value each call', () => {
      const a = generateIngressToken()
      const b = generateIngressToken()
      expect(a).not.toBe(b)
    })
  })

  describe('timingSafeEqualStr', () => {
    it('true for identical strings', () => {
      expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true)
    })
    it('false for same-length but different strings', () => {
      expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false)
    })
    it('false for different-length strings (no throw)', () => {
      expect(timingSafeEqualStr('short', 'a-much-longer-string')).toBe(false)
    })
  })

  describe('verifyIngressToken', () => {
    it('true when no token is configured (expected empty) — nothing to enforce', () => {
      expect(verifyIngressToken('', 'anything')).toBe(true)
      expect(verifyIngressToken('', undefined)).toBe(true)
    })
    it('false when a token is expected but none provided', () => {
      expect(verifyIngressToken('secret', undefined)).toBe(false)
      expect(verifyIngressToken('secret', '')).toBe(false)
    })
    it('true only on an exact match', () => {
      const token = generateIngressToken()
      expect(verifyIngressToken(token, token)).toBe(true)
      expect(verifyIngressToken(token, `${token}x`)).toBe(false)
      expect(verifyIngressToken(token, 'wrong')).toBe(false)
    })
  })

  describe('readIngressHeader', () => {
    it('reads the header case-insensitively', () => {
      expect(readIngressHeader({ [INGRESS_HEADER]: 'tok' })).toBe('tok')
      expect(readIngressHeader({ 'X-CamStack-Ingress': 'tok' })).toBe('tok')
    })
    it('returns undefined when absent', () => {
      expect(readIngressHeader({ authorization: 'Bearer x' })).toBeUndefined()
      expect(readIngressHeader({})).toBeUndefined()
    })
  })
})
