import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  activeAcl,
  activeClients,
  buildMqttAclInstances,
  buildMqttClientInstances,
  MQTT_ACL_INSTANCE_KIND,
  MQTT_CLIENT_INSTANCE_KIND,
} from '../mqtt-embedded-instances.js'
import { mqttAclEntryKind, mqttClientEntryKind } from '../mqtt-entry-record-kinds.js'

async function setup() {
  const world = makeInMemoryRecords('mqtt-broker')
  await world.records.declare({
    'mqtt-client': mqttClientEntryKind,
    'mqtt-acl-rule': mqttAclEntryKind,
  })
  let changed = 0
  const deps = {
    onChanged: async () => {
      changed += 1
    },
  }
  const clients = buildMqttClientInstances(world.records, deps)
  const acl = buildMqttAclInstances(world.records, deps)
  return { clients, acl, changes: () => changed }
}

describe('the embedded clients and ACL as instance kinds', () => {
  it('lists a client under its kind, with the username as its name, and reloads on a change', async () => {
    const w = await setup()
    const provider = w.clients.toProvider()
    const created = await provider.createInstance({
      id: 'c1',
      name: 'cam-gateway',
    })
    expect(created.id).toBe('c1')
    await provider.updateInstance({
      id: 'c1',
      values: { passwordHash: '$2b$10$h' },
    })
    const listed = await provider.listInstances()
    expect(listed).toMatchObject([
      {
        id: 'c1',
        name: 'cam-gateway',
        kind: MQTT_CLIENT_INSTANCE_KIND,
        configured: true,
      },
    ])
    expect(w.changes()).toBeGreaterThan(0)
    expect(activeClients(await w.clients.listResolved())).toEqual([
      { username: 'cam-gateway', passwordHash: '$2b$10$h' },
    ])
  })

  it('does not authenticate a switched-off client or evaluate a switched-off rule', async () => {
    const w = await setup()
    const cp = w.clients.toProvider()
    await cp.createInstance({ id: 'c1', name: 'a' })
    await cp.updateInstance({ id: 'c1', values: { passwordHash: '$2b$10$h' } })
    await cp.setInstanceEnabled({ id: 'c1', enabled: false })
    expect(activeClients(await w.clients.listResolved())).toEqual([])

    const ap = w.acl.toProvider()
    await ap.createInstance({ id: 'r1', name: 'a' })
    await ap.updateInstance({
      id: 'r1',
      values: { topicPattern: 'home/#', access: 'sub' },
    })
    expect(activeAcl(await w.acl.listResolved())).toEqual([
      { username: 'a', topicPattern: 'home/#', access: 'sub' },
    ])
    expect((await ap.listInstances())[0]?.kind).toBe(MQTT_ACL_INSTANCE_KIND)
    await ap.setInstanceEnabled({ id: 'r1', enabled: false })
    expect(activeAcl(await w.acl.listResolved())).toEqual([])
  })
})
