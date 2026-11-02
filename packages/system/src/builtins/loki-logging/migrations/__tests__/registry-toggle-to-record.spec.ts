/**
 * Loki used to be switched off at the `log-destination` registry toggle (D777). The switch is now
 * the record's own `enabled` (D996): a provider the registry holds off is carried to a record that
 * is off, and the registry toggle is turned back on so the operator has ONE visible switch.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { lokiDestinationsKind } from '../../loki-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  REGISTRY_TOGGLE_TO_RECORD_ID,
  type LokiCataloguePorts,
  type RegistryState,
} from '../index.js'

const MARKED_JOB = 'job-the-migration-does-not-know'

async function world(registry: RegistryState, withRecord = true, readFails = false) {
  const records = makeInMemoryRecords('loki-logging')
  await records.records.declare({ destinations: lokiDestinationsKind })
  const handle = records.records.kind(lokiDestinationsKind)
  if (withRecord) {
    await handle.put(
      {
        id: 'int_0007',
        data: {
          name: 'Loki',
          url: 'http://loki:3100',
          level: 'warn',
          job: MARKED_JOB,
          extraLabels: '',
          tenantId: '',
          username: '',
          batchIntervalMs: 5000,
          batchSize: 200,
          timeoutMs: 10000,
        },
      },
      { ifRev: 0 },
    )
  }
  const state = { registry }
  const writes: string[] = []
  const unused = async (): Promise<never> => {
    throw new Error('not a port of this migration')
  }
  const ports: LokiCataloguePorts = {
    readStored: unused,
    readRawStored: unused,
    ensureIntegration: unused,
    putRecord: unused,
    findIntegration: unused,
    readRecord: unused,
    clearOldPassword: unused,
    warn: () => undefined,
    readRegistryState: async () => {
      if (readFails) throw new Error('registry unreadable')
      return state.registry
    },
    findToggleRecord: async () => {
      const page = await handle.query({ limit: 1 })
      const [row] = page.records
      return row === undefined ? null : { id: row.id, enabled: row.data.enabled !== false }
    },
    disableRecord: async (id) => {
      writes.push('record-off')
      await handle.patch(id, { enabled: false })
    },
    enableRegistry: async () => {
      writes.push('registry-on')
      state.registry = 'active'
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const run = async (): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === REGISTRY_TOGGLE_TO_RECORD_ID)
    if (entry === undefined) throw new Error('no migration')
    return entry.execute()
  }
  return { handle, writes, state, run }
}

describe('loki-logging/2026-11-02-registry-toggle-to-record', () => {
  it('maps a registry-off provider to a record that is off and turns the registry back on', async () => {
    const w = await world('inactive')
    const result = await w.run()
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const row = await w.handle.get('int_0007')
    expect(row?.data.enabled).toBe(false)
    expect(row?.data.job).toBe(MARKED_JOB)
    expect(w.state.registry).toBe('active')
    expect(w.writes).toEqual(['record-off', 'registry-on'])
  })

  it('is idempotent: a second run writes nothing', async () => {
    const w = await world('inactive')
    await w.run()
    w.writes.length = 0
    const again = await w.run()
    expect(again).toMatchObject({ result: { outcome: 'already-done' } })
    expect(w.writes).toEqual([])
  })

  it('resumes after a crash between the two writes', async () => {
    const w = await world('inactive')
    await w.handle.patch('int_0007', { enabled: false })
    const result = await w.run()
    expect(result).toMatchObject({ result: { outcome: 'done' } })
    expect(w.writes).toEqual(['registry-on'])
  })

  it('leaves an active provider alone', async () => {
    const w = await world('active')
    const result = await w.run()
    expect(result).toMatchObject({ result: { outcome: 'already-done' } })
    expect((await w.handle.get('int_0007'))?.data.enabled).toBeUndefined()
    expect(w.writes).toEqual([])
  })

  it('writes nothing when the registry cannot be read (D49)', async () => {
    const w = await world('inactive', true, true)
    const result = await w.run()
    expect(result.kind).toBe('failed')
    expect(w.writes).toEqual([])
    expect((await w.handle.get('int_0007'))?.data.enabled).toBeUndefined()
  })

  it('fails, writing nothing, while the provider is not registered yet', async () => {
    const w = await world('unregistered')
    const result = await w.run()
    expect(result.kind).toBe('failed')
    expect(w.writes).toEqual([])
  })

  it('without a record there is nothing to carry and the registry is left as it is', async () => {
    const w = await world('inactive', false)
    const result = await w.run()
    expect(result).toMatchObject({ result: { outcome: 'already-done' } })
    expect(w.writes).toEqual([])
    expect(w.state.registry).toBe('inactive')
  })
})
