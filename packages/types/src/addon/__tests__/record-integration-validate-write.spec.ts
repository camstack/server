import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({
  name: z.string().min(1),
  echoId: z.string().optional(),
  account: z.string().optional(),
})
type Body = z.infer<typeof BodySchema>

const kind = defineEntryKind('spec-validated', {
  title: 'Spec validated',
  nameField: 'name',
  schema: BodySchema,
})

async function setup() {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ 'spec-validated': kind })
  const instances = new RecordIntegrationInstances<Body>(world.records, kind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'target',
      canTest: false,
      kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name) => ({ name }),
    configured: () => true,
    validateWrite: ({ body }) => {
      if (body['echoId'] === undefined || body['echoId'] === '') throw new Error('Pick the Echo')
      return body['account'] === undefined ? { account: 'pinned' } : undefined
    },
  })
  return instances
}

describe('RecordIntegrationInstances.validateWrite', () => {
  it('refuses a create that carries values and leaves no row behind', async () => {
    const instances = await setup()
    await expect(
      instances.createInstance({ id: 'a', name: 'A', values: { account: 'x' } }),
    ).rejects.toThrow('Pick the Echo')
    expect(await instances.getInstance({ id: 'a' })).toBeNull()
  })

  it('lets a bare create through (the form follows as an update) and keeps what the rule pins', async () => {
    const instances = await setup()
    await instances.createInstance({ id: 'a', name: 'A' })
    await instances.updateInstance({ id: 'a', values: { echoId: 'e1' } })
    expect((await instances.getInstance({ id: 'a' }))?.formValues).toMatchObject({
      echoId: 'e1',
      account: 'pinned',
    })
  })

  it('judges an update on the stored body with the patch over it', async () => {
    const instances = await setup()
    await instances.createInstance({ id: 'a', name: 'A' })
    await expect(instances.updateInstance({ id: 'a', values: { account: 'x' } })).rejects.toThrow(
      'Pick the Echo',
    )
    await instances.updateInstance({ id: 'a', values: { echoId: 'e1', account: 'x' } })
    await instances.updateInstance({ id: 'a', values: { account: 'y' } })
    expect((await instances.getInstance({ id: 'a' }))?.formValues).toMatchObject({
      echoId: 'e1',
      account: 'y',
    })
  })

  it('does not hold a rename back', async () => {
    const instances = await setup()
    await instances.createInstance({ id: 'a', name: 'A' })
    await instances.updateInstance({ id: 'a', name: 'B', values: {} })
    expect((await instances.getInstance({ id: 'a' }))?.name).toBe('B')
  })
})
