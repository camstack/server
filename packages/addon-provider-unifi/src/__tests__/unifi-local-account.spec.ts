/**
 * The local account (planning#583): a username + password reaches the classic Network API on a
 * UniFi OS console and on a legacy controller, carries the session cookie and the CSRF token,
 * signs in again ONCE on a 401, and switches a port's PoE through `port_overrides` — the whole
 * list sent back, merged, read fresh. With an API key too, the key serves the listing and the
 * local account adds PoE on/off; a refused local account never hammers the sign-in on a poll.
 */
import { describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import { mergePoeOverride, UnifiClassicClient } from '../unifi-client-classic.js'
import { UnifiDualClient } from '../unifi-client-dual.js'
import { makeUnifiClientFactory, unifiCredentialOf } from '../unifi-client-factory.js'
import { type UnifiFetch, UnifiLiveClient } from '../unifi-client-live.js'
import { testUnifiConnection } from '../unifi-connection-test.js'
import { UnifiAuthError, UnifiMfaRequiredError, UnifiSiteNotFoundError } from '../unifi-errors.js'
import {
  type UnifiHttp,
  type UnifiHttpRequest,
  type UnifiHttpResponse,
  UnifiSession,
} from '../unifi-session.js'

type Flavor = 'unifi-os' | 'legacy'

interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
}

interface FakeControllerOptions {
  readonly flavor: Flavor
  readonly password?: string
  /** Answer the login with the second-factor refusal of the flavour. */
  readonly mfa?: boolean
  /** How many API calls answer 401 (an expired session) before the session works again. */
  readonly expireNext?: number
  /** Every API call answers 401, signed in or not. */
  readonly alwaysExpired?: boolean
  /** Unreachable: every request fails at the socket. */
  readonly down?: boolean
}

interface ControllerState {
  /** The overrides the controller holds NOW (a fresh read sees them; the poll may be older). */
  overrides: Record<string, unknown>[]
}

const SWITCH_MAC = 'aa:bb:cc:00:00:01'

function device(state: ControllerState): Record<string, unknown> {
  return {
    _id: 'dev1',
    mac: SWITCH_MAC,
    type: 'usw',
    name: 'Office switch',
    model: 'USW-Lite-8-PoE',
    state: 1,
    uptime: 3600,
    'system-stats': { cpu: '12.5' },
    general_temperature: 41,
    num_sta: 3,
    led_override: 'default',
    port_table: [
      {
        port_idx: 1,
        up: true,
        speed: 1000,
        poe_caps: 7,
        poe_mode: 'off',
        poe_power: '3.21',
        poe_voltage: '52.1',
        poe_current: '61.5',
      },
      { port_idx: 2, up: false, port_poe: false },
      { port_idx: 3, poe_caps: 7, poe_enable: true },
    ],
    port_overrides: state.overrides,
  }
}

function response(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  cookies: readonly string[] = [],
): UnifiHttpResponse {
  return {
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    setCookies: () => cookies,
    json: async () => body,
  }
}

function socketError(code: string): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(code), { code }),
  })
}

/** A controller that answers like the real one of its flavour, recording every request. */
function fakeController(options: FakeControllerOptions): {
  http: UnifiHttp
  seen: Seen[]
  state: ControllerState
} {
  const seen: Seen[] = []
  const state: ControllerState = {
    overrides: [
      { port_idx: 1, name: 'cam', poe_mode: 'off' },
      { port_idx: 2, name: 'uplink', portconf_id: 'trunk' },
    ],
  }
  const os = options.flavor === 'unifi-os'
  const cookie = os ? 'TOKEN' : 'unifises'
  const apiPrefix = os ? '/proxy/network/api' : '/api'
  let generation = 0
  let expire = options.expireNext ?? 0
  const http: UnifiHttp = async (url, req: UnifiHttpRequest) => {
    const path = new URL(url).pathname
    seen.push({
      method: req.method,
      path,
      headers: req.headers,
      body: req.body,
    })
    if (options.down === true) throw socketError('EHOSTUNREACH')
    if (path === '/') return os ? response(200, null) : response(302, null, { location: '/manage' })
    if (path === (os ? '/api/auth/login' : '/api/login')) {
      if (options.mfa === true) {
        return os
          ? response(499, { code: 'MFA_AUTH_REQUIRED' })
          : response(400, {
              meta: { rc: 'error', msg: 'api.err.Ubic2faTokenRequired' },
            })
      }
      const sent: unknown = JSON.parse(req.body ?? '{}')
      const ok =
        typeof sent === 'object' &&
        sent !== null &&
        'password' in sent &&
        sent.password === (options.password ?? 'secret')
      if (!ok) {
        return os
          ? response(401, {})
          : response(400, { meta: { rc: 'error', msg: 'api.err.Invalid' } })
      }
      generation += 1
      return os
        ? response(200, {}, { 'x-csrf-token': `csrf-${generation}` }, [
            `TOKEN=tok-${generation}; Path=/; HttpOnly`,
          ])
        : response(200, { meta: { rc: 'ok' }, data: [] }, {}, [
            `unifises=ses-${generation}; Path=/`,
            `csrf_token=csrf-${generation}; Path=/`,
          ])
    }
    if (path.startsWith('/api/auth/logout') || path === '/api/logout') return response(200, {})
    if (!path.startsWith(apiPrefix)) return response(404, {})
    const sessionOk =
      (req.headers['Cookie'] ?? '').includes(`${cookie}=${os ? 'tok' : 'ses'}-${generation}`) &&
      req.headers['X-CSRF-Token'] === `csrf-${generation}`
    if (options.alwaysExpired === true || !sessionOk) return response(401, {})
    if (expire > 0) {
      expire -= 1
      return response(401, {
        meta: { rc: 'error', msg: 'api.err.LoginRequired' },
      })
    }
    const apiPath = path.slice(apiPrefix.length)
    const ok = (data: unknown): UnifiHttpResponse => response(200, { meta: { rc: 'ok' }, data })
    if (apiPath === '/self/sites') return ok([{ name: 'default', desc: 'Default' }])
    if (apiPath === '/s/default/stat/device') return ok([device(state)])
    if (apiPath === `/s/default/stat/device/${encodeURIComponent(SWITCH_MAC)}`) {
      return ok([device(state)])
    }
    if (apiPath === '/s/default/stat/sta') {
      return ok([
        {
          mac: 'AA:BB:CC:DD:EE:01',
          name: 'marker-camera',
          is_wired: true,
          sw_mac: 'AA:BB:CC:00:00:01',
          sw_port: 1,
        },
        {
          mac: 'AA:BB:CC:DD:EE:FF',
          hostname: 'phone',
          ip: '192.0.2.5',
          is_wired: false,
        },
      ])
    }
    if (apiPath === '/s/default/rest/device/dev1' && req.method === 'PUT') {
      const body: unknown = JSON.parse(req.body ?? '{}')
      if (
        typeof body === 'object' &&
        body !== null &&
        'port_overrides' in body &&
        Array.isArray(body.port_overrides)
      ) {
        state.overrides = body.port_overrides
      }
      return ok([])
    }
    if (apiPath === '/s/default/cmd/devmgr') return ok([])
    return response(404, {})
  }
  return { http, seen, state }
}

function classic(http: UnifiHttp, site = 'default', password = 'secret'): UnifiClassicClient {
  return new UnifiClassicClient({
    site,
    session: new UnifiSession({
      host: 'console.example',
      port: 443,
      username: 'camstack',
      password,
      http,
    }),
  })
}

describe('UniFi local-account sign-in', () => {
  it.each<[Flavor, string, string]>([
    ['unifi-os', '/api/auth/login', '/proxy/network/api/s/default/stat/device'],
    ['legacy', '/api/login', '/api/s/default/stat/device'],
  ])('signs in on a %s controller and lists through its API', async (flavor, login, devices) => {
    const { http, seen } = fakeController({ flavor })
    const client = classic(http)
    await client.connect()
    const [sw] = await client.listInfraDevices()
    const paths = seen.map((s) => s.path)
    expect(paths.slice(0, 2)).toEqual(['/', login])
    expect(paths).toContain(devices)
    expect(sw).toMatchObject({
      id: 'dev1',
      mac: SWITCH_MAC,
      kind: 'switch',
      poeSwitchable: true,
    })
  })

  it.each<Flavor>([
    'unifi-os',
    'legacy',
  ])('carries the session cookie and the CSRF token on every API call (%s)', async (flavor) => {
    const { http, seen } = fakeController({ flavor })
    await classic(http).connect()
    const api = seen.filter((s) => s.path.endsWith('/self/sites'))
    expect(api).toHaveLength(1)
    expect(api[0]?.headers['X-CSRF-Token']).toBe('csrf-1')
    expect(api[0]?.headers['Cookie']).toContain(
      flavor === 'unifi-os' ? 'TOKEN=tok-1' : 'unifises=ses-1',
    )
  })

  it('signs in again ONCE on a 401 and retries the call', async () => {
    const { http, seen } = fakeController({
      flavor: 'unifi-os',
      expireNext: 1,
    })
    const client = classic(http)
    await client.connect()
    expect(await client.listInfraDevices()).toHaveLength(1)
    expect(seen.filter((s) => s.path === '/api/auth/login')).toHaveLength(2)
  })

  it('a session refused again after signing in is an auth failure, not a loop', async () => {
    const { http, seen } = fakeController({
      flavor: 'legacy',
      alwaysExpired: true,
    })
    await expect(classic(http).connect()).rejects.toBeInstanceOf(UnifiAuthError)
    expect(seen.filter((s) => s.path === '/api/login')).toHaveLength(2)
  })

  it.each<Flavor>([
    'unifi-os',
    'legacy',
  ])('a wrong password is a typed auth refusal (%s)', async (flavor) => {
    const { http } = fakeController({ flavor })
    await expect(classic(http, 'default', 'wrong').connect()).rejects.toBeInstanceOf(UnifiAuthError)
  })

  it.each<Flavor>([
    'unifi-os',
    'legacy',
  ])('an account asking for 2FA says so (%s)', async (flavor) => {
    const { http } = fakeController({ flavor, mfa: true })
    await expect(classic(http).connect()).rejects.toBeInstanceOf(UnifiMfaRequiredError)
    await expect(classic(http).connect()).rejects.toThrow(/local account/i)
  })

  it('a wrong site names the sites the console has', async () => {
    const { http } = fakeController({ flavor: 'unifi-os' })
    await expect(classic(http, 'office').connect()).rejects.toBeInstanceOf(UnifiSiteNotFoundError)
    await expect(classic(http, 'office').connect()).rejects.toThrow(/the console has: default/)
  })
})

describe('the ports the local account reads', () => {
  it('PoE mode, power, link and the wired client on each port', async () => {
    const { http } = fakeController({ flavor: 'unifi-os' })
    const client = classic(http)
    await client.connect()
    const [sw] = await client.listInfraDevices()
    expect(sw?.ports).toEqual([
      {
        idx: 1,
        poeCapable: true,
        poeOn: false,
        linkUp: true,
        speedMbps: 1000,
        poePowerW: 3.21,
        poeVoltageV: 52.1,
        poeCurrentA: 0.0615,
        clientMac: 'aa:bb:cc:dd:ee:01',
        clientName: 'marker-camera',
      },
      {
        idx: 2,
        poeCapable: false,
        poeOn: false,
        linkUp: false,
        speedMbps: null,
        poePowerW: null,
        poeVoltageV: null,
        poeCurrentA: null,
        clientMac: null,
        clientName: null,
      },
      expect.objectContaining({
        idx: 3,
        poeCapable: true,
        poeOn: true,
        clientMac: null,
      }),
    ])
  })
})

describe('PoE on/off through port_overrides', () => {
  const others = [
    { port_idx: 2, name: 'uplink', portconf_id: 'trunk' },
    { port_idx: 5, poe_mode: 'off', name: 'spare' },
  ]

  it('changes only the touched port and keeps every other port override whole', () => {
    const merged = mergePoeOverride(
      [{ port_idx: 1, name: 'cam', poe_mode: 'off' }, ...others],
      1,
      'auto',
    )
    expect(merged).toEqual([{ port_idx: 1, name: 'cam', poe_mode: 'auto' }, ...others])
  })

  it('appends an entry for a port that had none, keeping the rest', () => {
    expect(mergePoeOverride(others, 3, 'off')).toEqual([
      ...others,
      { port_idx: 3, poe_mode: 'off' },
    ])
  })

  it('reads the device FRESH and PUTs the merged list (an override added since the poll survives)', async () => {
    const { http, seen, state } = fakeController({ flavor: 'unifi-os' })
    const client = classic(http)
    await client.connect()
    await client.listInfraDevices()
    // Someone named port 4 on the controller after our last poll.
    state.overrides = [...state.overrides, { port_idx: 4, name: 'doorbell' }]
    await client.setPortPoe('dev1', 1, true)
    const put = seen.find((s) => s.method === 'PUT')
    expect(seen.map((s) => s.path)).toContain(
      `/proxy/network/api/s/default/stat/device/${encodeURIComponent(SWITCH_MAC)}`,
    )
    expect(put?.path).toBe('/proxy/network/api/s/default/rest/device/dev1')
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      port_overrides: [
        { port_idx: 1, name: 'cam', poe_mode: 'auto' },
        { port_idx: 2, name: 'uplink', portconf_id: 'trunk' },
        { port_idx: 4, name: 'doorbell' },
      ],
    })
  })
})

const INTEGRATION_ROUTES: Record<string, unknown> = {
  '/sites': {
    data: [{ id: 's1', name: 'Default', internalReference: 'default' }],
  },
  '/sites/s1/devices': {
    data: [
      {
        id: 'int-1',
        name: 'Office switch',
        model: 'USW-Lite-8-PoE',
        macAddress: 'AA:BB:CC:00:00:01',
        state: 'ONLINE',
        features: ['switching'],
      },
    ],
  },
  '/sites/s1/devices/int-1': {
    interfaces: {
      ports: [
        { idx: 1, poe: { state: 'UP' } },
        { idx: 3, poe: { state: 'UP' } },
      ],
    },
  },
  '/sites/s1/devices/int-1/statistics/latest': {
    uptimeSec: 100,
    cpuUtilizationPct: 5,
  },
  '/sites/s1/clients': { data: [] },
}

const integrationFetch: UnifiFetch = async (url) => {
  const path = url.split('/integration/v1')[1]?.split('?')[0] ?? ''
  const body = INTEGRATION_ROUTES[path]
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => body }
}

function dual(http: UnifiHttp, password = 'secret'): UnifiDualClient {
  return new UnifiDualClient({
    integration: new UnifiLiveClient({
      host: 'console.example',
      port: 443,
      apiKey: 'k',
      site: 'default',
      fetchImpl: integrationFetch,
    }),
    classic: classic(http, 'default', password),
  })
}

describe('an API key AND a local account', () => {
  it('the key lists; the local account lays its ports over the same device (by MAC)', async () => {
    const { http } = fakeController({ flavor: 'unifi-os' })
    const client = dual(http)
    await client.connect()
    const [sw] = await client.listInfraDevices()
    expect(sw).toMatchObject({ id: 'int-1', poeSwitchable: true })
    expect(sw?.ports[0]).toMatchObject({
      idx: 1,
      poeOn: false,
      clientName: 'marker-camera',
    })
    expect(client.degradedError()).toBeNull()
  })

  it('switches PoE through the local account, on the classic id of the same device', async () => {
    const { http, seen } = fakeController({ flavor: 'unifi-os' })
    const client = dual(http)
    await client.connect()
    await client.listInfraDevices()
    await client.setPortPoe('int-1', 3, false)
    const put = seen.find((s) => s.method === 'PUT')
    expect(put?.path).toBe('/proxy/network/api/s/default/rest/device/dev1')
    expect(JSON.parse(put?.body ?? '{}').port_overrides).toContainEqual({
      port_idx: 3,
      poe_mode: 'off',
    })
  })

  it('a refused local password degrades, the key still lists, and the poll never signs in again', async () => {
    const { http, seen } = fakeController({ flavor: 'unifi-os' })
    const client = dual(http, 'wrong')
    await client.connect()
    expect(await client.listInfraDevices()).toHaveLength(1)
    expect(await client.listInfraDevices()).toHaveLength(1)
    expect(client.degradedError()).toBeInstanceOf(UnifiAuthError)
    expect(seen.filter((s) => s.path === '/api/auth/login')).toHaveLength(1)
  })
})

describe('which credential signs in', () => {
  const base = {
    host: 'h',
    port: 443,
    site: 'default',
    allowSelfSigned: false,
  }
  const factory = makeUnifiClientFactory({
    fetchFor: () => integrationFetch,
    httpFor: () => fakeController({ flavor: 'unifi-os' }).http,
  })

  it.each<[string, string, string, string | null, unknown]>([
    ['k', '', '', 'api-key', UnifiLiveClient],
    ['', 'u', 'p', 'local-account', UnifiClassicClient],
    ['k', 'u', 'p', 'both', UnifiDualClient],
  ])('apiKey=%s user=%s → %s', (apiKey, username, password, kind, ctor) => {
    expect(unifiCredentialOf({ apiKey, username, password })).toBe(kind)
    expect(factory({ ...base, apiKey, username, password })).toBeInstanceOf(ctor)
  })

  it('an API key alone cannot switch PoE (no switch is offered)', async () => {
    const client = factory({
      ...base,
      apiKey: 'k',
      username: '',
      password: '',
    })
    await client.connect()
    const [sw] = await client.listInfraDevices()
    expect(sw?.poeSwitchable).toBe(false)
  })
})

describe('the connection test with a local account', () => {
  function factoryOver(options: FakeControllerOptions) {
    const { http } = fakeController(options)
    return makeUnifiClientFactory({
      fetchFor: () => integrationFetch,
      httpFor: () => http,
    })
  }
  const account = {
    host: 'console.example',
    username: 'camstack',
    password: 'secret',
  }

  it('validates a local account that signs in', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ flavor: 'legacy' }),
    )
    expect(result).toMatchObject({ success: true })
  })

  it('a wrong password is rejected with the reason', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ flavor: 'unifi-os', password: 'other' }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
  })

  it('a two-factor (cloud) account is rejected with a readable reason', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ flavor: 'unifi-os', mfa: true }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toMatch(/local account/i)
  })

  it('an unreachable console is inconclusive', async () => {
    const result = await testUnifiConnection(
      settingsToConnection(account),
      factoryOver({ flavor: 'unifi-os', down: true }),
    )
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
  })

  it('with an API key, a refused local account still fails the test, naming which half', async () => {
    const result = await testUnifiConnection(
      settingsToConnection({ ...account, apiKey: 'k' }),
      factoryOver({ flavor: 'unifi-os', password: 'other' }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('The API key works, but')
  })
})
