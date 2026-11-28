import { describe, expect, it, vi } from 'vitest'
import type { Alert } from '@dominevo/types'
import { connectionFromSettings, HOMECOM_GATEWAYS_PATH, type HomeComConfig } from '../config.js'
import { createHomeComApiClient, HomeComAuthError, type FetchFn } from '../homecom-api-client.js'
import { HomeComIntegrationManager } from '../homecom-integration-manager.js'
import { HomeComConnectionResolver } from '../homecom-gateway.js'
import { createHomeComSessionAlert } from '../homecom-session-alert.js'

const STORED = {
  username: 'me@example.com',
  token: 'stale-access',
  refresh: 'refresh-0',
  brand: 'bosch',
  region: 'eu',
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function required(c: HomeComConfig | null): HomeComConfig {
  if (c === null) throw new Error('settings did not parse')
  return c
}

/**
 * A cloud that rotates on every refresh, accepts only the CURRENT refresh token (a replay is
 * 400 invalid_grant), and expires the access token once, right after the gateway listing.
 */
function rotatingCloud(refreshesSeen: string[]): FetchFn {
  let validAccess = 'none'
  let validRefresh = 'refresh-0'
  let n = 0
  let listed = false
  let expireOnce = false
  return async (url, init) => {
    const form = new URLSearchParams(init?.body ?? '')
    if (url.endsWith('/auth/connect/token')) {
      const presented = form.get('refresh_token') ?? ''
      refreshesSeen.push(presented)
      if (presented !== validRefresh) {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
      }
      n += 1
      validAccess = `access-${n}`
      validRefresh = `refresh-${n}`
      const body = { access_token: validAccess, refresh_token: validRefresh }
      return { ok: true, status: 200, json: async () => body }
    }
    if (init?.headers?.['Authorization'] !== `Bearer ${validAccess}`) {
      return { ok: false, status: 401, json: async () => ({}) }
    }
    if (expireOnce) {
      expireOnce = false
      validAccess = 'expired'
      return { ok: false, status: 401, json: async () => ({}) }
    }
    if (url.endsWith(HOMECOM_GATEWAYS_PATH)) {
      listed = true
      expireOnce = true
      return {
        ok: true,
        status: 200,
        json: async () => [{ deviceId: 'g1', deviceType: 'k40' }],
      }
    }
    void listed
    return {
      ok: true,
      status: 200,
      json: async () => ({ heatingCircuits: [], domesticHotWater: null }),
    }
  }
}

function manager(
  fetchFn: FetchFn,
  extra: { onAuthFailed?: (id: string) => void; onConnected?: (id: string) => void } = {},
): HomeComIntegrationManager {
  return new HomeComIntegrationManager({
    id: 'int-1',
    name: 'Home',
    connection: required(connectionFromSettings(STORED)),
    logger: logger() as never,
    onConnected: extra.onConnected ?? (() => undefined),
    onDisconnected: () => undefined,
    onAuthFailed: extra.onAuthFailed,
    surfaceSink: new HomeComConnectionResolver(),
    fetchFn,
  })
}

describe('HomeCom refresh-token single source of truth', () => {
  it('after the lister rotates, the polling client refreshes with the NEW refresh token', async () => {
    const seen: string[] = []
    const m = manager(rotatingCloud(seen))
    await m.start()
    // start(): lister refreshed refresh-0 -> refresh-1; the polling client's first request
    // 401s once (expiry) and must refresh with refresh-1, never replay refresh-0.
    expect(seen).toEqual(['refresh-0', 'refresh-1'])
    expect(m.getConnection().refresh).toBe('refresh-2')
    await m.stop()
  })
})

describe('HomeCom refresh refusal', () => {
  it('maps 400 invalid_grant to HomeComAuthError', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })
    const client = createHomeComApiClient(required(connectionFromSettings(STORED)), 'g1', {
      fetchFn,
    })
    await expect(client.refreshTokens()).rejects.toBeInstanceOf(HomeComAuthError)
  })

  it('keeps other 400s generic', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_request' }),
    })
    const client = createHomeComApiClient(required(connectionFromSettings(STORED)), 'g1', {
      fetchFn,
    })
    const err: unknown = await client.refreshTokens().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(HomeComAuthError)
  })

  it('the manager says "authentication failed — sign in again" and reports the failure', async () => {
    const fetchFn: FetchFn = async (url) =>
      url.endsWith('/auth/connect/token')
        ? { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
        : { ok: false, status: 401, json: async () => ({}) }
    const onAuthFailed = vi.fn()
    const m = manager(fetchFn, { onAuthFailed })
    await expect(m.start()).rejects.toBeInstanceOf(HomeComAuthError)
    expect(m.getInfo().error).toBe('authentication failed — sign in again')
    expect(onAuthFailed).toHaveBeenCalledWith('int-1')
  })
})

describe('HomeCom sign-in alert', () => {
  it('raises one alert on auth failure and clears it when the integration connects', async () => {
    const emitted: Alert[] = []
    const updates: { alertId: string; patch: Partial<Alert> }[] = []
    const alert = createHomeComSessionAlert({
      logger: logger() as never,
      getAlerts: () => ({
        emit: { mutate: async (a: Alert) => void emitted.push(a) },
        update: { mutate: async (u) => void updates.push(u) },
      }),
      nameOf: () => 'Home',
      addonId: 'bosch-homecom',
      debounceMs: 0,
    })
    alert.authFailed('int-1')
    alert.authFailed('int-1')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(emitted[0]?.severity).toBe('critical')
    expect(emitted[0]?.action).toEqual({
      label: 'Sign in again',
      href: '/integrations/bosch-homecom?instance=int-1',
      navigation: 'app',
    })
    expect(JSON.stringify(emitted[0])).not.toMatch(/refresh-\d|access-\d/)
    await alert.connected('int-1')
    expect(updates).toEqual([
      { alertId: emitted[0]?.id, patch: expect.objectContaining({ status: 'completed' }) },
    ])
    alert.dispose()
  })
})
