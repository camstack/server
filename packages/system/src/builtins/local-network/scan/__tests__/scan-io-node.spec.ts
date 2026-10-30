import { createSocket } from 'node:dgram'
import { describe, expect, it } from 'vitest'
import { nodeScanIo } from '../scan-io-node.js'

describe('node udpExchange resend', () => {
  it('a responder that answers only the second datagram is heard', async () => {
    const server = createSocket('udp4')
    let received = 0
    server.on('message', (_msg, rinfo) => {
      received += 1
      if (received === 2) server.send(Buffer.from('pong'), rinfo.port, rinfo.address)
    })
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      const replies = await nodeScanIo.udpExchange({
        payload: Buffer.from('ping'),
        targets: [{ host: '127.0.0.1', port }],
        resendAtMs: [50],
        listenMs: 300,
      })
      expect(replies.map((r) => r.data.toString())).toEqual(['pong'])
      const single = await nodeScanIo.udpExchange({
        payload: Buffer.from('ping'),
        targets: [{ host: '127.0.0.1', port }],
        listenMs: 100,
      })
      expect(single).toEqual([])
    } finally {
      server.close()
    }
  })
})
