/**
 * The S-B rows-to-record migration (planning#416): an addon whose integrations hold real settings
 * moves them, secrets included, into a record of its own kind and clears the legacy rows.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEntryKind, entryBody } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { defineAddonMigrations } from '../addon-migration.js'
import {
  integrationBodyFromRows,
  integrationRowsMigration,
  integrationRowsPortsOver,
} from '../integration-rows-migration.js'

const ADDON = 'provider-spec-rows'
const MARK = 'host-marked-by-the-spec.example'
const SECRET = 'secret-value-the-spec-must-see-again'

const kind = defineEntryKind('connections', {
  title: 'Spec integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().optional(),
    apiKey: z.string().optional().meta({ secret: true }),
  }),
})

async function world(rows: Record<string, Record<string, unknown>>) {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare({ connections: kind })
  const store = new Map(Object.entries(rows).map(([id, row]) => [id, { ...row }]))
  const names = new Map(Object.keys(rows).map((id) => [id, `Name ${id}`]))
  const cleared: string[] = []
  const warnings: string[] = []
  const api = {
    list: async () => [...names].map(([id, name]) => ({ id, addonId: ADDON, name })),
    getSettings: async ({ id }: { id: string }) => ({
      ...store.get(id),
    }),
    clearSettings: async ({ id }: { id: string }) => {
      cleared.push(id)
      store.set(id, {})
    },
  }
  const ports = integrationRowsPortsOver({
    api,
    records: mem.records,
    kind,
    warn: (m) => warnings.push(m),
  })
  const run = async () => {
    const [bound] = defineAddonMigrations(
      [
        integrationRowsMigration({
          addonId: ADDON,
          date: '2026-11-05',
          kind,
          fixtureMark: 'host',
        }),
      ],
      ports,
    )
    if (bound === undefined) throw new Error('no migration')
    return bound.execute()
  }
  return { mem, store, cleared, warnings, run, handle: mem.records.kind(kind) }
}

describe('integrationRowsMigration', () => {
  it('moves the marked field and the secret into the record, then clears the rows', async () => {
    const w = await world({
      int_0001: { host: MARK, port: 8443, apiKey: SECRET },
    })

    const first = await w.run()

    expect(first).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'done' },
    })
    const row = await w.handle.getResolved('int_0001')
    expect(row?.data).toMatchObject({
      name: 'Name int_0001',
      host: MARK,
      port: 8443,
      apiKey: SECRET,
    })
    // the secret left the body: the stored row holds a marker, not the value
    expect(JSON.stringify(w.mem.tables.get('connections')?.get('int_0001')?.data)).not.toContain(
      SECRET,
    )
    expect(w.cleared).toEqual(['int_0001'])

    const again = await w.run()
    expect(again).toMatchObject({ result: { outcome: 'already-done' } })
  })

  it('drops a key the kind has no field for, naming the key and never the value', () => {
    const warnings: string[] = []
    const body = integrationBodyFromRows(
      kind,
      { host: MARK, stray: 'stray-value', port: 'not-a-number', apiKey: '' },
      { warn: (m) => warnings.push(m) },
      { id: 'int_0003', name: 'Three' },
    )
    expect(body).toEqual({ name: 'Three', host: MARK })
    expect(warnings.join('\n')).toContain('stray, port')
    expect(warnings.join('\n')).not.toContain('stray-value')
  })

  it('refuses to move a secret the keychain could not serve, and clears nothing', async () => {
    const w = await world({
      int_0004: { host: MARK, apiKey: { $secret: 'secret://x' } },
    })
    const result = await w.run()
    expect(result).toMatchObject({ kind: 'failed' })
    expect(w.cleared).toEqual([])
  })
})
