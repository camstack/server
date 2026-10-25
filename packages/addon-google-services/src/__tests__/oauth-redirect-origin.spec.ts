import { describe, expect, it } from 'vitest'
import { pickOauthRedirectOrigin } from '../oauth-redirect-origin.js'

describe('pickOauthRedirectOrigin', () => {
  it('prefers publicEndpoint over internal (OAuth2 / sign-in role)', () => {
    expect(
      pickOauthRedirectOrigin({
        roles: {
          publicEndpoint: { resolved: 'https://hub.example' },
          internal: { resolved: 'http://192.0.2.10:4480' },
        },
      }),
    ).toBe('https://hub.example')
  })

  it('falls back to internal when public is unset', () => {
    expect(
      pickOauthRedirectOrigin({
        roles: {
          publicEndpoint: { resolved: null },
          internal: { resolved: 'https://10.0.0.2:4443' },
        },
      }),
    ).toBe('https://10.0.0.2:4443')
  })

  it('returns null when neither role has an address', () => {
    expect(
      pickOauthRedirectOrigin({
        roles: {
          publicEndpoint: { resolved: null },
          internal: { resolved: null },
        },
      }),
    ).toBeNull()
  })
})
