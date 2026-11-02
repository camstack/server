/**
 * The static TURN server moves from the addon settings into a `servers` record. The records door
 * is the real in-memory one (the credential really leaves the body and comes back resolved); the
 * settings store is a map the fake ports read and clear.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  preconditionOf,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { staticTurnServersKind } from '../../turn-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  CONNECTION_TO_RECORDS_ID,
  DROP_MOVED_SETTINGS_ID,
  type TurnCataloguePorts,
} from '../index.js'

/** A key the migration does not know: it must survive both migrations untouched. */
const MARK = { someUnrelatedKey: 'keep-me' }

async function world(initial: Record<string, unknown>, readFails = false) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const records = makeInMemoryRecords('static-turn')
  await records.records.declare({ servers: staticTurnServersKind })
  const handle = records.records.kind(staticTurnServersKind)
  const writes: string[] = []
  const created: string[] = []
  const warnings: string[] = []
  const ports: TurnCataloguePorts = {
    readStored: async () => {
      if (readFails) throw new Error('keychain locked')
      return Object.fromEntries(store)
    },
    readRawStored: async () => Object.fromEntries(store),
    ensureServerId: async () => {
      created.push('turn-0a1b2c3d')
      return 'turn-0a1b2c3d'
    },
    putRecord: async (id, body) => {
      if ((await handle.get(id)) !== null) return 'exists'
      writes.push('record')
      await handle.put({ id, data: body }, { ifRev: 0 })
      return 'created'
    },
    warn: (message) => {
      warnings.push(message)
    },
    findServerId: async () => (created.length > 0 ? 'turn-0a1b2c3d' : null),
    readRecord: async (id) => {
      const row = await handle.getResolved(id)
      return row === null
        ? null
        : { urls: row.data.urls, hasCredential: (row.data.credential ?? '').length > 0 }
    },
    clearOldCredential: async () => {
      writes.push('clear-credential')
      store.delete('credential')
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const run = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { store, handle, writes, created, warnings, run }
}

const OLD = {
  urls: 'turn:203.0.113.7:3478?transport=udp, stun:203.0.113.7:3478',
  username: 'camstack',
  credential: 'pw-secret',
  ...MARK,
}

describe('static-turn/2026-11-02-connection-to-records', () => {
  it('moves urls, username and the credential into one record and the secret resolves', async () => {
    const w = await world(OLD)
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const row = await w.handle.getResolved('turn-0a1b2c3d')
    expect(row?.data).toMatchObject({
      urls: OLD.urls,
      username: 'camstack',
      credential: 'pw-secret',
    })
    expect(w.store.has('credential')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('pw-secret')
  })

  it('a failed read of the old settings writes nothing', async () => {
    const w = await world(OLD, true)
    expect(await w.run(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('keychain locked') as string,
    })
    expect(w.writes).toEqual([])
  })

  it('nothing to move is already-done, and a second run after the move is too', async () => {
    const empty = await world({ ...MARK })
    expect(await empty.run(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(empty.writes).toEqual([])

    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    const again = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(again).toMatchObject({ result: { outcome: 'already-done' } })
  })

  it('an existing record is never overwritten and the only credential copy is kept', async () => {
    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    w.store.set('credential', 'pw-secret')
    await w.handle.patch('turn-0a1b2c3d', { credential: null })
    w.writes.length = 0
    const again = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(again).toMatchObject({ result: { outcome: 'already-done' } })
    expect(w.store.get('credential')).toBe('pw-secret')
    expect(w.warnings.join(' ')).toContain('legacy one is kept')
    expect(w.writes).not.toContain('record')
  })

  it('the drop migration deletes the moved keys and leaves the unrelated key alone', async () => {
    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    const result = await w.run(DROP_MOVED_SETTINGS_ID)
    expect(result.kind).toBe('plan')
    if (result.kind !== 'plan') return
    const [edit] = result.plan.edits
    expect(edit?.op).toBe('deleteKeys')
    if (edit?.op !== 'deleteKeys') return
    expect(edit.scope).toBe('addon-settings')
    expect(edit.keys).toContain('static-turn.urls')
    expect(edit.keys).not.toContain('static-turn.someUnrelatedKey')
    expect(edit.precondition).toBe(
      preconditionOf(
        Object.fromEntries(
          edit.keys.map((id) => {
            const key = id.slice('static-turn.'.length)
            return [id, { addonId: 'static-turn', key, value: w.store.get(key) ?? null }]
          }),
        ),
      ),
    )
  })

  it('the drop migration refuses while the record lacks the urls or the credential', async () => {
    const w = await world(OLD)
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no TURN server record') as string,
    })
    await w.run(CONNECTION_TO_RECORDS_ID)
    // The legacy credential is still stored while the record lost its own.
    w.store.set('credential', 'pw-secret')
    await w.handle.patch('turn-0a1b2c3d', { credential: null })
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no credential') as string,
    })
    await w.handle.patch('turn-0a1b2c3d', { urls: '' })
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no urls') as string,
    })
  })
})
