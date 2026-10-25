import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { writeHeld } from '../stream-broker/held-write'
import { PacketSlabPool } from '../stream-broker/slab-pool'

/**
 * A socket behind a full kernel buffer queues writes for seconds. The broker's
 * packets are views of recycled slabs, so a write that is not HELD reads
 * recycled (detached) memory when the peer finally drains (D868):
 *  - the bytes that go out are zero-length / another packet's;
 *  - Node's `writableLength` stays inflated forever, because `clearBuffer`
 *    subtracts `chunk.length` as it is NOW (0 after the slab is detached), not
 *    as it was when queued (repro: `Writable({highWaterMark: 0})`, write two
 *    views of one ArrayBuffer, `transfer()` it, drain: `writableLength` ends at
 *    the second chunk's original length).
 */

interface Sink {
  readonly stream: Writable
  /** What the peer reads once it drains: the chunk bytes AT THAT TIME. */
  readonly drainAll: () => Buffer[]
}

/** A peer that never drains until told to. */
function stalledSink(): Sink {
  const pending: Array<{ chunk: Buffer; done: () => void }> = []
  const stream = new Writable({
    highWaterMark: 0,
    write(chunk: Buffer, _enc, done) {
      pending.push({ chunk, done: () => done() })
    },
  })
  return {
    stream,
    drainAll: () => {
      const read: Buffer[] = []
      while (pending.length > 0) {
        const next = pending.shift()!
        read.push(Buffer.from(next.chunk)) // the bytes the kernel would be handed now
        next.done()
      }
      return read
    },
  }
}

const SLAB = 4096
const QUARANTINE = 1000

function run(write: (sink: Writable, packet: Buffer) => void) {
  const clock = { t: 0 }
  const pool = new PacketSlabPool({
    slabBytes: SLAB,
    quarantineMs: QUARANTINE,
    now: () => clock.t,
  })
  const sink = stalledSink()
  const sent: Buffer[] = []
  for (let i = 0; i < 40; i++) {
    const src = Buffer.alloc(900, i + 1)
    const packet = pool.copy(src, 0, src.length)
    sent.push(Buffer.from(src))
    write(sink.stream, packet)
  }
  // The broker moves on for far longer than the quarantine: every slab turns over.
  for (let i = 0; i < 600; i++) {
    clock.t += 50
    pool.copy(Buffer.alloc(900, 0xee), 0, 900)
  }
  const read = sink.drainAll()
  return { sent, read, sink }
}

describe('writeHeld behind a peer that never drains', () => {
  it('delivers every byte, and writableLength returns to 0', async () => {
    const { sent, read, sink } = run((s, p) => writeHeld(s, p))
    expect(read.length).toBe(sent.length)
    read.forEach((chunk, i) => expect(chunk.equals(sent[i]!)).toBe(true))
    await new Promise((r) => setImmediate(r))
    expect(sink.stream.writableLength).toBe(0)
  })

  it('DISARM: a plain write reads recycled memory and leaves writableLength inflated', async () => {
    const { sent, read, sink } = run((s, p) => s.write(p))
    const intact = read.filter((chunk, i) => chunk.equals(sent[i]!)).length
    expect(intact).toBeLessThan(sent.length)
    await new Promise((r) => setImmediate(r))
    expect(sink.stream.writableLength).toBeGreaterThan(0)
  })
})
