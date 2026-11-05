import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

/**
 * A kind whose records carry the `integrations` registry id in `integrationId`: the Integrations
 * page holds that id, the record has its own. Both must reach the same record.
 */
describe('RecordIntegrationInstances: a registry integration id', () => {
  it('reads, edits and tests the record that links to it', async () => {
    const tested: (string | null)[] = []
    const kind = defineEntryKind('accounts', {
      title: 'Accounts',
      nameField: 'name',
      schema: z.object({
        name: z.string(),
        region: z.string(),
        integrationId: z.string().optional(),
      }),
    })
    const world = makeInMemoryRecords('x')
    await world.records.declare({ accounts: kind })
    await world.records
      .kind(kind)
      .put(
        { id: 'rec_002', data: { name: 'A', region: 'it', integrationId: 'int_0035' } },
        { ifRev: 0 },
      )
    const instances = new RecordIntegrationInstances(world.records, kind, {
      description: { role: 'both', instanceMode: 'multiple', kind: 'account', canTest: true },
      formSchema: () => ({ sections: [] }),
      initialBody: (name) => ({ name, region: 'us' }),
      configured: () => true,
      test: async ({ id }) => {
        tested.push(id)
        return { success: true }
      },
    })
    expect((await instances.getInstance({ id: 'int_0035' }))?.formValues['region']).toBe('it')
    expect((await instances.getInstance({ id: 'rec_002' }))?.formValues['region']).toBe('it')
    await instances.updateInstance({ id: 'int_0035', values: { region: 'de' } })
    expect((await instances.getResolved('rec_002'))?.region).toBe('de')
    await instances.testInstance({ id: 'int_0035', values: {} })
    expect(tested).toEqual(['rec_002'])
    expect(await instances.getInstance({ id: 'nope' })).toBeNull()
  })
})
