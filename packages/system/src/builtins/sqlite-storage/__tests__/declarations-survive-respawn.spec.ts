/**
 * A collection stays declared across a backend RESPAWN.
 *
 * ## The outage this reproduces, 2026-09-12
 *
 * The hub's settings backend lost every runtime collection declaration and
 * stayed that way for roughly six hours. Reads and writes across the whole
 * cluster failed with `collection "X" is not declared`, the operator could not
 * log in (`auth-webauthn:user_passkeys`), and `BindingCache.isActive` failures
 * made the pipeline report `frames will drop as inactive`.
 *
 * Reproduced deliberately, with a manually triggered backup:
 *
 *   before : [hub/sqlite-settings] pid 162      0 errors
 *   after  : [hub/sqlite-settings] pid 349597   1 624 errors in two minutes
 *
 *   [process-service EXIT] runner=sqlite-settings code=null signal=SIGBUS
 *
 * The backup opened a SECOND connection to the live database and issued
 * `wal_checkpoint(TRUNCATE)`, which truncates the WAL file — under the live
 * process's mmap (the backend logs `mapsWholeFile`). Touching a page that no
 * longer exists is a SIGBUS, so the addon died and `CrashSupervisor` respawned
 * it.
 *
 * ## Why the respawn was catastrophic rather than a blip
 *
 * `declaredCollections` was an in-memory `Map` on the backend instance, and
 * the declarations are made ONCE, by each addon, at that addon's own boot.
 * Nothing re-declares: a repo-wide search found no handshake, nothing
 * listening for the settings store restarting. So a new backend came up
 * knowing only the nine canonical KV collections, every other addon stayed up
 * and never spoke again, and each had to be restarted by hand to repair its
 * own rows.
 *
 * The blocking checkpoint has been made `PASSIVE`, which removes THIS trigger.
 * This test is about the other half: the backend must not depend on being the
 * first thing that ever ran. The tables are durable; the knowledge that they
 * exist has to be too.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openOn(dbPath: string): Promise<SqliteSettingsBackend> {
  const b = new SqliteSettingsBackend(dbPath)
  await b.initialize()
  return b
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function tmpDb(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decl-respawn-'))
  tmpDirs.push(dir)
  return path.join(dir, 'camstack.db')
}

describe('collection declarations survive a backend respawn', () => {
  it('a declared collection is still usable from a FRESH backend on the same file', async () => {
    const dbPath = await tmpDb()

    const first = await openOn(dbPath)
    await first.declareCollection({
      namespace: 'recorder',
      collection: 'recording-configs',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'enabled', type: 'BOOLEAN' },
        { name: 'data', type: 'TEXT' },
      ],
    })
    await first.set({
      namespace: 'recorder',
      collection: 'recording-configs',
      key: '101',
      value: { enabled: true, data: 'x' },
    })
    await first.shutdown()

    // The respawn. Nothing re-declares — that is the whole point: on the live
    // hub the OWNING addon stays up across this and never speaks again.
    const second = await openOn(dbPath)
    const got = await second.get({
      namespace: 'recorder',
      collection: 'recording-configs',
      key: '101',
    })
    expect(got, 'the row written before the respawn is unreachable').not.toBeNull()
    await second.shutdown()
  })

  it('the BOOLEAN semantics survive too — not just the table name', async () => {
    // SQLite has no boolean type, so `booleanColumns` cannot be recovered by
    // reading the schema back. A declaration that survives as "the table
    // exists" would hand every consumer a 1 where it declared `z.boolean()`.
    const dbPath = await tmpDb()
    const first = await openOn(dbPath)
    await first.declareCollection({
      namespace: 'recorder',
      collection: 'recording-configs',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'enabled', type: 'BOOLEAN' },
      ],
    })
    await first.set({
      namespace: 'recorder',
      collection: 'recording-configs',
      key: '102',
      value: { enabled: true },
    })
    await first.shutdown()

    const second = await openOn(dbPath)
    const got = await second.get({
      namespace: 'recorder',
      collection: 'recording-configs',
      key: '102',
    })
    // A guard, not a cast: `get` answers `unknown` and this assertion is about
    // what the VALUE is, so narrowing has to be real.
    expect(isRecord(got), 'the row did not come back as an object at all').toBe(true)
    if (!isRecord(got)) return
    expect(got['enabled'], 'a BOOLEAN came back as the raw INTEGER').toBe(true)
    await second.shutdown()
  })
})
