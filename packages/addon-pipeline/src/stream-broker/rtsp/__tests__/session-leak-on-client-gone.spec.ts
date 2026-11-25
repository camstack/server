/**
 * A battery camera was held awake for 40 minutes by an RTSP session that no
 * socket event could ever remove (prod hub, 2026-11-25, planning#711): two
 * recorder dials arrived together, the client dropped one while the broker was
 * still waiting for the SDP, so the session was built on an already-closed
 * socket — its `close` listener attached after the event had fired — while the
 * other session's close ran its teardown twice (`error` then `close`).
 */
import * as net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { RtspListenServer } from '../rtsp-listen-server.js'
import { RtspRestreamer } from '../rtsp-restreamer.js'

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function dial(port: number, token: string): net.Socket {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  socket.write(`DESCRIBE rtsp://127.0.0.1:${port}/${token} RTSP/1.0\r\nCSeq: 1\r\n\r\n`)
  return socket
}

describe('an RTSP session is removed exactly once, whatever order its socket dies in', () => {
  const servers: RtspListenServer[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop()
  })

  async function setup(): Promise<{
    server: RtspListenServer
    restreamer: RtspRestreamer
    token: string
    detach: ReturnType<typeof vi.fn>
  }> {
    const info = vi.fn()
    const debug = vi.fn()
    const logger = { info, debug, warn: vi.fn() } as unknown as IScopedLogger // test double
    const server = new RtspListenServer()
    server.setLogger(logger)
    servers.push(server)
    await server.start(0)
    const restreamer = new RtspRestreamer('640/native:sub')
    restreamer.setLogger(logger)
    const token = server.registerRestreamer('640/native:sub', restreamer)
    return { server, restreamer, token, detach: info }
  }

  it('two dials, one dropped while the SDP is pending: the count reaches 0', async () => {
    const { server, restreamer, token } = await setup()
    const a = dial(server.getPort(), token)
    const b = dial(server.getPort(), token)
    await sleep(100) // both are now waiting for the SDP
    b.destroy() // the client abandons one dial before the broker answered
    restreamer.setCameraSdp(SDP, 'h264', null) // the SDP lands afterwards
    await sleep(200)
    expect(restreamer.getSessionCount()).toBe(1)
    a.destroy()
    await sleep(100)
    expect(restreamer.getSessionCount()).toBe(0)
  })

  it('a duplicate teardown does not detach again nor mask a live session', async () => {
    const { restreamer } = await setup()
    const changes = vi.fn()
    restreamer.onSessionCountChanged(changes)
    restreamer.removeSession('never-added')
    expect(changes).not.toHaveBeenCalled()
  })
})

describe('a session that never reaches PLAY', () => {
  it('is closed and removed once the deadline passes', async () => {
    const server = new RtspListenServer()
    server.setPlayDeadlineMs(150)
    await server.start(0)
    try {
      const restreamer = new RtspRestreamer('640/native:sub')
      restreamer.setCameraSdp(SDP, 'h264', null)
      const token = server.registerRestreamer('640/native:sub', restreamer)
      const c = dial(server.getPort(), token)
      await sleep(80)
      expect(restreamer.getSessionCount()).toBe(1)
      await sleep(250)
      expect(restreamer.getSessionCount()).toBe(0)
      c.destroy()
    } finally {
      await server.stop()
    }
  })
})
