import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  IntegrationInstanceDescriptionSchema,
  IntegrationInstanceSchema,
} from '../../capabilities/integration-instances.cap.js'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({
  name: z.string().min(1),
  adapter: z.string(),
  checkedAt: z.number().optional(),
  enabled: z.boolean().optional(),
})
type Body = z.infer<typeof BodySchema>

const kind = defineEntryKind('spec-kinds', {
  title: 'Spec kinds',
  nameField: 'name',
  schema: BodySchema,
})

async function setup(withMint: boolean) {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ 'spec-kinds': kind })
  let counter = 0
  const instances = new RecordIntegrationInstances<Body>(world.records, kind, {
    description: {
      instanceMode: 'multiple',
      kind: 'target',
      canTest: false,
      allowRestoreId: true,
      kinds: [
        { id: 'a', label: 'Adapter A', connectPath: '/addon/x/connect/{{brokerId}}' },
        { id: 'b', label: 'Adapter B', signIn: { basePath: '/addon/x/sign-in' } },
      ],
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name, k) => ({ name, adapter: k ?? 'a' }),
    ...(withMint ? { mintId: ({ kind: k }) => `${k ?? 'a'}-${++counter}` } : {}),
    configured: () => true,
    kindOf: (body) => body.adapter,
    health: (body) => ({
      status: { state: 'ok', label: 'Signed in' },
      ...(body.checkedAt !== undefined ? { lastCheckedAt: body.checkedAt } : {}),
    }),
  })
  return { instances }
}

describe('integration-instances additive fields (P2)', () => {
  it('the schemas accept the new optional fields and the old shapes', () => {
    expect(
      IntegrationInstanceDescriptionSchema.safeParse({
        instanceMode: 'multiple',
        kind: 'x',
        canTest: true,
      }).success,
    ).toBe(true)
    expect(
      IntegrationInstanceDescriptionSchema.safeParse({
        instanceMode: 'multiple',
        kind: 'x',
        canTest: true,
        allowRestoreId: true,
        kinds: [{ id: 'a', label: 'A' }],
      }).success,
    ).toBe(true)
    const parsed = IntegrationInstanceSchema.parse({
      id: 'i',
      name: 'n',
      configured: true,
      enabled: true,
      formValues: {},
      kind: 'a',
      status: { state: 'ok', label: 'Signed in' },
      lastCheckedAt: 5,
    })
    expect(parsed.status?.label).toBe('Signed in')
    expect(parsed.lastCheckedAt).toBe(5)
  })

  it('mints the id in the provider when the caller sends none, and keeps the kind', async () => {
    const { instances } = await setup(true)
    const created = await instances.createInstance({ name: 'One', kind: 'b' })
    expect(created.id).toBe('b-1')
    const view = await instances.getInstance({ id: created.id })
    expect(view?.kind).toBe('b')
  })

  it('refuses a create without an id when the provider mints none', async () => {
    const { instances } = await setup(false)
    await expect(instances.createInstance({ name: 'One' })).rejects.toThrow(/id/)
  })

  it('restores under a given id, and refuses it when it is in use', async () => {
    const { instances } = await setup(true)
    await instances.createInstance({ id: 'ha_004', name: 'Back', kind: 'a' })
    expect((await instances.getInstance({ id: 'ha_004' }))?.name).toBe('Back')
    await expect(
      instances.createInstance({ id: 'ha_004', name: 'Again', kind: 'a' }),
    ).rejects.toThrow()
  })

  it('serves the status label and lastCheckedAt from the health hook', async () => {
    const { instances } = await setup(true)
    await instances.createInstance({ id: 'i1', name: 'One' })
    const listed = await instances.listInstances()
    expect(listed[0]?.status).toEqual({ state: 'ok', label: 'Signed in' })
    expect(listed[0]?.lastCheckedAt).toBeUndefined()
    await instances.updateInstance({ id: 'i1', values: { checkedAt: 99 } })
    expect((await instances.getInstance({ id: 'i1' }))?.lastCheckedAt).toBe(99)
  })

  it('describes the kinds and allowRestoreId', async () => {
    const { instances } = await setup(true)
    const d = await instances.describe()
    expect(d.allowRestoreId).toBe(true)
    expect(d.kinds?.map((k) => k.id)).toEqual(['a', 'b'])
  })
})
