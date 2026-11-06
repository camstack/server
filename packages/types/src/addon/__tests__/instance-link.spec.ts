import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { assertInstanceUnused, InstanceInUseError } from '../instance-in-use.js'
import {
  buildLinkedInstances,
  declareLinkKind,
  linkFieldDescriptor,
  linksOfKind,
  linkUserFinder,
} from '../instance-link.js'

const kind = declareLinkKind({
  name: 'connections',
  title: 'Things',
  writeTrigger: 'test',
  links: { brokerId: { cap: 'broker', kind: 'mqtt' }, smtpId: { cap: 'smtp-provider' } },
  fields: { topic: z.string().optional() },
})

async function world() {
  const memory = makeInMemoryRecords('x')
  await memory.records.declare({ connections: kind })
  const instances = buildLinkedInstances(memory.records, {
    kind,
    description: { role: 'services', instanceMode: 'multiple', kind: 'thing', canTest: false },
    dynamicSections: async (id) => [
      { id: 'dyn', title: 'Dyn', fields: [{ type: 'info', key: id, label: id, content: id }] },
    ],
  })
  return instances
}

describe('the instance link primitive', () => {
  it('records the links in the kind and reads them back', () => {
    expect(linksOfKind(kind)).toEqual([
      { field: 'brokerId', to: { cap: 'broker', kind: 'mqtt' } },
      { field: 'smtpId', to: { cap: 'smtp-provider' } },
    ])
  })

  it('describe() answers the links of the kind', async () => {
    const instances = await world()
    expect((await instances.describe()).links).toEqual([
      { kind: 'connections', field: 'brokerId', to: { cap: 'broker', kind: 'mqtt' } },
      { kind: 'connections', field: 'smtpId', to: { cap: 'smtp-provider' } },
    ])
  })

  it('draws an instance-select per link and the dynamic sections of the first chosen link', async () => {
    const instances = await world()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    const bare = await instances.instanceFormSchema({ id: 'int_1' })
    expect(bare.sections.map((s) => s.id)).toEqual(['links'])
    expect(bare.sections[0]?.fields.map((f) => f.type)).toEqual([
      'instance-select',
      'instance-select',
    ])
    await instances.updateInstance({ id: 'int_1', values: { brokerId: 'b_1' } })
    const linked = await instances.instanceFormSchema({ id: 'int_1' })
    expect(linked.sections.map((s) => s.id)).toEqual(['links', 'dyn'])
  })

  it('is configured only when every link names an instance', async () => {
    const instances = await world()
    await instances.createInstance({ id: 'int_1', name: 'A' })
    expect((await instances.getInstance({ id: 'int_1' }))?.configured).toBe(false)
    await instances.updateInstance({ id: 'int_1', values: { brokerId: 'b_1', smtpId: 's_1' } })
    expect((await instances.getInstance({ id: 'int_1' }))?.configured).toBe(true)
  })

  it('linkUserFinder names the records that link an instance, and the assert refuses', async () => {
    const instances = await world()
    await instances.createInstance({ id: 'int_1', name: 'A', values: { brokerId: 'b_1' } })
    await instances.createInstance({ id: 'int_2', name: 'B', values: { brokerId: 'b_2' } })
    const finder = linkUserFinder(instances, 'brokerId')
    expect((await finder.find('b_1')).map((u) => u.id)).toEqual(['int_1'])
    await expect(assertInstanceUnused('b_1', [finder])).rejects.toBeInstanceOf(InstanceInUseError)
    await expect(assertInstanceUnused('b_9', [finder])).resolves.toBeUndefined()
  })

  it('linkFieldDescriptor builds a required instance-select', () => {
    expect(
      linkFieldDescriptor('brokerId', { cap: 'broker', kind: 'mqtt' }, { label: 'Broker' }),
    ).toEqual({
      type: 'instance-select',
      key: 'brokerId',
      label: 'Broker',
      required: true,
      functionCap: 'broker',
      kind: 'mqtt',
    })
  })
})
