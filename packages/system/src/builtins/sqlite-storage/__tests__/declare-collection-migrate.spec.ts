/**
 * `declareCollection` against a collection that already exists on disk — the
 * shape B2 leaves behind for the keyless tables (`integration_settings`,
 * `device_settings_kv`).
 *
 * Those two were created by the pre-B2 `ensureTable` path with NO primary-key
 * column. `declareCollection` SYNTHESISES one when the caller declares none,
 * and a PK is a column SQLite cannot add in place — so the first declaration
 * over such a table lands in the destructive-rebuild branch and takes the rows
 * with it. **The operator's hub was repaired one-shot** (the two tables were
 * rebuilt with the synthesised `id` populated, rows preserved) rather than by
 * teaching the engine a data-preserving migration.
 *
 * What this file pins is the property that has to hold from now on: once the
 * table carries the synthesised key, re-declaring the SAME shape on a later
 * boot must be a no-op that preserves every row. If that ever regresses, every
 * deploy silently empties these tables again.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CollectionColumn } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function backend(): Promise<{ b: SqliteSettingsBackend; dbPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-declare-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'test.db'))
  await b.initialize()
  return { b, dbPath: path.join(dir, 'test.db') }
}

/** Exactly `INTEGRATION_SETTINGS_COLUMNS` — no primary key of its own. */
const KEYLESS: readonly CollectionColumn[] = [
  { name: 'integration_id', type: 'TEXT', notNull: true },
  { name: 'key', type: 'TEXT', notNull: true },
  { name: 'value', type: 'TEXT', notNull: true },
  { name: 'value_type', type: 'TEXT', notNull: true, defaultValue: 'string' },
]

describe('declareCollection over a pre-existing collection', () => {
  it('re-declaring the same keyless shape on a later boot preserves every row', async () => {
    const { b, dbPath } = await backend()
    await b.declareCollection({ collection: 'integration_settings', columns: KEYLESS })
    await b.insert({
      collection: 'integration_settings',
      record: {
        id: 'int_0009:host',
        data: {
          integration_id: 'int_0009',
          key: 'host',
          value: '192.168.10.64',
          value_type: 'string',
        },
      },
    })

    // The deploy: a fresh process declares the identical shape.
    const b2 = new SqliteSettingsBackend(dbPath)
    await b2.initialize()
    await b2.declareCollection({ collection: 'integration_settings', columns: KEYLESS })

    const rows = await b2.query({ collection: 'integration_settings' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('int_0009:host')
    expect(rows[0]!.data['key']).toBe('host')
    expect(rows[0]!.data['value']).toBe('192.168.10.64')
  })

  it('the synthesised key is the record id, so rows stay addressable', async () => {
    const { b } = await backend()
    await b.declareCollection({ collection: 'device_settings_kv', columns: KEYLESS })
    await b.insert({
      collection: 'device_settings_kv',
      record: {
        id: 'dev_0001:rtspPort',
        data: {
          integration_id: 'dev_0001',
          key: 'rtspPort',
          value: '554',
          value_type: 'number',
        },
      },
    })

    const deleted = await b.deleteWhere({
      collection: 'device_settings_kv',
      filter: { where: { key: 'rtspPort' } },
    })
    expect(deleted).toEqual({ deleted: 1 })
    expect(await b.query({ collection: 'device_settings_kv' })).toHaveLength(0)
  })
})
