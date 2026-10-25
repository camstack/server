/**
 * ClusterNodeHistoryStore — durable offline-node history, on the REAL records
 * engine (in-memory SQLite) through the `cluster-agent` owner's `node-history`
 * kind. There is no `cluster-node-history` table (D902): until the hub binds
 * the kind, the store writes nothing and answers every read as unanswered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRecordsAccess,
  type IScopedLogger,
  type RecordKindHandle,
  type RecordsTransport,
} from '@camstack/types'
import {
  clusterAgentRecordKinds,
  type ClusterNodeHistoryBody,
} from '../../../../../../packages/system/src/builtins/cluster-agent/record-kinds.js'
import { makeRecordsWorld } from '../../../../../../packages/system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { SqliteSettingsBackend } from '../../../../../../packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.js'
import { ClusterNodeHistoryStore, type ClusterNodeDescriptor } from '../cluster-node-history-store'

type Kind = RecordKindHandle<ClusterNodeHistoryBody>

function noopLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Fixture {
  readonly kind: Kind
  /** Number of row writes (`put`) that reached the engine — a SQLite commit each. */
  readonly puts: () => number
  readonly store: ClusterNodeHistoryStore
}

async function fixture(
  wrap: (t: RecordsTransport) => RecordsTransport = (t) => t,
): Promise<Fixture> {
  const world = makeRecordsWorld()
  await world.provider.init()
  let puts = 0
  const inner = wrap(world.transportFor('cluster-agent'))
  const transport: RecordsTransport = {
    ...inner,
    put: (input) => {
      puts += 1
      return inner.put(input)
    },
  }
  const records = createRecordsAccess({
    owner: 'cluster-agent',
    transport,
    secrets: null,
  })
  await records.declare(clusterAgentRecordKinds)
  const kind = records.kind(clusterAgentRecordKinds['node-history'])
  return {
    kind,
    puts: () => puts,
    store: new ClusterNodeHistoryStore(noopLogger(), () => kind),
  }
}

function descriptor(
  id: string,
  overrides: Partial<ClusterNodeDescriptor> = {},
): ClusterNodeDescriptor {
  return {
    id,
    name: id,
    hostname: `${id}.local`,
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'N100',
    cpuCores: 4,
    memoryMB: 8192,
    engines: ['onnx'],
    isHub: false,
    localIps: ['192.168.10.10'],
    addonIds: ['provider-onvif'],
    ...overrides,
  }
}

async function lastActiveOf(kind: Kind, id: string): Promise<number | null | undefined> {
  return (await kind.get(id))?.at
}

describe('ClusterNodeHistoryStore', () => {
  let f: Fixture

  beforeEach(async () => {
    f = await fixture()
  })

  it('snapshots a descriptor, stamps lastActive as the row time, and reads it back', async () => {
    const before = Date.now()
    await f.store.snapshot(descriptor('agent-1'))
    const all = await f.store.getAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.id).toBe('agent-1')
    expect(all[0]!.hostname).toBe('agent-1.local')
    expect(all[0]!.addonIds).toEqual(['provider-onvif'])
    expect(all[0]!.lastActive).toBeGreaterThanOrEqual(before)
    expect(await lastActiveOf(f.kind, 'agent-1')).toBe(all[0]!.lastActive)
  })

  it('touch updates only lastActive, preserving the descriptor', async () => {
    await f.store.snapshot(descriptor('agent-1'))
    const original = (await f.store.getAll())[0]!
    // Force an older stored value so touch is observable.
    const row = await f.kind.get('agent-1')
    await f.kind.put({ id: 'agent-1', at: 1, data: row!.data })
    await f.store.touch('agent-1')
    const touched = (await f.store.getAll())[0]!
    expect(touched.lastActive).toBeGreaterThan(1)
    expect(touched.hostname).toBe(original.hostname)
    expect(touched.addonIds).toEqual(original.addonIds)
  })

  it('touch is a no-op for a node never snapshotted', async () => {
    await f.store.touch('ghost')
    expect(await f.store.getAll()).toEqual([])
  })

  it('forget purges a node row and says what it did', async () => {
    await f.store.snapshot(descriptor('agent-1'))
    await f.store.snapshot(descriptor('agent-2'))
    expect(await f.store.forget('agent-1')).toBe('removed')
    expect(await f.store.forget('agent-1')).toBe('not-found')
    expect((await f.store.getAll()).map((n) => n.id)).toEqual(['agent-2'])
  })

  it('records a package roster and reads it back', async () => {
    await f.store.recordPackages('agent-1', [
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-ai', version: '1.2.10' },
    ])
    expect(await f.store.getPackages('agent-1')).toEqual([
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-ai', version: '1.2.10' },
    ])
  })

  it('recordPackages GROWS the roster — a wiped node cannot erase its own record', async () => {
    await f.store.recordPackages('agent-1', [
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-ai', version: '1.2.10' },
    ])
    // The node comes back wiped, declaring only its bootstrap package.
    await f.store.recordPackages('agent-1', [
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
    ])
    expect((await f.store.getPackages('agent-1')).map((p) => p.name)).toEqual([
      '@camstack/addon-pipeline',
      '@camstack/addon-ai',
    ])
  })

  it("recordPackages takes the node's declared version on a re-report", async () => {
    await f.store.recordPackages('agent-1', [{ name: '@camstack/addon-ai', version: '1.0.0' }])
    await f.store.recordPackages('agent-1', [{ name: '@camstack/addon-ai', version: '2.0.0' }])
    expect(await f.store.getPackages('agent-1')).toEqual([
      { name: '@camstack/addon-ai', version: '2.0.0' },
    ])
  })

  it('prunePackages is the only shrink, and leaves the rest intact', async () => {
    await f.store.recordPackages('agent-1', [
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-ai', version: '1.2.10' },
    ])
    await f.store.prunePackages('agent-1', ['@camstack/addon-ai'])
    expect((await f.store.getPackages('agent-1')).map((p) => p.name)).toEqual([
      '@camstack/addon-pipeline',
    ])
  })

  it('snapshot carries the roster forward — a topology poll must not erase it', async () => {
    await f.store.recordPackages('agent-1', [{ name: '@camstack/addon-ai', version: '1.2.10' }])
    // `listNodes()` snapshots a descriptor that carries no package roster.
    await f.store.snapshot(descriptor('agent-1'))
    expect(await f.store.getPackages('agent-1')).toEqual([
      { name: '@camstack/addon-ai', version: '1.2.10' },
    ])
    expect((await f.store.getAll())[0]!.hostname).toBe('agent-1.local')
  })

  it('reports an empty roster for a node the hub has never recorded', async () => {
    expect(await f.store.getPackages('ghost')).toEqual([])
  })

  /**
   * The worst write:row ratio in the system, before D131: `snapshot()` ran on
   * every `listNodes()` refresh — driven by the 30 s topology heartbeat — and
   * unconditionally upserted `lastActive = Date.now()`: ~8,640 writes/day to
   * maintain three rows. The disconnect edge is written by `touch()`, which is
   * unaffected.
   */
  describe('write bounding', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-13T10:00:00Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('an unchanged descriptor inside the heartbeat window writes nothing', async () => {
      await f.store.snapshot(descriptor('agent-1'))
      expect(f.puts()).toBe(1)
      const firstActive = await lastActiveOf(f.kind, 'agent-1')

      // Nine more topology refreshes at the real 30 s cadence — 4.5 minutes,
      // inside the 5-minute bound.
      for (let i = 0; i < 9; i += 1) {
        vi.advanceTimersByTime(30_000)
        await f.store.snapshot(descriptor('agent-1'))
      }

      expect(f.puts()).toBe(1)
      expect(await lastActiveOf(f.kind, 'agent-1')).toBe(firstActive)
    })

    it('a descriptor CHANGE writes immediately, window or not', async () => {
      await f.store.snapshot(descriptor('agent-1'))
      vi.advanceTimersByTime(30_000)
      await f.store.snapshot(descriptor('agent-1', { addonIds: ['provider-onvif', 'addon-ai'] }))

      expect(f.puts()).toBe(2)
      expect((await f.kind.get('agent-1'))?.data.descriptor.addonIds).toEqual([
        'provider-onvif',
        'addon-ai',
      ])
    })

    it('the heartbeat lands once the window expires — "last seen" stays truthful', async () => {
      await f.store.snapshot(descriptor('agent-1'))
      const firstActive = (await lastActiveOf(f.kind, 'agent-1')) ?? 0

      vi.advanceTimersByTime(5 * 60_000 + 1_000)
      await f.store.snapshot(descriptor('agent-1'))

      expect(f.puts()).toBe(2)
      expect(await lastActiveOf(f.kind, 'agent-1')).toBeGreaterThan(firstActive)
    })

    it('over a day: 288 heartbeats per node, not 2,880', async () => {
      // 2,880 topology refreshes = 24 h at 30 s.
      for (let i = 0; i < 2_880; i += 1) {
        await f.store.snapshot(descriptor('agent-1'))
        vi.advanceTimersByTime(30_000)
      }
      // 24 h / 5 min = 288 heartbeats, plus the first write.
      expect(f.puts()).toBeLessThanOrEqual(290)
    })
  })

  describe('before the kind is bound — early boot (D902)', () => {
    it('creates no cluster-node-history table, writes nothing, and every read is unanswered', async () => {
      const backend = new SqliteSettingsBackend(':memory:')
      await backend.initialize()
      const unbound = new ClusterNodeHistoryStore(noopLogger())
      await unbound.snapshot(descriptor('agent-1'))
      await unbound.touch('agent-1')
      await unbound.recordPackages('agent-1', [{ name: '@camstack/addon-ai', version: '1.0.0' }])
      await unbound.prunePackages('agent-1', ['@camstack/addon-ai'])
      expect(await unbound.forget('agent-1')).toBe('store-unavailable')
      expect(await unbound.tryGetAll()).toBeNull()
      expect(await unbound.getAll()).toEqual([])
      expect(await unbound.getPackages('agent-1')).toEqual([])
      expect(backend.hasTable('cluster-node-history')).toBe(false)
      await backend.shutdown()
    })

    it('binding the kind later makes the same store answer from records', async () => {
      const unbound = new ClusterNodeHistoryStore(noopLogger())
      expect(await unbound.tryGetAll()).toBeNull()
      unbound.bindRecordsKind(() => f.kind)
      await unbound.snapshot(descriptor('agent-1'))
      expect((await f.kind.get('agent-1'))?.data.descriptor.hostname).toBe('agent-1.local')
      expect((await unbound.tryGetAll())?.map((n) => n.id)).toEqual(['agent-1'])
    })
  })

  describe('tryGetAll — an unanswered read is null, never an empty history (D315)', () => {
    it('answers the rows when the kind answers', async () => {
      await f.store.snapshot(descriptor('agent-1'))
      expect((await f.store.tryGetAll())?.map((n) => n.id)).toEqual(['agent-1'])
    })

    it('answers [] for a kind that answered with nothing', async () => {
      expect(await f.store.tryGetAll()).toEqual([])
    })

    it('is null when the read throws; getAll still reads []', async () => {
      const failing = await fixture((t) => ({
        ...t,
        query: () => Promise.reject(new Error('SQLITE_BUSY')),
      }))
      expect(await failing.store.tryGetAll()).toBeNull()
      expect(await failing.store.getAll()).toEqual([])
    })
  })
})
