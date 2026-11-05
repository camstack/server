import { describe, expect, it } from 'vitest'
import {
  assocHandleSuffix,
  buildSignInUrl,
  newOauthAttemptSecrets,
  pkceChallenge,
} from '../amazon-auth/oauth-request.js'

/** RFC 7636 appendix B: a published verifier/challenge pair. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('the Amazon sign-in request', () => {
  it('derives the PKCE S256 challenge of the RFC 7636 vector', () => {
    expect(pkceChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
  })

  it('names the assoc handle by top-level domain', () => {
    expect(assocHandleSuffix('amazon.com')).toBe('')
    expect(assocHandleSuffix('amazon.it')).toBe('_it')
    expect(assocHandleSuffix('amazon.co.uk')).toBe('_uk')
    expect(assocHandleSuffix('amazon.co.jp')).toBe('_jp')
  })

  it('builds the exact /ap/signin URL the Alexa app opens', () => {
    const url = buildSignInUrl({
      amazonDomain: 'amazon.it',
      deviceId: 'DEVICE-ID',
      codeVerifier: RFC_VERIFIER,
      language: 'it_IT',
    })
    const expected =
      'https://www.amazon.it/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.it%2Fap%2Fmaplanding' +
      '&openid.assoc_handle=amzn_dp_project_dee_ios_it' +
      '&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select' +
      '&pageId=amzn_dp_project_dee_ios_it&accountStatusPolicy=P1' +
      '&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select' +
      '&openid.mode=checkid_setup' +
      '&openid.ns.oa2=http%3A%2F%2Fwww.amazon.it%2Fap%2Fext%2Foauth%2F2' +
      '&openid.oa2.client_id=device%3ADEVICE-ID' +
      '&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0' +
      '&openid.oa2.response_type=code' +
      '&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0' +
      '&openid.pape.max_auth_age=0&openid.oa2.scope=device_auth_access' +
      '&openid.oa2.code_challenge_method=S256' +
      `&openid.oa2.code_challenge=${RFC_CHALLENGE}&language=it_IT`
    expect(url).toBe(expected)
  })

  it('has no handle suffix on amazon.com', () => {
    const url = new URL(
      buildSignInUrl({
        amazonDomain: 'amazon.com',
        deviceId: 'D',
        codeVerifier: RFC_VERIFIER,
        language: 'en_US',
      }),
    )
    expect(url.searchParams.get('openid.assoc_handle')).toBe('amzn_dp_project_dee_ios')
    expect(url.searchParams.get('pageId')).toBe('amzn_dp_project_dee_ios')
  })

  it('draws every per-attempt value from the injected randomness', () => {
    const calls: number[] = []
    const secrets = newOauthAttemptSecrets((size) => {
      calls.push(size)
      return Buffer.alloc(size, 0xab)
    })
    // verifier (32 bytes), device id (16 bytes), frc (313 bytes), in that order
    expect(calls).toEqual([32, 16, 313])
    expect(secrets.codeVerifier).toBe(Buffer.alloc(32, 0xab).toString('base64url'))
    const hex = 'AB'.repeat(16)
    expect(secrets.deviceId).toBe(`${Buffer.from(hex).toString('hex')}23413249564c5635564d32573831`)
    expect(secrets.frc).toBe(Buffer.alloc(313, 0xab).toString('base64'))
    expect(Buffer.from(secrets.mapMd, 'base64').toString('utf8')).toContain(
      '"app_version":"2.2.651540.0"',
    )
  })
})
