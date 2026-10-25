/**
 * The single-JPEG grab: it reads a composition, it never starts one.
 *
 * No ffmpeg runs here — the spawn is injected. What is under test is the
 * PLUMBING, which is where this kind of grab goes wrong: an stdin nobody
 * writes, a hold nobody closes (which leaves the grid composing for a
 * thumbnail), and a child nobody kills.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { GridFrameSampler, type GridSpawn } from '../grid-frame-sample.js'
import type { GridStreamLogger } from '../grid-stream-session.js'

const silentLogger: GridStreamLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed: NodeJS.Signals | null = null
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM'
    this.emit('exit', null, signal)
    return true
  }
}

function fakeSpawn(child: FakeChild): { spawnFn: GridSpawn; argv: string[][] } {
  const argv: string[][] = []
  const spawnFn = ((_bin: string, args: readonly string[]) => {
    argv.push([...args])
    return child
  }) as unknown as GridSpawn
  return { spawnFn, argv }
}

describe('GridFrameSampler', () => {
  it('asks ffmpeg for exactly ONE frame, as mjpeg, off stdin', async () => {
    const child = new FakeChild()
    const { spawnFn, argv } = fakeSpawn(child)
    const sampler = new GridFrameSampler({
      binaryPath: '/opt/ffmpeg',
      logger: silentLogger,
      spawnFn,
    })

    const pending = sampler.sample(4581, {
      attach: (onChunk) => {
        onChunk(Buffer.from('ts'))
        return { close: () => {} }
      },
    })
    child.stdout.write(Buffer.from([0xff, 0xd8, 0xff]))
    child.emit('exit', 0, null)

    expect((await pending)?.length).toBe(3)
    const args = argv[0] ?? []
    expect(args).toContain('pipe:0')
    expect(args.join(' ')).toContain('-frames:v 1')
    expect(args.join(' ')).toContain('-f mjpeg')
  })

  it('CLOSES the hold when it is done — a grab must not keep the grid composing', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn(child)
    const close = vi.fn()
    const sampler = new GridFrameSampler({
      binaryPath: '/opt/ffmpeg',
      logger: silentLogger,
      spawnFn,
    })

    const pending = sampler.sample(4581, { attach: () => ({ close }) })
    child.stdout.write(Buffer.from([0xff]))
    child.emit('exit', 0, null)
    await pending

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('answers null when there is nothing to attach to, and kills the child', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn(child)
    const sampler = new GridFrameSampler({
      binaryPath: '/opt/ffmpeg',
      logger: silentLogger,
      spawnFn,
    })

    // `attach` returning null is the session saying "nothing is composing".
    // The grab must not sit on an ffmpeg waiting for bytes that never come.
    expect(await sampler.sample(4581, { attach: () => null })).toBeNull()
    expect(child.killed).toBe('SIGKILL')
  })

  it('answers null when the child produced no bytes', async () => {
    const child = new FakeChild()
    const { spawnFn } = fakeSpawn(child)
    const sampler = new GridFrameSampler({
      binaryPath: '/opt/ffmpeg',
      logger: silentLogger,
      spawnFn,
    })
    const pending = sampler.sample(4581, { attach: () => ({ close: () => {} }) })
    child.emit('exit', 1, null)
    expect(await pending).toBeNull()
  })

  it('kills a grab that never finishes — a thumbnail must not hold an ffmpeg for ever', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const { spawnFn } = fakeSpawn(child)
      const sampler = new GridFrameSampler({
        binaryPath: '/opt/ffmpeg',
        logger: silentLogger,
        spawnFn,
        timeoutMs: 1_000,
      })
      const pending = sampler.sample(4581, { attach: () => ({ close: () => {} }) })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await pending).toBeNull()
      expect(child.killed).toBe('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})
