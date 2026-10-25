import { describe, expect, it } from 'vitest'
import { decideCertificateTrust } from '../role/cert-trust'

const ROOT_FP = 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const OTHER_FP = 'sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
const AUTHORITY_INVALID = 'net::ERR_CERT_AUTHORITY_INVALID'

describe('decideCertificateTrust', () => {
  it('accepts anything the OS chain already trusts, with or without a pin', () => {
    expect(
      decideCertificateTrust({
        verificationResult: 'net::OK',
        issuerFingerprint: OTHER_FP,
        pinnedFingerprint: null,
      }),
    ).toEqual({ accept: true, reason: 'os-trust' })

    expect(
      decideCertificateTrust({
        verificationResult: 'net::OK',
        issuerFingerprint: OTHER_FP,
        pinnedFingerprint: ROOT_FP,
      }),
    ).toEqual({ accept: true, reason: 'os-trust' })
  })

  it('accepts an untrusted chain whose issuer matches the pin', () => {
    expect(
      decideCertificateTrust({
        verificationResult: AUTHORITY_INVALID,
        issuerFingerprint: ROOT_FP,
        pinnedFingerprint: ROOT_FP,
      }),
    ).toEqual({ accept: true, reason: 'pinned-issuer' })
  })

  it('rejects an untrusted chain when this hub has no pin (first contact)', () => {
    expect(
      decideCertificateTrust({
        verificationResult: AUTHORITY_INVALID,
        issuerFingerprint: ROOT_FP,
        pinnedFingerprint: null,
      }),
    ).toEqual({ accept: false, reason: 'no-pin' })
  })

  it('rejects an untrusted chain whose issuer contradicts the pin', () => {
    expect(
      decideCertificateTrust({
        verificationResult: AUTHORITY_INVALID,
        issuerFingerprint: OTHER_FP,
        pinnedFingerprint: ROOT_FP,
      }),
    ).toEqual({ accept: false, reason: 'pin-mismatch' })
  })

  it('rejects as a mismatch when a pinned hub presents no inspectable issuer', () => {
    expect(
      decideCertificateTrust({
        verificationResult: AUTHORITY_INVALID,
        issuerFingerprint: null,
        pinnedFingerprint: ROOT_FP,
      }),
    ).toEqual({ accept: false, reason: 'pin-mismatch' })
  })
})
