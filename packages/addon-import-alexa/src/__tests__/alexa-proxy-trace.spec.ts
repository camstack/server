import { describe, it, expect } from 'vitest'
import { sanitizeProxyTraceLine } from '../alexa-proxy-trace.js'

describe('sanitizeProxyTraceLine', () => {
  it('keeps method and path of a Router line, drops query and the JSON headers', () => {
    const line =
      'Router: /ax/claim?arb=SECRETARB&openid.return_to=https://www.amazon.com/ap/maplanding / POST / {"cookie":"session-id=abc","host":"127.0.0.1:3456"}'
    expect(sanitizeProxyTraceLine(line)).toBe(
      'router POST /ax/claim names=[arb,openid.return_to] oa2=false return_to=true assoc_handle=false mode=false ua=none',
    )
  })

  it('keeps the proxied method and target without query for Proxy-Request', () => {
    const out = sanitizeProxyTraceLine(
      'Alexa-Cookie: Proxy-Request: GET https://www.amazon.com/ap/signin?openid.assoc_handle=x&token=y',
    )
    expect(out).toBe(
      'proxy-request GET https://www.amazon.com/ap/signin names=[openid.assoc_handle,token] oa2=false return_to=false assoc_handle=true mode=false',
    )
  })

  it('ignores the debug-level modified Proxy-Request dump', () => {
    expect(
      sanitizeProxyTraceLine(
        'Alexa-Cookie: Proxy-Request: (modified:true){"headers":{"cookie":"a=b"}}',
      ),
    ).toBeNull()
  })

  it('keeps the upstream host of a Proxy Response line', () => {
    expect(sanitizeProxyTraceLine('Alexa-Cookie: Proxy Response from Host: www.amazon.com')).toBe(
      'proxy-response host=www.amazon.com',
    )
  })

  it('keeps redirect targets without query or fragment', () => {
    expect(
      sanitizeProxyTraceLine(
        'Redirect: Original Location ----> https://www.amazon.com/ax/claim?arb=SECRET#frag',
      ),
    ).toBe(
      'redirect-original https://www.amazon.com/ax/claim names=[arb] oa2=false return_to=false assoc_handle=false mode=false',
    )
    expect(
      sanitizeProxyTraceLine('Redirect: Final Location ----> /127.0.0.1:3456/ax/claim?arb=SECRET'),
    ).toBe(
      'redirect-final /127.0.0.1:3456/ax/claim names=[arb] oa2=false return_to=false assoc_handle=false mode=false',
    )
  })

  it('reports oa2 presence on a redirect and never a value', () => {
    const out = sanitizeProxyTraceLine(
      'Redirect: Original Location ----> https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=SECRETCODE&openid.mode=SECRETMODE',
    )
    expect(out).toContain('oa2=true')
    expect(out).not.toContain('SECRET')
  })

  it('traces the initial outgoing sign-in request: path, names, oa2 flag, never values', () => {
    const out = sanitizeProxyTraceLine(
      'Alexa-Cookie: Initial Page Request: https://www.amazon.it/ap/signin?openid.assoc_handle=amzn_dp_project_dee_iosit&openid.oa2.client_id=device%3ASECRETID&openid.oa2.code_challenge=SECRETCH&openid.mode=checkid_setup&language=it_IT',
    )
    expect(out).toBe(
      'initial-request https://www.amazon.it/ap/signin names=[language,openid.assoc_handle,openid.mode,openid.oa2.client_id,openid.oa2.code_challenge] oa2=true return_to=false assoc_handle=true mode=true',
    )
    expect(out).not.toContain('SECRET')
  })

  it('adds the user-agent family to a Router line, not the agent string', () => {
    const out = sanitizeProxyTraceLine(
      'Router: /ap/signin / GET / {"user-agent":"Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15","cookie":"a=b"}',
    )
    expect(out).toContain('ua=safari')
    expect(out).not.toContain('Mozilla')
    expect(out).not.toContain('a=b')
  })

  it('returns null for any other line', () => {
    expect(sanitizeProxyTraceLine('Result: csrf=1, Cookie=2')).toBeNull()
    expect(sanitizeProxyTraceLine('something else')).toBeNull()
  })
})
