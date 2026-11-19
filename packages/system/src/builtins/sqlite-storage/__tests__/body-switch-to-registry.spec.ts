/**
 * The switch comes back to the registry (D1066) over the REAL records engine on SQLite. A services
 * record switched off in its body gets a registry row that is off; a devices row whose column
 * disagrees with the body takes the BODY value; the key leaves every body; a rerun changes nothing.
 */
import {
  bodySwitchPortsOver,
  bodySwitchToRegistryMigration,
  defineAddonMigrations,
  defineEntryKind,
  entryBody,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeRecordsAccessForOwner } from './support/records-world.js'

const ADDON = 'provider-spec-switch-back'

const kind = defineEntryKind('connections', {
  title: 'Spec integrations',
  schema: entryBody({ host: z.string().optional(), enabled: z.boolean().optional() }),
})

interface RegistryRow {
  id: string
  name: string
  enabled: boolean
  /** The addon the row belongs to; the addon under test when absent. */
  addonId?: string
}

/** The hub's `adoptInstanceRows`, with the same contract, over a map. */
function fakeHub(initial: readonly RegistryRow[]) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]))
  const adopt = async (
    addonId: string,
    input: readonly { id: string; name: string; enabled: boolean; stated: boolean }[],
  ) => {
    let created = 0
    let updated = 0
    const conflicts: { id: string; ownerAddonId: string }[] = []
    for (const r of input) {
      const have = rows.get(r.id)
      if (have === undefined) {
        rows.set(r.id, { id: r.id, name: r.name, enabled: r.enabled, addonId })
        created += 1
      } else if ((have.addonId ?? addonId) !== addonId) {
        conflicts.push({ id: r.id, ownerAddonId: have.addonId ?? addonId })
      } else if (r.stated && have.enabled !== r.enabled) {
        have.enabled = r.enabled
        updated += 1
      }
    }
    return { created, updated, conflicts }
  }
  return { rows, adopt }
}

async function world(
  records: Readonly<Record<string, z.infer<typeof kind.schema>>>,
  registry: readonly RegistryRow[],
) {
  const access = await makeRecordsAccessForOwner(ADDON)
  await access.declare({ connections: kind })
  const handle = access.kind(kind)
  for (const [id, data] of Object.entries(records)) await handle.put({ id, data })
  const hub = fakeHub(registry)
  const warnings: string[] = []
  const ports = bodySwitchPortsOver({
    records: {
      kind: (definition) => {
        const h = access.kind(definition)
        return {
          query: (q) => h.query(q),
          get: (id) => h.get(id),
          put: (input, opts) => h.put(input, opts),
        }
      },
    },
    kind,
    nameField: 'name',
    adopt: hub.adopt,
    warn: async (message) => {
      warnings.push(message)
    },
  })
  const run = async () => {
    const [bound] = defineAddonMigrations(
      [
        bodySwitchToRegistryMigration({
          addonId: ADDON,
          kindName: 'connections',
          date: '2026-11-19',
          seq: 1001,
          followsDate: '2026-11-06',
        }),
      ],
      ports,
    )
    if (bound === undefined) throw new Error('no migration')
    return bound.execute()
  }
  return { handle, hub, run, warnings }
}

describe('bodySwitchToRegistryMigration on SQLite', () => {
  it('creates the row of a switched-off services record, lets the body win over a disagreeing devices row, strips the key, and a rerun does nothing', async () => {
    const w = await world(
      {
        svc_off: { name: 'Relay', host: 'a', enabled: false },
        int_0001: { name: 'Camera hub', host: 'b', enabled: false },
        svc_on: { name: 'Plain', host: 'c' },
      },
      [
        // The registry column says ON; the body says OFF and is the live copy.
        { id: 'int_0001', name: 'Camera hub', enabled: true },
      ],
    )

    const first = await w.run()
    expect(first).toMatchObject({
      kind: 'procedure',
      result: {
        outcome: 'done',
        summary: { records: 3, stripped: 2, rowsCreated: 2, rowsCorrected: 1 },
      },
    })

    expect(w.hub.rows.get('svc_off')).toMatchObject({
      id: 'svc_off',
      name: 'Relay',
      enabled: false,
    })
    expect(w.hub.rows.get('int_0001')?.enabled).toBe(false)
    expect(w.hub.rows.get('svc_on')?.enabled).toBe(true)

    for (const id of ['svc_off', 'int_0001', 'svc_on']) {
      expect((await w.handle.get(id))?.data).not.toHaveProperty('enabled')
    }
    expect((await w.handle.get('svc_off'))?.data).toMatchObject({ name: 'Relay', host: 'a' })

    const revs = await Promise.all(['svc_off', 'int_0001', 'svc_on'].map((id) => w.handle.get(id)))
    const second = await w.run()
    expect(second).toMatchObject({ result: { outcome: 'already-done' } })
    const after = await Promise.all(['svc_off', 'int_0001', 'svc_on'].map((id) => w.handle.get(id)))
    expect(after.map((r) => r?.rev)).toEqual(revs.map((r) => r?.rev))
    expect(w.hub.rows.get('svc_off')?.enabled).toBe(false)
  })

  it("keeps the body switch of a record whose id is another addon's row, and logs the conflict", async () => {
    const w = await world(
      {
        taken: { name: 'Mine?', host: 'a', enabled: false },
        mine: { name: 'Mine', host: 'b', enabled: false },
      },
      [{ id: 'taken', name: 'Theirs', enabled: true, addonId: 'someone-else' }],
    )
    const run = await w.run()
    expect(run).toMatchObject({ result: { summary: { stripped: 1, conflicts: 1 } } })
    // The record with no row of its own keeps the only copy of its switch.
    expect((await w.handle.get('taken'))?.data).toHaveProperty('enabled', false)
    expect((await w.handle.get('mine'))?.data).not.toHaveProperty('enabled')
    expect(w.hub.rows.get('taken')?.enabled).toBe(true)
    expect(w.warnings).toHaveLength(1)
    expect(w.warnings[0]).toContain('taken')
    expect(w.warnings[0]).toContain('someone-else')
    expect(w.warnings[0]).toContain(ADDON)
  })

  it('declares itself after the registry-to-body move', () => {
    const entry = bodySwitchToRegistryMigration({
      addonId: ADDON,
      kindName: 'connections',
      date: '2026-11-19',
      seq: 1001,
      followsDate: '2026-11-06',
    })
    expect(entry.meta.dependsOn).toEqual([`${ADDON}/2026-11-06-registry-switch-to-body`])
    expect(entry.meta.seq).toBeGreaterThan(1000)
  })
})
