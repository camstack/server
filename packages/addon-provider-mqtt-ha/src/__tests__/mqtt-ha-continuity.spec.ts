import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { buildMqttHaAdoptionProvider } from '../mqtt-ha-adoption-provider.js'
import { buildMqttHaStableId, parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import { MqttHaDiscoveryStore } from '../mqtt-ha-discovery-store.js'
import { resolveDeviceModel, mqttHaDeviceSchema } from '../devices/mqtt-ha-device-config.js'
import { plugMessages, type DiscoveryMessage } from './fixtures/z2m-discovery.js'

const BROKER = 'mqtt_z2m'

function storeWith(messages: readonly DiscoveryMessage[]): MqttHaDiscoveryStore {
  const store = new MqttHaDiscoveryStore()
  for (const m of messages) {
    const parsed = parseDiscoveryConfigPayload({
      brokerId: BROKER,
      component: m.component,
      objectId: m.objectId,
      payload: JSON.stringify(m.payload),
      now: 1,
    })
    if (parsed !== null && parsed !== 'remove') store.upsert(parsed)
  }
  return store
}

const logger: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

function providerOver(
  store: MqttHaDiscoveryStore,
  adopted: ReadonlyArray<{ id: number; config: Record<string, unknown> }>,
) {
  return buildMqttHaAdoptionProvider({
    store,
    logger,
    getMqttBrokerIdForIntegration: async () => BROKER,
    listAdoptedMqttHa: async () => adopted,
    adoptDevice: vi.fn(async () => ({ deviceId: 999 })),
    removeDevice: vi.fn(async () => {}),
  })
}

// What the previous flat-entity flow persisted for an adopted switch.
const LEGACY_SWITCH_CONFIG = {
  brokerId: BROKER,
  entityKey: 'switch.kitchen',
  component: 'switch',
  stateTopic: 'home/kitchen/state',
  commandTopic: 'home/kitchen/set',
  capabilities: ['switch'],
  payloadOn: 'ON',
  payloadOff: 'OFF',
  system: 'mqtt-ha',
}

describe('a device adopted before grouping keeps its identity', () => {
  it('keeps the stable id scheme of a lone entity', () => {
    expect(buildMqttHaStableId(BROKER, 'switch.kitchen')).toBe(
      `mqtt:${BROKER}:entity:switch.kitchen`,
    )
  })

  it('reads the old flat config as a one-entity switch with the same topics', () => {
    const model = resolveDeviceModel(mqttHaDeviceSchema.parse(LEGACY_SWITCH_CONFIG))
    expect(model.capabilities).toEqual(['switch'])
    const entity = model.entities.get('switch.kitchen')
    expect(entity).toMatchObject({
      stateTopic: 'home/kitchen/state',
      commandTopic: 'home/kitchen/set',
      payloadOn: 'ON',
    })
  })

  it('a lone entity is still offered under its old id, and reported adopted with its deviceId', async () => {
    const store = storeWith([
      {
        component: 'switch',
        objectId: 'kitchen',
        payload: {
          name: 'Kitchen',
          state_topic: 'home/kitchen/state',
          command_topic: 'home/kitchen/set',
          unique_id: 'kitchen',
        },
      },
    ])
    const entity = store.listForBroker(BROKER)[0]!
    const provider = providerOver(store, [
      { id: 41, config: { ...LEGACY_SWITCH_CONFIG, entityKey: entity.entityKey } },
    ])
    const { candidates } = await provider.listCandidates({
      integrationId: 'i1',
      page: 1,
      pageSize: 50,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      childNativeId: entity.entityKey,
      alreadyAdopted: true,
      adoptedDeviceId: 41,
    })
  })

  it('a z2m device whose switch was adopted alone is reported adopted, not offered again', async () => {
    const store = storeWith(plugMessages())
    const sw = store.listForBroker(BROKER).find((e) => e.component === 'switch')!
    const provider = providerOver(store, [
      { id: 52, config: { ...LEGACY_SWITCH_CONFIG, entityKey: sw.entityKey } },
    ])
    const { candidates } = await provider.listCandidates({
      integrationId: 'i1',
      page: 1,
      pageSize: 50,
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ alreadyAdopted: true, adoptedDeviceId: 52 })
  })
})
