/**
 * The instance descriptor and the addon agree on the Test action: the addon registers a
 * `connection-test` provider (`buildDreoConnectionTestProvider`), so the descriptor must offer it.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildDreoInstances, dreoRecordKinds } from '../dreo-instances.js'

describe('dreo instance descriptor', () => {
  it('offers the Test action the connection-test provider implements', async () => {
    const mem = makeInMemoryRecords('provider-dreo')
    await mem.records.declare(dreoRecordKinds)
    const instances = buildDreoInstances(mem.records, { onChanged: async () => undefined })

    const description = await instances.describe()

    expect(description.canTest).toBe(true)
  })
})
