import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import {
  composeInstanceKinds,
  UnknownInstanceError,
  UnknownInstanceKindError,
} from '../compose-instance-kinds.js'
import { buildLinkedInstances, declareLinkKind } from '../instance-link.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
})
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
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: prefix,
      canTest: false,
      kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
    },
    formSchema: async () => ({ sections: [] }),
    initialBody: (name) => ({ name }),
    mintId: () => `${prefix}-${++counter}`,
    configured: () => true,
    test: async ({ id }) => ({
      success: true,
      status: 'validated',
      error: `probed ${id}`,
    }),
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
        kind: {
          id: 'account',
          label: 'Account',
          functionCap: 'broker',
          role: 'services',
        },
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
    {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
    },
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

  it('a null-id test names its kind; with several testable kinds and none named it refuses, listing them', async () => {
    const { composed } = await setup()
    expect(await composed.testInstance?.({ id: null, kind: 'account', values: {} })).toMatchObject({
      success: true,
    })
    const refused = await composed.testInstance?.({ id: null, values: {} })
    expect(refused).toMatchObject({ success: false, status: 'inconclusive' })
    expect(refused?.error).toContain('account, integration')
  })

  it('a null-id test with no kind runs on the only testable kind', async () => {
    const world = makeInMemoryRecords('spec-addon')
    await world.records.declare({ accounts, connections })
    const composed = composeInstanceKinds(
      [
        {
          kind: { id: 'account', label: 'Account', functionCap: 'broker', role: 'services' },
          provider: part(world, accounts, 'acc').toProvider(),
        },
        {
          kind: {
            id: 'calendar',
            label: 'Calendar',
            functionCap: 'device-provider',
            role: 'devices',
            canTest: false,
          },
          provider: part(world, connections, 'con').toProvider(),
        },
      ],
      { role: 'devices', instanceMode: 'multiple', kind: 'account', canTest: true },
    )
    expect(await composed.testInstance?.({ id: null, values: {} })).toMatchObject({
      success: true,
      status: 'validated',
    })
  })
})

describe('composeInstanceKinds links', () => {
  const calendars = declareLinkKind({
    name: 'calendars',
    title: 'Calendars',
    writeTrigger: 'test',
    links: { accountId: { cap: 'broker', kind: 'google' } },
    fields: { calendarId: z.string().default('') },
  })

  it('answers the links the kind of a part declares, and is configured only with its own field', async () => {
    const world = makeInMemoryRecords('spec-addon')
    await world.records.declare({ accounts, calendars })
    const linked = buildLinkedInstances(world.records, {
      kind: calendars,
      instanceKind: 'calendar',
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'calendar',
        canTest: false,
        kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
      },
      alsoConfigured: (body) => body.calendarId !== '',
    })
    const composed = composeInstanceKinds(
      [
        {
          kind: { id: 'account', label: 'Account', functionCap: 'broker' },
          provider: part(world, accounts, 'acc').toProvider(),
        },
        {
          kind: {
            id: 'calendar',
            label: 'Calendar',
            functionCap: 'calendar-source',
          },
          provider: linked.toProvider(),
        },
      ],
      {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'account',
        canTest: false,
      },
    )
    expect((await composed.describe()).links).toEqual([
      {
        kind: 'calendar',
        field: 'accountId',
        to: { cap: 'broker', kind: 'google' },
      },
    ])
    await linked.createInstance({ id: 'cal_1', name: 'Work' })
    await linked.updateInstance({
      id: 'cal_1',
      values: { accountId: 'google_001' },
    })
    expect((await linked.getInstance({ id: 'cal_1' }))?.configured).toBe(false)
    await linked.updateInstance({
      id: 'cal_1',
      values: { calendarId: 'work@example.com' },
    })
    expect((await linked.getInstance({ id: 'cal_1' }))?.configured).toBe(true)
  })
})
