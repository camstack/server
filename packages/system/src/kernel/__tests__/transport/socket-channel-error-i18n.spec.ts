/**
 * D863: a `userError` thrown by a handler in ANOTHER process keeps its code and
 * params across the real msgpack frame codec, and across a second hop (the hub
 * re-serving a child's refusal), so the hub's error formatter can translate it.
 */
import { Socket } from 'node:net'
import { readErrorI18n, userError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { PeerAnsweredError } from '../../transport/peer-answered-error.js'
import { SocketChannel } from '../../transport/socket-channel.js'

function pair(): [SocketChannel, SocketChannel] {
  const a = new Socket()
  const b = new Socket()
  Object.assign(a, {
    write: (c: Buffer) => {
      b.emit('data', Buffer.from(c))
      return true
    },
    destroy: () => void a.emit('close'),
  })
  Object.assign(b, {
    write: (c: Buffer) => {
      a.emit('data', Buffer.from(c))
      return true
    },
    destroy: () => void b.emit('close'),
  })
  return [new SocketChannel(a), new SocketChannel(b)]
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (err: unknown) {
    if (err instanceof Error) return err
  }
  throw new Error('expected a rejection')
}

describe('an error answered by a peer', () => {
  it('keeps its code and params across the wire', async () => {
    const [client, server] = pair()
    server.onRequest(async () => {
      throw userError('recording.export-expired', { id: 'x1' }, 'Export "x1" has expired')
    })
    const err = await rejection(client.request({ capName: 'recording-export', method: 'read' }))
    expect(err).toBeInstanceOf(PeerAnsweredError)
    expect(err.message).toBe('Export "x1" has expired')
    expect(readErrorI18n(err)).toEqual({ code: 'recording.export-expired', params: { id: 'x1' } })
  })

  it('survives a second hop (the hub re-serving the child refusal)', async () => {
    const [childSide, hubChild] = pair()
    const [hubClient, callerSide] = pair()
    childSide.onRequest(async () => {
      throw userError('device.not-found', { id: 7 }, 'Device 7 not found')
    })
    hubClient.onRequest(async () => hubChild.request({}))
    const err = await rejection(callerSide.request({}))
    expect(readErrorI18n(err)).toEqual({ code: 'device.not-found', params: { id: 7 } })
  })

  it('a legacy error stays a plain refusal with no code', async () => {
    const [client, server] = pair()
    server.onRequest(async () => {
      throw new Error('plain')
    })
    const err = await rejection(client.request({}))
    expect(err.message).toBe('plain')
    expect(readErrorI18n(err)).toBeNull()
  })
})
