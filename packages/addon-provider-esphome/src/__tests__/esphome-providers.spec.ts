import { describe, expect, it } from 'vitest'
import type { EspBrokerEntry, EspConnection } from '../config.js'
import { buildEspAdoptionProvider } from '../esphome-adoption-provider.js'
import { buildEspBrokerProvider } from '../esphome-broker-provider.js'
import { EspBrokerRegistry, type EspBrokerInfo } from '../esphome-registry.js'
import { EspLinkHub } from '../esphome-link-hub.js'
import { FakeFactory, FakeLink, entity } from './fake-link.js'
import { captureLogger } from './fake-ctx.js'

const PSK = 'c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0wMDAwMDA='
const CONNECTION: EspConnection = { host: '10.0.0.7', port: 6053, noisePsk: PSK, password: '' }

const BOARD = [
  entity({ id: 'switch-relay', type: 'switch', name: 'Relay' }),
  entity({ id: 'sensor-power', type: 'sensor', deviceClass: 'power', unit: 'W' }),
]

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('broker provider', () => {
  async function setup() {
    const factory = new FakeFactory(new FakeLink(BOARD))
    const registry = new EspBrokerRegistry({
      factory,
      logger: captureLogger([]),
      hub: new EspLinkHub(),
    })
    let brokers: readonly EspBrokerEntry[] = []
    const cascaded: string[] = []
    const provider = buildEspBrokerProvider({
      ownerAddonId: 'provider-esphome',
      registry,
      getBrokers: () => brokers,
      persistBrokers: async (next) => {
        brokers = next
      },
      cascadeRemoveDevices: async (id) => {
        cascaded.push(id)
      },
      logger: captureLogger([]),
    })
    return { provider, registry, factory, cascaded, brokers: () => brokers }
  }

  it('never returns a stored key through a read', async () => {
    const { provider } = await setup()
    const { id } = await provider.add({ kind: 'esphome', name: 'Board', settings: CONNECTION })
    await settle()
    const settings = await provider.getSettings({ id })
    const config = await provider.getBrokerConfig({ id })
    expect(JSON.stringify(settings)).not.toContain(PSK)
    expect(JSON.stringify(config)).not.toContain(PSK)
    expect(settings).toMatchObject({ host: '10.0.0.7', noisePsk: '' })
  })

  it('keeps the stored key when a write echoes the blank', async () => {
    const { provider, registry, brokers } = await setup()
    const { id } = await provider.add({ kind: 'esphome', name: 'Board', settings: CONNECTION })
    await settle()
    await provider.setSettings({ id, settings: { ...CONNECTION, host: '10.0.0.8', noisePsk: '' } })
    expect(registry.getConnection(id)).toMatchObject({ host: '10.0.0.8', noisePsk: PSK })
    expect(brokers()[0]?.connection.noisePsk).toBe(PSK)
  })

  it('removes the board and cascades its devices', async () => {
    const { provider, registry, cascaded } = await setup()
    const { id } = await provider.add({ kind: 'esphome', name: 'Board', settings: CONNECTION })
    await provider.remove({ id })
    expect(cascaded).toEqual([id])
    expect(registry.get(id)).toBeNull()
  })

  it('refuses a foreign kind and validates settings without opening a session', async () => {
    const { provider, factory } = await setup()
    await expect(provider.add({ kind: 'mqtt', name: 'x', settings: CONNECTION })).rejects.toThrow()
    const ok = await provider.testSettings({ kind: 'esphome', settings: CONNECTION })
    expect(ok.ok).toBe(true)
    const bad = await provider.testSettings({ kind: 'esphome', settings: { host: '' } })
    expect(bad.ok).toBe(false)
    expect(factory.opened).toHaveLength(0)
  })
})

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

  function setup(link: FakeLink | null) {
    const adopted: { id: number; config: Record<string, unknown> }[] = []
    const calls: { brokerId: string; name: string }[] = []
    const provider = buildEspAdoptionProvider({
      registry: {
        list: () => [info('b1')],
        get: (id) => (id === 'b1' ? info(id) : null),
        getLink: (id) => (id === 'b1' ? link : null),
      },
      getBrokerIdForIntegration: async () => 'b1',
      listAdopted: async () => adopted,
      adoptDevice: async ({ brokerId, name }) => {
        calls.push({ brokerId, name })
        adopted.push({ id: 42, config: { system: 'esphome', brokerId } })
        return { deviceId: 42, accessoryDeviceIds: [43, 44] }
      },
      removeDevice: async () => undefined,
      findDeviceConfig: async (id) => adopted.find((a) => a.id === id)?.config ?? null,
      logger: captureLogger([]),
    })
    return { provider, calls }
  }

  it('offers the connected board as one candidate with its entities as children', async () => {
    const { provider } = setup(new FakeLink(BOARD))
    const page = await provider.listCandidates({ integrationId: 'i1', page: 1, pageSize: 10 })
    expect(page.totalCount).toBe(1)
    const candidate = page.candidates[0]
    expect(candidate?.childNativeId).toBe('b1')
    expect(candidate?.children?.map((c) => c.childNativeId)).toEqual([
      'switch-relay',
      'power-meter',
    ])
    expect(candidate?.alreadyAdopted).toBe(false)
  })

  it('offers nothing for a board that is not connected', async () => {
    const { provider } = setup(null)
    const page = await provider.listCandidates({ integrationId: 'i1', page: 1, pageSize: 10 })
    expect(page.totalCount).toBe(0)
    await expect(provider.adopt({ integrationId: 'i1', childNativeIds: ['b1'] })).rejects.toThrow(
      /not connected/,
    )
  })

  it('adopts the board once and then reports it adopted', async () => {
    const { provider, calls } = setup(new FakeLink(BOARD))
    const result = await provider.adopt({ integrationId: 'i1', childNativeIds: ['b1'] })
    expect(result.adopted).toEqual([
      { childNativeId: 'b1', parentDeviceId: 42, accessoryDeviceIds: [43, 44] },
    ])
    expect(calls).toEqual([{ brokerId: 'b1', name: 'board-a' }])
    const after = await provider.getCandidate({ integrationId: 'i1', childNativeId: 'b1' })
    expect(after?.alreadyAdopted).toBe(true)
    expect(after?.adoptedDeviceId).toBe(42)
  })

  it('refuses to resync a device that is not an ESPHome board', async () => {
    const { provider } = setup(new FakeLink(BOARD))
    await expect(provider.resync({ camDeviceId: 99 })).rejects.toThrow(/not found/)
  })
})
