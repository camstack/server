import { describe, it, expect } from 'vitest'
import { sanitizeProxyTraceLine } from '../alexa-proxy-trace.js'

describe('sanitizeProxyTraceLine', () => {
  it('keeps method and path of a Router line, drops query and the JSON headers', () => {
    const line =
      'Router: /ax/claim?arb=SECRETARB&openid.return_to=https://www.amazon.com/ap/maplanding / POST / {"cookie":"session-id=abc","host":"127.0.0.1:3456"}'
    expect(sanitizeProxyTraceLine(line)).toBe('router POST /ax/claim')
  })

  it('keeps the proxied method and target without query for Proxy-Request', () => {
    const out = sanitizeProxyTraceLine(
      'Alexa-Cookie: Proxy-Request: GET https://www.amazon.com/ap/signin?openid.assoc_handle=x&token=y',
    )
    expect(out).toBe('proxy-request GET https://www.amazon.com/ap/signin')
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
    ).toBe('redirect-original https://www.amazon.com/ax/claim')
    expect(
      sanitizeProxyTraceLine('Redirect: Final Location ----> /127.0.0.1:3456/ax/claim?arb=SECRET'),
    ).toBe('redirect-final /127.0.0.1:3456/ax/claim')
  })

  it('returns null for any other line', () => {
    expect(sanitizeProxyTraceLine('Result: csrf=1, Cookie=2')).toBeNull()
    expect(sanitizeProxyTraceLine('something else')).toBeNull()
  })
})
