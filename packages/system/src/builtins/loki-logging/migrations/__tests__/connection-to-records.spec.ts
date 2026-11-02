/**
 * The Loki connection moves from the addon settings into a `destinations` record.
 * The records door is the real in-memory one (so the secret really leaves the body and comes
 * back resolved); the settings store is a map the fake ports read and clear.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  preconditionOf,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { lokiDestinationsKind } from '../../loki-record-kinds.js'
import { ADDON_MIGRATIONS, CONNECTION_TO_RECORDS_ID, type LokiCataloguePorts } from '../index.js'

const MARK = { migratedEnabled: true }

async function world(initial: Record<string, unknown>, readFails = false) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const records = makeInMemoryRecords('loki-logging')
  await records.records.declare({ destinations: lokiDestinationsKind })
  const handle = records.records.kind(lokiDestinationsKind)
  const writes: string[] = []
  const created: string[] = []
  const ports: LokiCataloguePorts = {
    readStored: async () => {
      if (readFails) throw new Error('keychain locked')
      return Object.fromEntries(store)
    },
    readRawStored: async () => Object.fromEntries(store),
    ensureIntegration: async () => {
      writes.push('integration')
      created.push('int_0007')
      return 'int_0007'
    },
    putRecord: async (id, body) => {
      const existing = await handle.get(id)
      if (existing !== null) return 'exists'
      writes.push('record')
      await handle.put({ id, data: body }, { ifRev: 0 })
      return 'created'
    },
    clearOldPassword: async () => {
      writes.push('clear-password')
      store.delete('password')
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const run = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { store, handle, writes, created, run }
}

const OLD = {
  url: 'http://loki:3100',
  level: 'warn',
  job: 'cam',
  extraLabels: 'env=home',
  tenantId: 't1',
  username: 'u',
  password: 'pw-secret',
  batchIntervalMs: 2000,
  batchSize: 50,
  timeoutMs: 5000,
  ...MARK,
}

describe('loki-logging/2026-11-02-connection-to-records', () => {
  it('moves url and password into the record and the secret resolves', async () => {
    const w = await world(OLD)
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const row = await w.handle.getResolved('int_0007')
    expect(row?.data).toMatchObject({
      url: 'http://loki:3100',
      level: 'warn',
      username: 'u',
      password: 'pw-secret',
      batchSize: 50,
    })
    expect(w.store.has('password')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('pw-secret')
  })

  it('the second migration deletes the moved keys and leaves the marker alone', async () => {
    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    const result = await w.run('loki-logging/2026-11-02-drop-moved-settings')
    expect(result.kind).toBe('plan')
    if (result.kind !== 'plan') return
    const [edit] = result.plan.edits
    expect(edit?.op).toBe('deleteKeys')
    if (edit?.op !== 'deleteKeys') return
    expect(edit.keys).toContain('url')
    expect(edit.keys).not.toContain('migratedEnabled')
    expect(edit.precondition).toBe(
      preconditionOf(Object.fromEntries(edit.keys.map((k) => [k, w.store.get(k) ?? null]))),
    )
  })

  it('a second run is already-done and writes nothing', async () => {
    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    w.writes.length = 0
    await w.run(CONNECTION_TO_RECORDS_ID)
    // The old keys are still there until the plan ran: the existing record wins.
    expect(w.writes).toEqual(['integration'])
    const after = await w.handle.get('int_0007')
    expect(after?.rev).toBe(1)
  })

  it('a store with nothing to move is already-done without touching the hub', async () => {
    const w = await world({ ...MARK })
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    expect(w.writes).toEqual([])
  })

  it('a failed read writes nothing', async () => {
    const w = await world(OLD, true)
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result.kind).toBe('failed')
    expect(w.writes).toEqual([])
    expect(w.store.get('password')).toBe('pw-secret')
  })
})
