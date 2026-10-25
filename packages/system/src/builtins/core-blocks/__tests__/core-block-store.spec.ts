/**
 * `setStatus` is the runner's half of the store, and the only window an author
 * has into a block that is not running. What it must never do is show an error
 * that is over.
 */

import {
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { CORE_BLOCKS_LOAD_LIMIT, CoreBlockStore } from '../core-block-store.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { coreBlockRecordsHarness, coreBlockStoreHarness, recordingLogger } from './fixtures.js'

const { logger } = recordingLogger()

async function loadedStore(): Promise<CoreBlockStore> {
  const s = await coreBlockStoreHarness(logger, { now: () => 1_000, newId: () => 'b1' })
  await s.load()
  return s
}

let store: CoreBlockStore

beforeEach(async () => {
  store = await loadedStore()
  await store.create(
    { name: 'One', code: 'export default () => {}', enabled: true, placement: 'hub' },
    'u1',
  )
})

describe('setStatus', () => {
  it('never reports a block as running on creation', () => {
    // The runner reports that. A store that claimed it would be lying about a
    // process nobody started.
    expect(store.get('b1')?.status).toBe('stopped')
  })

  it('records the reason a block failed', async () => {
    await store.setStatus('b1', 'failed', 'the block does not compile')
    expect(store.get('b1')).toMatchObject({
      status: 'failed',
      lastError: 'the block does not compile',
    })
  })

  it('clears the error once the caller reports none', async () => {
    await store.setStatus('b1', 'failed', 'boom')
    await store.setStatus('b1', 'stopped')
    // NOT only on `running`: an operator who fixed a block and disabled it
    // would otherwise keep reading the failure they already dealt with.
    expect(store.get('b1')?.lastError).toBeUndefined()
  })

  it('ignores an unknown block instead of inventing a row', async () => {
    await store.setStatus('nope', 'running')
    expect(store.get('nope')).toBeNull()
  })
})

describe('enabledFor', () => {
  it('returns only the enabled blocks placed on that node', async () => {
    await store.update('b1', { placement: 'agent-a' })
    expect(store.enabledFor('hub')).toEqual([])
    expect(store.enabledFor('agent-a')).toHaveLength(1)
  })
})

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})

describe('compositions', () => {
  it('are stored hub-placed with no code, never running on creation', async () => {
    const s = await loadedStore()
    const block = await s.createComposition(
      { name: 'Room', enabled: true, composition: ROOM },
      'u1',
    )
    expect(block).toMatchObject({
      code: '',
      placement: 'hub',
      status: 'stopped',
      source: { kind: 'composition' },
    })
  })
  it('refuse a code, placement or integration patch by name', async () => {
    const s = await loadedStore()
    const block = await s.createComposition(
      { name: 'Room', enabled: true, composition: ROOM },
      'u1',
    )
    await expect(s.update(block.id, { code: 'export default () => {}' })).rejects.toThrow(
      'is a composition',
    )
    await expect(s.update(block.id, { placement: 'agent-a' })).rejects.toThrow('is a composition')
    await expect(s.update(block.id, { integrationId: 'int_other' })).rejects.toThrow(
      'is a composition',
    )
    expect(s.get(block.id)).toMatchObject({ placement: 'hub' })
  })
  it('refuse a rename through update — it would bypass the expectedUpdatedAt check — but keep the enabled switch (D62)', async () => {
    const s = await loadedStore()
    const block = await s.createComposition(
      { name: 'Room', enabled: true, composition: ROOM },
      'u1',
    )
    await expect(s.update(block.id, { name: 'Kitchen' })).rejects.toThrow(
      'rename it with updateComposition',
    )
    expect(s.get(block.id)?.name).toBe('Room')
    // The same name is not a rename.
    await expect(s.update(block.id, { name: 'Room', enabled: false })).resolves.toMatchObject({
      enabled: false,
    })
  })
  it('updateComposition refuses a code block by name', async () => {
    await expect(store.updateComposition('b1', { name: 'x' })).rejects.toThrow('is a code block')
  })
  it('updateComposition replaces the composition and keeps the source kind', async () => {
    const s = await loadedStore()
    const block = await s.createComposition(
      { name: 'Room', enabled: true, composition: ROOM },
      'u1',
    )
    const updated = await s.updateComposition(block.id, { name: 'Lounge', enabled: false })
    expect(updated).toMatchObject({
      name: 'Lounge',
      enabled: false,
      source: { kind: 'composition' },
    })
  })
  it('every update moves updatedAt strictly forward, even within one millisecond — it is the version a stale edit is refused against', async () => {
    const s = await loadedStore()
    const block = await s.createComposition(
      { name: 'Room', enabled: true, composition: ROOM },
      'u1',
    )
    const first = await s.updateComposition(block.id, { name: 'A' })
    const second = await s.update(block.id, { enabled: false })
    expect(first.updatedAt).toBeGreaterThan(block.updatedAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })
})

describe('isLoaded', () => {
  it('is false before load and true after a successful one', async () => {
    const s = await coreBlockStoreHarness(logger)
    expect(s.isLoaded()).toBe(false)
    await s.load()
    expect(s.isLoaded()).toBe(true)
  })

  it('stays false when the core_blocks read FAILS — an empty store is not an empty table (D49)', async () => {
    const log = recordingLogger()
    const { records } = await coreBlockRecordsHarness(log.logger)
    const inner = records.kind(coreBlocksRecordKinds.blocks)
    const kind = {
      ...inner,
      query: async (): ReturnType<typeof inner.query> => {
        throw new Error('SQLITE_BUSY')
      },
    }
    const s = new CoreBlockStore({ blocks: kind, logger: log.logger })
    await s.load()
    expect(s.list()).toEqual([])
    expect(s.isLoaded()).toBe(false)
  })

  it('refuses a write before the table has been read — a later load would wipe it from memory', async () => {
    const log = recordingLogger()
    const { records } = await coreBlockRecordsHarness(log.logger)
    const inner = records.kind(coreBlocksRecordKinds.blocks)
    const kind = {
      ...inner,
      query: async (): ReturnType<typeof inner.query> => {
        throw new Error('SQLITE_BUSY')
      },
    }
    const s = new CoreBlockStore({ blocks: kind, logger: log.logger })
    await s.load()
    await expect(
      s.create({ name: 'x', code: '', enabled: true, placement: 'hub' }, 'u1'),
    ).rejects.toThrow('has not loaded')
    await expect(
      s.createComposition({ name: 'Room', enabled: true, composition: ROOM }, 'u1'),
    ).rejects.toThrow('has not loaded')
  })

  it('a read that hits the row limit is NOT a loaded table — rows past it would read as deleted', async () => {
    const { store: s, records } = await coreBlockRecordsHarness(logger, {
      now: () => 1_000,
      newId: () => 'b1',
    })
    const kind = records.kind(coreBlocksRecordKinds.blocks)
    for (let i = 0; i < CORE_BLOCKS_LOAD_LIMIT; i += 1) {
      await kind.put({
        id: `r${i}`,
        data: {
          name: 'x',
          enabled: true,
          placement: 'hub',
          updatedAt: 1,
          block: {
            id: `r${i}`,
            name: 'x',
            code: '',
            enabled: true,
            placement: 'hub',
            createdAt: 1,
            updatedAt: 1,
            createdBy: 'u',
            status: 'stopped',
            lastChangedAt: 1,
          },
        },
      })
    }
    await s.load()
    expect(s.isLoaded()).toBe(false)
  })
})

describe('load retries', () => {
  it('warns ONCE for a run of failed reads, and says when it recovered and after how many', async () => {
    const log = recordingLogger()
    const { store: s, records } = await coreBlockRecordsHarness(log.logger)
    const inner = records.kind(coreBlocksRecordKinds.blocks)
    let left = 3
    const kind = {
      ...inner,
      query: async (q: Parameters<typeof inner.query>[0]): ReturnType<typeof inner.query> => {
        if (left > 0) {
          left -= 1
          throw new Error('SQLITE_BUSY')
        }
        return inner.query(q)
      },
    }
    const flaky = new CoreBlockStore({ blocks: kind, logger: log.logger })
    await flaky.load()
    await flaky.load()
    await flaky.load()
    expect(flaky.isLoaded()).toBe(false)
    const warns = () => log.lines.filter((l) => l.level === 'warn')
    expect(warns()).toHaveLength(1)
    await flaky.load()
    expect(flaky.isLoaded()).toBe(true)
    const recovered = log.lines.filter(
      (l) => l.level === 'info' && l.message.includes('loaded after'),
    )
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.extras?.meta).toMatchObject({ failedAttempts: 3 })
    expect(warns()).toHaveLength(1)
    expect(s.isLoaded()).toBe(false)
  })
})

describe('unreadable rows', () => {
  function row(
    block: Record<string, unknown>,
    name = 'Room',
  ): {
    name: string
    enabled: boolean
    placement: string
    updatedAt: number
    block: Record<string, unknown>
  } {
    return { name, enabled: true, placement: 'hub', updatedAt: 5, block }
  }
  const valid = {
    id: 'c1',
    name: 'Room',
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 5,
    createdBy: 'u1',
    status: 'stopped',
    lastChangedAt: 1,
    source: { kind: 'composition', composition: ROOM },
  }

  it('an unparseable COMPOSITION row is reported, by id, name and parse error — never just skipped (D49)', async () => {
    const { store: s, records } = await coreBlockRecordsHarness(logger, {
      now: () => 1_000,
      newId: () => 'b1',
    })
    const kind = records.kind(coreBlocksRecordKinds.blocks)
    await kind.put({ id: 'c1', data: row(valid) })
    await kind.put({
      id: 'c2',
      data: row(
        { ...valid, id: 'c2', source: { kind: 'composition', composition: { bogus: 1 } } },
        'Broken',
      ),
    })
    await kind.put({ id: 'b9', data: row({ id: 'b9', name: 'old code' }, 'old code') })
    await s.load()
    expect(s.isLoaded()).toBe(true)
    expect(s.list().map((b) => b.id)).toEqual(['c1'])
    expect(s.unreadableCompositions()).toEqual([
      { id: 'c2', name: 'Broken', error: expect.stringContaining('source.composition') },
    ])
  })

  it('a row whose source kind cannot be read at all is held too — it may be a composition', async () => {
    const { store: s, records } = await coreBlockRecordsHarness(logger, {
      now: () => 1_000,
      newId: () => 'b1',
    })
    const kind = records.kind(coreBlocksRecordKinds.blocks)
    await kind.put({ id: 'c3', data: row({ id: 'c3', source: 'garbled' }, 'Garbled') })
    await s.load()
    expect(s.unreadableCompositions().map((u) => u.id)).toEqual(['c3'])
  })
})
