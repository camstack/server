import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AmcrestEvent, eventStreamPath } from '../amcrest-cgi-client.js'
import {
  EVENT_STREAM_BUFFER_RETAIN_BYTES,
  EVENT_STREAM_MAX_BUFFER_BYTES,
  type MultipartItem,
  pumpEventStream,
  readCompleteParts,
} from '../event-stream-parts.js'

const BOUNDARY = 'myboundary'
const B = `--${BOUNDARY}`
const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'binary'))
const dec = (b: Uint8Array): string => Buffer.from(b).toString('binary')

/** One part exactly as an IP4M-1041B sends it on `eventManager.cgi?action=attach`. */
const part = (body: string): string =>
  `${B}\r\nContent-Type: text/plain\r\nContent-Length:${Buffer.byteLength(body)}\r\n\r\n${body}\r\n\r\n`

/** A part whose only end is the next boundary. */
const partWithoutLength = (body: string): string =>
  `${B}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`

const START = 'Code=VideoMotion;action=Start;index=0'
const STOP = 'Code=VideoMotion;action=Stop;index=0'

const bodies = (items: readonly MultipartItem[]): string[] =>
  items.map((i) => (i.kind === 'part' ? dec(i.body) : `JUNK:${dec(i.bytes)}`))

describe('readCompleteParts — a part is delivered when it is complete (D669)', () => {
  /**
   * REGRESSION (2026-09-28, camera 3836). The splitter emitted a part only when
   * the NEXT boundary arrived. The camera sends one part per edge and then
   * nothing, so every Start was delivered at the following Stop and every Stop
   * at the following Start: motion was phase-inverted for weeks, and the
   * recorder filmed the quiet between episodes.
   */
  it('emits a part the moment its Content-Length bytes are in, with no boundary after it', () => {
    const out = readCompleteParts(enc(part(START)), B, false)
    expect(bodies(out.items)).toEqual([START])
    expect(out.preambleConsumed).toBe(true)
    // What is left is the part's trailing line break only — no event is held back.
    expect(dec(out.rest).trim()).toBe('')
  })

  it('emits every part when several arrive in one chunk — including the last', () => {
    const out = readCompleteParts(
      enc(part('Code=A;action=Start') + part('Code=B;action=Start') + part('Code=C;action=Start')),
      B,
      true,
    )
    expect(bodies(out.items)).toEqual([
      'Code=A;action=Start',
      'Code=B;action=Start',
      'Code=C;action=Start',
    ])
  })

  it('holds a part whose body is still in flight, and emits it when the rest arrives', () => {
    const whole = part(START)
    const cut = whole.indexOf('action=')
    const first = readCompleteParts(enc(whole.slice(0, cut)), B, false)
    expect(first.items).toHaveLength(0)
    const second = readCompleteParts(
      enc(dec(first.rest) + whole.slice(cut)),
      B,
      first.preambleConsumed,
    )
    expect(bodies(second.items)).toEqual([START])
  })

  it('discards a real preamble once, on the first read only', () => {
    const out = readCompleteParts(enc(`junk before the stream starts\r\n${part(START)}`), B, false)
    expect(bodies(out.items)).toEqual([START])
  })

  it('names bytes between parts as junk instead of skipping them — after the preamble', () => {
    const out = readCompleteParts(enc(`stray bytes\r\n${part(START)}`), B, true)
    expect(bodies(out.items)).toEqual(['JUNK:stray bytes\r\n', START])
  })

  it('a part WITHOUT Content-Length still ends at the next boundary (its only end)', () => {
    const first = readCompleteParts(enc(partWithoutLength(START)), B, false)
    expect(first.items).toHaveLength(0)
    const second = readCompleteParts(enc(dec(first.rest) + part(STOP)), B, true)
    expect(bodies(second.items)).toEqual([`${START}\r\n`, STOP])
  })

  it('an overstated Content-Length is cut at the next boundary rather than swallowing it', () => {
    const lying = `${B}\r\nContent-Length: 500\r\n\r\n${START}\r\n`
    const out = readCompleteParts(enc(lying + part(STOP)), B, false)
    expect(bodies(out.items)).toEqual([`${START}\r\n`, STOP])
  })

  it('emits a part whose last body byte is the last byte of the chunk', () => {
    const exact = `${B}\r\nContent-Length: ${START.length}\r\n\r\n${START}`
    const out = readCompleteParts(enc(exact), B, false)
    expect(bodies(out.items)).toEqual([START])
    expect(out.rest.byteLength).toBe(0)
  })

  it('a firmware that ends headers with bare LF is read on completion too', () => {
    const bareLf = `${B}\nContent-Type: text/plain\nContent-Length: ${START.length}\n\n${START}\n\n`
    const out = readCompleteParts(enc(bareLf), B, false)
    expect(bodies(out.items)).toEqual([START])
  })

  it('a closing delimiter is not a part', () => {
    const out = readCompleteParts(enc(`${part(START)}${B}--\r\n`), B, false)
    expect(bodies(out.items)).toEqual([START])
  })
})

describe('eventStreamPath', () => {
  it('asks the camera for heartbeats', () => {
    expect(eventStreamPath('[VideoMotion]')).toBe(
      '/cgi-bin/eventManager.cgi?action=attach&codes=[VideoMotion]&heartbeat=5',
    )
  })
})

describe('pumpEventStream — chunked bytes, as the socket delivers them', () => {
  const T0 = Date.UTC(2026, 8, 28, 7, 51, 34)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r))
  }

  interface Harness {
    readonly stream: PassThrough
    readonly events: AmcrestEvent[]
    readonly unparsed: string[]
    readonly byteChunks: number[]
    readonly overflows: number[]
    readonly done: Promise<void>
    readonly send: (s: string) => Promise<void>
  }

  const harness = (): Harness => {
    const stream = new PassThrough()
    const events: AmcrestEvent[] = []
    const unparsed: string[] = []
    const byteChunks: number[] = []
    const overflows: number[] = []
    const done = pumpEventStream(stream, BOUNDARY, {
      onEvent: (ev) => events.push(ev),
      onError: () => undefined,
      onUnparsedBlock: (reason, preview) => unparsed.push(`${reason}:${preview}`),
      onBytes: (n) => byteChunks.push(n),
      onBufferOverflow: (dropped) => overflows.push(dropped),
    })
    const send = async (s: string): Promise<void> => {
      stream.write(Buffer.from(s, 'binary'))
      await settle()
    }
    return { stream, events, unparsed, byteChunks, overflows, done, send }
  }

  it('delivers Start before a single Stop byte exists, and stamps each at its own arrival', async () => {
    const h = harness()
    const start = part(START)
    // Split across the boundary line, the headers and the body.
    const a = start.indexOf('Content-Length')
    const b = start.indexOf('action=')
    await h.send(start.slice(0, a))
    await h.send(start.slice(a, b))
    expect(h.events).toHaveLength(0)
    await h.send(start.slice(b))

    // The camera now says nothing for a minute. Start must already be out.
    expect(h.events.map((e) => e.action)).toEqual(['Start'])
    expect(h.events[0]!.observedAt).toBe(T0)

    vi.setSystemTime(T0 + 60_000)
    const stop = part(STOP)
    const c = stop.indexOf('\r\n\r\n')
    await h.send(stop.slice(0, c))
    expect(h.events.map((e) => e.action)).toEqual(['Start'])
    await h.send(stop.slice(c))

    expect(h.events.map((e) => e.action)).toEqual(['Start', 'Stop'])
    expect(h.events[1]!.observedAt).toBe(T0 + 60_000)
    expect(h.unparsed).toEqual([])

    h.stream.end()
    await h.done
  })

  it('heartbeat parts are keep-alives: no event, no dropped-block warning, no bytes line', async () => {
    const h = harness()
    await h.send(part('Heartbeat'))
    await h.send(part('Heartbeat') + part('Heartbeat'))
    expect(h.events).toEqual([])
    expect(h.unparsed).toEqual([])
    expect(h.byteChunks).toEqual([])

    await h.send(part('Heartbeat') + part(START))
    expect(h.events.map((e) => e.action)).toEqual(['Start'])
    expect(h.unparsed).toEqual([])
    expect(h.byteChunks).toHaveLength(1)

    h.stream.end()
    await h.done
  })

  it('a part that carries no Code= is still named as dropped', async () => {
    const h = harness()
    await h.send(part('something=else'))
    expect(h.events).toEqual([])
    expect(h.unparsed).toEqual(['body:something=else'])
    h.stream.end()
    await h.done
  })

  const filler = (n: number): string => 'x'.repeat(n)

  it('a Content-Length no boundary cuts short is bounded: one overflow, then resync', async () => {
    const h = harness()
    await h.send(`${B}\r\nContent-Length: 900000000\r\n\r\n`)
    await h.send(filler(EVENT_STREAM_MAX_BUFFER_BYTES))
    expect(h.overflows).toHaveLength(1)
    expect(h.overflows[0]).toBeGreaterThan(
      EVENT_STREAM_MAX_BUFFER_BYTES - EVENT_STREAM_BUFFER_RETAIN_BYTES,
    )

    // The next boundary is a fresh start; the stream reads on.
    await h.send(part(START))
    expect(h.events.map((e) => e.action)).toEqual(['Start'])
    // Resync, not junk: the kept tail was cut mid-part and is discarded as a preamble.
    expect(h.unparsed).toEqual([])
    h.stream.end()
    await h.done
  })

  it('a stream whose first boundary never comes is bounded, then resyncs on it', async () => {
    const h = harness()
    await h.send(filler(EVENT_STREAM_MAX_BUFFER_BYTES + 1))
    expect(h.overflows).toHaveLength(1)
    await h.send(part(STOP))
    expect(h.events.map((e) => e.action)).toEqual(['Stop'])
    h.stream.end()
    await h.done
  })
})
