import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createOffThreadDemuxClient,
  DEMUX_WORKER_IDLE_MS,
  DEMUX_WORKER_RESOURCE_LIMITS,
  type DemuxTimers,
  type DemuxWorkerLike,
  type DemuxWorkerOptions,
} from '../demux-off-thread'

/** Manual clock: timers fire only when the test advances time. */
function fakeClock(): DemuxTimers & {
  advance(ms: number): Promise<void>
  now(): number
} {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    set: (fn, ms) => {
      seq += 1
      timers.set(seq, { at: t + ms, fn })
      return seq
    },
    clear: (h) => {
      if (typeof h === 'number') timers.delete(h)
    },
    advance: async (ms) => {
      t += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= t) {
          timers.delete(id)
          timer.fn()
        }
      }
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

class FakeWorker extends EventEmitter implements DemuxWorkerLike {
  terminated = false
  readonly requests: { id: number }[] = []
  /** When false, replies are held until `reply()`. */
  autoReply = true
  postMessage(value: unknown): void {
    const msg = value as { id: number }
    this.requests.push(msg)
    if (this.autoReply) this.reply(msg.id)
  }
  reply(id: number): void {
    this.emit('message', { id, ok: true, aus: [] })
  }
  terminate(): void {
    this.terminated = true
    this.emit('exit', 0)
  }
  async getHeapStatistics() {
    return {
      total_heap_size: 50 * 1048576,
      total_physical_size: 1,
      used_heap_size: 1,
    }
  }
}

function setup() {
  const clock = fakeClock()
  const workers: FakeWorker[] = []
  const options: (DemuxWorkerOptions | undefined)[] = []
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const client = createOffThreadDemuxClient({
    workerFilename: '/built/demux-worker-child.js',
    existsSync: () => true,
    parseInProcess: async () => null,
    WorkerCtor: class extends FakeWorker {
      constructor(_f: string, o?: DemuxWorkerOptions) {
        super()
        workers.push(this)
        options.push(o)
      }
    },
    timers: clock,
    now: clock.now,
    logger,
  })
  return { clock, workers, options, logger, client }
}

describe('demux worker idle exit', () => {
  it('terminates the worker after the quiet period and logs once with age and heap', async () => {
    const { clock, workers, client, logger } = setup()
    await client.parse(Uint8Array.of(1))
    await clock.advance(DEMUX_WORKER_IDLE_MS - 1)
    expect(workers[0]!.terminated).toBe(false)
    await clock.advance(1)
    expect(workers[0]!.terminated).toBe(true)
    const idleLogs = logger.info.mock.calls.filter(([m]) => String(m).includes('idle'))
    expect(idleLogs).toHaveLength(1)
    expect(idleLogs[0]![1].meta).toMatchObject({
      ageMs: DEMUX_WORKER_IDLE_MS,
      lastHeapMb: 50,
    })
    await expect(client.readHeaps()).resolves.toMatchObject({ workers: 0 })
  })

  it('never terminates while a parse is in flight, then exits once it lands', async () => {
    const { clock, workers, client } = setup()
    await client.parse(Uint8Array.of(1))
    workers[0]!.autoReply = false
    const inFlight = client.parse(Uint8Array.of(2))
    await clock.advance(DEMUX_WORKER_IDLE_MS * 3)
    expect(workers[0]!.terminated).toBe(false)
    workers[0]!.reply(workers[0]!.requests[1]!.id)
    await expect(inFlight).resolves.toEqual([])
    await clock.advance(DEMUX_WORKER_IDLE_MS)
    expect(workers[0]!.terminated).toBe(true)
  })

  it('a new parse restarts the quiet period', async () => {
    const { clock, workers, client } = setup()
    await client.parse(Uint8Array.of(1))
    await clock.advance(DEMUX_WORKER_IDLE_MS - 1000)
    await client.parse(Uint8Array.of(2))
    await clock.advance(DEMUX_WORKER_IDLE_MS - 1000)
    expect(workers[0]!.terminated).toBe(false)
  })

  it('respawns lazily on the next parse and the new worker is not hit by the old exit', async () => {
    const { clock, workers, client } = setup()
    await client.parse(Uint8Array.of(1))
    await clock.advance(DEMUX_WORKER_IDLE_MS)
    expect(workers).toHaveLength(1)
    await expect(client.parse(Uint8Array.of(2))).resolves.toEqual([])
    expect(workers).toHaveLength(2)
    expect(workers[1]!.terminated).toBe(false)
    await expect(client.readHeaps()).resolves.toMatchObject({
      workers: 1,
      idleTerminates: true,
    })
  })

  it('spawns every worker with the demux resourceLimits', async () => {
    const { workers, options, client } = setup()
    await client.parse(Uint8Array.of(1))
    expect(workers).toHaveLength(1)
    expect(options[0]).toEqual({
      resourceLimits: DEMUX_WORKER_RESOURCE_LIMITS,
    })
    expect(DEMUX_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBeGreaterThan(0)
  })

  it('a worker that dies on its limit fails the parse (null) with the device tag, and respawns', async () => {
    const { workers, client, logger } = setup()
    await client.parse(Uint8Array.of(1))
    workers[0]!.autoReply = false
    const doomed = client.parse(Uint8Array.of(2), { deviceId: 102 })
    workers[0]!.emit('error', new Error('ERR_WORKER_OUT_OF_MEMORY'))
    await expect(doomed).resolves.toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ERR_WORKER_OUT_OF_MEMORY'),
      expect.objectContaining({ tags: { deviceId: 102 } }),
    )
    await expect(client.parse(Uint8Array.of(3))).resolves.toEqual([])
    expect(workers).toHaveLength(2)
  })
})
