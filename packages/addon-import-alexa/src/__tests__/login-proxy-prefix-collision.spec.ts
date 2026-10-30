/**
 * The hub's `/addon/<id>/*` dispatch consults the data-plane prefixes BEFORE the
 * addon's own HTTP routes (`server/backend/src/main.ts`, `DataPlaneRegistry.match`).
 * A login-proxy prefix that equals the first segment of a route the addon serves
 * therefore swallows that route: `POST /login/start` reached the proxy as attempt
 * "start" and answered HTML, which the admin UI could not parse.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { VENDOR_LOGIN_PROXY_PREFIX } from '@camstack/types'
import { buildAlexaLoginRoutes } from '../alexa-login-routes.js'
import type { AlexaLoginRouteDeps } from '../alexa-login-routes.js'
import type { AlexaDeviceCodeManager } from '../alexa-device-code-manager.js'
import type { AlexaProxyLoginManager } from '../alexa-proxy-login-manager.js'

function swallowedBy(prefix: string, routePath: string): boolean {
  const normalized = `/${routePath.replace(/^\/+|\/+$/g, '')}`
  const p = `/${prefix.replace(/^\/+|\/+$/g, '')}`
  return normalized === p || normalized.startsWith(`${p}/`)
}

function deps(): AlexaLoginRouteDeps {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const proxyLogin = Object.create(null) as AlexaProxyLoginManager
  const deviceCode = Object.create(null) as AlexaDeviceCodeManager
  return { logger, proxyLogin, deviceCode, commitCookie: async () => ({ brokerId: 'b' }) }
}

describe('the login proxy prefix', () => {
  it('shadows none of the routes the addon serves', () => {
    const routes = buildAlexaLoginRoutes(deps())
    expect(routes.length).toBeGreaterThan(0)
    const swallowed = routes
      .filter((r) => swallowedBy(VENDOR_LOGIN_PROXY_PREFIX, r.path))
      .map((r) => r.path)
    expect(swallowed).toEqual([])
  })
})
