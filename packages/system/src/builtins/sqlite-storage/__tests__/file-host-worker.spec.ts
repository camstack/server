/**
 * The thread that serves one file (D851), over REAL worker threads.
 *
 * Covers the host contract: a request round-trips, a typed error keeps its
 * class across the thread boundary, a buffer is transferred rather than
 * cloned, a thread that dies fails the runner through the injected exit, the
 * in-flight bound refuses instead of queueing, and the thread's log lines come
 * out of the main thread's logger tagged with the database.
 */
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { encodeVectorBase64 } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileHostThread } from '../file-host-client.js'
import { collectTransferables } from '../file-host-protocol.js'
import { CompositeKeyError, DatabaseBusyError } from '../placement-errors.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { ledgerDeclaration, makeHarness, type Harness } from './support/owned-files-harness.js'

/** A thread that boots, serves nothing, and can be made to die — without a real teardown. */
class DyingThread extends EventEmitter implements FileHostThread {
  constructor() {
    super()
    queueMicrotask(() => this.emit('message', { kind: 'ready', declared: [] }))
  }
  postMessage(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  die(code: number): void {
    this.emit('exit', code)
  }
}

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

describe('file host worker', () => {
  it('round-trips data requests through the thread', async () => {
    harness = makeHarness()
    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    await events.call('declareCollection', ledgerDeclaration('fh:ledger'))
    await events.call('insertMany', {
      collection: 'fh:ledger',
      records: [
        { id: 'a', data: { atMs: 1, label: 'first' } },
        { id: 'b', data: { atMs: 2, label: 'second' } },
      ],
    })
    const rows = await events.call('query', {
      collection: 'fh:ledger',
      filter: { orderBy: { field: 'atMs', direction: 'asc' } },
    })
    expect(rows.map((r) => r.data['label'])).toEqual(['first', 'second'])
    expect(events.declaredCollections().has('fh:ledger')).toBe(true)
    expect(await events.hasTable('fh:ledger')).toBe(true)
    expect(await events.hasTable('fh:nope')).toBe(false)
    await events.stop()
  })

  it('keeps a typed error a typed error across the thread boundary', async () => {
    harness = makeHarness()
    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    await events.call('declareCollection', {
      collection: 'fh:series',
      columns: [
        { name: 'seriesId', type: 'INTEGER' },
        { name: 'ts', type: 'INTEGER' },
        { name: 'value', type: 'REAL' },
      ],
      primaryKey: ['seriesId', 'ts'],
    })
    const refusal = events.call('get', { collection: 'fh:series', key: '1' })
    await expect(refusal).rejects.toBeInstanceOf(CompositeKeyError)
    await expect(refusal).rejects.toThrow(/composite key \(seriesId, ts\)/)
    await events.stop()
  })

  it('transfers a typed array buffer rather than cloning it', async () => {
    const vector = new Float32Array([1, 2, 3, 4])
    const view = new Float32Array(new ArrayBuffer(32), 8, 2)
    const found = collectTransferables({
      items: [{ id: 'x', vector }],
      other: view,
      plain: [1, 2, 3],
    })
    expect(found).toEqual([vector.buffer])
    // A view that does not own its whole buffer is cloned, not transferred.
    expect(collectTransferables(view)).toEqual([])

    // And the thread really does take ownership: the sender's buffer is detached.
    const buffer = new Float32Array([5, 6, 7, 8]).buffer
    const echo = new Worker('process.exit(0)', { eval: true })
    echo.postMessage({ buffer }, [buffer])
    expect(buffer.byteLength).toBe(0)
    await echo.terminate()
  })

  it('serves vector calls on a worker that loads sqlite-vec', async () => {
    harness = makeHarness()
    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    await events.vector('declareIndex', { index: 'fh-vec', dim: 4, metric: 'cosine' })
    const vector = encodeVectorBase64(new Float32Array([1, 0, 0, 0]))
    await events.vector('upsert', {
      index: 'fh-vec',
      items: [{ id: 'near', vector, metadata: { deviceId: 1 } }],
    })
    const hit = await events.vector('query', { index: 'fh-vec', vector, topK: 1 })
    expect(hit.matches.map((m) => m.id)).toEqual(['near'])
    await events.stop()
  })

  it('refuses vector calls on a file that does not load sqlite-vec', async () => {
    harness = makeHarness()
    const history = await openOwnedSqliteFile(harness.specOf('history'), harness.deps)
    await expect(
      history.vector('declareIndex', { index: 'nope', dim: 4, metric: 'cosine' }),
    ).rejects.toThrow(/does not serve vector calls/)
    await history.stop()
  })

  it('fails the runner through the injected exit when the thread dies', async () => {
    // A FAKE thread: forcing a real one down (`terminate()`, `process.exit`)
    // segfaults the process on macOS arm64 — the very crash `file-host-client`
    // avoids by letting a stopped thread end itself (see file-host-client-stop.spec.ts).
    const fakes: DyingThread[] = []
    harness = makeHarness({
      threadFactory: () => {
        const thread = new DyingThread()
        fakes.push(thread)
        return thread
      },
    })
    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    expect(harness.fatal).toEqual([])

    const pending = events
      .call('count', { collection: 'addon-settings' })
      .catch((err: unknown) => err)
    fakes[0]?.die(1)
    await pending
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.fatal).toHaveLength(1)
    expect(harness.fatal[0]).toMatch(/exited with code/)
    const death = harness.lines.find((l) => l.message.includes('worker died'))
    expect(death?.level).toBe('error')
    expect(death?.extras?.tags?.['database']).toBe('events')
    expect(death?.extras?.meta?.['lastOp']).toBe('data:count')
    // Calls after the death are refused, not queued behind a dead thread.
    await expect(events.call('count', { collection: 'addon-settings' })).rejects.toThrow(
      /not serving/,
    )
  })

  it('an orderly stop is not a death', async () => {
    harness = makeHarness()
    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    await events.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.fatal).toEqual([])
    // The thread ended itself; nothing had to force it down.
    expect(harness.lines.some((l) => l.message.includes('did not leave after stop'))).toBe(false)
  })

  it('refuses a call beyond the in-flight bound instead of queueing it, and says so once', async () => {
    harness = makeHarness({ maxInFlight: 2 })
    const events = await openOwnedSqliteFile(harness.specOf('events'), harness.deps)
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => events.call('count', { collection: 'addon-settings' })),
    )
    const refused = settled.filter(
      (s) => s.status === 'rejected' && s.reason instanceof DatabaseBusyError,
    )
    expect(refused.length).toBe(4)
    const warnings = harness.lines.filter((l) => l.message.includes('too many in flight'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.extras?.tags?.['database']).toBe('events')
    await events.stop()
  })

  it('writes the thread’s log lines through the runner logger, tagged with the database', async () => {
    harness = makeHarness()
    const history = await openOwnedSqliteFile(harness.specOf('history'), harness.deps)
    const fromThread = harness.lines.filter((l) => l.scope.startsWith('Db/history'))
    expect(fromThread.length).toBeGreaterThan(0)
    for (const line of fromThread) expect(line.extras?.tags?.['database']).toBe('history')
    expect(fromThread.some((l) => l.message.includes('sqlite connection sized'))).toBe(true)
    await history.stop()
  })
})
