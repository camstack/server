import { describe, expect, it, vi } from 'vitest'
import { createHomeComApiClient, type FetchFn } from '../homecom-api-client.js'
import { runHomeComExplore } from '../homecom-explore-action.js'
import { EXPLORER_SEED_ROOTS, exploreHomeComResources } from '../homecom-resource-explorer.js'

const CONFIG = {
  username: 'me@example.com',
  token: 'access',
  refresh: 'refresh',
  brand: 'bosch',
  region: 'eu',
  gatewayId: undefined,
} as const

const URI = 'https://example.com/pointt-api/api/v1/gateways/g1/resource'

function refs(paths: readonly string[]) {
  return {
    type: 'refEnum',
    references: paths.map((id) => ({ id, uri: `${URI}${id}` })),
  }
}

/** `/heatSources` → hs1 → three leaves; one 403; `/system` answers 429. */
const TREE: Readonly<Record<string, unknown>> = {
  '/': refs(['/heatSources', '/heatingCircuits', '/system']),
  '/heatSources': refs(['/heatSources/hs1']),
  '/heatSources/hs1': {
    type: 'refEnum',
    // A reference named only by its uri.
    references: [
      { uri: `${URI}/heatSources/hs1/actualSupplyTemperature` },
      { id: '/heatSources/hs1/heatPumpPower' },
      { id: '/heatSources/hs1/starts' },
    ],
  },
  '/heatSources/hs1/actualSupplyTemperature': {
    id: '/heatSources/hs1/actualSupplyTemperature',
    type: 'floatValue',
    value: 34.5,
    unitOfMeasure: 'C',
    writeable: 0,
    recordable: 1,
    minValue: -40,
    maxValue: 120,
  },
  '/heatSources/hs1/starts': {
    id: '/heatSources/hs1/starts',
    type: 'stringValue',
    value: 'x'.repeat(500),
    writeable: 1,
    allowedValues: ['a', 'b'],
  },
  '/heatingCircuits': refs(['/heatingCircuits/hc1']),
  '/heatingCircuits/hc1': refs(['/heatingCircuits/hc1/roomtemperature']),
  '/heatingCircuits/hc1/roomtemperature': {
    type: 'floatValue',
    value: 20.5,
    unitOfMeasure: 'C',
  },
}

const STATUSES: Readonly<Record<string, number>> = {
  '/heatSources/hs1/heatPumpPower': 403,
  '/system': 429,
}

interface Call {
  readonly path: string
  readonly method: string
}

function gateway(tree = TREE, statuses = STATUSES): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetchFn: FetchFn = async (url, init) => {
    const path = decodeURIComponent(url.split('/resource')[1] ?? '')
    calls.push({ path, method: init?.method ?? 'GET' })
    const pinned = statuses[path]
    if (pinned !== undefined) return { ok: false, status: pinned, json: async () => ({}) }
    if (path in tree) return { ok: true, status: 200, json: async () => tree[path] }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetchFn, calls }
}

function clientOver(fetchFn: FetchFn) {
  return createHomeComApiClient(CONFIG, 'g1', { fetchFn })
}

describe('HomeCom resource explorer', () => {
  it('walks the tree breadth-first, records leaves, and stops at the first 429 with GETs only', async () => {
    const { fetchFn, calls } = gateway()
    const client = clientOver(fetchFn)
    const sleeps: number[] = []
    const result = await exploreHomeComResources({
      read: (path) => client.readResource(path),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    // BFS: /, then the three roots in order; /system is 429 and stops the walk.
    expect(calls.map((c) => c.path)).toEqual(['/', '/heatSources', '/heatingCircuits', '/system'])
    expect(result.stoppedBy).toBe('rate-limited')
    expect(result.unvisited).toBe(2)
    expect(result.summary).toEqual({
      ok: 3,
      forbidden: 0,
      'not-found': 0,
      'rate-limited': 1,
      error: 0,
    })
    // Paced: one pause between each pair of calls, never shorter than 150 ms.
    expect(sleeps).toHaveLength(calls.length - 1)
    expect(sleeps.every((ms) => ms >= 150)).toBe(true)
  })

  it('records status, type, value, unit, writeable and range per path', async () => {
    const { fetchFn, calls } = gateway(TREE, {
      '/heatSources/hs1/heatPumpPower': 403,
    })
    const client = clientOver(fetchFn)
    const result = await exploreHomeComResources({
      read: (path) => client.readResource(path),
      sleep: async () => undefined,
    })

    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(result.stoppedBy).toBe('complete')
    const byPath = new Map(result.resources.map((r) => [r.path, r]))
    expect(byPath.get('/heatSources/hs1')).toMatchObject({
      type: 'refEnum',
      childCount: 3,
    })
    expect(byPath.get('/heatSources/hs1/actualSupplyTemperature')).toEqual({
      path: '/heatSources/hs1/actualSupplyTemperature',
      httpStatus: 200,
      outcome: 'ok',
      type: 'floatValue',
      value: 34.5,
      unit: 'C',
      writeable: false,
      recordable: true,
      minValue: -40,
      maxValue: 120,
    })
    expect(byPath.get('/heatSources/hs1/heatPumpPower')).toEqual({
      path: '/heatSources/hs1/heatPumpPower',
      httpStatus: 403,
      outcome: 'forbidden',
    })
    const starts = byPath.get('/heatSources/hs1/starts')
    expect(typeof starts?.value === 'string' && starts.value.length).toBe(200)
    expect(starts).toMatchObject({
      writeable: true,
      allowedValues: ['a', 'b'],
    })
    expect(byPath.get('/system')).toEqual({
      path: '/system',
      httpStatus: 404,
      outcome: 'not-found',
    })
    expect(result.summary.forbidden).toBe(1)
  })

  it('stops at maxNodes and reports what it left unvisited', async () => {
    const { fetchFn, calls } = gateway(TREE, {})
    const client = clientOver(fetchFn)
    const result = await exploreHomeComResources({
      read: (path) => client.readResource(path),
      maxNodes: 3,
      sleep: async () => undefined,
    })
    expect(calls).toHaveLength(3)
    expect(result.resources).toHaveLength(3)
    expect(result.stoppedBy).toBe('max-nodes')
    expect(result.unvisited).toBeGreaterThan(0)
  })

  it('caps maxNodes at 1500', async () => {
    const wide: Record<string, unknown> = {}
    const leaves = Array.from({ length: 2000 }, (_, i) => `/system/r${i}`)
    wide['/'] = refs(['/system'])
    wide['/system'] = refs(leaves)
    for (const leaf of leaves) wide[leaf] = { type: 'floatValue', value: 1 }
    const { fetchFn, calls } = gateway(wide, {})
    const client = clientOver(fetchFn)
    const result = await exploreHomeComResources({
      read: (path) => client.readResource(path),
      maxNodes: 5000,
      sleep: async () => undefined,
    })
    expect(calls).toHaveLength(1500)
    expect(result.stoppedBy).toBe('max-nodes')
  })

  it('walks the known roots when / does not list its children', async () => {
    const { fetchFn, calls } = gateway({}, { '/': 404 })
    const client = clientOver(fetchFn)
    await exploreHomeComResources({
      read: (path) => client.readResource(path),
      sleep: async () => undefined,
    })
    expect(calls.map((c) => c.path)).toEqual(['/', ...EXPLORER_SEED_ROOTS])
  })

  it('the action picks the only connected integration and logs one tagged summary line', async () => {
    const { fetchFn, calls } = gateway()
    const client = clientOver(fetchFn)
    const info = vi.fn()
    const out = await runHomeComExplore(
      { root: '/heatSources' },
      {
        listConnected: () => ['int-1'],
        getClient: (id) => (id === 'int-1' ? client : null),
        getGatewayId: () => 'g1',
        logger: { info },
        sleep: async () => undefined,
      },
    )
    expect(calls[0]?.path).toBe('/heatSources')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(out).toMatchObject({
      integrationId: 'int-1',
      gatewayId: 'g1',
      stoppedBy: 'complete',
    })
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      tags: { integrationId: 'int-1' },
      meta: { ok: 4, forbidden: 1 },
    })
  })

  it('refuses to guess between several connected integrations', async () => {
    await expect(
      runHomeComExplore(
        {},
        {
          listConnected: () => ['a', 'b'],
          getClient: () => null,
          getGatewayId: () => null,
          logger: { info: vi.fn() },
        },
      ),
    ).rejects.toThrow(/integrationId/)
  })
})
