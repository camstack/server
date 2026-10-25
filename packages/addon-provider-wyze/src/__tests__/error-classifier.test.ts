import { describe, expect, it } from 'vitest'
import { classifyCloudError } from '../error-classifier.js'

describe('classifyCloudError', () => {
  it('classifies MFA WyzeAuthError', () => {
    const got = classifyCloudError({
      message: 'MFA required',
      needsMfa: true,
      mfaType: 'TotpVerificationCode',
    })
    expect(got.kind).toBe('mfa')
    expect(got.message).toContain('TotpVerificationCode')
  })

  it('classifies rate-limit errors', () => {
    expect(classifyCloudError(new Error('HTTP 429 too many requests')).kind).toBe('rate-limited')
  })

  it('classifies credential errors', () => {
    expect(classifyCloudError(new Error('Wyze login failed (code 1000)')).kind).toBe('credentials')
    expect(classifyCloudError(new Error('no access token in response')).kind).toBe('credentials')
  })

  it('classifies P2P / DTLS errors', () => {
    expect(classifyCloudError(new Error('DTLS handshake failed')).kind).toBe('p2p')
    expect(classifyCloudError(new Error('Keyframe timeout')).kind).toBe('p2p')
  })

  it('falls back to unknown', () => {
    const got = classifyCloudError(new Error('something weird'))
    expect(got.kind).toBe('unknown')
    expect(got.message).toBe('something weird')
  })
})
