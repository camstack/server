/**
 * The channel's half of the per-action census (D456): it owns the BYTES and
 * the request/response correlation; it must never own the label.
 *
 * `socket-traffic.ts` explains why the method is not kept next to the byte
 * counters, and the first of its three reasons is structural: a `SocketChannel`
 * sees `{ k, id, body }` with `body: unknown`, and a `res` frame carries no
 * method at all — only its id. So the channel is given a labeller by the layer
 * that understands the protocol, takes the label off the `req`, and settles it
 * against the `res` that matches the id. These tests pin exactly that seam.
 */
import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { encodeFrame } from '../../transport/frame-codec.js'
import { SocketChannel } from '../../transport/socket-channel.js'

interface Recorded {
  readonly label: string | null
  readonly reqBytes: number
  readonly resBytes: number
}

function observer(recorded: Recorded[]): {
  label: (body: unknown) => string | null
  record: (label: string | null, reqBytes: number, resBytes: number) => void
} {
  return {
    label: (body) => {
      const b = body as { capName?: string; method?: string } | null
      if (b === null || typeof b !== 'object') return null
      if (typeof b.capName !== 'string' || typeof b.method !== 'string') return null
      return `${b.capName}.${b.method}`
    },
    record: (label, reqBytes, resBytes) => void recorded.push({ label, reqBytes, resBytes }),
  }
}

function pair(): [SocketChannel, SocketChannel] {
  const a = new Socket()
  const b = new Socket()
  ;(a as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
    b.emit('data', Buffer.from(c))
    return true
  }
  ;(b as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer) => {
    a.emit('data', Buffer.from(c))
    return true
  }
  ;(a as unknown as { destroy: () => void }).destroy = () => void a.emit('close')
  ;(b as unknown as { destroy: () => void }).destroy = () => void b.emit('close')
  return [new SocketChannel(a), new SocketChannel(b)]
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('a channel that SERVES a request', () => {
  it('charges the answer it wrote to the label the request carried', async () => {
    const recorded: Recorded[] = []
    const [client, server] = pair()
    server.observeActions(observer(recorded))
    server.onRequest(async () => 'x'.repeat(4000))

    await client.request({ capName: 'device-state', method: 'getAllSnapshots' })
    await settle()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.label).toBe('device-state.getAllSnapshots')
    // The response is far bigger than the request — the shape the census exists
    // to name (144 MB on 1 966 responses against 2 kB of requests).
    expect(recorded[0]?.resBytes).toBeGreaterThan(4000)
    expect(recorded[0]?.reqBytes).toBeGreaterThan(0)
    expect(recorded[0]?.reqBytes).toBeLessThan(recorded[0]!.resBytes)
  })

  it('charges an error answer too — a call that failed still cost its bytes', async () => {
    const recorded: Recorded[] = []
    const [client, server] = pair()
    server.observeActions(observer(recorded))
    server.onRequest(async () => {
      throw new Error('nope')
    })

    await client.request({ capName: 'a', method: 'b' }).catch(() => undefined)
    await settle()

    expect(recorded[0]?.label).toBe('a.b')
    expect(recorded[0]?.resBytes).toBeGreaterThan(0)
  })

  it('reports a frame it cannot label as UNLABELLED, never by inventing one', async () => {
    const recorded: Recorded[] = []
    const [client, server] = pair()
    server.observeActions(observer(recorded))
    server.onRequest(async () => 'ok')

    await client.request({ kind: 'register', childId: 'r' })
    await settle()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.label).toBeNull()
    expect(recorded[0]?.resBytes).toBeGreaterThan(0)
  })
})

describe('a channel that ISSUES a request', () => {
  it('holds the label from its own req and settles it on the matching res', async () => {
    const recorded: Recorded[] = []
    const [client, server] = pair()
    client.observeActions(observer(recorded))
    server.onRequest(async () => 'y'.repeat(2000))

    await client.request({ capName: 'audio-codec', method: 'pullPcm' })
    await settle()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.label).toBe('audio-codec.pullPcm')
    expect(recorded[0]?.resBytes).toBeGreaterThan(2000)
  })

  it('never mis-charges a late answer to a different request', async () => {
    // The pending entry is dropped on timeout; a `res` that arrives after it
    // must find no waiter AND no label, or its bytes land on whatever id was
    // reused next.
    const recorded: Recorded[] = []
    const socket = new Socket()
    ;(socket as unknown as { write: () => boolean }).write = () => true
    const channel = new SocketChannel(socket)
    channel.observeActions(observer(recorded))

    await channel
      .request({ capName: 'slow', method: 'call' }, { timeoutMs: 5 })
      .catch(() => undefined)
    await settle()
    socket.emit('data', encodeFrame({ k: 'res', id: 1, ok: true, body: 'late' }))
    await settle()

    expect(recorded).toHaveLength(0)
  })
})

describe('the census is opt-in', () => {
  it('records nothing at all when no observer is wired', async () => {
    const recorded: Recorded[] = []
    const [client, server] = pair()
    server.onRequest(async () => 'ok')
    await client.request({ capName: 'a', method: 'b' })
    await settle()
    expect(recorded).toHaveLength(0)
  })

  it('survives an observer that throws — a diagnostic never fails the call it watches', async () => {
    const [client, server] = pair()
    server.observeActions({
      label: () => {
        throw new Error('broken labeller')
      },
      record: () => {
        throw new Error('broken sink')
      },
    })
    server.onRequest(async () => 'ok')
    await expect(client.request({ capName: 'a', method: 'b' })).resolves.toBe('ok')
  })

  it('charges an EVENT nothing — a one-way frame has no answer to correlate', async () => {
    const recorded: Recorded[] = []
    const [client, server] = pair()
    server.observeActions(observer(recorded))
    server.onEvent(() => undefined)
    client.emit({ capName: 'a', method: 'b' })
    await settle()
    expect(recorded).toHaveLength(0)
  })
})
