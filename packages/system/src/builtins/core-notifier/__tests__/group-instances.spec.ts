import {
  buildNotificationTargetInstances,
  listNotificationTargets,
  NotificationTargetStore,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { groupRecordKinds, groupTargetKind, EMPTY_GROUP_CAPS } from '../group-descriptor.js'
import { groupInstancesSpec, validateGroupMembers } from '../group-instances.js'

describe('validateGroupMembers', () => {
  it('refuses a nested group, a duplicate and an unreadable row', () => {
    const groups = new Set(['inner'])
    expect(() => validateGroupMembers({ members: [{ targetId: 'inner' }] }, groups)).toThrow(
      /another group/,
    )
    expect(() =>
      validateGroupMembers({ members: [{ targetId: 'a' }, { targetId: 'a' }] }, groups),
    ).toThrow(/twice/)
    expect(() => validateGroupMembers({ members: [{ targetId: '' }] }, groups)).toThrow(/not valid/)
    expect(validateGroupMembers({ members: [{ targetId: 'a', minPriority: 2 }] }, groups)).toEqual([
      { targetId: 'a', minPriority: 2 },
    ])
  })
})

describe('a group is a notification-output instance', () => {
  it('is listed by the reader both senders use, with the id and addon the send is addressed by', async () => {
    const records = await makeRecordsAccessForOwner('core-notifier')
    await records.declare(groupRecordKinds)
    const provider = buildNotificationTargetInstances(
      records,
      groupInstancesSpec({ mintId: () => 'g-1', knownGroupIds: () => new Set() }),
    )
    const created = await provider.createInstance({
      name: 'Night crew',
      kind: 'group',
      values: { members: [{ targetId: 'a' }] },
    })
    expect(created.id).toBe('g-1')
    const read = await listNotificationTargets({
      capabilities: { getCapability: { query: async () => ({ providers: ['core-notifier'] }) } },
      integrationInstances: {
        describe: { query: async () => provider.describe() },
        listInstances: { query: async () => provider.listInstances({}) },
      },
    })
    expect(read.unreadable).toEqual([])
    expect(read.targets).toEqual([
      { id: 'g-1', name: 'Night crew', kind: 'group', addonId: 'core-notifier', enabled: true },
    ])
    const store = NotificationTargetStore.of(records, 'core-notifier', groupRecordKinds, [
      groupTargetKind(EMPTY_GROUP_CAPS),
    ])
    expect((await store.getById('g-1'))?.config).toEqual({ members: [{ targetId: 'a' }] })
  })
})
