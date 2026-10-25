import { describe, expect, it } from 'vitest'
import { mqttAclEntryKind, mqttClientEntryKind } from '../mqtt-entry-record-kinds.js'
import { MqttAclStore, MqttClientStore, mqttAclRecordId } from '../mqtt-entry-store.js'
import { makeInMemoryRecords } from '@camstack/types'

async function makeMqttEntryRecords() {
  const world = makeInMemoryRecords('mqtt-broker')
  await world.records.declare({
    'mqtt-client': mqttClientEntryKind,
    'mqtt-acl-rule': mqttAclEntryKind,
  })
  return world
}

describe('MqttClientStore', () => {
  it('replaceAll round-trips client password hash', async () => {
    const world = await makeMqttEntryRecords()
    const store = MqttClientStore.of(world.records)
    await store.replaceAll([{ username: 'u', passwordHash: 'pw' }])
    expect((await store.listResolved())[0]?.passwordHash).toBe('pw')
  })
})

describe('MqttAclStore', () => {
  it('replaceAll round-trips ACL rows', async () => {
    const world = await makeMqttEntryRecords()
    const store = MqttAclStore.of(world.records)
    const entry = {
      username: 'client-a',
      topicPattern: 'topic/#',
      access: 'both' as const,
    }
    await store.replaceAll([entry])
    expect(await store.listResolved()).toEqual([entry])
    expect(mqttAclRecordId(entry)).toBe('client-a\u0000topic/#')
  })
})
