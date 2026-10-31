import { describe, expect, it } from 'vitest'
import { classifyWindowOpen } from '../role/window-open-policy'

const HUB = 'https://192.168.10.9:4443'

describe('classifyWindowOpen', () => {
  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    ['blank popup', 'about:blank', '', 'child'],
    ['hub url', `${HUB}/api/auth/sso/oidc/start?popup=1`, 'camstack-sso', 'child'],
    ['hub url, no name', `${HUB}/viewer/`, '', 'child'],
    ['IdP inside the SSO popup', 'https://auth.example.com/authorize', 'camstack-sso', 'child'],
    ['other site, no auth flow', 'https://docs.example.com/x', '', 'external'],
    ['other origin port', 'https://192.168.10.9:4444/', '', 'external'],
    ['file scheme', 'file:///etc/passwd', '', 'deny'],
    ['javascript scheme', 'javascript:alert(1)', '', 'deny'],
    ['malformed', 'not a url', '', 'deny'],
    ['non-http in sso popup', 'file:///x', 'camstack-sso', 'deny'],
  ]
  it.each(cases)('%s', (_label, url, name, action) => {
    expect(classifyWindowOpen(url, HUB, name).action).toBe(action)
  })

  it('hands an external url to the system browser verbatim', () => {
    expect(classifyWindowOpen('https://docs.example.com/x', HUB)).toEqual({
      action: 'external',
      url: 'https://docs.example.com/x',
    })
  })
})
