import { describe, expect, it } from 'vitest'
import {
  filterForwardedCookies,
  isValidUpstream,
  parseProxyPath,
  rewriteBody,
  rewriteLocation,
  rewriteReferer,
  rewriteSetCookie,
  upstreamUrlFor,
  type LoginProxyRoute,
  type LoginProxyUpstream,
} from '../url-rewrite.js'

const AUTH: LoginProxyUpstream = { host: 'auth.vendor.test', scheme: 'https' }
const API: LoginProxyUpstream = { host: 'api.vendor.test', scheme: 'https' }
const route: LoginProxyRoute = {
  basePath: '/addon/demo/login/ATTEMPT12',
  upstreams: [AUTH, API],
}

describe('rewriteLocation', () => {
  it('maps an absolute vendor URL to the proxy path, keeping query and hash', () => {
    expect(rewriteLocation('https://api.vendor.test/x?a=1#f', AUTH, route)).toBe(
      '/addon/demo/login/ATTEMPT12/api.vendor.test/x?a=1#f',
    )
  })
  it('resolves a relative Location against the current upstream host', () => {
    expect(rewriteLocation('/next?s=1', AUTH, route)).toBe(
      '/addon/demo/login/ATTEMPT12/auth.vendor.test/next?s=1',
    )
  })
  it('leaves a host outside the allow-list and an app scheme untouched', () => {
    expect(rewriteLocation('https://elsewhere.test/a', AUTH, route)).toBe(
      'https://elsewhere.test/a',
    )
    expect(rewriteLocation('hcauth://auth/prod?code=X', AUTH, route)).toBe(
      'hcauth://auth/prod?code=X',
    )
  })
})

describe('rewriteBody', () => {
  it('rewrites absolute, protocol-relative and JSON-escaped URLs for several hosts', () => {
    const body =
      '<a href="https://auth.vendor.test/a">x</a><script>var u="//api.vendor.test/b";' +
      'var j="https:\\/\\/api.vendor.test\\/c";</script>'
    const out = rewriteBody(body, 'html', AUTH, route)
    expect(out).toContain('href="/addon/demo/login/ATTEMPT12/auth.vendor.test/a"')
    expect(out).toContain('"/addon/demo/login/ATTEMPT12/api.vendor.test/b"')
    expect(out).toContain('"\\/addon\\/demo\\/login\\/ATTEMPT12\\/api.vendor.test\\/c"')
  })
  it('leaves a vendor URL that is a query parameter value alone (plain and encoded)', () => {
    const body =
      '<a href="/ap/signin?return_to=https://auth.vendor.test/maplanding&x=1">a</a>' +
      '<a href="/ap/signin?return_to=https%3A%2F%2Fauth.vendor.test%2Fmaplanding">b</a>'
    const out = rewriteBody(body, 'other', AUTH, route)
    expect(out).toContain('return_to=https://auth.vendor.test/maplanding&x=1')
    expect(out).toContain('return_to=https%3A%2F%2Fauth.vendor.test%2Fmaplanding')
    expect(out).not.toContain('/addon/demo/login/ATTEMPT12')
  })
  it('pulls root-relative references in HTML under the current host, not the hub root', () => {
    const out = rewriteBody(
      '<form action="/ax/claim"><img src="/p.png"><link href="//cdn.other/x"></form>',
      'html',
      AUTH,
      route,
    )
    expect(out).toContain('action="/addon/demo/login/ATTEMPT12/auth.vendor.test/ax/claim"')
    expect(out).toContain('src="/addon/demo/login/ATTEMPT12/auth.vendor.test/p.png"')
    expect(out).toContain('href="//cdn.other/x"')
  })
  it('does not rewrite root-relative references in non-HTML bodies', () => {
    expect(rewriteBody('{"a":"href=\\"/x\\""}', 'other', AUTH, route)).toBe('{"a":"href=\\"/x\\""}')
  })
})

describe('rewriteSetCookie', () => {
  it('drops Domain, scopes Path to the attempt and keeps Secure and HttpOnly', () => {
    const out = rewriteSetCookie('sid=abc; Domain=.vendor.test; Path=/; Secure; HttpOnly', route)
    expect(out).toBe('sid=abc; Secure; HttpOnly; Path=/addon/demo/login/ATTEMPT12/')
  })
})

describe('request side', () => {
  it('turns a proxy Referer back into the vendor URL and drops one that is not ours', () => {
    expect(
      rewriteReferer('https://hub.lan/addon/demo/login/ATTEMPT12/auth.vendor.test/p?q=1', route),
    ).toBe('https://auth.vendor.test/p?q=1')
    expect(rewriteReferer('https://hub.lan/admin/page', route)).toBeNull()
  })
  it('never forwards the hub session cookie', () => {
    expect(filterForwardedCookies('camstack_session=SECRET; sid=1; theme=x')).toBe('sid=1; theme=x')
  })
})

describe('allow-list', () => {
  it('accepts http for loopback only', () => {
    expect(isValidUpstream({ host: '127.0.0.1:3456', scheme: 'http' })).toBe(true)
    expect(isValidUpstream({ host: 'evil.test', scheme: 'http' })).toBe(false)
    expect(isValidUpstream({ host: 'evil.test/path', scheme: 'https' })).toBe(false)
  })
  it('parses a proxy path and refuses a path that would change the host', () => {
    const parsed = parseProxyPath('/ATTEMPT12/auth.vendor.test/a/b?x=1')
    expect(parsed).toEqual({
      attemptId: 'ATTEMPT12',
      host: 'auth.vendor.test',
      pathname: '/a/b',
      search: '?x=1',
    })
    const evil = parseProxyPath('/ATTEMPT12/auth.vendor.test//evil.test/x')
    expect(evil).not.toBeNull()
    expect(upstreamUrlFor(AUTH, evil!)?.host).toBe('auth.vendor.test')
  })
})
