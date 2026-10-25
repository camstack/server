import { describe, expect, it } from 'vitest'
import { AlertActionSchema } from '../../capabilities/alerts.cap.js'
import {
  OAUTH_LANDING_PATH,
  isOauthLandingReason,
  oauthLandingUrl,
  parseOauthLandingFragment,
} from '../oauth-landing.js'

describe('oauthLandingUrl', () => {
  it('lands on the admin-ui completion route with the outcome in the FRAGMENT', () => {
    const url = oauthLandingUrl('https://hub.example.com/', {
      status: 'success',
      addonId: 'google-services',
      brokerId: 'google_001',
    })
    expect(url).toBe(
      `https://hub.example.com${OAUTH_LANDING_PATH}#return=oauth&status=success&addon=google-services&broker=google_001`,
    )
    expect(url.split('#')[0]).not.toContain('?')
  })

  it('carries a reason code on an error and never a free-form message', () => {
    const url = oauthLandingUrl(null, {
      status: 'error',
      addonId: 'google-services',
      reason: 'access_denied',
    })
    expect(url).toBe(
      `${OAUTH_LANDING_PATH}#return=oauth&status=error&addon=google-services&reason=access_denied`,
    )
  })

  it('round-trips through parseOauthLandingFragment', () => {
    const url = oauthLandingUrl('https://hub.example.com', {
      status: 'error',
      addonId: 'export-alexa',
      integration: 'export-alexa',
      reason: 'invalid_request',
    })
    const parsed = parseOauthLandingFragment(url.slice(url.indexOf('#')))
    expect(parsed).toEqual({
      status: 'error',
      addonId: 'export-alexa',
      integration: 'export-alexa',
      reason: 'invalid_request',
    })
  })
})

describe('a sign-out landing', () => {
  it('round-trips the disconnect action', () => {
    const url = oauthLandingUrl(null, {
      status: 'success',
      addonId: 'google-services',
      brokerId: 'google_001',
      action: 'disconnect',
    })
    expect(url).toContain('&action=disconnect')
    expect(parseOauthLandingFragment(url.slice(url.indexOf('#')))?.action).toBe('disconnect')
  })
})

describe('parseOauthLandingFragment', () => {
  it('ignores anything that is not an oauth landing', () => {
    expect(parseOauthLandingFragment('#return=login&token=x')).toBeNull()
    expect(parseOauthLandingFragment('')).toBeNull()
    expect(parseOauthLandingFragment('#return=oauth&status=maybe')).toBeNull()
  })

  it('maps an unknown reason to "unknown" instead of echoing it', () => {
    const parsed = parseOauthLandingFragment('#return=oauth&status=error&addon=a&reason=<script>')
    expect(parsed?.reason).toBe('unknown')
    expect(isOauthLandingReason('access_denied')).toBe(true)
    expect(isOauthLandingReason('<script>')).toBe(false)
  })

  it('drops a code or token smuggled into the fragment', () => {
    const parsed = parseOauthLandingFragment(
      '#return=oauth&status=success&addon=a&code=abc&token=secret&access_token=t',
    )
    expect(JSON.stringify(parsed)).not.toContain('abc')
    expect(JSON.stringify(parsed)).not.toContain('secret')
  })
})

describe('AlertActionSchema', () => {
  it('accepts navigation "server" and stays backward compatible without it', () => {
    expect(
      AlertActionSchema.parse({
        label: 'Sign in',
        href: '/addon/x/oauth/start',
        navigation: 'server',
      }).navigation,
    ).toBe('server')
    expect(AlertActionSchema.parse({ label: 'Open', href: '/devices' }).navigation).toBeUndefined()
    expect(() => AlertActionSchema.parse({ label: 'x', navigation: 'popup' })).toThrow()
  })
})
