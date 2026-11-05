import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import {
  composeInstanceKinds,
  UnknownInstanceError,
  UnknownInstanceKindError,
} from '../compose-instance-kinds.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({ name: z.string().min(1), enabled: z.boolean().optional() })
type Body = z.infer<typeof BodySchema>

const accounts = defineEntryKind('accounts', {
  title: 'Accounts',
  nameField: 'name',
  schema: BodySchema,
})
const connections = defineEntryKind('connections', {
  title: 'Connections',
  nameField: 'name',
  schema: BodySchema,
})

function part(
  world: ReturnType<typeof makeInMemoryRecords>,
  entryKind: typeof accounts,
  prefix: string,
): RecordIntegrationInstances<Body> {
  let counter = 0
  return new RecordIntegrationInstances<Body>(world.records, entryKind, {
    description: { role: 'services', instanceMode: 'multiple', kind: prefix, canTest: false },
    formSchema: async () => ({ sections: [] }),
    initialBody: (name) => ({ name }),
    mintId: () => `${prefix}-${++counter}`,
    configured: () => true,
    test: async ({ id }) => ({ success: true, status: 'validated', error: `probed ${id}` }),
  })
}

async function setup() {
  const world = makeInMemoryRecords('spec-addon')
  await world.records.declare({ accounts, connections })
  const account = part(world, accounts, 'acc')
  const connection = part(world, connections, 'con')
  const composed = composeInstanceKinds(
    [
      {
        kind: { id: 'account', label: 'Account', functionCap: 'broker', role: 'services' },
        provider: account.toProvider(),
      },
      {
        kind: {
          id: 'integration',
          label: 'Integration',
          functionCap: 'device-provider',
          role: 'devices',
        },
        provider: connection.toProvider(),
      },
    ],
    { role: 'devices', instanceMode: 'multiple', kind: 'account', canTest: true },
  )
  return { composed }
}

describe('composeInstanceKinds', () => {
  it('describes the base with every part kind and its function cap', async () => {
    const { composed } = await setup()
    const description = await composed.describe()
    expect(description.role).toBe('devices')
    expect(description.kinds?.map((k) => [k.id, k.functionCap])).toEqual([
      ['account', 'broker'],
      ['integration', 'device-provider'],
    ])
  })

  it('creates by kind, lists both kinds tagged, and refuses a create without a kind', async () => {
    const { composed } = await setup()
    const a = await composed.createInstance({ name: 'A', kind: 'account' })
    const c = await composed.createInstance({ name: 'C', kind: 'integration' })
    expect(a.id).toBe('acc-1')
    expect(c.id).toBe('con-1')
    const rows = await composed.listInstances()
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['acc-1', 'account'],
      ['con-1', 'integration'],
    ])
    await expect(composed.createInstance({ name: 'X' })).rejects.toBeInstanceOf(
      UnknownInstanceKindError,
    )
  })

  it('routes update, switch, test and delete to the part that holds the id', async () => {
    const { composed } = await setup()
    await composed.createInstance({ name: 'A', kind: 'account' })
    const c = await composed.createInstance({ name: 'C', kind: 'integration' })
    await composed.setInstanceEnabled({ id: c.id, enabled: false })
    expect((await composed.getInstance({ id: c.id }))?.enabled).toBe(false)
    expect((await composed.getInstance({ id: 'acc-1' }))?.enabled).not.toBe(false)
    expect(await composed.testInstance?.({ id: c.id, values: {} })).toMatchObject({
      error: 'probed con-1',
    })
    await composed.deleteInstance({ id: c.id })
    expect(await composed.getInstance({ id: c.id })).toBeNull()
    expect(await composed.getInstance({ id: 'acc-1' })).not.toBeNull()
    await expect(composed.deleteInstance({ id: 'nope' })).rejects.toBeInstanceOf(
      UnknownInstanceError,
    )
  })

  it('a null-id test names its kind', async () => {
    const { composed } = await setup()
    expect(await composed.testInstance?.({ id: null, kind: 'account', values: {} })).toMatchObject({
      success: true,
    })
    await expect(composed.testInstance?.({ id: null, values: {} })).rejects.toBeInstanceOf(
      UnknownInstanceKindError,
    )
  })
})
