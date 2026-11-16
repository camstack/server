import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({ name: z.string().min(1), enabled: z.boolean().optional() })
type Body = z.infer<typeof BodySchema>

const kind = defineEntryKind('spec-things', {
  title: 'Spec things',
  nameField: 'name',
  schema: BodySchema,
})

async function build(withTest: boolean): Promise<RecordIntegrationInstances<Body>> {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ 'spec-things': kind })
  return new RecordIntegrationInstances<Body>(world.records, kind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'thing',
      canTest: true,
      kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider', canTest: true }],
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name) => ({ name }),
    configured: () => true,
    ...(withTest ? { test: async () => ({ success: true, status: 'validated' as const }) } : {}),
  })
}

describe('RecordIntegrationInstances canTest follows the test hook (planning#543)', () => {
  it('a provider that declares canTest but wires no test does not offer one', async () => {
    const description = await (await build(false)).describe()
    expect(description.canTest).toBe(false)
    expect(description.kinds?.map((k) => k.canTest)).toEqual([false])
  })

  it('a provider with a test hook keeps what it declared', async () => {
    const description = await (await build(true)).describe()
    expect(description.canTest).toBe(true)
    expect(description.kinds?.map((k) => k.canTest)).toEqual([true])
  })
})
