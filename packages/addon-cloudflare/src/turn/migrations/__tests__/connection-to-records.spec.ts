/**
 * The Cloudflare TURN credentials move from the addon settings into one `accounts` record. The
 * records door is the real in-memory one (the token really leaves the body and comes back
 * resolved); the settings store is a map the fake ports read and clear.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  preconditionOf,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_TURN_RECORD_ID, cloudflareTurnAccountsKind } from '../../turn-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  CONNECTION_TO_RECORDS_ID,
  DROP_MOVED_SETTINGS_ID,
  type CloudflareTurnCataloguePorts,
} from '../index.js'

/** A key the migration does not know: it must survive both migrations untouched. */
const MARK = { someUnrelatedKey: 'keep-me' }

async function world(initial: Record<string, unknown>, readFails = false) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const records = makeInMemoryRecords('cloudflare-turn')
  await records.records.declare({ accounts: cloudflareTurnAccountsKind })
  const handle = records.records.kind(cloudflareTurnAccountsKind)
  const writes: string[] = []
  const warnings: string[] = []
  const ports: CloudflareTurnCataloguePorts = {
    readStored: async () => {
      if (readFails) throw new Error('keychain locked')
      return Object.fromEntries(store)
    },
    readRawStored: async () => Object.fromEntries(store),
    putRecord: async (body) => {
      if ((await handle.get(CLOUDFLARE_TURN_RECORD_ID)) !== null) return 'exists'
      writes.push('record')
      await handle.put({ id: CLOUDFLARE_TURN_RECORD_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    warn: (message) => {
      warnings.push(message)
    },
    readRecord: async () => {
      const row = await handle.getResolved(CLOUDFLARE_TURN_RECORD_ID)
      return row === null
        ? null
        : { keyId: row.data.keyId, hasApiToken: (row.data.apiToken ?? '').length > 0 }
    },
    clearOldApiToken: async () => {
      writes.push('clear-token')
      store.delete('apiToken')
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

const OLD = { accountId: 'a1b2c3d4e5f6', apiToken: 'tok-secret', ...MARK }

describe('cloudflare-turn/2026-11-02-connection-to-records', () => {
  it('moves the key id and the token into the record; the secret resolves', async () => {
    const w = await world(OLD)
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const row = await w.handle.getResolved(CLOUDFLARE_TURN_RECORD_ID)
    expect(row?.data).toMatchObject({ keyId: 'a1b2c3d4e5f6', apiToken: 'tok-secret' })
    expect(w.store.has('apiToken')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('tok-secret')
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
    expect(await w.run(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
  })

  it('an existing record is never overwritten and the only token copy is kept', async () => {
    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    w.store.set('apiToken', 'tok-secret')
    await w.handle.patch(CLOUDFLARE_TURN_RECORD_ID, { apiToken: null })
    w.writes.length = 0
    expect(await w.run(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(w.store.get('apiToken')).toBe('tok-secret')
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
    expect(edit.keys).toContain('cloudflare-turn.accountId')
    expect(edit.keys).not.toContain('cloudflare-turn.someUnrelatedKey')
    expect(edit.precondition).toBe(
      preconditionOf(
        Object.fromEntries(
          edit.keys.map((id) => {
            const key = id.slice('cloudflare-turn.'.length)
            return [id, { addonId: 'cloudflare-turn', key, value: w.store.get(key) ?? null }]
          }),
        ),
      ),
    )
  })

  it('the drop migration refuses while the record lacks the key id or the token', async () => {
    const w = await world(OLD)
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no Cloudflare TURN record') as string,
    })
    await w.run(CONNECTION_TO_RECORDS_ID)
    // The legacy token is still stored while the record lost its own.
    w.store.set('apiToken', 'tok-secret')
    await w.handle.patch(CLOUDFLARE_TURN_RECORD_ID, { apiToken: null })
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no API token') as string,
    })
    await w.handle.patch(CLOUDFLARE_TURN_RECORD_ID, { keyId: '' })
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no key id') as string,
    })
  })
})
