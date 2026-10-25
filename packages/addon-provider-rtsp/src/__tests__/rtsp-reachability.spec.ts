import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { parseRtspTarget, probeRtspReachable } from '../rtsp-reachability.js'

describe('parseRtspTarget', () => {
  it('defaults to port 554 when none is given', () => {
    expect(parseRtspTarget('rtsp://cam.local/stream')).toEqual({ host: 'cam.local', port: 554 })
  })
  it('honours an explicit port and ignores credentials/path', () => {
    expect(parseRtspTarget('rtsp://user:pass@10.0.0.5:8554/cam/main')).toEqual({
      host: '10.0.0.5',
      port: 8554,
    })
  })
  it('returns null for a non-parseable / empty URL', () => {
    expect(parseRtspTarget('not a url')).toBeNull()
    expect(parseRtspTarget('')).toBeNull()
  })
})

describe('probeRtspReachable', () => {
  let server: net.Server | null = null
  const accepted: net.Socket[] = []

  afterEach(async () => {
    // Force-close any lingering server-side sockets so `server.close()`
    // (which otherwise waits on open connections) resolves promptly.
    for (const socket of accepted.splice(0)) socket.destroy()
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = null
    }
  })

  const listen = (onConn?: (socket: net.Socket) => void): Promise<number> =>
    new Promise((resolve) => {
      server = net.createServer((socket) => {
        accepted.push(socket)
        onConn?.(socket)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server?.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

  it('reports REACHABLE on a bare TCP handshake (no RTSP response)', async () => {
    const port = await listen() // accepts, never answers
    const reachable = await probeRtspReachable(`rtsp://127.0.0.1:${port}/stream`, 2_000)
    expect(reachable).toBe(true)
  })

  it('reports REACHABLE when the server answers with an RTSP response line', async () => {
    const port = await listen((socket) => {
      socket.on('data', () => {
        socket.write('RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n')
      })
    })
    const reachable = await probeRtspReachable(`rtsp://127.0.0.1:${port}/stream`, 2_000)
    expect(reachable).toBe(true)
  })

  it('reports UNREACHABLE when nothing is listening on the port', async () => {
    // Bind + immediately close to obtain a definitely-free port.
    const freePort = await new Promise<number>((resolve) => {
      const probe = net.createServer()
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address()
        const p = typeof addr === 'object' && addr ? addr.port : 0
        probe.close(() => resolve(p))
      })
    })
    const reachable = await probeRtspReachable(`rtsp://127.0.0.1:${freePort}/stream`, 2_000)
    expect(reachable).toBe(false)
  })

  it('reports UNREACHABLE for an un-parseable URL without throwing', async () => {
    await expect(probeRtspReachable('garbage', 500)).resolves.toBe(false)
  })
})
