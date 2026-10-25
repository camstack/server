import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { GoogleBrokerRegistry } from '../google-broker-registry.js'
import {
  buildGoogleBrokerReconnectAlert,
  isInvalidGrantRefreshError,
} from '../google-broker-reconnect-alert.js'
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

function seedAddon(
  emitMutate: ReturnType<typeof vi.fn<(alert: unknown) => Promise<void>>> = vi.fn(
    async () => undefined,
  ),
  updateMutate: ReturnType<
    typeof vi.fn<(input: { alertId: string; patch: unknown }) => Promise<void>>
  > = vi.fn(async () => undefined),
): GoogleServicesAddon {
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
      },
    ],
  )
  Reflect.set(addon, 'registry', registry)
  Reflect.set(addon, '_ctx', {
    api: {
      alerts: {
        emit: { mutate: emitMutate },
        update: { mutate: updateMutate },
      },
    },
    logger: mockLogger(),
  } as unknown as AddonContext)
  return addon
}

describe('google broker reconnect alert helpers', () => {
  it('detects invalid_grant in refresh errors only', () => {
    expect(
      isInvalidGrantRefreshError(new Error('Google token refresh failed (400): invalid_grant')),
    ).toBe(true)
    expect(
      isInvalidGrantRefreshError(new Error('Google token refresh failed (400): invalid_client')),
    ).toBe(false)
    expect(isInvalidGrantRefreshError(new Error('fetch failed'))).toBe(false)
  })

  it('builds the critical alert shape with action href', () => {
    const alert = buildGoogleBrokerReconnectAlert('google_001', 'Work Google')
    expect(alert.severity).toBe('critical')
    expect(alert.action?.href).toBe('/addon/google-services/oauth/start?brokerId=google_001')
    expect(alert.metadata?.episodeKey).toBe('reconnect')
  })
})

describe('GoogleServicesAddon ensureAccessToken', () => {
  beforeEach(() => {
    vi.mocked(refreshAccessToken).mockReset()
    vi.mocked(exchangeCode).mockReset()
  })

  it('emits reconnect alert on invalid_grant and still throws', async () => {
    const emitMutate = vi.fn<(alert: unknown) => Promise<void>>(async () => undefined)
    vi.mocked(refreshAccessToken).mockRejectedValue(
      new Error('Google token refresh failed (400): {"error":"invalid_grant"}'),
    )
    const addon = seedAddon(emitMutate)
    await expect(
      Reflect.apply(Reflect.get(addon, 'ensureAccessToken'), addon, ['google_001']),
    ).rejects.toThrow(/invalid_grant/)
    await vi.waitFor(() => expect(emitMutate).toHaveBeenCalledTimes(1))
    const emitted = vi.mocked(emitMutate).mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(emitted).toMatchObject({
      id: 'google-broker:google_001',
      category: 'google.broker-reconnect',
      severity: 'critical',
    })
  })

  it('does not emit on invalid_client refresh failure', async () => {
    const emitMutate = vi.fn<(alert: unknown) => Promise<void>>(async () => undefined)
    vi.mocked(refreshAccessToken).mockRejectedValue(
      new Error('Google token refresh failed (401): invalid_client'),
    )
    const addon = seedAddon(emitMutate)
    await expect(
      Reflect.apply(Reflect.get(addon, 'ensureAccessToken'), addon, ['google_001']),
    ).rejects.toThrow(/invalid_client/)
    expect(emitMutate).not.toHaveBeenCalled()
  })

  it('resolves the reconnect alert when OAuth stores a refresh token', async () => {
    const updateMutate = vi.fn<(input: { alertId: string; patch: unknown }) => Promise<void>>(
      async () => undefined,
    )
    const addon = seedAddon(vi.fn(), updateMutate)
    await Reflect.apply(Reflect.get(addon, 'resolveGoogleBrokerReconnectAlert'), addon, [
      'google_001',
    ])
    expect(updateMutate).toHaveBeenCalledWith({
      alertId: 'google-broker:google_001',
      patch: { status: 'completed', read: true },
    })
  })

  it('resolves the reconnect alert from the OAuth callback when exchange returns refresh_token', async () => {
    vi.mocked(exchangeCode).mockResolvedValue({
      access_token: 'new-access',
      expires_in: 3600,
      refresh_token: 'new-refresh',
    })
    const updateMutate = vi.fn<(input: { alertId: string; patch: unknown }) => Promise<void>>(
      async () => undefined,
    )
    const addon = seedAddon(vi.fn(), updateMutate)
    const oauthState = 'test-oauth-state-hex'
    const pendingStates = Reflect.get(addon, 'pendingStates') as Map<
      string,
      { brokerId: string; popup: boolean; issuedAt: number }
    >
    pendingStates.set(oauthState, { brokerId: 'google_001', popup: false, issuedAt: Date.now() })
    Reflect.set(
      addon,
      'resolveRedirectUri',
      async () => 'https://hub.example/addon/google-services/oauth/callback',
    )
    Reflect.set(addon, 'fetchAccountEmail', async () => '')
    const reply = {
      header: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      redirect: vi.fn(),
    }
    await Reflect.apply(Reflect.get(addon, 'handleCallback'), addon, [
      { query: { code: 'auth-code', state: oauthState } },
      reply,
    ])
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1))
    expect(updateMutate).toHaveBeenCalledWith({
      alertId: 'google-broker:google_001',
      patch: { status: 'completed', read: true },
    })
  })
})
