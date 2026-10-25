import { describe, expect, it } from 'vitest'
import { buildAppCallbackUrl, parseAppHandoffParams } from '../login-redirect'

const CHALLENGE = 'a'.repeat(43)

describe('app handoff params (D855)', () => {
  it('reads the PKCE challenge, state and purpose from the login URL', () => {
    expect(
      parseAppHandoffParams({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        state: 'st-1',
        purpose: 'step-up',
      }),
    ).toEqual({ codeChallenge: CHALLENGE, state: 'st-1', purpose: 'step-up' })
  })

  it('defaults the purpose to new-session and refuses a missing, short or non-S256 binding', () => {
    expect(parseAppHandoffParams({ codeChallenge: CHALLENGE, state: 's' })?.purpose).toBe(
      'new-session',
    )
    expect(parseAppHandoffParams({ state: 's' })).toBeNull()
    expect(parseAppHandoffParams({ codeChallenge: 'short', state: 's' })).toBeNull()
    expect(parseAppHandoffParams({ codeChallenge: CHALLENGE })).toBeNull()
    expect(
      parseAppHandoffParams({ codeChallenge: CHALLENGE, codeChallengeMethod: 'plain', state: 's' }),
    ).toBeNull()
    expect(parseAppHandoffParams({ codeChallenge: CHALLENGE, state: 'bad state!' })).toBeNull()
  })

  it('echoes the state on the callback', () => {
    expect(buildAppCallbackUrl('camstack://auth-callback', 'chc_x', 'st-1')).toBe(
      'camstack://auth-callback?code=chc_x&state=st-1',
    )
  })
})
