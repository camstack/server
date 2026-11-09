import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { wasteSourceEntryKind } from '../waste-source-record-kinds.js'
import { WasteSourceStore } from '../waste-source-store.js'
import { sourceArgs, WasteCredentialUnavailableError } from '../waste-types.js'

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

  it('replaceAll leaves a source whose credential is an unresolved marker exactly as stored', async () => {
    const world = await makeWasteRecords()
    const store = WasteSourceStore.of(world.records)
    await store.putIfAbsent({
      id: 'home',
      label: 'Home',
      module: 'junker_app',
      args: { city: 'Torino', password: 'hunter2' },
      enabled: true,
    })
    // The keychain did not serve the credential: the in-memory source carries the marker.
    await store.replaceAll([
      {
        id: 'home',
        label: 'Renamed',
        module: 'junker_app',
        args: { city: 'Milano', password: { $secret: 'ref-1', v: 1 } },
        enabled: true,
      },
    ])
    const back = await store.readResolved('home')
    expect(back).toMatchObject({
      label: 'Home',
      args: { city: 'Torino', password: 'hunter2' },
    })
  })

  it('the redaction token is never a usable credential: the fetch args are refused, not the token', () => {
    const source = {
      id: 'h',
      label: 'H',
      module: 'ics',
      args: { password: REDACTED_SECRET },
      enabled: true,
    }
    expect(() => sourceArgs(source)).toThrow(WasteCredentialUnavailableError)
  })
})
