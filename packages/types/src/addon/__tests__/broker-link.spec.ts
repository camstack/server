import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { assertBrokerUnused, BrokerInUseError } from '../broker-in-use.js'
import {
  brokerLinkUserFinder,
  buildBrokerLinkInstances,
  declareBrokerLinkKind,
} from '../broker-link.js'

const kind = declareBrokerLinkKind({
  title: 'Things',
  writeTrigger: 'test',
  linkFields: { calendarIds: z.array(z.string()).optional() },
})

async function world(read: (brokerId: string) => Promise<string[]>) {
  const memory = makeInMemoryRecords('x')
  await memory.records.declare({ connections: kind })
  const instances = buildBrokerLinkInstances(memory.records, {
    kind,
    brokerKind: 'thing',
    brokerLabel: 'Thing account',
    dynamicSections: async (brokerId) => [
      {
        id: 'picked',
        title: 'Picked',
        fields: (await read(brokerId)).map((key) => ({
          type: 'info' as const,
          key,
          label: key,
          content: key,
        })),
      },
    ],
  })
  return { memory, instances }
}

describe('the broker link primitive', () => {
  it('renders the picker alone while no broker is chosen, then the sections the chosen broker offers', async () => {
    const { instances } = await world(async (brokerId) => [`from-${brokerId}`])
    await instances.createInstance({ id: 'int_0001', name: 'A' })
    const bare = await instances.instanceFormSchema({ id: 'int_0001' })
    expect(bare.sections.map((s) => s.id)).toEqual(['broker-link'])
    await instances.updateInstance({ id: 'int_0001', values: { brokerId: 'thing_007' } })
    const linked = await instances.instanceFormSchema({ id: 'int_0001' })
    expect(linked.sections.map((s) => s.id)).toEqual(['broker-link', 'picked'])
    expect(linked.sections[1]?.fields.map((f) => f.key)).toEqual(['from-thing_007'])
    expect(linked.sections[0]?.fields[0]).toMatchObject({
      type: 'broker-select',
      brokerKind: 'thing',
    })
  })

  it('keeps the service own link fields and lists the users of a broker, refusing its removal', async () => {
    const { instances } = await world(async () => [])
    await instances.createInstance({ id: 'int_0001', name: 'A' })
    await instances.updateInstance({
      id: 'int_0001',
      values: { brokerId: 'thing_007', calendarIds: ['marked'] },
    })
    await instances.createInstance({ id: 'int_0002', name: 'B' })
    expect((await instances.getResolved('int_0001'))?.calendarIds).toEqual(['marked'])
    const finder = brokerLinkUserFinder(instances)
    expect(await finder.find('thing_007')).toEqual([
      { kind: 'integration', id: 'int_0001', name: 'A' },
    ])
    await expect(assertBrokerUnused('thing_007', [finder])).rejects.toBeInstanceOf(BrokerInUseError)
    await expect(assertBrokerUnused('thing_999', [finder])).resolves.toBeUndefined()
  })
})
