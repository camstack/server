import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  createOffThreadDemuxClient,
  type DemuxWorkerHeapStats,
  type DemuxWorkerLike,
} from '../demux-off-thread'

class FakeWorker extends EventEmitter implements DemuxWorkerLike {
  constructor(_filename: string) {
    super()
  }
  postMessage(value: unknown): void {
    const msg = value as { readonly id: number }
    queueMicrotask(() => this.emit('message', { id: msg.id, ok: true, aus: [] }))
  }
  terminate(): void {
    this.emit('exit', 0)
  }
}

class StatsWorker extends FakeWorker {
  async getHeapStatistics(): Promise<DemuxWorkerHeapStats> {
    return { total_heap_size: 40e6, total_physical_size: 30e6, used_heap_size: 20e6 }
  }
}

function clientOf(WorkerCtor: new (filename: string) => FakeWorker) {
  return createOffThreadDemuxClient({
    workerFilename: '/built/demux-worker-child.js',
    existsSync: () => true,
    parseInProcess: async () => null,
    WorkerCtor,
  })
}

describe('createOffThreadDemuxClient.readHeaps', () => {
  it('reports nothing before a worker exists', async () => {
    const client = clientOf(StatsWorker)
    await expect(client.readHeaps()).resolves.toMatchObject({ workers: 0, heapBytes: 0 })
  })

  it('reports the live worker heap, its age, and that it is idle-terminated', async () => {
    const client = clientOf(StatsWorker)
    await client.parse(Uint8Array.of(1))
    const r = await client.readHeaps(Date.now() + 5_000)
    expect(r).toMatchObject({
      workers: 1,
      heapBytes: 40e6,
      physicalBytes: 30e6,
      usedBytes: 20e6,
      idleTerminates: true,
    })
    expect(r.maxAgeMs).toBeGreaterThanOrEqual(5_000)
  })

  it('counts a worker whose stats are unavailable without failing the probe', async () => {
    const client = clientOf(FakeWorker)
    await client.parse(Uint8Array.of(1))
    await expect(client.readHeaps()).resolves.toMatchObject({ workers: 1, heapBytes: 0 })
  })

  it('stops reporting a worker once it exits', async () => {
    let spawned: StatsWorker | undefined
    class Tracked extends StatsWorker {
      constructor(_filename: string) {
        super(_filename)
        spawned = this
      }
    }
    const client = clientOf(Tracked)
    await client.parse(Uint8Array.of(1))
    spawned?.terminate()
    await expect(client.readHeaps()).resolves.toMatchObject({ workers: 0 })
  })
})
