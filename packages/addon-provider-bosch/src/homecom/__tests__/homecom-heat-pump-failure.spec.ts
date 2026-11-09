import { describe, expect, it, vi } from 'vitest'
import { createHomeComApiClient, type FetchFn } from '../homecom-api-client.js'

const CONFIG = {
  username: 'me@example.com',
  token: 'access',
  refresh: 'refresh',
  brand: 'bosch',
  region: 'eu',
} as const

function envelope(value: string | number) {
  return { value }
}

const REFS = (ids: readonly string[]) => ({ references: ids.map((id) => ({ id })) })

/** A hydronic gateway whose heat-pump tree is wholly refused: 404 on some paths, 500 on the rest. */
function gateway(answers: Readonly<Record<string, unknown>>): FetchFn {
  return async (url) => {
    const path = decodeURIComponent(url.split('/resource')[1] ?? '')
    if (path in answers) return { ok: true, status: 200, json: async () => answers[path] }
    if (path.startsWith('/heatSources') || path.startsWith('/recordings')) {
      return { ok: false, status: 500, json: async () => ({}) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
}

const BASE = {
  '/heatingCircuits': REFS(['/heatingCircuits/hc1']),
  '/dhwCircuits': REFS(['/dhwCircuits/dhw1']),
  '/heatingCircuits/hc1/operationMode': { ...envelope('manual'), allowedValues: ['off', 'manual'] },
  '/heatingCircuits/hc1/roomtemperature': envelope(20.5),
  '/heatingCircuits/hc1/manualRoomSetpoint': { ...envelope(21), minValue: 5, maxValue: 30 },
  '/dhwCircuits/dhw1/actualTemp': envelope(48),
  '/dhwCircuits/dhw1/operationMode': { ...envelope('eco'), allowedValues: ['off', 'eco'] },
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

describe('HomeCom heat pump reads never break the working devices', () => {
  it('keeps Climate and WaterHeater and offers no heat pump when every heat-pump path fails', async () => {
    const log = logger()
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway(BASE),
      deviceType: 'k40',
      logger: log,
    })
    const first = await client.fetchSystem()
    await client.fetchSystem()
    expect(first.circuits.map((c) => c.id)).toEqual(['hc1'])
    expect(first.dhw?.circuitId).toBe('dhw1')
    expect(first.heatPump).toBeUndefined()
    const failed = log.warn.mock.calls.map((c) => c[1]?.meta?.path)
    expect(failed.length).toBeGreaterThan(0)
    expect(new Set(failed).size).toBe(failed.length)
    expect(log.warn.mock.calls[0]?.[1]?.tags).toEqual({ gatewayId: 'g1' })
  })

  it('attaches the heat pump once a heat source answers', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({ ...BASE, '/heatSources/hs1/heatPumpPower': envelope(4200) }),
      deviceType: 'k40',
      logger: logger(),
    })
    expect((await client.fetchSystem()).heatPump?.thermalW).toBe(4200)
  })
})
