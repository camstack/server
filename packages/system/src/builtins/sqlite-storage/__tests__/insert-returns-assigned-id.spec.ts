/**
 * `insert` answers with the id the row actually got (D473).
 *
 * It returned `void`, and that closed two doors:
 *
 * 1. **A caller that omits the id cannot learn what was minted.** On a TEXT key
 *    the backend generates a `randomUUID()` and threw it away — the row exists
 *    and the writer does not know its name.
 * 2. **An `INTEGER` rowid alias is unusable.** SQLite assigns the key only when
 *    the column is omitted, so with an auto key the id is knowable ONLY from
 *    the insert. `pipeline-analytics` needs it on the very next line:
 *
 *    ```ts
 *    await this.eventStore.insertAudio(ev)
 *    this.notificationCenter?.onAudioEventPersisted(ev)        // reads ev.id
 *    await this.captureMotionMarkerStill(deviceId, ev.id, ...)  // builds a media key
 *    ```
 *
 *    A placeholder is not an option: it would reach the event bus and the media
 *    keys. This is the precondition that blocked the 263 MB event-key migration
 *    — `insertMany` already honoured `autoPrimaryKey`, `insert` learned it, and
 *    neither could hand the key back.
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

async function openBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insert-id-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await b.initialize()
  return b
}

describe('insert returns the assigned id', () => {
  it('hands back the ROWID SQLite assigned on an INTEGER key', async () => {
    const b = await openBackend()
    await b.declareCollection({
      namespace: 'test',
      collection: 'events',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER' },
      ],
    })
    const first = await b.insert({
      namespace: 'test',
      collection: 'events',
      record: { data: { deviceId: 101 } },
    })
    const second = await b.insert({
      namespace: 'test',
      collection: 'events',
      record: { data: { deviceId: 102 } },
    })
    expect(typeof first.id).toBe('number')
    expect(Number(second.id)).toBe(Number(first.id) + 1)
    // And the row really is under that key.
    const row = await b.get({ namespace: 'test', collection: 'events', key: String(first.id) })
    expect(row).not.toBeNull()
    await b.shutdown()
  })

  it('hands back the UUID it minted on a TEXT key', async () => {
    const b = await openBackend()
    await b.declareCollection({
      namespace: 'test',
      collection: 'texty',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER' },
      ],
    })
    const out = await b.insert({
      namespace: 'test',
      collection: 'texty',
      record: { data: { deviceId: 1 } },
    })
    expect(typeof out.id).toBe('string')
    expect(String(out.id)).toHaveLength(36)
    const row = await b.get({ namespace: 'test', collection: 'texty', key: String(out.id) })
    expect(row, 'the returned id does not address the row it created').not.toBeNull()
    await b.shutdown()
  })

  it('echoes an id the caller supplied, rather than inventing a second one', async () => {
    const b = await openBackend()
    await b.declareCollection({
      namespace: 'test',
      collection: 'texty',
      columns: [
        { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
        { name: 'deviceId', type: 'INTEGER' },
      ],
    })
    const out = await b.insert({
      namespace: 'test',
      collection: 'texty',
      record: { id: 'chosen', data: { deviceId: 1 } },
    })
    expect(out.id).toBe('chosen')
    await b.shutdown()
  })
})
