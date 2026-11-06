/**
 * The legacy `sources` setting (typed args, or a free `argsJson` string that could carry a password
 * raw) becomes `waste-source` records before the boot seeding and the argsJson rewrite are gone.
 * Real SQLite for the settings table, the real record kind, the credential read back.
 */
import { makeInMemoryRecords, REDACTED_SECRET, type StoredKeyRead } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import { wasteSourceEntryKind } from '../../waste-source-record-kinds.js'
import { WasteSourceStore } from '../../waste-source-store.js'
import { ADDON_MIGRATIONS, SOURCES_FROM_SETTINGS_ID, type WasteSourcePorts } from '../index.js'
import { copySourcesToRecords } from '../sources-from-settings.js'

async function start(stored: Record<string, unknown>) {
  const world = makeInMemoryRecords('waste-collections')
  await world.records.declare({ 'waste-source': wasteSourceEntryKind })
  const store = WasteSourceStore.of(world.records)
  const raw = world.records.kind(wasteSourceEntryKind)
  const ports = (readStored: (key: string) => Promise<StoredKeyRead>): WasteSourcePorts => ({
    readStored,
    listSourceIds: () => store.listIds(),
    putSource: async (source) => {
      await store.putIfAbsent(source)
    },
    readSource: (id) => store.readResolved(id),
  })
  const fixture = settingsFixture('waste-collections', ADDON_MIGRATIONS, ports, stored, 'keep-me')
  return { fixture, store, raw, ports }
}

const LEGACY_ROWS = [
  {
    id: 'home',
    label: 'Home',
    module: 'junker_app',
    argsJson: JSON.stringify({
      city: 'Torino',
      password: 'hunter2',
      pin: 4821,
    }),
    enabled: true,
  },
  {
    id: 'cabin',
    label: 'Cabin',
    module: 'ics',
    args: { url: 'https://example.com/cabin.ics' },
    enabled: false,
  },
]

describe('waste-collections: legacy sources move into records', () => {
  it('a legacy argsJson row becomes typed args with its credential in the keychain, a disabled one stays off', async () => {
    const { fixture, store, raw } = await start({
      sources: LEGACY_ROWS,
      other: { mark: 'survive' },
    })
    expect(await fixture.boot()).toEqual({
      failed: [],
      applied: [SOURCES_FROM_SETTINGS_ID],
    })

    const rows = await store.listResolved()
    expect(rows.map((r) => r.id).toSorted()).toEqual(['cabin', 'home'])
    const home = rows.find((r) => r.id === 'home')
    expect(home).toMatchObject({
      label: 'Home',
      module: 'junker_app',
      enabled: true,
      args: { city: 'Torino', password: 'hunter2', pin: '4821' },
    })
    expect(home?.argsJson).toBeUndefined()
    expect(rows.find((r) => r.id === 'cabin')).toMatchObject({
      enabled: false,
      args: { url: 'https://example.com/cabin.ics' },
    })

    // A plain read shows the redaction token: the text lives in the keychain, bound to the row.
    const stored = await raw.get('home')
    expect(stored?.data.args.password).toBe(REDACTED_SECRET)
    expect(stored?.data.args.pin).toBe(REDACTED_SECRET)
    expect(JSON.stringify(stored?.data)).not.toContain('hunter2')
    expect(stored?.data.args.city).toBe('Torino')

    // The legacy key and its neighbours are not touched by the copy.
    expect(fixture.rows()['waste-collections.other']?.['value']).toEqual({
      mark: 'survive',
    })
    expect(fixture.rows()['other-addon.sources']?.['value']).toBe('keep-me')
  })

  it('a second run changes nothing', async () => {
    const { fixture, store, ports } = await start({ sources: LEGACY_ROWS })
    await fixture.boot()
    const before = JSON.stringify(await store.listResolved())
    const again = await copySourcesToRecords(ports(fixture.readStored))
    expect(again).toMatchObject({
      outcome: 'already-done',
      summary: { created: 0, kept: 2 },
    })
    expect(JSON.stringify(await store.listResolved())).toBe(before)
  })

  it('never overwrites a record that already exists', async () => {
    const { fixture, store } = await start({ sources: LEGACY_ROWS })
    await store.putIfAbsent({
      id: 'home',
      label: 'Edited at the page',
      module: 'junker_app',
      args: { city: 'Milano', password: 'newer' },
      enabled: true,
    })
    await fixture.boot()
    const home = (await store.listResolved()).find((r) => r.id === 'home')
    expect(home).toMatchObject({
      label: 'Edited at the page',
      args: { city: 'Milano', password: 'newer' },
    })
  })

  it('leaves a row it cannot convert, converts the others', async () => {
    const { fixture, store } = await start({
      sources: [
        {
          id: 'bad',
          label: 'Bad',
          module: 'ics',
          argsJson: '{ not json password',
        },
        ...LEGACY_ROWS,
      ],
    })
    expect(await fixture.boot()).toEqual({
      failed: [],
      applied: [SOURCES_FROM_SETTINGS_ID],
    })
    expect((await store.listResolved()).map((r) => r.id).toSorted()).toEqual(['cabin', 'home'])
  })

  it('writes nothing when a stored credential is a marker the keychain did not serve', async () => {
    const { fixture, store } = await start({
      sources: [
        LEGACY_ROWS[1],
        {
          id: 'locked',
          label: 'L',
          module: 'x',
          args: { password: { $secret: 'ref-1', v: 1 } },
        },
      ],
    })
    const report = await fixture.boot()
    expect(report.applied).toEqual([])
    expect(report.failed).toEqual([SOURCES_FROM_SETTINGS_ID])
    expect(await store.listIds()).toEqual([])
  })

  it('does nothing without a legacy setting', async () => {
    const { fixture, store } = await start({})
    expect(await fixture.boot()).toEqual({
      failed: [],
      applied: [SOURCES_FROM_SETTINGS_ID],
    })
    expect(await store.listIds()).toEqual([])
  })
})
