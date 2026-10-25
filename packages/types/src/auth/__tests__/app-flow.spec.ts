import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APP_FLOW_DEFAULT_REDIRECT,
  APP_START_REFUSAL_MESSAGES,
  appFlowLocation,
  isAppStartRefusal,
  parseAppFlowRequest,
} from '../app-flow.js'

describe('start refusals', () => {
  it('names every parse refusal and the combined flow, and only those', () => {
    expect(isAppStartRefusal('bad-state')).toBe(true)
    expect(isAppStartRefusal('combined-flow')).toBe(true)
    expect(isAppStartRefusal('constructor')).toBe(false)
    expect(isAppStartRefusal(undefined)).toBe(false)
    expect(Object.keys(APP_START_REFUSAL_MESSAGES)).toContain('bad-redirect')
  })
})

/** The one reading of an app sign-in request (D858): PKCE S256, exact state, allow-listed return. */

const CHALLENGE = createHash('sha256').update('verifier').digest('base64url')
const OK = {
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'abc.DEF_123-~',
  purpose: 'step-up',
}

describe('parseAppFlowRequest', () => {
  it('accepts a complete request and defaults the return to the production scheme', () => {
    expect(parseAppFlowRequest(OK)).toEqual({
      ok: true,
      request: {
        codeChallenge: CHALLENGE,
        state: 'abc.DEF_123-~',
        purpose: 'step-up',
        redirect: APP_FLOW_DEFAULT_REDIRECT,
      },
    })
  })

  it('canonicalises the allow-listed redirect variants', () => {
    for (const redirect of ['camstack.dev:///auth-callback', 'camstack.dev://auth-callback/']) {
      const parsed = parseAppFlowRequest({ ...OK, redirect })
      expect(parsed).toMatchObject({
        ok: true,
        request: { redirect: 'camstack.dev://auth-callback' },
      })
    }
  })

  it.each([
    [{ code_challenge: undefined }, 'bad-challenge'],
    [{ code_challenge: CHALLENGE.slice(1) }, 'bad-challenge'],
    [{ code_challenge: `${CHALLENGE}=` }, 'bad-challenge'],
    [{ code_challenge_method: 'plain' }, 'bad-challenge-method'],
    [{ code_challenge_method: undefined }, 'bad-challenge-method'],
    [{ state: undefined }, 'bad-state'],
    [{ state: 'a b' }, 'bad-state'],
    [{ state: 'x'.repeat(257) }, 'bad-state'],
    [{ purpose: 'renew' }, 'bad-purpose'],
    [{ purpose: undefined }, 'bad-purpose'],
    [{ redirect: 'https://evil.example/cb' }, 'bad-redirect'],
    [{ redirect: 'camstack://auth-callback?x=1' }, 'bad-redirect'],
    [{ redirect: 'camstack://auth-callback#frag' }, 'bad-redirect'],
    [{ redirect: 'camstack://other' }, 'bad-redirect'],
    [{ redirect: 'javascript:alert(1)' }, 'bad-redirect'],
  ])('refuses %j as %s', (patch, reason) => {
    expect(parseAppFlowRequest({ ...OK, ...patch })).toEqual({ ok: false, reason })
  })
})

describe('the page language (lang)', () => {
  it('is carried when allow-listed and dropped (not refused) otherwise', () => {
    expect(parseAppFlowRequest({ ...OK, lang: 'it' })).toMatchObject({
      ok: true,
      request: { lang: 'it' },
    })
    for (const lang of ['xx', '<script>', 'IT', '']) {
      const parsed = parseAppFlowRequest({ ...OK, lang })
      expect(parsed.ok && 'lang' in parsed.request).toBe(false)
    }
    expect(parseAppFlowRequest(OK).ok).toBe(true)
  })
})

describe('appFlowLocation', () => {
  it('echoes the state exactly and encodes values', () => {
    expect(appFlowLocation('camstack://auth-callback', { code: 'chc_1' }, 'a.b-c')).toBe(
      'camstack://auth-callback?code=chc_1&state=a.b-c',
    )
    expect(appFlowLocation('camstack://auth-callback', { error: 'sso-not-linked' })).toBe(
      'camstack://auth-callback?error=sso-not-linked',
    )
  })
})
