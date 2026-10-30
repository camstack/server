import { describe, expect, it } from 'vitest'
import { buildEspAdoptionProvider } from '../esphome-adoption-provider.js'
import type { EspBrokerInfo } from '../esphome-registry.js'
import { FakeLink, entity } from './fake-link.js'
import { captureLogger } from './fake-ctx.js'

const BOARD = [
  entity({ id: 'switch-relay', type: 'switch', name: 'Relay' }),
  entity({ id: 'sensor-power', type: 'sensor', deviceClass: 'power', unit: 'W' }),
]

describe('adoption provider', () => {
  function info(id: string): EspBrokerInfo {
    return {
      id,
      name: 'Board',
      kind: 'esphome',
      status: 'connected',
      info: {},
      lastCheckedAt: 1,
      error: null,
    }
  }

  /** Two integrations: `i1` holds b1 and b2, `i2` holds b3. */
  const BOARDS_OF: Readonly<Record<string, readonly string[]>> = {
    i1: ['b1', 'b2'],
    i2: ['b3'],
  }

  function setup(links: Readonly<Record<string, FakeLink | null>>) {
    const adopted: { id: number; config: Record<string, unknown> }[] = []
    const calls: { brokerId: string; integrationId: string; name: string }[] = []
    let nextId = 42
    const provider = buildEspAdoptionProvider({
      registry: {
        list: () => Object.keys(links).map(info),
        get: (id) => (id in links ? info(id) : null),
        getLink: (id) => links[id] ?? null,
      },
      getBoardIdsForIntegration: async (id) => BOARDS_OF[id] ?? [],
      listAdopted: async () => adopted,
      adoptDevice: async ({ brokerId, integrationId, name }) => {
        calls.push({ brokerId, integrationId, name })
        const deviceId = nextId
        nextId += 10
        adopted.push({ id: deviceId, config: { system: 'esphome', brokerId } })
        return { deviceId, accessoryDeviceIds: [deviceId + 1, deviceId + 2] }
      },
      removeDevice: async () => undefined,
      findDeviceConfig: async (id) => adopted.find((a) => a.id === id)?.config ?? null,
      logger: captureLogger([]),
    })
    return { provider, calls }
  }

  const B1 = new FakeLink(BOARD)
  const B2 = new FakeLink(BOARD)
  const B3 = new FakeLink(BOARD)

  it('offers each connected board of the integration as its own candidate with its entities as children', async () => {
    const { provider } = setup({ b1: B1, b2: B2, b3: B3 })
    const page = await provider.listCandidates({ integrationId: 'i1', page: 1, pageSize: 10 })
    expect(page.candidates.map((c) => c.childNativeId)).toEqual(['b1', 'b2'])
    expect(page.totalCount).toBe(2)
    const candidate = page.candidates[0]
    expect(candidate?.children?.map((c) => c.childNativeId)).toEqual([
      'switch-relay',
      'power-meter',
    ])
    expect(candidate?.alreadyAdopted).toBe(false)
  })

  it('never offers a board that belongs to another integration', async () => {
    const { provider } = setup({ b1: B1, b2: B2, b3: B3 })
    const other = await provider.listCandidates({ integrationId: 'i2', page: 1, pageSize: 10 })
    expect(other.candidates.map((c) => c.childNativeId)).toEqual(['b3'])
    expect(await provider.getCandidate({ integrationId: 'i1', childNativeId: 'b3' })).toBeNull()
  })

  it('offers nothing for a board that is not connected, and refuses to adopt it', async () => {
    const { provider } = setup({ b1: null, b2: null })
    const page = await provider.listCandidates({ integrationId: 'i1', page: 1, pageSize: 10 })
    expect(page.totalCount).toBe(0)
    await expect(provider.adopt({ integrationId: 'i1', childNativeIds: ['b1'] })).rejects.toThrow(
      /failed/,
    )
  })

  it('adopts two boards as two containers, each reported adopted on its own', async () => {
    const { provider, calls } = setup({ b1: B1, b2: B2, b3: B3 })
    const result = await provider.adopt({ integrationId: 'i1', childNativeIds: ['b1', 'b2'] })
    expect(result.adopted).toEqual([
      { childNativeId: 'b1', parentDeviceId: 42, accessoryDeviceIds: [43, 44] },
      { childNativeId: 'b2', parentDeviceId: 52, accessoryDeviceIds: [53, 54] },
    ])
    expect(calls.map((c) => [c.brokerId, c.integrationId])).toEqual([
      ['b1', 'i1'],
      ['b2', 'i1'],
    ])
    const after = await provider.listCandidates({ integrationId: 'i1', page: 1, pageSize: 10 })
    expect(after.candidates.map((c) => c.adoptedDeviceId)).toEqual([42, 52])
  })

  it('refuses a board of another integration', async () => {
    const { provider, calls } = setup({ b1: B1, b2: B2, b3: B3 })
    await expect(provider.adopt({ integrationId: 'i1', childNativeIds: ['b3'] })).rejects.toThrow(
      /failed/,
    )
    expect(calls).toEqual([])
  })

  it('refuses to resync a device that is not an ESPHome board', async () => {
    const { provider } = setup({ b1: B1 })
    await expect(provider.resync({ camDeviceId: 99 })).rejects.toThrow(/not found/)
  })
})
