/**
 * The on-demand lifecycle: no consumers, no child.
 *
 * "The recorder counts as a client" is not a special case in here — it cannot
 * be. A consumer is whoever is reading the composite's bytes, and the recorder
 * reaches those bytes the same way a viewer does: through the broker, which
 * dials this session's HTTP endpoint. So the only thing this file has to get
 * right is that the count is honest in both directions.
 */
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLV_AVC_CONFIG, FLV_HEADER, FLV_INTER, FLV_KEYFRAME, FLV_OPENING } from './flv-fixture.js'
import type { GridLayout } from '../grid-filter-graph.js'
import { GridStreamSession } from '../grid-stream-session.js'
import type {
  GridStreamChild,
  GridStreamPlan,
  GridStreamSessionDeps,
} from '../grid-stream-session.js'

const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 } as const

function layoutOf(inputCount: number): GridLayout {
  return {
    width: 1280,
    height: 720,
    cells: Array.from({ length: inputCount }, (_, index) => ({
      inputIndex: index,
      source: FULL_FRAME,
      cell: { x: 0, y: 0, width: 1, height: 1 },
    })),
  }
}

interface Recorded {
  readonly acquired: number[]
  readonly released: string[]
  readonly spawned: GridStreamPlan[]
  readonly stopped: number[]
  readonly logs: { level: string; message: string; deviceId: unknown }[]
  readonly children: FakeChild[]
}

class FakeChild implements GridStreamChild {
  readonly stdout = new PassThrough()
  stopCalls = 0
  constructor(private readonly onStop: () => void) {}
  async stop(): Promise<void> {
    this.stopCalls += 1
    this.onStop()
    this.stdout.end()
  }
}

function makeDeps(
  recorded: Recorded,
  over: Partial<GridStreamSessionDeps> = {},
): GridStreamSessionDeps {
  const log = (level: string) => (message: string, ctx?: { tags?: { deviceId?: unknown } }) => {
    recorded.logs.push({ level, message, deviceId: ctx?.tags?.deviceId })
  }
  return {
    logger: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    acquireSource: async (deviceId) => {
      recorded.acquired.push(deviceId)
      return { url: `rtsp://127.0.0.1/${String(deviceId)}`, pipelineKey: `pk-${String(deviceId)}` }
    },
    releaseSource: async (pipelineKey) => {
      recorded.released.push(pipelineKey)
    },
    startChild: async (plan) => {
      recorded.spawned.push(plan)
      const child = new FakeChild(() => recorded.stopped.push(recorded.children.length - 1))
      recorded.children.push(child)
      return child
    },
    lingerMs: 0,
    ...over,
  }
}

function planOf(deviceIds: readonly number[]): GridStreamPlan {
  return {
    layout: layoutOf(deviceIds.length),
    sourceDeviceIds: deviceIds,
    encoder: 'libx264',
    decodeHwAccel: null,
    fps: 10,
    bitrateKbps: 4000,
  }
}

function noopConsumer() {
  return { onData: vi.fn(), onClose: vi.fn() }
}

describe('GridStreamSession', () => {
  let recorded: Recorded

  beforeEach(() => {
    recorded = { acquired: [], released: [], spawned: [], stopped: [], logs: [], children: [] }
  })

  function sessionFor(deviceIds: readonly number[], over: Partial<GridStreamSessionDeps> = {}) {
    return new GridStreamSession({
      deviceId: 900,
      deps: makeDeps(recorded, over),
      resolvePlan: () => planOf(deviceIds),
    })
  }

  // ── openIfRunning: the guarantee that a thumbnail never dials a camera ──
  //
  // A snapshot of a grid is a frame of the composition, and a composition only
  // exists while something is watching. The tempting implementation is
  // `open()`, which would produce a lovely fresh frame by acquiring every
  // source and — on a battery source — waking a camera for a 160-pixel-wide
  // picture in a list.

  it('openIfRunning refuses a COLD session, and acquires NOTHING', () => {
    const session = sessionFor([611, 612])
    expect(session.openIfRunning(noopConsumer())).toBeNull()
    // Not one acquisition, which means not one dial, which means not one wake.
    expect(recorded.acquired).toEqual([])
    expect(recorded.spawned).toHaveLength(0)
    expect(session.consumerCount()).toBe(0)
    expect(session.isRunning()).toBe(false)
  })

  it('openIfRunning attaches to a RUNNING composition and takes its bytes', async () => {
    const session = sessionFor([611])
    const viewer = noopConsumer()
    const hold = await session.open(viewer)
    expect(recorded.acquired).toEqual([611])

    const sample = noopConsumer()
    const sampleHold = session.openIfRunning(sample)
    expect(sampleHold).not.toBeNull()
    expect(session.consumerCount()).toBe(2)
    // Still ONE acquisition: the sample rode the composition that was up.
    expect(recorded.acquired).toEqual([611])

    recorded.children[0]?.stdout.write(FLV_OPENING)
    await vi.waitFor(() => {
      expect(sample.onData).toHaveBeenCalled()
    })

    sampleHold?.close()
    hold.close()
    await session.settled()
  })

  it('a sample that leaves does not keep the composition up on its own', async () => {
    const session = sessionFor([611])
    const hold = await session.open(noopConsumer())
    const sampleHold = session.openIfRunning(noopConsumer())
    hold.close()
    sampleHold?.close()
    await session.settled()
    expect(session.isRunning()).toBe(false)
    expect(recorded.released).toEqual(['pk-611'])
  })

  it('runs NOTHING until the first consumer arrives', () => {
    const session = sessionFor([611, 612])
    expect(session.isRunning()).toBe(false)
    expect(recorded.spawned).toHaveLength(0)
    expect(recorded.acquired).toHaveLength(0)
  })

  it('the first consumer starts exactly one child and acquires one source per cell', async () => {
    const session = sessionFor([611, 612, 613, 105])
    await session.open(noopConsumer())
    expect(recorded.spawned).toHaveLength(1)
    expect(recorded.acquired).toEqual([611, 612, 613, 105])
    expect(recorded.spawned[0]?.sourceDeviceIds).toEqual([611, 612, 613, 105])
    expect(session.isRunning()).toBe(true)
  })

  it('a second consumer shares the SAME child — one composition, not two', async () => {
    const session = sessionFor([611, 612])
    await session.open(noopConsumer())
    await session.open(noopConsumer())
    expect(recorded.spawned).toHaveLength(1)
    expect(recorded.acquired).toEqual([611, 612])
    expect(session.consumerCount()).toBe(2)
  })

  it('fans every byte out to every consumer, once the stream has described itself', async () => {
    const session = sessionFor([611])
    const a = noopConsumer()
    const b = noopConsumer()
    await session.open(a)
    await session.open(b)
    // Bytes that are not yet a joinable FLV stream reach nobody — a reader
    // handed an inter frame with no sequence header decodes noise.
    recorded.children[0]?.stdout.write(FLV_HEADER)
    recorded.children[0]?.stdout.write(FLV_INTER)
    await new Promise((resolve) => setImmediate(resolve))
    expect(a.onData).not.toHaveBeenCalled()
    expect(b.onData).not.toHaveBeenCalled()

    recorded.children[0]?.stdout.write(Buffer.concat([FLV_AVC_CONFIG, FLV_KEYFRAME]))
    await new Promise((resolve) => setImmediate(resolve))
    expect(a.onData).toHaveBeenCalledOnce()
    expect(b.onData).toHaveBeenCalledOnce()
    // Both were handed the SAME opening bytes: the header, the sequence header
    // and the key frame they may start at.
    const toA = a.onData.mock.calls[0]?.[0] as Buffer
    expect(toA.subarray(0, 3).toString()).toBe('FLV')
    expect(toA.includes(FLV_KEYFRAME)).toBe(true)
  })

  it('keeps the child alive while ANY consumer remains', async () => {
    const session = sessionFor([611, 612])
    const first = await session.open(noopConsumer())
    await session.open(noopConsumer())
    first.close()
    await new Promise((resolve) => setImmediate(resolve))
    expect(session.isRunning()).toBe(true)
    expect(recorded.released).toHaveLength(0)
  })

  it('the LAST consumer leaving stops the child and releases EVERY source', async () => {
    const session = sessionFor([611, 612, 613])
    const hold = await session.open(noopConsumer())
    hold.close()
    await session.settled()
    expect(session.isRunning()).toBe(false)
    expect(recorded.children[0]?.stopCalls).toBe(1)
    expect(recorded.released).toEqual(['pk-611', 'pk-612', 'pk-613'])
  })

  it('a reconnect inside the linger window reuses the child instead of respawning', async () => {
    vi.useFakeTimers()
    try {
      const session = sessionFor([611], { lingerMs: 3_000 })
      const hold = await session.open(noopConsumer())
      hold.close()
      vi.advanceTimersByTime(1_000)
      await session.open(noopConsumer())
      expect(recorded.spawned).toHaveLength(1)
      expect(recorded.released).toHaveLength(0)
      expect(session.isRunning()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to start a grid with no cells, and SAYS so with the device tag', async () => {
    const session = new GridStreamSession({
      deviceId: 900,
      deps: makeDeps(recorded),
      resolvePlan: () => null,
    })
    const consumer = noopConsumer()
    await expect(session.open(consumer)).rejects.toThrow(/no cells/i)
    expect(recorded.spawned).toHaveLength(0)
    // A branch that drops work logs it — and a line about a device carries the tag.
    const dropped = recorded.logs.find((line) => line.message.includes('no cells'))
    expect(dropped?.deviceId).toBe(900)
  })

  it('releases what it already acquired when a later acquisition fails', async () => {
    let calls = 0
    const session = sessionFor([611, 612], {
      acquireSource: async (deviceId) => {
        calls += 1
        if (calls === 2) throw new Error('broker said no')
        recorded.acquired.push(deviceId)
        return { url: 'rtsp://x', pipelineKey: `pk-${String(deviceId)}` }
      },
    })
    await expect(session.open(noopConsumer())).rejects.toThrow(/broker said no/)
    expect(recorded.released).toEqual(['pk-611'])
    expect(recorded.spawned).toHaveLength(0)
    expect(session.isRunning()).toBe(false)
  })

  it('tells every consumer why it ended when the child dies on its own', async () => {
    const session = sessionFor([611])
    const consumer = noopConsumer()
    await session.open(consumer)
    session.onChildEnded('crashed')
    await session.settled()
    expect(consumer.onClose).toHaveBeenCalledWith('crashed')
    expect(recorded.released).toEqual(['pk-611'])
    expect(session.isRunning()).toBe(false)
  })

  it('dispose stops the child and releases the sources even with consumers attached', async () => {
    const session = sessionFor([611, 612])
    await session.open(noopConsumer())
    await session.dispose()
    expect(session.isRunning()).toBe(false)
    expect(recorded.released).toEqual(['pk-611', 'pk-612'])
  })
})
