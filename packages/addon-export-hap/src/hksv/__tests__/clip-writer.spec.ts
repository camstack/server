/**
 * The tee, and the one property that outranks the feature.
 *
 * `Fmp4FragmentPlane` is serving the operator's real home: the delegate's own
 * subscription feeds HomeKit Secure Video right now. A second subscriber that
 * misbehaves — a full disk, a throwing write, a stall — must therefore be
 * unable to change one byte of what the delegate receives. That is not a
 * property of the writer alone, it is a property of the writer AGAINST the
 * plane, so every test here drives a REAL `Fmp4FragmentPlane` with two
 * subscriptions and compares the delegate's stream against a control run.
 *
 * A fake plane would only prove the writer agrees with whoever wrote the fake,
 * which is the pre-seeding failure this repo has shipped twice.
 */
import type { IScopedLogger } from '@camstack/types'
import type { Fmp4Packet } from '@camstack/types/node'
import { Fmp4FragmentPlane } from '@camstack/types/node'
import { describe, expect, it } from 'vitest'

import type { ClipSink } from '../clip-writer.js'
import { HksvClipWriter } from '../clip-writer.js'

const DEVICE_ID = 101
const STREAM_ID = 7

interface LogLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface LogPayload {
  readonly meta?: Record<string, unknown>
  readonly tags?: Record<string, unknown>
}

function logger(sink: LogLine[] = []): IScopedLogger {
  const record =
    (level: LogLine['level']) =>
    (message: string, payload?: LogPayload): void => {
      sink.push({ level, message, meta: payload?.meta ?? {}, tags: payload?.tags ?? {} })
    }
  const log = {
    debug: () => {},
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
    withTags: () => log,
  }
  // Documented type boundary: `IScopedLogger` is the kernel's full injected
  // surface; the writer only ever calls these six.
  return log as unknown as IScopedLogger
}

/** A sink that records what landed, and optionally refuses to take it. */
class MemorySink implements ClipSink {
  readonly chunks: Uint8Array[] = []
  closed = 0
  private paused = false
  private readonly parked: Array<() => void> = []
  constructor(private readonly failOnWrite = false) {}
  /** A disk that stopped answering. Every further write parks until resumed. */
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
    for (const wake of this.parked.splice(0)) wake()
  }
  async write(chunk: Uint8Array): Promise<void> {
    if (this.failOnWrite) throw new Error('ENOSPC: no space left on device')
    if (this.paused) await new Promise<void>((resolve) => this.parked.push(resolve))
    this.chunks.push(chunk)
  }
  async close(): Promise<void> {
    this.closed += 1
  }
  get bytes(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  concat(): number[] {
    return this.chunks.flatMap((c) => [...c])
  }
}

function unit(kind: 'init' | 'fragment', sequence: number, size = 4) {
  return { kind, sequence, data: new Uint8Array(size).fill(sequence) }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

interface Run {
  readonly delegatePackets: readonly Fmp4Packet[]
  /** How the DELEGATE's own subscription ended — `ended` is the healthy one. */
  readonly delegateClosedReason: string | null
  readonly sink: MemorySink
  readonly logs: LogLine[]
  readonly writer: HksvClipWriter | null
}

/**
 * One HKSV recording, with or without a tee beside it. The delegate consumer
 * is the SAME code in both runs, so "byte-identical" is a real comparison and
 * not two different loops agreeing.
 */
async function recordingRun(options: {
  readonly withTee: boolean
  readonly sink?: MemorySink
  readonly fragments?: number
  readonly maxBytes?: number
  readonly teeQueueCapacity?: number
  /** Stall the tee's sink after N writes, to make it the slow consumer. */
  readonly stallTeeAfter?: number
}): Promise<Run> {
  const logs: LogLine[] = []
  const plane = new Fmp4FragmentPlane(undefined, { windowMs: 60_000, maxBytes: 1_000_000 })
  plane.publish(unit('init', 0))
  plane.publish(unit('fragment', 1))

  const delegateSub = plane.subscribe({ tag: `hksv/${DEVICE_ID}`, withPrebuffer: true })
  const sink = options.sink ?? new MemorySink()
  let writer: HksvClipWriter | null = null
  if (options.withTee) {
    const teeSub = plane.subscribe({
      tag: `clip/${DEVICE_ID}`,
      withPrebuffer: true,
      queueCapacity: options.teeQueueCapacity,
    })
    writer = new HksvClipWriter({
      logger: logger(logs),
      deviceId: DEVICE_ID,
      streamId: STREAM_ID,
      subscription: teeSub,
      sink,
      maxBytes: options.maxBytes ?? 10_000_000,
      now: () => 1_000,
    })
    writer.start()
  }

  const delegatePackets: Fmp4Packet[] = []
  const consume = (async () => {
    for await (const packet of delegateSub.packets()) delegatePackets.push(packet)
  })()

  const fragments = options.fragments ?? 4
  for (let i = 2; i < 2 + fragments; i += 1) {
    if (options.stallTeeAfter !== undefined && i - 2 === options.stallTeeAfter) {
      // From here on the tee cannot drain: the plane must close IT, and only it.
      sink.pause()
    }
    plane.publish(unit('fragment', i))
    await tick()
  }
  plane.end('test ended')
  await consume
  if (writer !== null) {
    // The disk comes back BEFORE we wait on the tee: a parked write is a slow
    // disk, and a test that waited on one forever would be testing nothing.
    sink.resume()
    writer.finish()
    await writer.done
  }
  return {
    delegatePackets,
    delegateClosedReason: delegateSub.closedReason,
    sink,
    logs,
    writer,
  }
}

describe('HksvClipWriter — the tee never touches the delegate', () => {
  it('writes the retained init and then every fragment, in order', async () => {
    const run = await recordingRun({ withTee: true })
    // init + the one prebuffered fragment + 4 live ones.
    expect(run.sink.chunks).toHaveLength(6)
    expect(run.sink.concat()).toEqual(run.delegatePackets.flatMap((p) => [...p.data]))
    const outcome = await run.writer?.done
    expect(outcome?.truncated).toBeNull()
    expect(outcome?.sawInit).toBe(true)
    expect(outcome?.fragments).toBe(5)
    expect(run.sink.closed).toBe(1)
  })

  it('leaves the delegate BYTE-IDENTICAL when every disk write throws', async () => {
    const control = await recordingRun({ withTee: false })
    const teed = await recordingRun({ withTee: true, sink: new MemorySink(true) })

    expect(teed.delegatePackets.map((p) => [...p.data])).toEqual(
      control.delegatePackets.map((p) => [...p.data]),
    )
    expect(teed.delegatePackets.map((p) => p.isLast)).toEqual(
      control.delegatePackets.map((p) => p.isLast),
    )
    // Not merely equal to the control: ENDED, which is the plane's healthy
    // close. A delegate the tee had dragged down would read `slow-consumer`.
    expect(teed.delegateClosedReason).toBe('ended')
    expect(control.delegateClosedReason).toBe('ended')

    const outcome = await teed.writer?.done
    expect(outcome?.truncated).toBe('write-failed')
    // The failure is LOGGED, not propagated — and it names the camera.
    const failure = teed.logs.find((l) => l.level === 'warn')
    expect(failure?.message).toMatch(/clip tee/i)
    expect(failure?.tags).toMatchObject({ deviceId: DEVICE_ID })
  })

  it('stops at the per-clip byte ceiling instead of following an endless stream', async () => {
    const run = await recordingRun({ withTee: true, fragments: 20, maxBytes: 20 })
    const outcome = await run.writer?.done
    expect(outcome?.truncated).toBe('size-cap')
    expect(run.sink.bytes).toBeLessThanOrEqual(24)
    expect(run.sink.closed).toBe(1)
    expect(run.logs.some((l) => l.level === 'warn' && /size/i.test(l.message))).toBe(true)
  })

  it('reports a tee the plane closed for falling behind, and the delegate keeps its stream', async () => {
    const control = await recordingRun({ withTee: false, fragments: 12 })
    const run = await recordingRun({
      withTee: true,
      fragments: 12,
      teeQueueCapacity: 1,
      stallTeeAfter: 1,
    })
    const outcome = await run.writer?.done
    expect(outcome?.truncated).toBe('slow-consumer')
    expect(run.delegatePackets.map((p) => [...p.data])).toEqual(
      control.delegatePackets.map((p) => [...p.data]),
    )
    expect(run.delegateClosedReason).toBe('ended')
  })
})
