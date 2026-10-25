import type { OauthLandingOutcome } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { BROKER_OAUTH_MESSAGE } from '../broker-oauth-popup'
import { deliverOauthOutcome, oauthReturnPath } from '../oauth-landing'

const OK: OauthLandingOutcome = {
  status: 'success',
  addonId: 'google-services',
  brokerId: 'google_001',
}

describe('oauthReturnPath', () => {
  it('a broker flow returns to that addon on Connectivity -> Brokers', () => {
    expect(oauthReturnPath(OK)).toBe('/system/integrations?tab=brokers&integration=google-services')
  })

  it('an account link returns to its integration', () => {
    expect(
      oauthReturnPath({ status: 'error', integration: 'export-alexa', reason: 'invalid_request' }),
    ).toBe('/system/integrations?integration=export-alexa')
  })

  it('never builds a path from anything but a plain id', () => {
    expect(oauthReturnPath({ status: 'success', addonId: '../../evil?x=1' })).toBe(
      '/system/integrations',
    )
  })

  it('knows nothing -> the integrations page', () => {
    expect(oauthReturnPath({ status: 'error', reason: 'unknown' })).toBe('/system/integrations')
  })
})

describe('deliverOauthOutcome', () => {
  const origin = 'https://hub.example'

  function opener(sameOrigin = true) {
    const postMessage = vi.fn()
    const win = {
      closed: false,
      postMessage,
      location: sameOrigin
        ? { origin }
        : {
            get origin(): string {
              throw new Error('cross-origin')
            },
          },
    } as unknown as Window
    return { win, postMessage }
  }

  it('hands the outcome to a same-origin opener, to its own origin only, and reports it taken', () => {
    const { win, postMessage } = opener()
    expect(deliverOauthOutcome(OK, { opener: win, origin })).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(
      { type: BROKER_OAUTH_MESSAGE, ok: true, brokerId: 'google_001' },
      origin,
    )
  })

  it('carries the reason CODE on a failure, never a message', () => {
    const { win, postMessage } = opener()
    deliverOauthOutcome(
      { status: 'error', addonId: 'google-services', reason: 'access_denied' },
      { opener: win, origin },
    )
    expect(postMessage).toHaveBeenCalledWith(
      { type: BROKER_OAUTH_MESSAGE, ok: false, error: 'access_denied' },
      origin,
    )
  })

  it('does nothing without an opener, with a closed one, or at another origin', () => {
    expect(deliverOauthOutcome(OK, { opener: null, origin })).toBe(false)
    const closed = opener()
    ;(closed.win as unknown as { closed: boolean }).closed = true
    expect(deliverOauthOutcome(OK, { opener: closed.win, origin })).toBe(false)
    const foreign = opener(false)
    expect(deliverOauthOutcome(OK, { opener: foreign.win, origin })).toBe(false)
    expect(foreign.postMessage).not.toHaveBeenCalled()
  })
})
