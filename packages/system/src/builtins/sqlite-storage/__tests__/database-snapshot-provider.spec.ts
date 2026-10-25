/**
 * P1 (D693, D852) — the `database-snapshot` provider lists EVERY open owned
 * file, read at call time, and snapshots each by id.
 *
 * The defect this pins: `listDatabases` answered the settings file only, so a
 * file created at runtime (`events`, `history`) was never offered to a backup.
 */
import type { DatabaseSnapshotResult, DataStoreDatabase } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  DatabaseSnapshotProvider,
  type OpenFileSource,
  type SnapshotableFile,
} from '../database-snapshot-provider.js'

function resultFor(livePath: string): DatabaseSnapshotResult {
  return {
    livePath,
    snapshotPath: `${livePath}.backup-snapshot`,
    sizeBytes: 1,
    pageCount: 1,
    pageSize: 4096,
    tables: [],
    copyMs: 1,
    verifyMs: 1,
    takenAt: 1,
  }
}

interface FakeFile extends SnapshotableFile {
  readonly calls: { count: number }
}

function fakeFile(databaseId: DataStoreDatabase, log?: string[], delayMs = 0): FakeFile {
  const livePath = `/data/addons-data/sqlite-settings/${databaseId}.db`
  const calls = { count: 0 }
  return {
    databaseId,
    livePath,
    calls,
    snapshot: async () => {
      calls.count += 1
      log?.push(`start:${databaseId}`)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      log?.push(`end:${databaseId}`)
      return resultFor(livePath)
    },
  }
}

function sourceOf(files: FakeFile[]): OpenFileSource {
  return { openFiles: () => files }
}

describe('DatabaseSnapshotProvider', () => {
  it('lists every open file, with its id', async () => {
    const provider = new DatabaseSnapshotProvider(
      sourceOf([fakeFile('settings'), fakeFile('events'), fakeFile('history')]),
    )
    const { databases } = await provider.listDatabases()
    expect(databases.map((d) => d.databaseId)).toEqual(['settings', 'events', 'history'])
    expect(databases.every((d) => d.livePath.endsWith('.db'))).toBe(true)
  })

  it('lists a file that was opened AFTER the provider was built', async () => {
    const files = [fakeFile('settings')]
    const provider = new DatabaseSnapshotProvider(sourceOf(files))
    expect((await provider.listDatabases()).databases).toHaveLength(1)
    files.push(fakeFile('events'))
    expect((await provider.listDatabases()).databases.map((d) => d.databaseId)).toEqual([
      'settings',
      'events',
    ])
  })

  it('snapshots the database it is asked for, and names it in the answer', async () => {
    const settings = fakeFile('settings')
    const events = fakeFile('events')
    const provider = new DatabaseSnapshotProvider(sourceOf([settings, events]))
    const written = await provider.writeSnapshot({ databaseId: 'events' })
    expect(written.databaseId).toBe('events')
    expect(written.livePath).toBe(events.livePath)
    expect(events.calls.count).toBe(1)
    expect(settings.calls.count).toBe(0)
  })

  it('refuses a database that is not open', async () => {
    const provider = new DatabaseSnapshotProvider(sourceOf([fakeFile('settings')]))
    await expect(provider.writeSnapshot({ databaseId: 'history' })).rejects.toThrow(/not open/)
  })

  it('joins a second call for the SAME database, and runs different databases one after the other', async () => {
    const log: string[] = []
    const settings = fakeFile('settings', log, 15)
    const events = fakeFile('events', log, 15)
    const provider = new DatabaseSnapshotProvider(sourceOf([settings, events]))
    const [a, b, c] = await Promise.all([
      provider.writeSnapshot({ databaseId: 'settings' }),
      provider.writeSnapshot({ databaseId: 'settings' }),
      provider.writeSnapshot({ databaseId: 'events' }),
    ])
    expect(a).toBe(b)
    expect(c.databaseId).toBe('events')
    expect(settings.calls.count).toBe(1)
    expect(log).toEqual(['start:settings', 'end:settings', 'start:events', 'end:events'])
  })

  it('a failed snapshot does not wedge the next one', async () => {
    const failing: FakeFile = {
      ...fakeFile('events'),
      snapshot: async () => {
        throw new Error('integrity_check failed')
      },
    }
    const settings = fakeFile('settings')
    const provider = new DatabaseSnapshotProvider(sourceOf([settings, failing]))
    await expect(provider.writeSnapshot({ databaseId: 'events' })).rejects.toThrow(/integrity/)
    await expect(provider.writeSnapshot({ databaseId: 'settings' })).resolves.toMatchObject({
      databaseId: 'settings',
    })
  })
})
