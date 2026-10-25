import { describe, expect, it } from 'vitest'
import {
  classifyBearerPrincipal,
  methodAccessForHttpMethod,
  principalMayReachAddon,
  scopesAllowAddon,
  scopesAllowDeviceCap,
} from '../auth/principal-scope.js'
import type { TokenScope } from '../schemas/auth-records.js'

/** The live `export-alexa` descriptor's grant, verbatim. */
const ALEXA_SCOPES: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]

/** The live `homeassistant` descriptor's grant, minus the widening. */
const HA_SCOPES_BEFORE_WIDENING: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
  { type: 'capability', target: 'device-manager', access: ['view'] },
  { type: 'capability', target: 'device-state', access: ['view'] },
  { type: 'capability', target: 'pipeline-orchestrator', access: ['view', 'create'] },
]

describe('methodAccessForHttpMethod', () => {
  it('maps HTTP verbs onto the MethodAccess vocabulary', () => {
    expect(methodAccessForHttpMethod('GET')).toBe('view')
    expect(methodAccessForHttpMethod('HEAD')).toBe('view')
    expect(methodAccessForHttpMethod('POST')).toBe('create')
    expect(methodAccessForHttpMethod('PUT')).toBe('create')
    expect(methodAccessForHttpMethod('PATCH')).toBe('create')
    expect(methodAccessForHttpMethod('DELETE')).toBe('delete')
  })

  it('treats an unknown verb as the most privileged access, never as view', () => {
    expect(methodAccessForHttpMethod('WHATEVER')).toBe('delete')
  })
})

describe('scopesAllowDeviceCap', () => {
  it('accepts only a category:device grant carrying the access', () => {
    expect(scopesAllowDeviceCap(ALEXA_SCOPES, 'view')).toBe(true)
    expect(scopesAllowDeviceCap(ALEXA_SCOPES, 'create')).toBe(true)
    expect(scopesAllowDeviceCap(ALEXA_SCOPES, 'delete')).toBe(false)
    expect(
      scopesAllowDeviceCap([{ type: 'category', target: 'system', access: ['view'] }], 'view'),
    ).toBe(false)
    expect(scopesAllowDeviceCap([], 'view')).toBe(false)
  })
})

describe('scopesAllowAddon', () => {
  it('matches an addon grant by id and access', () => {
    const scopes: readonly TokenScope[] = [
      { type: 'addon', target: 'homeassistant-export', access: ['view', 'create'] },
    ]
    expect(scopesAllowAddon(scopes, 'homeassistant-export', 'create')).toBe(true)
    expect(scopesAllowAddon(scopes, 'homeassistant-export', 'delete')).toBe(false)
    expect(scopesAllowAddon(scopes, 'export-alexa', 'create')).toBe(false)
  })

  it('does NOT let a device-category grant stand in for an addon grant', () => {
    expect(scopesAllowAddon(ALEXA_SCOPES, 'homeassistant-export', 'create')).toBe(false)
  })
})

describe('classifyBearerPrincipal', () => {
  it('calls an ordinary session JWT a session', () => {
    expect(classifyBearerPrincipal({ userId: 'u1', isAdmin: false, scopes: [] })).toEqual({
      kind: 'session',
    })
    expect(classifyBearerPrincipal({ userId: 'u1', isAdmin: true })).toEqual({ kind: 'session' })
  })

  it('calls an oauth-access bridge token an integration token', () => {
    expect(
      classifyBearerPrincipal({
        kind: 'sso-bridge',
        provider: 'oauth-access',
        userId: 'u1',
        isAdmin: false,
        scopes: ALEXA_SCOPES,
      }),
    ).toEqual({ kind: 'integration', provider: 'oauth-access' })
  })

  it('refuses every bridge token that is NOT an API credential', () => {
    // An authorization CODE travels in a browser redirect URL. A REFRESH
    // token is for /token only. A totp-challenge is login leg 1.
    for (const provider of ['oauth-code', 'oauth-refresh', 'oidc', 'magic-link']) {
      expect(
        classifyBearerPrincipal({ kind: 'sso-bridge', provider, userId: 'u1', isAdmin: false }),
      ).toEqual({ kind: 'not-a-credential', reason: `bridge token provider=${provider}` })
    }
    expect(
      classifyBearerPrincipal({ kind: 'totp-challenge', userId: 'u1', isAdmin: false }),
    ).toEqual({ kind: 'not-a-credential', reason: 'bridge token kind=totp-challenge' })
  })
})

describe('principalMayReachAddon — the measured privilege boundary', () => {
  /**
   * Measured on the live hub 2026-08-09: an `oauth-access` token minted for
   * the `export-alexa` integration reached `POST /addon/homeassistant-export/command`
   * and was answered `422 {"error":"malformed topic"}` — i.e. the auth gate
   * PASSED it onto a route that actuates PTZ, reboot, camera switches and
   * snooze for another integration entirely.
   */
  it('REFUSES an Alexa integration token on the Home Assistant command route', () => {
    expect(
      principalMayReachAddon({
        principal: { kind: 'integration', provider: 'oauth-access' },
        scopes: ALEXA_SCOPES,
        isAdmin: false,
        addonId: 'homeassistant-export',
        method: 'POST',
      }),
    ).toEqual({
      allowed: false,
      reason: 'integration token holds no addon:homeassistant-export[create] grant',
    })
  })

  it('REFUSES a Home Assistant token that declares only its tRPC scopes', () => {
    // This is why the descriptor has to be WIDENED rather than the check weakened.
    expect(
      principalMayReachAddon({
        principal: { kind: 'integration', provider: 'oauth-access' },
        scopes: HA_SCOPES_BEFORE_WIDENING,
        isAdmin: false,
        addonId: 'homeassistant-export',
        method: 'POST',
      }).allowed,
    ).toBe(false)
  })

  it('ALLOWS a Home Assistant token once the descriptor declares the addon it calls', () => {
    const widened: readonly TokenScope[] = [
      ...HA_SCOPES_BEFORE_WIDENING,
      { type: 'addon', target: 'homeassistant-export', access: ['view', 'create'] },
    ]
    expect(
      principalMayReachAddon({
        principal: { kind: 'integration', provider: 'oauth-access' },
        scopes: widened,
        isAdmin: false,
        addonId: 'homeassistant-export',
        method: 'POST',
      }),
    ).toEqual({ allowed: true })
  })

  it('leaves ordinary user sessions alone — admin and non-admin alike', () => {
    // The gate must not become stricter for the principals it already served,
    // or it breaks the admin UI and every non-admin viewer instead of the hole.
    expect(
      principalMayReachAddon({
        principal: { kind: 'session' },
        scopes: [],
        isAdmin: false,
        addonId: 'homeassistant-export',
        method: 'POST',
      }),
    ).toEqual({ allowed: true })
    expect(
      principalMayReachAddon({
        principal: { kind: 'session' },
        scopes: [],
        isAdmin: true,
        addonId: 'terminal',
        method: 'POST',
      }),
    ).toEqual({ allowed: true })
  })

  it('REFUSES an authorization code and a refresh token outright, admin flag or not', () => {
    // Measured on the live hub: BOTH reached /command and were answered 422.
    // An authorization code appears in a browser redirect URL.
    for (const provider of ['oauth-code', 'oauth-refresh']) {
      expect(
        principalMayReachAddon({
          principal: { kind: 'not-a-credential', reason: `bridge token provider=${provider}` },
          scopes: [{ type: 'addon', target: 'homeassistant-export', access: ['view', 'create'] }],
          isAdmin: true,
          addonId: 'homeassistant-export',
          method: 'POST',
        }),
      ).toEqual({ allowed: false, reason: `bridge token provider=${provider}` })
    }
  })

  it('does not let an integration token widen itself by claiming isAdmin', () => {
    expect(
      principalMayReachAddon({
        principal: { kind: 'integration', provider: 'oauth-access' },
        scopes: ALEXA_SCOPES,
        isAdmin: true,
        addonId: 'homeassistant-export',
        method: 'POST',
      }).allowed,
    ).toBe(false)
  })
})
