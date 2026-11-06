/**
 * The one-switch migration (epic #440, step 3) over the REAL records engine on SQLite: a registry
 * row that is OFF moves into the instance record body, an ON row writes nothing, a missing record
 * is created, and a rerun does nothing. The dry-run count is the migration's own summary.
 */
import {
  defineAddonMigrations,
  defineEntryKind,
  entryBody,
  isInstanceEnabled,
  registrySwitchPortsOver,
  registrySwitchToBodyMigration,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeRecordsAccessForOwner } from './support/records-world.js'

const ADDON = 'provider-spec-switch'
const MARK = 'host-marked-by-the-spec.example'

const kind = defineEntryKind('connections', {
  title: 'Spec integrations',
  schema: entryBody({ host: z.string().optional() }),
})

interface Row {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
}

async function world(rows: readonly Row[], records: readonly string[]) {
  const access = await makeRecordsAccessForOwner(ADDON)
  await access.declare({ connections: kind })
  const handle = access.kind(kind)
  for (const id of records) await handle.put({ id, data: { name: `Name ${id}`, host: MARK } })
  const ports = registrySwitchPortsOver({
    api: { list: async () => rows.map((r) => ({ ...r, addonId: ADDON })) },
    records: access,
    kind,
  })
  const run = async () => {
    const [bound] = defineAddonMigrations(
      [
        registrySwitchToBodyMigration({
          addonId: ADDON,
          date: '2026-11-06',
          seq: 2,
          initialBody: (name) => ({ name }),
        }),
      ],
      ports,
    )
    if (bound === undefined) throw new Error('no migration')
    return bound.execute()
  }
  return { handle, run }
}

describe('registrySwitchToBodyMigration on SQLite', () => {
  it('moves OFF into the body, leaves ON alone, creates a missing record, and a rerun does nothing', async () => {
    const w = await world(
      [
        { id: 'int_1', name: 'Off with record', enabled: false },
        { id: 'int_2', name: 'On with record', enabled: true },
        { id: 'int_3', name: 'Off, never had a record', enabled: false },
      ],
      ['int_1', 'int_2'],
    )

    const first = await w.run()
    expect(first).toMatchObject({
      kind: 'procedure',
      result: {
        outcome: 'done',
        summary: { integrations: 3, off: 2, created: 1, switched: 1, kept: 0 },
      },
    })

    const off = await w.handle.get('int_1')
    expect(off?.data).toMatchObject({ host: MARK, enabled: false })
    expect(isInstanceEnabled(off?.data ?? {})).toBe(false)
    const on = await w.handle.get('int_2')
    expect(on?.data).toMatchObject({ host: MARK })
    expect(on?.data).not.toHaveProperty('enabled')
    const created = await w.handle.get('int_3')
    expect(created?.data).toEqual({ name: 'Off, never had a record', enabled: false })

    const revs = await Promise.all(['int_1', 'int_2', 'int_3'].map((id) => w.handle.get(id)))
    const second = await w.run()
    expect(second).toMatchObject({
      result: { outcome: 'already-done', summary: { off: 2, created: 0, switched: 0, kept: 2 } },
    })
    expect(await Promise.all(['int_1', 'int_2', 'int_3'].map((id) => w.handle.get(id)))).toEqual(
      revs,
    )
  })

  it('never turns a stated switch back on: a record that says on stays on', async () => {
    const w = await world([{ id: 'int_1', name: 'Re-enabled since', enabled: false }], [])
    await w.handle.put({ id: 'int_1', data: { name: 'Re-enabled since', enabled: true } })

    const result = await w.run()

    expect(result).toMatchObject({ result: { outcome: 'already-done', summary: { kept: 1 } } })
    expect((await w.handle.get('int_1'))?.data).toMatchObject({ enabled: true })
  })
})
