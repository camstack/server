import { describe, expect, it, vi } from 'vitest'
import { createHomeComApiClient, HomeComAuthError, type FetchFn } from '../homecom-api-client.js'
import {
  HomeComBridgeError,
  type HomeComBridge,
  type HomeComBridgeReading,
  type HomeComBridgeTarget,
  type HomeComBridgeWrite,
} from '../homecom-bridge.js'
import { buildDiscoverables } from '../homecom-gateway.js'
import { HOMECOM_TOKEN_URL } from '../homecom-oauth.js'
import { k40Reading } from './homecom-bridge-fixture.js'

const CONFIG = {
  username: 'me@example.com',
  token: 'access-1',
  refresh: 'refresh-1',
  brand: 'bosch',
  region: 'eu',
  gatewayId: undefined,
} as const

const REFS = (ids: readonly string[]) => ({
  references: ids.map((id) => ({ id })),
})

/** The plain climate resources, for the fallback, plus the token endpoint. */
const HTTP_ANSWERS: Readonly<Record<string, unknown>> = {
  '/heatingCircuits': REFS(['/heatingCircuits/hc1']),
  '/dhwCircuits': REFS(['/dhwCircuits/dhw1']),
  '/heatingCircuits/hc1/operationMode': {
    value: 'manual',
    allowedValues: ['off', 'manual'],
  },
  '/heatingCircuits/hc1/roomtemperature': { value: 20.5 },
  '/dhwCircuits/dhw1/actualTemp': { value: 48 },
}

function cloud(): { fetchFn: FetchFn; urls: string[] } {
  const urls: string[] = []
  const fetchFn: FetchFn = async (url) => {
    urls.push(url)
    if (url === HOMECOM_TOKEN_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
        }),
      }
    }
    const path = decodeURIComponent(url.split('/resource')[1] ?? '')
    if (path in HTTP_ANSWERS) return { ok: true, status: 200, json: async () => HTTP_ANSWERS[path] }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetchFn, urls }
}

interface FakeBridge extends HomeComBridge {
  readonly reads: HomeComBridgeTarget[]
  readonly writes: { target: HomeComBridgeTarget; write: HomeComBridgeWrite }[]
}

function fakeBridge(answers: readonly (HomeComBridgeReading | HomeComBridgeError)[]): FakeBridge {
  const queue = [...answers]
  const reads: HomeComBridgeTarget[] = []
  const writes: { target: HomeComBridgeTarget; write: HomeComBridgeWrite }[] = []
  return {
    reads,
    writes,
    async read(target) {
      reads.push(target)
      const next = queue.shift() ?? k40Reading()
      if (next instanceof HomeComBridgeError) throw next
      return next
    },
    async write(target, write) {
      writes.push({ target, write })
    },
  }
}

function client(bridge: HomeComBridge | undefined, deviceType = 'k40') {
  const net = cloud()
  const log = { info: vi.fn(), warn: vi.fn() }
  const rotated = vi.fn(async () => {})
  const api = createHomeComApiClient(CONFIG, 'g1', {
    fetchFn: net.fetchFn,
    deviceType,
    logger: log,
    onTokensRotated: rotated,
    ...(bridge !== undefined ? { bridge } : {}),
  })
  return { api, net, log, rotated }
}

describe('HomeCom reads a k40 through the bridge', () => {
  it('builds Climate, WaterHeater and the heat pump from one bridge read, with no HTTP read', async () => {
    const bridge = fakeBridge([k40Reading()])
    const { api, net } = client(bridge)
    const snapshot = await api.fetchSystem()
    expect(bridge.reads).toEqual([{ token: 'access-1', gatewayId: 'g1', deviceType: 'k40' }])
    expect(net.urls).toEqual([])
    expect(snapshot.circuits).toMatchObject([
      {
        id: 'hc1',
        operationMode: 'manual',
        setpoint: 30,
        currentRoomTemp: 21.4,
        maxTemp: 30,
      },
    ])
    expect(snapshot.dhw).toMatchObject({
      circuitId: 'dhw1',
      currentTemp: 48,
      targetTemp: 51,
    })
    expect(snapshot.heatPump?.compressorPct).toBe(89)
    expect(buildDiscoverables(snapshot).map((d) => d.kind)).toContain('heat-pump')
  })

  it('refreshes the token once on an auth answer and reads again with the new one', async () => {
    const bridge = fakeBridge([new HomeComBridgeError('auth', 'refused'), k40Reading()])
    const { api, rotated } = client(bridge)
    await api.fetchSystem()
    expect(bridge.reads.map((r) => r.token)).toEqual(['access-1', 'access-2'])
    expect(rotated).toHaveBeenCalledWith({
      token: 'access-2',
      refresh: 'refresh-2',
    })
  })

  it('names an auth failure that survives the refresh', async () => {
    const bridge = fakeBridge([
      new HomeComBridgeError('auth', 'refused'),
      new HomeComBridgeError('auth', 'refused'),
    ])
    await expect(client(bridge).api.fetchSystem()).rejects.toBeInstanceOf(HomeComAuthError)
  })

  it('falls back to the climate resources, named, when the bridge fails otherwise', async () => {
    const bridge = fakeBridge([new HomeComBridgeError('timeout', 'no answer within 50s')])
    const { api, log } = client(bridge)
    const snapshot = await api.fetchSystem()
    expect(snapshot.circuits.map((c) => c.id)).toEqual(['hc1'])
    expect(snapshot.heatPump).toBeUndefined()
    expect(snapshot.bridge).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('bridge read failed'),
      expect.objectContaining({
        tags: { gatewayId: 'g1' },
        meta: expect.objectContaining({ kind: 'timeout' }),
      }),
    )
  })

  it('reads a room controller (rrc2) over HTTP, never through the bridge', async () => {
    const bridge = fakeBridge([])
    await client(bridge, 'rrc2').api.fetchSystem()
    expect(bridge.reads).toEqual([])
  })
})

describe('HomeCom writes a k40 through the bridge', () => {
  it('sends climate and hot-water writes as named ops the reading accepted', async () => {
    const bridge = fakeBridge([k40Reading()])
    const { api, net } = client(bridge)
    await api.fetchSystem()
    await api.setCircuitSetpoint('hc1', 22)
    await api.setCircuitMode('hc1', 'auto')
    await api.setDhwTarget(50)
    await api.setDhwMode('high')
    expect(bridge.writes.map((w) => w.write)).toEqual([
      { op: 'hcManualRoomSetpoint', circuitId: 'hc1', value: 22 },
      { op: 'hcOperationMode', circuitId: 'hc1', value: 'auto' },
      { op: 'dhwLevelTemp', circuitId: 'dhw1', level: 'eco', value: 50 },
      { op: 'dhwOperationMode', circuitId: 'dhw1', value: 'high' },
    ])
    expect(net.urls).toEqual([])
  })

  it('refuses a mode the circuit does not list before anything is sent', async () => {
    const bridge = fakeBridge([k40Reading()])
    const { api } = client(bridge)
    await api.fetchSystem()
    await expect(api.setCircuitMode('hc1', 'cool')).rejects.toThrow(/read-only/)
    expect(bridge.writes).toEqual([])
  })

  it('passes heat-pump writes to the bridge with the current token', async () => {
    const bridge = fakeBridge([k40Reading()])
    const { api } = client(bridge)
    await api.fetchSystem()
    await api.writeHeatPump([{ op: 'awayMode', value: 'on' }])
    expect(bridge.writes).toEqual([
      {
        target: { token: 'access-1', gatewayId: 'g1', deviceType: 'k40' },
        write: { op: 'awayMode', value: 'on' },
      },
    ])
  })
})
