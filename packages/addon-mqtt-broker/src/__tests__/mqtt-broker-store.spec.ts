import { describe, expect, it } from 'vitest'
import { MqttExternalBrokerEntrySchema } from '../mqtt-external-broker-entry.js'
import { MqttBrokerStore } from '../mqtt-broker-store.js'
import { makeInMemoryRecords } from '@camstack/types'
import { mqttBrokersEntryKind } from '../broker-record-kinds.js'

async function makeMqttRecords() {
  const world = makeInMemoryRecords('mqtt-broker')
  await world.records.declare({ brokers: mqttBrokersEntryKind })
  return world
}

describe('MqttBrokerStore', () => {
  it('replaceAll round-trips external broker password', async () => {
    const world = await makeMqttRecords()
    const store = MqttBrokerStore.of(world.records)
    const entry = MqttExternalBrokerEntrySchema.parse({
      id: 'mqtt_001',
      name: 'Hive',
      url: 'mqtt://broker.local:1883',
      password: 'pw',
    })
    await store.replaceAll([entry])
    expect((await store.listResolved())[0]?.password).toBe('pw')
  })
})
