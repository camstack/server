import { describe, it, expect } from 'vitest'
import type { LoginProxyResponseView } from '@camstack/types'
import { cookieSuccessTerminal } from '../alexa-proxy-login-manager.js'

function view(overrides: Partial<LoginProxyResponseView>): LoginProxyResponseView {
  return {
    status: 200,
    url: 'http://127.0.0.1:3456/',
    location: null,
    setCookies: [],
    bodyText: null,
    ...overrides,
  }
}

const MAP = 'http://127.0.0.1:3456/www.amazon.it/ap/maplanding'

describe('cookieSuccessTerminal', () => {
  it('ends at once as no_authorization_code on a maplanding Location without the oa2 code', () => {
    const verdict = cookieSuccessTerminal(
      view({ status: 302, location: `${MAP}?openid.mode=id_res&openid.sig=x&serial=` }),
    )
    expect(verdict).toEqual({ kind: 'done', payload: 'no_authorization_code' })
  })

  it('ends as no_authorization_code when the request itself was a code-less maplanding', () => {
    expect(cookieSuccessTerminal(view({ url: `${MAP}?openid.mode=id_res` }))).toEqual({
      kind: 'done',
      payload: 'no_authorization_code',
    })
  })

  it('waits for the registration when the maplanding carries the oa2 code', () => {
    expect(
      cookieSuccessTerminal(
        view({ status: 302, location: `${MAP}?openid.oa2.authorization_code=abc` }),
      ),
    ).toEqual({ kind: 'done', payload: 'registering' })
  })

  it('waits for the registration on the cookie-success page', () => {
    expect(
      cookieSuccessTerminal(
        view({ status: 302, location: 'http://127.0.0.1:3456/cookie-success' }),
      ),
    ).toEqual({ kind: 'done', payload: 'registering' })
  })

  it('keeps going on an ordinary sign-in page', () => {
    expect(
      cookieSuccessTerminal(view({ url: 'http://127.0.0.1:3456/www.amazon.it/ap/signin' })).kind,
    ).toBe('continue')
    expect(
      cookieSuccessTerminal(
        view({ status: 302, location: 'http://127.0.0.1:3456/www.amazon.it/ap/cvf/request' }),
      ).kind,
    ).toBe('continue')
  })
})
