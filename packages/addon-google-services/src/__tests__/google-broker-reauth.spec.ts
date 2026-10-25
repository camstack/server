import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { GoogleBrokerRegistry } from '../google-broker-registry.js'
import { buildGoogleBrokerReconnectAlert } from '../google-broker-reconnect-alert.js'
import { GoogleServicesAddon } from '../google-services.addon.js'

vi.mock('../google-oauth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../google-oauth.js')>()
  return {
    ...original,
    refreshAccessToken: vi.fn(),
    exchangeCode: vi.fn(),
    needsRefresh: () => true,
  }
})

import { exchangeCode, refreshAccessToken } from '../google-oauth.js'

const HUB = 'https://hub.example'
const LANDING = `${HUB}/sso-complete#return=oauth`

function mockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function seedAddon(emit = vi.fn(async (_alert: unknown) => undefined)): GoogleServicesAddon {
  const addon = new GoogleServicesAddon()
  const registry = new GoogleBrokerRegistry()
  registry.seedFrom(
    [
      {
        id: 'google_001',
        name: 'Work Google',
        clientId: 'cid',
        clientSecret: 'sec',
        calendarFilter: '',
        fromAddress: '',
        fromName: '',
      },
    ],
    [
      {
        id: 'google_001',
        refreshToken: 'rt',
        accessToken: 'at',
        accessExpiresAt: 0,
        accountEmail: 'a@example.com',
        needsReauth: false,
      },
    ],
  )
  Reflect.set(addon, 'registry', registry)
  Reflect.set(addon, '_ctx', {
    api: {
      alerts: { emit: { mutate: emit }, update: { mutate: vi.fn(async () => undefined) } },
      localNetwork: {
        getAddresses: {
          query: async () => ({
            roles: {
              publicEndpoint: { resolved: HUB },
              internal: { resolved: null },
            },
          }),
        },
      },
    },
    logger: mockLogger(),
  } as unknown as AddonContext)
  return addon
}

function call(addon: GoogleServicesAddon, method: string, ...args: unknown[]): Promise<unknown> {
  return Reflect.apply(Reflect.get(addon, method), addon, args)
}

function fakeReply() {
  return {
    header: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
    redirect: vi.fn(),
  }
}

function registryOf(addon: GoogleServicesAddon): GoogleBrokerRegistry {
  const registry: unknown = Reflect.get(addon, 'registry')
  if (!(registry instanceof GoogleBrokerRegistry)) throw new Error('no registry')
  return registry
}

const INVALID_GRANT = new Error('Google token refresh failed (400): {"error":"invalid_grant"}')

describe('reconnect alert action', () => {
  it('is a SERVER navigation: the SPA has no /addon/<id>/oauth route', () => {
    const alert = buildGoogleBrokerReconnectAlert('google_001', 'Work Google')
    expect(alert.action?.navigation).toBe('server')
    expect(alert.action?.href).toBe('/addon/google-services/oauth/start?brokerId=google_001')
  })
})

describe('a dead refresh token is reported as needing a new sign-in', () => {
  beforeEach(() => {
    vi.mocked(refreshAccessToken).mockReset()
    vi.mocked(exchangeCode).mockReset()
  })

  it('invalid_grant flips the broker to auth-failed, not connected', async () => {
    vi.mocked(refreshAccessToken).mockRejectedValue(INVALID_GRANT)
    const addon = seedAddon()
    const registry = registryOf(addon)
    expect(registry.isConnected('google_001')).toBe(true)

    await expect(call(addon, 'ensureAccessToken', 'google_001')).rejects.toThrow(/invalid_grant/)

    expect(registry.isConnected('google_001')).toBe(false)
    const info = registry.toBrokerInfo(registry.getEntry('google_001')!, 'google-services')
    expect(info.status).toBe('auth-failed')
    expect(info.error).toMatch(/sign in again/i)
    expect(registry.connectedSize()).toBe(0)
  })

  it('does not ask Google again with a token it knows is dead, nor re-raise the alert', async () => {
    vi.mocked(refreshAccessToken).mockRejectedValue(INVALID_GRANT)
    const emit = vi.fn(async (_alert: unknown) => undefined)
    const addon = seedAddon(emit)
    await expect(call(addon, 'ensureAccessToken', 'google_001')).rejects.toThrow()
    await expect(call(addon, 'ensureAccessToken', 'google_001')).rejects.toThrow(/sign in/i)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1))
  })

  it('a successful OAuth callback clears it', async () => {
    vi.mocked(refreshAccessToken).mockRejectedValue(INVALID_GRANT)
    vi.mocked(exchangeCode).mockResolvedValue({
      access_token: 'new-access',
      expires_in: 3600,
      refresh_token: 'new-refresh',
    })
    const addon = seedAddon()
    const registry = registryOf(addon)
    await expect(call(addon, 'ensureAccessToken', 'google_001')).rejects.toThrow()
    expect(registry.isConnected('google_001')).toBe(false)

    Reflect.set(addon, 'fetchAccountEmail', async () => '')
    const pending = Reflect.get(addon, 'pendingStates') as Map<string, unknown>
    pending.set('s1', { brokerId: 'google_001', popup: false, issuedAt: Date.now() })
    await call(addon, 'handleCallback', { query: { code: 'c', state: 's1' } }, fakeReply())

    expect(registry.isConnected('google_001')).toBe(true)
    expect(registry.getOauth('google_001')?.needsReauth).toBe(false)
  })
})

describe('the OAuth callback lands in CamStack, never on a bare text page', () => {
  beforeEach(() => {
    vi.mocked(exchangeCode).mockReset()
  })

  async function runCallback(
    addon: GoogleServicesAddon,
    query: Record<string, string>,
    popup = false,
  ): Promise<ReturnType<typeof fakeReply>> {
    const pending = Reflect.get(addon, 'pendingStates') as Map<string, unknown>
    pending.set('st', { brokerId: 'google_001', popup, issuedAt: Date.now() })
    const reply = fakeReply()
    await call(addon, 'handleCallback', { query }, reply)
    return reply
  }

  it('success redirects to the landing with broker and addon, and no text body', async () => {
    vi.mocked(exchangeCode).mockResolvedValue({
      access_token: 'a',
      expires_in: 3600,
      refresh_token: 'r',
    })
    const addon = seedAddon()
    Reflect.set(addon, 'fetchAccountEmail', async () => '')
    const reply = await runCallback(addon, { code: 'c', state: 'st' })
    expect(reply.redirect).toHaveBeenCalledWith(
      `${LANDING}&status=success&addon=google-services&broker=google_001`,
    )
    expect(reply.send).not.toHaveBeenCalled()
  })

  it('the popup flow lands on the same page (it posts to its opener itself)', async () => {
    vi.mocked(exchangeCode).mockResolvedValue({
      access_token: 'a',
      expires_in: 3600,
      refresh_token: 'r',
    })
    const addon = seedAddon()
    Reflect.set(addon, 'fetchAccountEmail', async () => '')
    const reply = await runCallback(addon, { code: 'c', state: 'st' }, true)
    expect(reply.redirect).toHaveBeenCalledWith(
      `${LANDING}&status=success&addon=google-services&broker=google_001`,
    )
  })

  it('a consent the user refused lands as access_denied', async () => {
    const reply = await runCallback(seedAddon(), { error: 'access_denied', state: 'st' })
    expect(reply.redirect).toHaveBeenCalledWith(
      `${LANDING}&status=error&addon=google-services&broker=google_001&reason=access_denied`,
    )
  })

  it('an unknown state lands as invalid_state', async () => {
    const reply = fakeReply()
    await call(seedAddon(), 'handleCallback', { query: { code: 'c', state: 'nope' } }, reply)
    expect(reply.redirect).toHaveBeenCalledWith(
      `${LANDING}&status=error&addon=google-services&reason=invalid_state`,
    )
  })

  it('a failed code exchange lands as exchange_failed and leaks neither code nor message', async () => {
    vi.mocked(exchangeCode).mockRejectedValue(new Error('boom code=SECRET-CODE'))
    const reply = await runCallback(seedAddon(), { code: 'SECRET-CODE', state: 'st' })
    const url = String(reply.redirect.mock.calls[0]?.[0])
    expect(url).toContain('reason=exchange_failed')
    expect(url).not.toContain('SECRET')
    expect(url).not.toContain('boom')
  })

  it('sign-out lands on the same page', async () => {
    const addon = seedAddon()
    const reply = fakeReply()
    await call(addon, 'handleDisconnect', { query: { brokerId: 'google_001' } }, reply)
    expect(reply.redirect).toHaveBeenCalledWith(
      `${LANDING}&status=success&addon=google-services&broker=google_001&action=disconnect`,
    )
  })
})
