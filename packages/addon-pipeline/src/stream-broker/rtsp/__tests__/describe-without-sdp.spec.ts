/**
 * A DESCRIBE the broker cannot answer with an SDP is REFUSED, not answered
 * `200` with an empty body (camera 108 outage, 2026-10-22: 79 writer exits per
 * profile, ffmpeg exit 183 "Invalid data found when processing input").
 */
import * as net from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { RtspListenServer } from '../rtsp-listen-server.js'
import { RtspRestreamer } from '../rtsp-restreamer.js'

function dial(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.on('data', (c) => {
      data += c.toString('ascii')
      if (data.includes('\r\n\r\n')) socket.destroy()
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
    socket.write(`DESCRIBE rtsp://127.0.0.1:${port}/${token} RTSP/1.0\r\nCSeq: 1\r\n\r\n`)
  })
}

describe('DESCRIBE with no SDP after the wait', () => {
  it('answers 503 (not 200) and logs the timeout with the device id', async () => {
    const warn = vi.fn()
    const logger = { warn } as unknown as IScopedLogger // test double: only warn is read
    const server = new RtspListenServer()
    server.setLogger(logger)
    server.setSdpWaitMs(150)
    await server.start(0)
    try {
      const token = server.registerRestreamer(
        '108/native:main',
        new RtspRestreamer('108/native:main'),
      )
      const reply = await dial(server.getPort(), token)
      expect(reply).toMatch(/^RTSP\/1\.0 503 /)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ tags: { deviceId: 108 } })
    } finally {
      await server.stop()
    }
  })
})
