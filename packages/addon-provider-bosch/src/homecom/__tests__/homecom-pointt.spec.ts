import { describe, expect, it, vi } from 'vitest'
import { connectionFromSettings, type HomeComConfig } from '../config.js'
import { climateSliceFromCircuit, waterHeaterSliceFromDhw } from '../homecom-domain-mapping.js'
import {
  createHomeComApiClient,
  HomeComAuthError,
  HomeComUnknownDeviceTypeError,
  type FetchFn,
} from '../homecom-api-client.js'
import { buildHomeComConnectionTestProvider } from '../homecom-connection-test.js'

/**
 * Recorded PointT resource envelopes. Shapes match what the MIT `homecom_alt`
 * tests record (`{ value }` and `{ references: [{ id }] }`). Not copied code.
 */

const ORIGIN = 'https://pointt-api.bosch-thermotechnology.com'
const GATEWAY = '101'

function settings(): HomeComConfig {
  const parsed = connectionFromSettings({
    token: 'access-old',
    refresh: 'refresh-old',
    brand: 'bosch',
    region: 'eu',
    gatewayId: GATEWAY,
  })
  if (parsed === null) throw new Error('settings did not parse')
  return parsed
}

interface Hit {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

function resourceOf(url: string): string | null {
  const marker = `/gateways/${GATEWAY}/resource`
  const at = url.indexOf(marker)
  if (at < 0) return null
  return url.slice(at + marker.length)
}

function envelope(value: unknown, extra: Record<string, unknown> = {}): unknown {
  return { value, ...extra }
}

function k40Bodies(path: string): unknown | 'missing' {
  switch (path) {
    case '/heatingCircuits':
      return { references: [{ id: '/heatingCircuits/hc1' }] }
    case '/heatingCircuits/hc1/operationMode':
      return envelope('manual', { allowedValues: ['off', 'auto', 'manual'] })
    case '/heatingCircuits/hc1/roomtemperature':
      return envelope(20.1)
    case '/heatingCircuits/hc1/currentRoomSetpoint':
      return envelope(21)
    case '/heatingCircuits/hc1/manualRoomSetpoint':
      return envelope(21, { minValue: 5, maxValue: 30 })
    case '/heatingCircuits/hc1/currentSuWiMode':
      return envelope('forced')
    case '/heatingCircuits/hc1/heatCoolMode':
      return envelope('heat')
    case '/heatingCircuits/hc1/actualHumidity':
      return envelope(40)
    case '/heatingCircuits/hc1/cooling/roomTempSetpoint':
      return 'missing'
    case '/dhwCircuits':
      return { references: [{ id: '/dhwCircuits/dhw1' }] }
    case '/dhwCircuits/dhw1/operationMode':
      return envelope('eco', { allowedValues: ['off', 'eco', 'high'] })
    case '/dhwCircuits/dhw1/actualTemp':
      return envelope(48)
    case '/dhwCircuits/dhw1/currentTemperatureLevel':
      return envelope('high', { allowedValues: ['off', 'high'] })
    case '/dhwCircuits/dhw1/temperatureLevels/high':
      return envelope(50, { minValue: 40, maxValue: 60 })
    case '/dhwCircuits/dhw1/currentSetpoint':
      return 'missing'
    case '/dhwCircuits/dhw1/manualsetpoint':
      return 'missing'
    case '/dhwCircuits/dhw1/outletTemperature':
      return 'missing'
    default:
      return 'missing'
  }
}

function router(bodies: (path: string) => unknown | 'missing', hits: Hit[]): FetchFn {
  return async (url, init) => {
    const method = init?.method ?? 'GET'
    let body: unknown = null
    if (init?.body !== undefined && method !== 'GET') {
      body = url.includes('/auth/connect/token') ? init.body : JSON.parse(init.body)
    }
    hits.push({ url, method, body })
    if (url.endsWith('/auth/connect/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new' }),
      }
    }
    const path = resourceOf(url)
    if (path === null) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const payload = bodies(path)
    if (payload === 'missing') {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
}

describe('HomeCom pointt resource API', () => {
  it('maps a k40 heating circuit and DHW read onto the climate and water-heater caps', async () => {
    const hits: Hit[] = []
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: router(k40Bodies, hits),
      deviceType: 'k40',
    })
    const snapshot = await client.fetchSystem()
    const circuit = snapshot.circuits[0]
    if (circuit === undefined) throw new Error('expected a heating circuit')
    const climate = climateSliceFromCircuit(circuit, 1_000)
    expect(climate.mode).toBe('heat')
    expect(climate.target).toBe(21)
    expect(climate.currentTemp).toBe(20.1)
    expect(climate.minTemp).toBe(5)
    expect(climate.maxTemp).toBe(30)
    expect(climate.currentHumidity).toBe(40)
    expect(climate.availableModes).toEqual(['off', 'auto', 'heat'])
    const dhw = snapshot.dhw
    if (dhw === null) throw new Error('expected domestic hot water')
    const water = waterHeaterSliceFromDhw(dhw, 1_000)
    expect(water.currentTemp).toBe(48)
    expect(water.targetTemp).toBe(50)
    expect(water.operationMode).toBe('eco')
    expect(water.minTemp).toBe(40)
    expect(water.maxTemp).toBe(60)
    expect(water.availableModes).toEqual(['off', 'eco', 'high'])

    const urls = hits.map((hit) => hit.url)
    expect(urls.some((url) => url.includes('/v2/gateways/'))).toBe(false)
    expect(urls).toContain(
      `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/heatingCircuits/hc1/operationMode`,
    )
    expect(urls).toContain(
      `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/heatingCircuits/hc1/manualRoomSetpoint`,
    )
    expect(urls).toContain(
      `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/dhwCircuits/dhw1/actualTemp`,
    )
    expect(urls).toContain(
      `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/dhwCircuits/dhw1/temperatureLevels/high`,
    )
  })

  it('writes a circuit setpoint, a circuit mode and a DHW target with PUT { value }', async () => {
    const hits: Hit[] = []
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: router(k40Bodies, hits),
      deviceType: 'k40',
    })
    await client.fetchSystem()
    hits.length = 0
    await client.setCircuitSetpoint('hc1', 22)
    await client.setCircuitMode('hc1', 'Heat')
    await client.setDhwTarget(52)
    await client.setDhwMode('high')
    expect(hits).toEqual([
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/heatingCircuits/hc1/manualRoomSetpoint`,
        method: 'PUT',
        body: { value: 22 },
      },
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/heatingCircuits/hc1/operationMode`,
        method: 'PUT',
        body: { value: 'manual' },
      },
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/dhwCircuits/dhw1/temperatureLevels/high`,
        method: 'PUT',
        body: { value: 52 },
      },
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/dhwCircuits/dhw1/operationMode`,
        method: 'PUT',
        body: { value: 'high' },
      },
    ])
  })

  it('writes the cooling setpoint when the circuit is in cooling season', async () => {
    const hits: Hit[] = []
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: router((path) => {
        if (path === '/heatingCircuits/hc1/currentSuWiMode') return envelope('cooling')
        if (path === '/heatingCircuits/hc1/cooling/roomTempSetpoint') return envelope(24)
        return k40Bodies(path)
      }, hits),
      deviceType: 'k40',
    })
    await client.fetchSystem()
    hits.length = 0
    await client.setCircuitSetpoint('hc1', 23)
    expect(hits).toEqual([
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/heatingCircuits/hc1/cooling/roomTempSetpoint`,
        method: 'PUT',
        body: { value: 23 },
      },
    ])
  })

  it('refreshes once on 401 and retries, then names a second refusal', async () => {
    const hits: Hit[] = []
    let access = 'access-new'
    const fetchFn: FetchFn = async (url, init) => {
      hits.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null })
      if (url.endsWith('/auth/connect/token')) {
        const form = new URLSearchParams(init?.body ?? '')
        expect(form.get('grant_type')).toBe('refresh_token')
        expect(form.get('refresh_token')).toBe('refresh-old')
        access = 'access-new'
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new' }),
        }
      }
      if (init?.headers?.['Authorization'] !== `Bearer ${access}`) {
        return { ok: false, status: 401, json: async () => ({}) }
      }
      const path = resourceOf(url)
      if (path === '/heatingCircuits') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ references: [] }),
        }
      }
      if (path === '/dhwCircuits') {
        return { ok: true, status: 200, json: async () => ({ references: [] }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn,
      deviceType: 'k40',
    })
    await client.fetchSystem()
    const refreshes = hits.filter((hit) => hit.url.endsWith('/auth/connect/token'))
    expect(refreshes).toHaveLength(1)
    const listed = hits.filter((hit) => hit.url.endsWith('/resource/heatingCircuits'))
    expect(listed).toHaveLength(2)

    const stuck: Hit[] = []
    const stillUnauthorized: FetchFn = async (url, init) => {
      stuck.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null })
      if (url.endsWith('/auth/connect/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2' }),
        }
      }
      return { ok: false, status: 401, json: async () => ({}) }
    }
    const refused = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: stillUnauthorized,
      deviceType: 'k40',
    })
    const failed = refused.fetchSystem()
    await expect(failed).rejects.toBeInstanceOf(HomeComAuthError)
    await expect(failed).rejects.toThrow(/after refresh/)
    expect(stuck.filter((hit) => hit.url.endsWith('/auth/connect/token'))).toHaveLength(1)
  })

  it('names an unknown device type and does not call the legacy system path', async () => {
    const hits: Hit[] = []
    const warn = vi.fn()
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: router(() => envelope('x'), hits),
      deviceType: 'toaster',
      logger: { info: vi.fn(), warn },
    })
    await expect(client.fetchSystem()).rejects.toBeInstanceOf(HomeComUnknownDeviceTypeError)
    await expect(client.fetchSystem()).rejects.toThrow(
      'HomeCom does not serve device type "toaster".',
    )
    expect(hits.some((hit) => hit.url.includes('/v2/gateways/'))).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('maps an air conditioner onto the climate cap and writes its resources', async () => {
    const hits: Hit[] = []
    const rac = (path: string): unknown | 'missing' => {
      switch (path) {
        case '/airConditioning/operationMode':
          return envelope('cool', { allowedValues: ['auto', 'heat', 'cool', 'dry', 'fanOnly'] })
        case '/airConditioning/temperatureSetpoint':
          return envelope(23, { minValue: 16, maxValue: 30 })
        case '/airConditioning/acControl':
          return envelope('on')
        case '/airConditioning/fanSpeed':
          return envelope('auto', { allowedValues: ['auto', 'low', 'mid', 'high'] })
        case '/airConditioning/airFlowVertical':
          return envelope('swing')
        case '/airConditioning/airFlowHorizontal':
          return envelope('center')
        case '/airConditioning/roomTemperature':
          return envelope(22)
        case '/airConditioning/standardFunctions':
          return { references: [] }
        default:
          return 'missing'
      }
    }
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: router(rac, hits),
      deviceType: 'rac',
    })
    const snapshot = await client.fetchSystem()
    const circuit = snapshot.circuits[0]
    if (circuit === undefined) throw new Error('expected the air conditioner')
    const climate = climateSliceFromCircuit(circuit, 1_000)
    expect(climate.mode).toBe('cool')
    expect(climate.target).toBe(23)
    expect(climate.currentTemp).toBe(22)
    expect(climate.fanMode).toBe('auto')
    expect(climate.availableFanModes).toEqual(['auto', 'low', 'mid', 'high'])
    expect(climate.swingVertical).toBe(true)
    expect(climate.swingHorizontal).toBe(false)
    expect(snapshot.dhw).toBeNull()
    hits.length = 0
    await client.setCircuitSetpoint('ac', 24)
    await client.setCircuitMode('ac', 'Off')
    await client.setFanMode('ac', 'low')
    await client.setSwingVertical('ac', false)
    expect(hits.map((hit) => ({ url: hit.url, method: hit.method, body: hit.body }))).toEqual([
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/airConditioning/temperatureSetpoint`,
        method: 'PUT',
        body: { value: 24 },
      },
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/airConditioning/acControl`,
        method: 'PUT',
        body: { value: 'off' },
      },
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/airConditioning/fanSpeed`,
        method: 'PUT',
        body: { value: 'low' },
      },
      {
        url: `${ORIGIN}/pointt-api/api/v1/gateways/${GATEWAY}/resource/airConditioning/airFlowVertical`,
        method: 'PUT',
        body: { value: 'angle3' },
      },
    ])
  })

  it('logs a missing room-temperature resource and still returns the circuit', async () => {
    const info = vi.fn()
    const client = createHomeComApiClient(settings(), GATEWAY, {
      fetchFn: router((path) => {
        if (path === '/heatingCircuits/hc1/roomtemperature') return 'missing'
        return k40Bodies(path)
      }, []),
      deviceType: 'k30',
      logger: { info, warn: vi.fn() },
    })
    const snapshot = await client.fetchSystem()
    expect(snapshot.circuits[0]?.currentRoomTemp).toBeNull()
    expect(info).toHaveBeenCalled()
    const reasons = info.mock.calls.map((call) => JSON.stringify(call))
    expect(reasons.some((line) => line.includes('roomtemperature'))).toBe(true)
  })
})

describe('HomeCom connection test probe', () => {
  it('reads the gateway clock and names the device type', async () => {
    const hits: Hit[] = []
    const fetchFn: FetchFn = async (url, init) => {
      hits.push({ url, method: init?.method ?? 'GET', body: null })
      if (url.endsWith('/pointt-api/api/v1/gateways/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ deviceId: GATEWAY, deviceType: 'k40', name: 'Boiler' }],
        }
      }
      if (url.endsWith('/resource/gateway/DateTime')) {
        return { ok: true, status: 200, json: async () => envelope('2024-06-01T12:00:00') }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const provider = buildHomeComConnectionTestProvider({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      makeClient: (config, gatewayId) =>
        createHomeComApiClient(config, gatewayId, { fetchFn, refreshOnUnauthorized: false }),
    })
    const outcome = await provider.testSettings({ settings: settings() })
    expect(outcome.outcome).toBe('validated')
    if (outcome.outcome === 'validated') {
      expect(outcome.detail).toMatch(/k40/)
      expect(outcome.detail).toMatch(/DateTime/)
    }
    expect(hits.some((hit) => hit.url.includes('/v2/gateways/'))).toBe(false)
    expect(hits.some((hit) => hit.url.endsWith('/resource/gateway/DateTime'))).toBe(true)
  })

  it('names an unknown device type after the probe', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith('/pointt-api/api/v1/gateways/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ deviceId: GATEWAY, deviceType: 'commodule' }],
        }
      }
      if (url.endsWith('/resource/gateway/DateTime')) {
        return { ok: true, status: 200, json: async () => envelope('2024-06-01T12:00:00') }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const provider = buildHomeComConnectionTestProvider({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      makeClient: (config, gatewayId) =>
        createHomeComApiClient(config, gatewayId, { fetchFn, refreshOnUnauthorized: false }),
    })
    const outcome = await provider.testSettings({ settings: settings() })
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome === 'rejected') {
      expect(outcome.error).toBe('HomeCom does not serve device type "commodule".')
    }
  })
})
