/**
 * The backup-archive download respects `drain`, and a client that stops
 * reading is cut after the grace — never buffered without bound.
 *
 * Disarmed (each turns at least one case red):
 *  - drop the `await` on the drain wait → "reads the next chunk only after…"
 *  - drop the `close` listener → "stops reading when the peer goes away…"
 *  - drop the grace timer → "cuts a client that never drains…"
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKUP_DOWNLOAD_DRAIN_GRACE_MS,
  pumpDownload,
  type DownloadSink,
  type PumpResult,
} from '../backup-download-pump.js'

/** A writable that says "not now" on demand and drains when the test says so. */
class FakeSink extends EventEmitter implements DownloadSink {
  readonly written: Uint8Array[] = []
  destroyed = false
  ended = false
  destroyError: Error | undefined
  /** What the next `write` answers. */
  accepts = true

  write(chunk: Uint8Array): boolean {
    this.written.push(chunk)
    return this.accepts
  }
  end(): void {
    this.ended = true
  }
  destroy(error?: Error): void {
    this.destroyed = true
    this.destroyError = error
    this.emit('close')
  }
  get writableLength(): number {
    return 0
  }
}

interface SourceCall {
  readonly offset: number
  readonly length: number
}

function sourceOf(
  sizeBytes: number,
  calls: SourceCall[],
): (offset: number, length: number) => Promise<Uint8Array> {
  return async (offset, length) => {
    calls.push({ offset, length })
    return new Uint8Array(Math.min(length, sizeBytes - offset)).fill(1)
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('pumpDownload', () => {
  let sink: FakeSink
  let calls: SourceCall[]

  beforeEach(() => {
    vi.useFakeTimers()
    sink = new FakeSink()
    calls = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('streams every chunk in order and ends the response when the sink keeps up', async () => {
    const result = await pumpDownload({
      sizeBytes: 20,
      chunkBytes: 8,
      read: sourceOf(20, calls),
      sink,
    })
    expect(calls).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: 8 },
      { offset: 16, length: 4 },
    ])
    expect(sink.ended).toBe(true)
    expect(sink.destroyed).toBe(false)
    expect(result.status).toBe('completed')
    expect(result.bytesWritten).toBe(20)
    expect(result.drainWaits).toBe(0)
  })

  it('reads the next chunk only after the sink drains the previous one', async () => {
    sink.accepts = false
    let result: PumpResult | undefined
    const pending = pumpDownload({
      sizeBytes: 16,
      chunkBytes: 8,
      read: sourceOf(16, calls),
      sink,
    }).then((r) => {
      result = r
    })
    await settle()
    // One chunk written, nothing more read: the source is not asked for
    // bytes the socket cannot take.
    expect(sink.written.length).toBe(1)
    expect(calls.length).toBe(1)
    expect(result).toBeUndefined()

    vi.advanceTimersByTime(5_000)
    sink.accepts = true
    sink.emit('drain')
    await pending
    expect(calls.length).toBe(2)
    expect(result?.status).toBe('completed')
    expect(result?.drainWaits).toBe(1)
    expect(result?.drainWaitMaxMs).toBe(5_000)
  })

  it('stops reading when the peer goes away mid-transfer and says so', async () => {
    sink.accepts = false
    const pending = pumpDownload({ sizeBytes: 24, chunkBytes: 8, read: sourceOf(24, calls), sink })
    await settle()
    sink.destroyed = true
    sink.emit('close')
    const result = await pending
    expect(result.status).toBe('peer-gone')
    expect(result.bytesWritten).toBe(8)
    expect(calls.length).toBe(1)
    expect(sink.ended).toBe(false)
  })

  it('cuts a client that never drains once the grace has run out', async () => {
    sink.accepts = false
    const pending = pumpDownload({ sizeBytes: 24, chunkBytes: 8, read: sourceOf(24, calls), sink })
    await settle()
    vi.advanceTimersByTime(BACKUP_DOWNLOAD_DRAIN_GRACE_MS - 1)
    await settle()
    expect(sink.destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    const result = await pending
    expect(result).toMatchObject({
      status: 'drain-timeout',
      heldForMs: BACKUP_DOWNLOAD_DRAIN_GRACE_MS,
    })
    expect(sink.destroyed).toBe(true)
    expect(calls.length).toBe(1)
  })

  it('does not write into a sink the peer already closed', async () => {
    let readCount = 0
    const result = await pumpDownload({
      sizeBytes: 16,
      chunkBytes: 8,
      read: async (offset, length) => {
        readCount += 1
        if (readCount === 1) sink.destroyed = true
        return new Uint8Array(Math.min(length, 16 - offset))
      },
      sink,
    })
    expect(result.status).toBe('peer-gone')
    expect(sink.written.length).toBe(0)
  })

  it('reports a source that fails and destroys the response with the error', async () => {
    const result = await pumpDownload({
      sizeBytes: 16,
      chunkBytes: 8,
      read: async () => {
        throw new Error('disk gone')
      },
      sink,
    })
    expect(result.status).toBe('source-failed')
    expect(result.status === 'source-failed' && result.error).toBe('disk gone')
    expect(sink.destroyed).toBe(true)
    expect(sink.destroyError?.message).toBe('disk gone')
  })

  it('treats an empty chunk before the end as a failed source, never as completion', async () => {
    const result = await pumpDownload({
      sizeBytes: 16,
      chunkBytes: 8,
      read: async () => new Uint8Array(0),
      sink,
    })
    expect(result.status).toBe('source-failed')
    expect(sink.ended).toBe(false)
    expect(sink.destroyed).toBe(true)
  })
})
