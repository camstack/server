import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { IntegrationInstanceDescription } from '../../capabilities/integration-instances.cap.js'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import {
  defaultAddDeviceMode,
  RecordIntegrationInstances,
} from '../record-integration-instances.js'

const BodySchema = z.object({
  name: z.string().min(1),
  host: z.string().optional(),
  enabled: z.boolean().optional(),
})
type Body = z.infer<typeof BodySchema>

const kind = defineEntryKind('spec-things', {
  title: 'Spec things',
  nameField: 'name',
  schema: BodySchema,
})

function description(
  discovery: IntegrationInstanceDescription['discovery'],
): IntegrationInstanceDescription {
  return {
    role: 'devices',
    instanceMode: 'multiple',
    kind: 'thing',
    canTest: false,
    kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
    ...(discovery !== undefined ? { discovery } : {}),
  }
}

async function served(
  desc: IntegrationInstanceDescription,
  addDevice?: (body: Body) => 'scan' | 'children' | 'none',
) {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ 'spec-things': kind })
  const instances = new RecordIntegrationInstances<Body>(world.records, kind, {
    description: desc,
    formSchema: () => ({ sections: [] }),
    initialBody: (name) => ({ name }),
    configured: () => true,
    ...(addDevice !== undefined ? { addDevice } : {}),
  })
  const provider = instances.toProvider()
  await provider.createInstance({ id: 'a', name: 'A' })
  await provider.createInstance({ id: 'b', name: 'B', values: { host: '192.0.2.1' } })
  return provider
}

describe('addDevice default comes from description.discovery, in one function', () => {
  it('maps lan to scan, account to children, the rest to none', () => {
    expect(defaultAddDeviceMode(description({ mode: 'lan', scopedToInstance: false }))).toBe('scan')
    expect(defaultAddDeviceMode(description({ mode: 'account', scopedToInstance: false }))).toBe(
      'children',
    )
    expect(defaultAddDeviceMode(description({ mode: 'none', scopedToInstance: false }))).toBe(
      'none',
    )
    expect(defaultAddDeviceMode(description(undefined))).toBe('none')
  })
})

describe('RecordIntegrationInstances stamps addDevice on every served instance', () => {
  it('uses the default when the provider supplies none', async () => {
    const provider = await served(description({ mode: 'lan', scopedToInstance: false }))
    const list = await provider.listInstances({})
    expect(list.map((i) => i.addDevice)).toEqual(['scan', 'scan'])
  })

  it('a provider value wins, per instance', async () => {
    const provider = await served(description({ mode: 'lan', scopedToInstance: false }), (body) =>
      (body.host ?? '') === '' ? 'scan' : 'children',
    )
    const byId = new Map((await provider.listInstances({})).map((i) => [i.id, i.addDevice]))
    expect(byId.get('a')).toBe('scan')
    expect(byId.get('b')).toBe('children')
    expect((await provider.getInstance({ id: 'b' }))?.addDevice).toBe('children')
  })
})
