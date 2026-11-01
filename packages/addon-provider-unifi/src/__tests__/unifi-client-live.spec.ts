import { describe, expect, it } from 'vitest'
import {
  UnifiAuthError,
  UnifiLiveClient,
  UnifiUnsupportedError,
  type UnifiFetch,
  type UnifiFetchInit,
} from '../unifi-client-live.js'

interface Call {
  readonly url: string
  readonly init: UnifiFetchInit
}

function page(data: readonly unknown[]): unknown {
  return { offset: 0, limit: 200, count: data.length, totalCount: data.length, data }
}

function fakeFetch(
  routes: Readonly<Record<string, unknown>>,
  calls: Call[],
  status = 200,
): UnifiFetch {
  return async (url, init) => {
    calls.push({ url, init })
    const path = url.split('/integration/v1')[1]?.split('?')[0] ?? ''
    const body = routes[path]
    if (status !== 200) return { ok: false, status, json: async () => ({}) }
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }
}

const ROUTES: Record<string, unknown> = {
  '/sites': page([{ id: 's1', name: 'Default', internalReference: 'default' }]),
  '/sites/s1/devices': page([
    { id: 'd1', name: 'Switch', model: 'USW-Lite-8-PoE', state: 'ONLINE', features: ['switching'] },
    { id: 'd2', name: 'AP', model: 'U6-Pro', state: 'OFFLINE', features: ['accessPoint'] },
  ]),
  '/sites/s1/devices/d1': {
    interfaces: {
      ports: [{ idx: 1, poe: { state: 'UP' } }, { idx: 2, poe: { state: 'DOWN' } }, { idx: 3 }],
    },
  },
  '/sites/s1/devices/d1/statistics/latest': { uptimeSec: 100, cpuUtilizationPct: 12.5 },
  '/sites/s1/devices/d1/actions': {},
  '/sites/s1/devices/d1/interfaces/ports/2/actions': {},
  '/sites/s1/clients': page([
    {
      id: 'c1',
      name: 'phone',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '192.0.2.5',
      uplinkDeviceId: 'd1',
    },
  ]),
}

function make(calls: Call[], status = 200): UnifiLiveClient {
  return new UnifiLiveClient({
    host: 'console.example',
    port: 443,
    apiKey: 'KEY-123',
    site: 'default',
    fetchImpl: fakeFetch(ROUTES, calls, status),
  })
}

describe('UnifiLiveClient', () => {
  it('maps devices, ports and clients and sends the API key header', async () => {
    const calls: Call[] = []
    const client = make(calls)
    await client.connect()
    const infra = await client.listInfraDevices()
    const sw = infra.find((d) => d.id === 'd1')
    expect(sw).toMatchObject({
      cpuPercent: 12.5,
      uptimeSec: 100,
      online: true,
      clients: 1,
      cpuTempC: null,
    })
    expect(sw?.ports).toEqual([
      { idx: 1, poeCapable: true, poeOn: true },
      { idx: 2, poeCapable: true, poeOn: false },
      { idx: 3, poeCapable: false, poeOn: false },
    ])
    // statistics unavailable for the AP -> null, never 0
    const ap = infra.find((d) => d.id === 'd2')
    expect(ap).toMatchObject({ cpuPercent: null, uptimeSec: null, online: false, state: 'offline' })
    const clients = await client.listClients()
    expect(clients[0]).toMatchObject({ mac: 'aa:bb:cc:dd:ee:ff', ip: '192.0.2.5', connected: true })
    expect(client.getClient('aa:bb:cc:dd:ee:ff')).not.toBeNull()
    expect(calls.every((c) => c.init.headers['X-API-KEY'] === 'KEY-123')).toBe(true)
    expect(
      calls[0]?.url.startsWith('https://console.example:443/proxy/network/integration/v1/'),
    ).toBe(true)
  })

  it('maps a 401 to an auth error', async () => {
    await expect(make([], 401).connect()).rejects.toBeInstanceOf(UnifiAuthError)
  })

  it('refuses PoE toggle and LED with a typed refusal', async () => {
    const client = make([])
    await expect(client.setPortPoe()).rejects.toBeInstanceOf(UnifiUnsupportedError)
    await expect(client.setLed()).rejects.toMatchObject({ feature: 'led' })
  })

  it('posts restart and port power-cycle actions', async () => {
    const calls: Call[] = []
    const client = make(calls)
    await client.connect()
    await client.restartDevice('d1')
    await client.powerCyclePort('d1', 2)
    const posts = calls.filter((c) => c.init.method === 'POST')
    expect(posts.map((p) => [p.url.split('/v1')[1], p.init.body])).toEqual([
      ['/sites/s1/devices/d1/actions', '{"action":"RESTART"}'],
      ['/sites/s1/devices/d1/interfaces/ports/2/actions', '{"action":"POWER_CYCLE"}'],
    ])
  })

  it('refuses to connect without an API key', async () => {
    const client = new UnifiLiveClient({
      host: 'h',
      port: 443,
      apiKey: '',
      site: 'default',
      fetchImpl: fakeFetch(ROUTES, []),
    })
    await expect(client.connect()).rejects.toBeInstanceOf(UnifiAuthError)
  })
})
