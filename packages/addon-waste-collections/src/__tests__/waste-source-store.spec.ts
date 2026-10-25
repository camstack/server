import { describe, expect, it } from 'vitest'
import { wasteSourceEntryKind } from '../waste-source-record-kinds.js'
import { WasteSourceStore } from '../waste-source-store.js'
import { makeInMemoryRecords } from '@camstack/types'

async function makeWasteRecords() {
  const world = makeInMemoryRecords('waste-collections')
  await world.records.declare({ 'waste-source': wasteSourceEntryKind })
  return world
}

describe('WasteSourceStore', () => {
  it('replaceAll round-trips typed args without argsJson', async () => {
    const world = await makeWasteRecords()
    const store = WasteSourceStore.of(world.records)
    await store.replaceAll([
      {
        id: 'home',
        label: 'Home',
        module: 'abfallnavi_de',
        args: { ort: 'Berlin' },
        enabled: true,
      },
    ])
    const rows = await store.listResolved()
    expect(rows[0]?.argsJson).toBeUndefined()
    expect(rows[0]?.args['ort']).toBe('Berlin')
  })
})
