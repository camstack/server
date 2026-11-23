import { describe, expect, it } from 'vitest'
import {
  browserHandoffLocation,
  parseBrowserHandoffDestination,
  ssoReturnLocation,
} from '../native-return.js'

/** D801 — the `Location` rules of the SSO finish and the browser handoff. */
describe('ssoReturnLocation', () => {
  it('prefixes an admin-ui path with the hub mount', () => {
    expect(ssoReturnLocation('/ingress', '/system/my-access?linked=a')).toBe(
      '/ingress/system/my-access?linked=a',
    )
  })

  it('never prefixes a native app return', () => {
    expect(ssoReturnLocation('/ingress', 'camstack://auth-callback?link=nlc_x')).toBe(
      'camstack://auth-callback?link=nlc_x',
    )
  })
})

describe('browserHandoffLocation', () => {
  it('lands on the account page with the session in the fragment', () => {
    const location = browserHandoffLocation('', {
      token: 'jwt.abc',
      user: { id: 'u', username: 'u', isAdmin: false },
      requiresTotp: false,
      expiresAt: 1000,
      refreshToken: 'csr_x',
    })
    expect(location.split('#')[0]).toBe('/login')
    const params = new URLSearchParams(location.split('#')[1])
    expect(params.get('token')).toBe('jwt.abc')
    expect(params.get('refreshToken')).toBe('csr_x')
    expect(params.get('expiresAt')).toBe('1000')
    expect(params.get('next')).toBe('/system/my-access')
  })

  it('no session → the plain login page, nothing in the URL', () => {
    expect(browserHandoffLocation('/m', null)).toBe('/m/login')
  })
})

describe('browserHandoffLocation destination (D1094)', () => {
  const session = {
    token: 'jwt.abc',
    user: { id: 'u', username: 'u', isAdmin: true },
    requiresTotp: false as const,
    expiresAt: 1000,
    refreshToken: 'csr_x',
  }

  it('admin lands on the admin UI root: no next, the session still in the fragment only', () => {
    const location = browserHandoffLocation('', session, 'admin')
    expect(location.split('#')[0]).toBe('/login')
    expect(location.includes('?')).toBe(false)
    const params = new URLSearchParams(location.split('#')[1])
    expect(params.get('token')).toBe('jwt.abc')
    expect(params.has('next')).toBe(false)
  })

  it('account stays the default', () => {
    const params = new URLSearchParams(browserHandoffLocation('', session).split('#')[1])
    expect(params.get('next')).toBe('/system/my-access')
  })

  it('only `admin` is recognised; anything else is the account page', () => {
    expect(parseBrowserHandoffDestination('admin')).toBe('admin')
    expect(parseBrowserHandoffDestination('/evil')).toBe('account')
    expect(parseBrowserHandoffDestination(undefined)).toBe('account')
  })
})
