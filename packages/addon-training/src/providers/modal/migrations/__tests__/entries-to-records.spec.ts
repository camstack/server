/**
 * The Modal accounts move from the addon settings `entries` into `training-account` records.
 * The records door is the real in-memory one (the secret really leaves the body and comes back
 * resolved); the settings store is a map the fake ports read and rewrite.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { trainingAccountEntryKind } from '../../training-account-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  DROP_MOVED_SETTINGS_ID,
  ENTRIES_TO_RECORDS_ID,
  FLAT_ACCOUNT_ID,
  type ModalCataloguePorts,
} from '../index.js'

/** A key the migration does not know: it must survive both migrations untouched. */
const MARK = { someUnrelatedKey: 'keep-me' }

const ROW_A = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  name: 'Home account',
  tokenId: 'ak-home',
  tokenSecret: 'as-home-secret',
  environment: 'main',
  gpuType: 'A10G',
  region: 'eu',
  costCapUsd: 7,
  maxRuntimeHours: 2,
  failedDatasetGraceHours: 12,
}
const ROW_B = {
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  name: 'Lab',
  tokenId: 'ak-lab',
  tokenSecret: 'as-lab-secret',
  environment: '',
  gpuType: 'L4',
  region: '',
  costCapUsd: 5,
  maxRuntimeHours: 4,
  failedDatasetGraceHours: 24,
}

async function world(initial: Record<string, unknown>, readFails = false) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const records = makeInMemoryRecords('training-modal')
  await records.records.declare({ 'training-account': trainingAccountEntryKind })
  const handle = records.records.kind(trainingAccountEntryKind)
  const writes: string[] = []
  const warnings: string[] = []
  const ports: ModalCataloguePorts = {
    readStored: async () => {
      if (readFails) throw new Error('keychain locked')
      return Object.fromEntries(store)
    },
    readRawStored: async () => Object.fromEntries(store),
    warn: (message) => {
      warnings.push(message)
    },
    putRecord: async (id, body) => {
      if ((await handle.get(id)) !== null) return 'exists'
      writes.push('record')
      await handle.put({ id, data: body }, { ifRev: 0 })
      return 'created'
    },
    readRecord: async (id) => {
      const row = await handle.getResolved(id)
      return row === null
        ? null
        : { tokenId: row.data.tokenId, hasSecret: (row.data.tokenSecret ?? '').length > 0 }
    },
    clearOldSecrets: async (ids) => {
      writes.push('clear-secrets')
      if (ids.includes(FLAT_ACCOUNT_ID)) store.set('tokenSecret', '')
      const list = store.get('entries')
      if (!Array.isArray(list)) return
      store.set(
        'entries',
        list.map((row: Record<string, unknown>) =>
          typeof row['id'] === 'string' && ids.includes(row['id'])
            ? { ...row, tokenSecret: '' }
            : row,
        ),
      )
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const run = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { store, handle, writes, warnings, run }
}

const OLD = { entries: [ROW_A, ROW_B], ...MARK }

describe('training-modal/2026-11-04-entries-to-records', () => {
  it('moves every account under its OWN id, the secret resolves and the marked field survives', async () => {
    const w = await world(OLD)
    const result = await w.run(ENTRIES_TO_RECORDS_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const a = await w.handle.getResolved(ROW_A.id)
    expect(a?.data).toMatchObject({
      name: 'Home account',
      tokenId: 'ak-home',
      tokenSecret: 'as-home-secret',
      environment: 'main',
      gpuType: 'A10G',
      costCapUsd: 7,
      maxRuntimeHours: 2,
      failedDatasetGraceHours: 12,
    })
    expect((await w.handle.getResolved(ROW_B.id))?.data.tokenSecret).toBe('as-lab-secret')
    // The unrelated key is untouched and the old secrets are gone from the settings.
    expect(w.store.get('someUnrelatedKey')).toBe('keep-me')
    expect(JSON.stringify(w.store.get('entries'))).not.toContain('as-home-secret')
    expect(JSON.stringify(result)).not.toContain('as-home-secret')
  })

  it('the oldest flat settings (no entries) become one account, secret moved, mark kept', async () => {
    const w = await world({
      tokenId: 'ak-flat',
      tokenSecret: 'as-flat-secret',
      environment: 'prod',
      gpuType: 'A10G',
      ...MARK,
    })
    expect(await w.run(ENTRIES_TO_RECORDS_ID)).toMatchObject({ result: { outcome: 'done' } })
    const row = await w.handle.getResolved(FLAT_ACCOUNT_ID)
    expect(row?.data).toMatchObject({
      name: 'Default',
      tokenId: 'ak-flat',
      tokenSecret: 'as-flat-secret',
      environment: 'prod',
      gpuType: 'A10G',
    })
    expect(w.store.get('tokenSecret')).toBe('')
    expect(w.store.get('someUnrelatedKey')).toBe('keep-me')
    // The drop is allowed now, and a rerun of the move changes nothing.
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({ kind: 'plan' })
    expect(await w.run(ENTRIES_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
  })

  it('a row without an id is moved under a stable id from its position', async () => {
    const w = await world({ entries: [{ ...ROW_A, id: '' }] })
    await w.run(ENTRIES_TO_RECORDS_ID)
    expect((await w.handle.getResolved('modal-account-0'))?.data.tokenId).toBe('ak-home')
    await w.run(ENTRIES_TO_RECORDS_ID)
    expect((await w.handle.query({ limit: 10 })).records).toHaveLength(1)
  })

  it('a failed read of the old settings writes nothing', async () => {
    const w = await world(OLD, true)
    expect(await w.run(ENTRIES_TO_RECORDS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('keychain locked') as string,
    })
    expect(w.writes).toEqual([])
  })

  it('nothing to move is already-done, and a second run after the move is too', async () => {
    const empty = await world({ ...MARK })
    expect(await empty.run(ENTRIES_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(empty.writes).toEqual([])

    const w = await world(OLD)
    await w.run(ENTRIES_TO_RECORDS_ID)
    w.writes.length = 0
    expect(await w.run(ENTRIES_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(w.writes).not.toContain('record')
  })

  it('an existing record is never overwritten and the only secret copy is kept', async () => {
    const w = await world(OLD)
    await w.run(ENTRIES_TO_RECORDS_ID)
    // The legacy secret is back in the settings while the record lost its own.
    w.store.set('entries', [ROW_A, ROW_B])
    await w.handle.patch(ROW_A.id, { tokenSecret: null, name: 'Renamed by the operator' })
    w.writes.length = 0
    await w.run(ENTRIES_TO_RECORDS_ID)
    expect((await w.handle.get(ROW_A.id))?.data.name).toBe('Renamed by the operator')
    expect(w.warnings.join(' ')).toContain('legacy one is kept')
    expect(JSON.stringify(w.store.get('entries'))).toContain('as-home-secret')
    expect(w.writes).not.toContain('record')
  })

  it('the drop migration deletes the moved keys and leaves the unrelated key alone', async () => {
    const w = await world(OLD)
    await w.run(ENTRIES_TO_RECORDS_ID)
    const result = await w.run(DROP_MOVED_SETTINGS_ID)
    expect(result.kind).toBe('plan')
    if (result.kind !== 'plan') return
    const [edit] = result.plan.edits
    expect(edit?.op).toBe('deleteKeys')
    if (edit?.op !== 'deleteKeys') return
    expect(edit.scope).toBe('addon-settings')
    expect(edit.keys).toEqual(['training-modal.entries'])
  })

  it('the drop migration refuses while a record is missing or lacks its secret', async () => {
    const w = await world(OLD)
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('has no record') as string,
    })
    await w.run(ENTRIES_TO_RECORDS_ID)
    w.store.set('entries', [ROW_A, ROW_B])
    await w.handle.patch(ROW_B.id, { tokenSecret: null })
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no token secret') as string,
    })
  })
})
