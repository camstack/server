import { describe, expect, it, vi } from 'vitest'
import { connectionFromSettings, HOMECOM_GATEWAYS_PATH, type HomeComConfig } from '../config.js'
import { createHomeComApiClient, type FetchFn } from '../homecom-api-client.js'
import { HomeComIntegrationManager } from '../homecom-integration-manager.js'
import { buildHomeComTokenPersister } from '../homecom-token-persist.js'
import { HomeComConnectionResolver } from '../homecom-gateway.js'

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

const STORED = {
  username: 'me@example.com',
  token: 'old-access',
  refresh: 'old-refresh',
  brand: 'bosch',
  region: 'eu',
}

interface Call {
  readonly url: string
  readonly auth: string | undefined
  readonly refreshToken: string | null
}

/**
 * A cloud that accepts one access token and one refresh token, and ROTATES both
 * whenever the refresh token is spent. It starts having already forgotten `old-access`.
 */
function cloud(calls: Call[], gateways: readonly string[] = ['g1']): FetchFn {
  let validAccess = 'server-side-access'
  let validRefresh = 'old-refresh'
  let n = 0
  return async (url, init) => {
    const form = new URLSearchParams(init?.body ?? '')
    calls.push({
      url,
      auth: init?.headers?.['Authorization'],
      refreshToken: form.get('refresh_token'),
    })
    if (url.endsWith('/auth/connect/token')) {
      if (form.get('refresh_token') !== validRefresh) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' }),
        }
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
    if (url.endsWith(HOMECOM_GATEWAYS_PATH)) {
      return {
        ok: true,
        status: 200,
        json: async () => gateways.map((deviceId) => ({ deviceId })),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ heatingCircuits: [], domesticHotWater: null }),
    }
  }
}

function required(c: HomeComConfig | null): HomeComConfig {
  if (c === null) throw new Error('settings did not parse')
  return c
}

function startManager(
  settings: Record<string, unknown>,
  fetchFn: FetchFn,
  persist: (t: { token: string; refresh: string }) => Promise<void>,
): HomeComIntegrationManager {
  return new HomeComIntegrationManager({
    id: 'int-1',
    name: 'Home',
    connection: required(connectionFromSettings(settings)),
    logger: logger() as never,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: new HomeComConnectionResolver(),
    fetchFn,
    onTokensRotated: (t) => persist(t),
    pollIntervalMs: 3_600_000,
  })
}

describe('HomeCom token rotation', () => {
  it('reports every rotation from the client', async () => {
    const rotated: { token: string; refresh: string }[] = []
    const client = createHomeComApiClient(required(connectionFromSettings(STORED)), 'g1', {
      fetchFn: cloud([]),
      onTokensRotated: async (t) => void rotated.push(t),
    })
    await client.refreshTokens()
    expect(rotated).toEqual([{ token: 'access-1', refresh: 'refresh-1' }])
  })

  it('a restart connects with the ROTATED tokens, not the spent ones', async () => {
    // The integration's settings, as the keychain holds them.
    const store: Record<string, unknown> = { ...STORED }
    const writes: Record<string, unknown>[] = []
    const persist = buildHomeComTokenPersister({
      getSettings: async () => ({ ...store }),
      setSettings: async ({ settings, secretKeys }) => {
        writes.push({ ...settings, __secretKeys: secretKeys })
        Object.assign(store, settings)
      },
      logger: logger() as never,
    })
    const cloudFetch = cloud([])

    // Session 1: the stored access token is stale, so it refreshes — and the cloud rotates.
    const first = startManager(store, cloudFetch, (t) => persist('int-1', t))
    await first.start()
    await first.stop()
    expect(store['token']).toBe('access-1')
    expect(store['refresh']).toBe('refresh-1')
    expect(store['username']).toBe('me@example.com')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.['__secretKeys']).toEqual(expect.arrayContaining(['token', 'refresh']))

    // Session 2 (restart): rebuilt from the store only. The old refresh token is SPENT.
    const calls: Call[] = []
    const second = startManager(store, cloudAfter(cloudFetch, calls), (t) => persist('int-1', t))
    await second.start()
    await second.stop()
    expect(calls.some((c) => c.url.endsWith('/auth/connect/token'))).toBe(false)
    expect(calls.every((c) => c.auth === 'Bearer access-1')).toBe(true)
  })

  it('without persistence the restart presents the spent refresh token and is refused', async () => {
    const cloudFetch = cloud([])
    const first = startManager({ ...STORED }, cloudFetch, async () => undefined)
    await first.start()
    await first.stop()
    const second = startManager({ ...STORED }, cloudFetch, async () => undefined)
    await expect(second.start()).rejects.toThrow()
  })

  it('does not write over tokens the keychain could not serve', async () => {
    const setSettings = vi.fn(async () => undefined)
    const persist = buildHomeComTokenPersister({
      getSettings: async () => ({
        ...STORED,
        refresh: { $secret: 'secret://x/y/refresh', v: 1 },
      }),
      setSettings,
      logger: logger() as never,
    })
    await persist('int-1', { token: 'a', refresh: 'b' })
    expect(setSettings).not.toHaveBeenCalled()
  })
})

/** Same cloud state, but records calls (the rotation state lives in `base`). */
function cloudAfter(base: FetchFn, calls: Call[]): FetchFn {
  return async (url, init) => {
    const form = new URLSearchParams(init?.body ?? '')
    calls.push({
      url,
      auth: init?.headers?.['Authorization'],
      refreshToken: form.get('refresh_token'),
    })
    return base(url, init)
  }
}
