/**
 * A channel reports how many bytes it has handed to the socket that the
 * kernel has not yet taken (D446). `writableLength` is the number the
 * 2026-09-10 investigation summed over `_getActiveHandles()` and called
 * "84 MB, all of it the WS client" — from the outside, on a subset of the
 * sockets. This puts it on the channel, so the heartbeat reads it per peer.
 */
import { describe, expect, it } from 'vitest'
import { Socket } from 'node:net'
import { SocketChannel } from '../../transport/socket-channel.js'

function socketWithQueue(): { socket: Socket; setQueued: (n: number) => void } {
  const socket = new Socket()
  let queued = 0
  Object.defineProperty(socket, 'writableLength', { get: () => queued, configurable: true })
  Object.defineProperty(socket, 'write', { value: () => true, configurable: true })
  return { socket, setQueued: (n) => void (queued = n) }
}

describe('SocketChannel.queuedBytes', () => {
  it('is the socket writableLength, read live, never cached', () => {
    const { socket, setQueued } = socketWithQueue()
    const channel = new SocketChannel(socket)
    expect(channel.queuedBytes()).toBe(0)
    setQueued(300 * 1048576)
    expect(channel.queuedBytes()).toBe(300 * 1048576)
    setQueued(0)
    expect(channel.queuedBytes()).toBe(0)
  })
})
