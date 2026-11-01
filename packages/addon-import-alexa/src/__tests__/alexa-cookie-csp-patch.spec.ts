import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// The login proxy is patched (patches/alexa-cookie2+5.0.6.patch) to drop
// `upgrade-insecure-requests` from Amazon's CSP: the proxy is plain http.
interface ProxyModule {
  readonly stripUpgradeInsecureRequestsHeaders: (res: {
    headers: Record<string, string | string[]>
  }) => void
}
const proxyModule: ProxyModule = createRequire(import.meta.url)('alexa-cookie2/lib/proxy.js')

describe('alexa-cookie2 login proxy CSP patch', () => {
  it('drops only upgrade-insecure-requests and keeps the other directives', () => {
    const res = {
      headers: {
        'content-security-policy':
          "frame-ancestors 'self'; upgrade-insecure-requests; form-action 'self'",
        'content-type': 'text/html',
      },
    }
    proxyModule.stripUpgradeInsecureRequestsHeaders(res)
    expect(res.headers).toEqual({
      'content-security-policy': "frame-ancestors 'self'; form-action 'self'",
      'content-type': 'text/html',
    })
  })

  it('removes a header left empty and handles the report-only array form', () => {
    const res = {
      headers: {
        'content-security-policy': 'Upgrade-Insecure-Requests',
        'content-security-policy-report-only': [
          'upgrade-insecure-requests; report-uri /r',
          'upgrade-insecure-requests',
        ],
      },
    }
    proxyModule.stripUpgradeInsecureRequestsHeaders(res)
    expect(res.headers).toEqual({ 'content-security-policy-report-only': 'report-uri /r' })
  })
})
