import { describe, expect, it } from 'vitest'
import {
  readWsFrame,
  WS_OP_CLOSE,
  WS_OP_PING,
  WS_OP_PONG,
  WS_OP_TEXT,
  writeWsFrame,
} from '../home-connect-tls-wire.js'

/** A server-to-client frame is not masked. */
function serverFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
}

describe('websocket frames', () => {
  it('round-trips a masked client frame of every size class', () => {
    for (const size of [5, 300, 70_000]) {
      const payload = Buffer.alloc(size, 0x61)
      const frame = readWsFrame(writeWsFrame(WS_OP_TEXT, payload))
      expect(frame?.opcode).toBe(WS_OP_TEXT)
      expect(frame?.payload.equals(payload)).toBe(true)
    }
  })

  it('tells a ping from text so the wire can answer it instead of emitting it as a message', () => {
    const ping = readWsFrame(serverFrame(WS_OP_PING, Buffer.from('hb')))
    expect(ping?.opcode).toBe(WS_OP_PING)
    expect(ping?.payload.toString()).toBe('hb')
    const pong = readWsFrame(writeWsFrame(WS_OP_PONG, ping?.payload ?? Buffer.alloc(0)))
    expect(pong?.opcode).toBe(WS_OP_PONG)
    expect(pong?.payload.toString()).toBe('hb')
  })

  it('reports a close frame as a close, distinct from an empty text frame', () => {
    expect(readWsFrame(serverFrame(WS_OP_CLOSE, Buffer.alloc(0)))?.opcode).toBe(WS_OP_CLOSE)
  })

  it('waits for the rest of a partial frame', () => {
    const whole = serverFrame(WS_OP_TEXT, Buffer.from('hello'))
    expect(readWsFrame(whole.subarray(0, 4))).toBeNull()
  })
})
