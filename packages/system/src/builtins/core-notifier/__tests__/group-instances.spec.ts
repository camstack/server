import {
  buildNotificationTargetInstances,
  listNotificationTargets,
  NotificationTargetStore,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { groupRecordKinds, groupTargetKind } from '../group-descriptor.js'
import { groupInstancesSpec, refuseNestedGroups, validateGroupMembers } from '../group-instances.js'

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

describe('a fallback member', () => {
  const none = new Set<string>()
  it('is accepted when it backs up a member listed before it', () => {
    const members = [{ targetId: 'a' }, { targetId: 'b', onlyIfUndelivered: ['a'] }]
    expect(validateGroupMembers({ members }, none)).toEqual(members)
  })

  it('is refused when it names a later member, itself, or a notifier outside the group', () => {
    const later = [{ targetId: 'b', onlyIfUndelivered: ['a'] }, { targetId: 'a' }]
    expect(() => validateGroupMembers({ members: later }, none)).toThrow(/listed before it/)
    expect(() =>
      validateGroupMembers({ members: [{ targetId: 'a', onlyIfUndelivered: ['a'] }] }, none),
    ).toThrow(/listed before it/)
    expect(() =>
      validateGroupMembers({ members: [{ targetId: 'a', onlyIfUndelivered: ['gone'] }] }, none),
    ).toThrow(/listed before it/)
  })
})

describe('a group is a notification-output instance', () => {
  it('is listed by the reader both senders use, with the id and addon the send is addressed by', async () => {
    const records = await makeRecordsAccessForOwner('core-notifier')
    await records.declare(groupRecordKinds)
    const provider = buildNotificationTargetInstances(
      records,
      groupInstancesSpec({ mintId: () => 'g-1' }),
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
      groupTargetKind(),
    ])
    expect((await store.getById('g-1'))?.config).toEqual({ members: [{ targetId: 'a' }] })
  })
})

describe('a group cannot be saved with another group as a member', () => {
  it('createInstance and updateInstance refuse a member that is a stored group', async () => {
    const records = await makeRecordsAccessForOwner('core-notifier')
    await records.declare(groupRecordKinds)
    let next = 0
    const store = NotificationTargetStore.of(records, 'core-notifier', groupRecordKinds, [
      groupTargetKind(),
    ])
    const provider = refuseNestedGroups(
      buildNotificationTargetInstances(
        records,
        groupInstancesSpec({ mintId: () => `g-${++next}` }),
      ),
      async () => new Set((await store.list()).map((target) => target.id)),
    )
    const inner = await provider.createInstance({ name: 'Inner', kind: 'group' })
    await expect(
      provider.createInstance({
        name: 'Outer',
        kind: 'group',
        values: { members: [{ targetId: inner.id }] },
      }),
    ).rejects.toThrow(/another group/)
    const outer = await provider.createInstance({ name: 'Outer', kind: 'group' })
    await expect(
      provider.updateInstance({ id: outer.id, values: { members: [{ targetId: inner.id }] } }),
    ).rejects.toThrow(/another group/)
    await provider.updateInstance({ id: outer.id, values: { members: [{ targetId: 'ntfy-1' }] } })
  })
})
