/**
 * The SMTP relay moves from the addon settings into a `relays` record. The records door is the
 * real in-memory one (so the secret really leaves the body and comes back resolved); the
 * settings store is a map the fake ports read and clear.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  preconditionOf,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { smtpRelaysKind } from '../../relay-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  CONNECTION_TO_RECORDS_ID,
  DROP_MOVED_SETTINGS_ID,
  type SmtpCataloguePorts,
} from '../index.js'

/** A key the migration does not know: it must survive both migrations untouched. */
const MARK = { someUnrelatedKey: 'keep-me' }

async function world(initial: Record<string, unknown>, readFails = false) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const records = makeInMemoryRecords('smtp-nodemailer')
  await records.records.declare({ relays: smtpRelaysKind })
  const handle = records.records.kind(smtpRelaysKind)
  const writes: string[] = []
  const created: string[] = []
  const warnings: string[] = []
  const ports: SmtpCataloguePorts = {
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
      if ((await handle.get(id)) !== null) return 'exists'
      writes.push('record')
      await handle.put({ id, data: body }, { ifRev: 0 })
      return 'created'
    },
    warn: (message) => {
      warnings.push(message)
    },
    findIntegration: async () => (created.length > 0 ? 'int_0007' : null),
    readRecord: async (id) => {
      const row = await handle.getResolved(id)
      return row === null
        ? null
        : { host: row.data.host, hasPassword: (row.data.password ?? '').length > 0 }
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
  return { store, handle, writes, created, warnings, run }
}

const OLD = {
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  username: 'mailer',
  password: 'pw-secret',
  fromAddress: 'cam@example.com',
  fromName: 'CamStack',
  ...MARK,
}

describe('smtp-nodemailer/2026-11-02-connection-to-records', () => {
  it('moves host, TLS and the password into the record and the secret resolves', async () => {
    const w = await world(OLD)
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const row = await w.handle.getResolved('int_0007')
    expect(row?.data).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'mailer',
      password: 'pw-secret',
      fromAddress: 'cam@example.com',
      fromName: 'CamStack',
    })
    expect(w.store.has('password')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('pw-secret')
  })

  it('a stored odd value never blocks the owner: port is clamped / parsed, secure coerced, and named', async () => {
    for (const [stored, expected] of [
      [70000, 65535],
      [0, 1],
      [-5, 1],
      ['2525', 2525],
      ['not-a-port', 587],
      [Number.NaN, 587],
      [{ weird: true }, 587],
    ] as const) {
      const w = await world({ host: 'h', port: stored, secure: 'maybe', username: 7 })
      const result = await w.run(CONNECTION_TO_RECORDS_ID)
      expect(result).toMatchObject({ result: { outcome: 'done' } })
      const row = await w.handle.getResolved('int_0007')
      expect(row?.data).toMatchObject({ port: expected, secure: false, username: '' })
    }
    const w = await world({ host: 'h', port: 70000 })
    await w.run(CONNECTION_TO_RECORDS_ID)
    expect(w.warnings.join(' ')).toContain('clamped to 65535')
  })

  it('a failed read of the old settings writes nothing', async () => {
    const w = await world(OLD, true)
    expect(await w.run(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('keychain locked') as string,
    })
    expect(w.writes).toEqual([])
  })

  it('nothing to move is already-done', async () => {
    const w = await world({ ...MARK })
    const result = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(result).toMatchObject({ result: { outcome: 'already-done' } })
    expect(w.writes).toEqual([])
  })

  it('an existing record is never overwritten and the only password copy is kept', async () => {
    const w = await world(OLD)
    await w.run(CONNECTION_TO_RECORDS_ID)
    // The record exists but lost its password; a re-run must not clear the legacy copy.
    w.store.set('password', 'pw-secret')
    await w.handle.patch('int_0007', { password: null })
    w.writes.length = 0
    const again = await w.run(CONNECTION_TO_RECORDS_ID)
    expect(again).toMatchObject({ result: { outcome: 'already-done' } })
    expect(w.store.get('password')).toBe('pw-secret')
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
    expect(edit.keys).toContain('smtp-nodemailer.host')
    expect(edit.keys).not.toContain('smtp-nodemailer.someUnrelatedKey')
    expect(edit.precondition).toBe(
      preconditionOf(
        Object.fromEntries(
          edit.keys.map((id) => {
            const key = id.slice('smtp-nodemailer.'.length)
            return [id, { addonId: 'smtp-nodemailer', key, value: w.store.get(key) ?? null }]
          }),
        ),
      ),
    )
  })

  it('the drop migration refuses while the record does not hold the host or the password', async () => {
    const w = await world(OLD)
    // No record yet: the legacy keys must stay.
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no integration row') as string,
    })
    await w.run(CONNECTION_TO_RECORDS_ID)
    await w.handle.patch('int_0007', { host: '' })
    expect(await w.run(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no host') as string,
    })
  })
})
