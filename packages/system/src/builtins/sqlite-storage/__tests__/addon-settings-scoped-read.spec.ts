/**
 * `getAllAddon` reads the SAME key range `setAllAddon` writes and deletes.
 *
 * It did not. The writer has always owned the `"<addonId>.<key>"` range —
 * `setAllAddon` deletes it with `prefixWhere` and re-inserts into it — while
 * the reader selected on `json_extract(data, '$.addonId')`. Two authorities
 * for "this addon's rows", and they disagree in both directions:
 *
 *  - a row inside the JSON's idea of the addon but outside the key range is
 *    READ and never DELETED — a config key that cannot be cleared;
 *  - `json_extract` is evaluated on EVERY row of the table, so an addon with
 *    four keys pays for the whole table, and one unparseable neighbour makes
 *    every addon's config read throw.
 *
 * The second is why this was found. On the live hub `addon-settings` holds
 * 627 KB in 24 rows, 625 KB of it device-manager's three fleet blobs, so every
 * `getAddonConfig` on the boot path pulled all 627 KB through the driver and
 * ran `json_extract` over it. Measured on that table: 0.947 ms for a 4-key
 * addon, against 0.02 ms for the range. hub-main's JS thread was 99.9% busy
 * for the whole boot with 64% of it inside this one method, which is what put
 * a 45 s queue in front of every runner's first store read.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'addon-settings-scope-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await b.initialize()
  return b
}

/** Write a row the public API cannot produce — a restore or a past migration can. */
function rawInsert(backend: SqliteSettingsBackend, id: string, data: string): void {
  const db = backend.getDatabase()
  if (db === null) throw new Error('backend not open')
  db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)').run(id, data)
}

describe('getAllAddon — the reader and the writer agree on one key range', () => {
  it('round-trips an addon config and keeps neighbouring addon ids apart', async () => {
    const backend = await openBackend()
    backend.setAllAddon('provider-wyze', { email: 'a@b.c', apiKey: 'k' })
    // `provider-wyze-2` sorts BEFORE `provider-wyze.` ('-' 0x2D < '.' 0x2E) and
    // `provider-wyzeX` after `provider-wyze/`; a range that got either bound
    // wrong would swallow one of them.
    backend.setAllAddon('provider-wyze-2', { email: 'other' })
    backend.setAllAddon('provider-wyzeX', { email: 'third' })

    expect(backend.getAllAddon('provider-wyze')).toEqual({ email: 'a@b.c', apiKey: 'k' })
    expect(backend.getAllAddon('provider-wyze-2')).toEqual({ email: 'other' })
    expect(backend.getAllAddon('provider-wyzeX')).toEqual({ email: 'third' })
  })

  it('never returns a key `setAllAddon` cannot delete', async () => {
    const backend = await openBackend()
    backend.setAllAddon('device-manager', { nextDeviceId: 1 })
    // Tagged as device-manager's in the blob, but keyed outside the range the
    // writer owns. The old reader returned it; the writer never deleted it, so
    // clearing the addon's config left it readable forever.
    rawInsert(
      backend,
      'legacy:device-manager.deviceMeta',
      JSON.stringify({ addonId: 'device-manager', key: 'deviceMeta', value: { ghost: true } }),
    )

    backend.setAllAddon('device-manager', {})
    expect(backend.getAllAddon('device-manager')).toEqual({})
  })

  it('is unaffected by an unparseable row belonging to another addon', async () => {
    const backend = await openBackend()
    backend.setAllAddon('device-manager', { nextDeviceId: 42 })
    // `json_extract` runs on every row of the table, and SQLite ABORTS the
    // statement on malformed JSON — so one bad row anywhere took out every
    // addon's config read, on the boot path, for the whole cluster.
    rawInsert(backend, 'provider-tuya.token', 'not-json')

    expect(backend.getAllAddon('device-manager')).toEqual({ nextDeviceId: 42 })
  })
})
