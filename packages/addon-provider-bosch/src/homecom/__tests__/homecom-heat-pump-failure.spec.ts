import { describe, expect, it, vi } from 'vitest'
import { heatPumpStatusFrom } from '../homecom-heat-pump.js'
import { buildDiscoverables } from '../homecom-gateway.js'
import { createHomeComApiClient, type FetchFn } from '../homecom-api-client.js'

const CONFIG = {
  username: 'me@example.com',
  token: 'access',
  refresh: 'refresh',
  brand: 'bosch',
  region: 'eu',
  gatewayId: undefined,
} as const

function envelope(value: string | number) {
  return { value }
}

const REFS = (ids: readonly string[]) => ({ references: ids.map((id) => ({ id })) })

/**
 * A hydronic gateway whose heat-pump tree is wholly refused: 404 on the heat-pump-only
 * resources (so it is a boiler), 500 on the rest of the tree. `statuses` pins a path's status.
 */
function gateway(
  answers: Readonly<Record<string, unknown>>,
  statuses: Readonly<Record<string, number>> = {},
): FetchFn {
  return async (url) => {
    const path = decodeURIComponent(url.split('/resource')[1] ?? '')
    if (path in answers) return { ok: true, status: 200, json: async () => answers[path] }
    const pinned = statuses[path]
    if (pinned !== undefined) return { ok: false, status: pinned, json: async () => ({}) }
    if (path === '/heatSources/hs1/heatPumpType' || path === '/heatSources/hs1/heatPumpPower') {
      return { ok: false, status: 404, json: async () => ({}) }
    }
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
    expect(buildDiscoverables(first).map((d) => d.kind)).toEqual([
      'gateway',
      'heating-circuit',
      'dhw',
    ])
    const failed = log.warn.mock.calls.map((c) => c[1]?.meta?.path)
    expect(failed.length).toBeGreaterThan(0)
    expect(new Set(failed).size).toBe(failed.length)
    expect(log.warn.mock.calls[0]?.[1]?.tags).toEqual({ gatewayId: 'g1' })
  })

  it('offers no heat pump on a boiler whose heat source answers only flow, pressure and starts', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({
        ...BASE,
        '/heatSources/hs1/supplyTemperature': envelope(55),
        '/heatSources/hs1/returnTemperature': envelope(40),
        '/heatSources/hs1/waterPressure': envelope(1.6),
        '/heatSources/hs1/numberOfStarts': envelope(1200),
      }),
      deviceType: 'k40',
      logger: logger(),
    })
    expect((await client.fetchSystem()).heatPump).toBeUndefined()
  })

  it('offers hp:0 when the gateway answers only away=off and an empty holiday', async () => {
    const log = logger()
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({
        ...BASE,
        '/heatingCircuits': REFS(['/heatingCircuits/hc1', '/heatingCircuits/hc2']),
        '/system/awayMode': { ...envelope('off'), allowedValues: ['off', 'on'] },
        '/system/holidayMode': envelope(''),
      }),
      deviceType: 'k40',
      logger: log,
    })
    const snapshot = await client.fetchSystem()
    await client.fetchSystem()
    const heatPump = snapshot.heatPump
    if (heatPump === undefined) throw new Error('expected a heat pump')
    const picks = buildDiscoverables(snapshot)
    expect(picks.map((d) => [d.nativeId, d.name])).toEqual([
      ['gateway:0', 'g1'],
      ['hp:0', 'Heat pump'],
    ])
    expect(picks[1]?.children?.map((d) => [d.nativeId, d.name])).toEqual([
      ['hc:hc1', 'Heating circuit 1'],
      ['hc:hc2', 'Heating circuit 2'],
      ['dhw:0', 'Hot water'],
    ])
    const status = heatPumpStatusFrom(heatPump, 1)
    expect(status.system.away?.value).toBe('off')
    expect(status.system.holiday?.value).toBe('none')
    expect(status.system.silent).toBeNull()
    expect(status.system.additionalHeater).toBeNull()
    expect(status.power).toEqual({ thermalW: null, electricalW: null, compressorPct: null })
    expect(status.temperatures.supply).toBeNull()
    expect(status.waterPressureBar).toBeNull()
    expect(status.starts).toBeNull()
    const census = log.info.mock.calls.filter((call) => call[0] === 'HomeCom heat-pump paths')
    expect(census).toHaveLength(1)
    expect(census[0]?.[1]?.tags).toEqual({ gatewayId: 'g1' })
    expect(census[0]?.[1]?.meta?.answered).toEqual(
      expect.arrayContaining(['/system/awayMode', '/system/holidayMode']),
    )
    expect(census[0]?.[1]?.meta?.unanswered).toEqual(
      expect.arrayContaining([
        '/heatSources/hs1/silentMode',
        '/heatSources/hs1/additionalHeaterMode',
        '/heatSources/hs1/heatPumpPower',
      ]),
    )
  })

  it('keeps a heating-circuit name the gateway already gave', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({
        ...BASE,
        '/heatingCircuits': {
          references: [{ id: '/heatingCircuits/hc1', name: 'Living room' }],
        },
      }),
      deviceType: 'k40',
      logger: logger(),
    })
    const snapshot = await client.fetchSystem()
    expect(buildDiscoverables(snapshot).find((d) => d.nativeId === 'hc:hc1')?.name).toBe(
      'Living room',
    )
  })

  it('attaches the heat pump once a heat source answers', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({ ...BASE, '/heatSources/hs1/heatPumpPower': envelope(4200) }),
      deviceType: 'k40',
      logger: logger(),
    })
    expect((await client.fetchSystem()).heatPump?.thermalW).toBe(4200)
  })

  it('recognises the heat pump of a gateway that refuses its system tree, from heatCoolMode', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({
        ...BASE,
        '/heatingCircuits/hc1/heatCoolMode': {
          ...envelope('heating'),
          allowedValues: ['heating', 'cooling'],
        },
      }),
      deviceType: 'k40',
      logger: logger(),
    })
    const snapshot = await client.fetchSystem()
    expect(snapshot.heatPump).toBeDefined()
    expect(buildDiscoverables(snapshot).map((d) => d.nativeId)).toEqual(['gateway:0', 'hp:0'])
  })

  it('recognises the heat pump of a gateway whose heat source answers 403, never as 0', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway(BASE, {
        '/heatSources/hs1/heatPumpPower': 403,
        '/heatSources/hs1/heatPumpType': 403,
      }),
      deviceType: 'k40',
      logger: logger(),
    })
    const snapshot = await client.fetchSystem()
    const heatPump = snapshot.heatPump
    if (heatPump === undefined) throw new Error('expected a heat pump')
    expect(buildDiscoverables(snapshot).map((d) => d.nativeId)).toEqual(['gateway:0', 'hp:0'])
    const status = heatPumpStatusFrom(heatPump, 1)
    expect(status.power).toEqual({ thermalW: null, electricalW: null, compressorPct: null })
    expect(status.system).toEqual({
      silent: null,
      away: null,
      additionalHeater: null,
      holiday: null,
    })
  })

  it('keeps a boiler a boiler when the probes only fail transiently (503, 429)', async () => {
    const log = logger()
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway(
        { ...BASE, '/heatSources/hs1/supplyTemperature': envelope(55) },
        { '/heatSources/hs1/heatPumpPower': 503, '/heatSources/hs1/heatPumpType': 429 },
      ),
      deviceType: 'k40',
      logger: log,
    })
    expect((await client.fetchSystem()).heatPump).toBeUndefined()
    const logged = log.warn.mock.calls.map((c) => c[1]?.meta?.path)
    expect(logged).toEqual(
      expect.arrayContaining(['/heatSources/hs1/heatPumpPower', '/heatSources/hs1/heatPumpType']),
    )
  })

  it('logs a probe that threw instead of dropping it, and does not count it', async () => {
    const log = logger()
    const inner = gateway({ ...BASE, '/heatSources/hs1/supplyTemperature': envelope(55) })
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: async (url, init) => {
        if (url.includes('heatPumpType')) throw new Error('socket hang up')
        return inner(url, init)
      },
      deviceType: 'k40',
      logger: log,
    })
    expect((await client.fetchSystem()).heatPump).toBeUndefined()
    expect(log.warn.mock.calls.map((c) => c[1]?.meta?.path)).toContain(
      '/heatSources/hs1/heatPumpType',
    )
  })

  it('does not take a boiler for a heat pump because a circuit answers heatCoolMode as heating only', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({
        ...BASE,
        '/heatSources/hs1/supplyTemperature': envelope(55),
        '/heatingCircuits/hc1/heatCoolMode': { ...envelope('heating'), allowedValues: ['heating'] },
      }),
      deviceType: 'k40',
      logger: logger(),
    })
    expect((await client.fetchSystem()).heatPump).toBeUndefined()
  })

  it('keeps the boiler path when the heat-pump-only resources are 404', async () => {
    const client = createHomeComApiClient(CONFIG, 'g1', {
      fetchFn: gateway({ ...BASE, '/heatSources/hs1/supplyTemperature': envelope(55) }),
      deviceType: 'k40',
      logger: logger(),
    })
    expect((await client.fetchSystem()).heatPump).toBeUndefined()
  })
})
