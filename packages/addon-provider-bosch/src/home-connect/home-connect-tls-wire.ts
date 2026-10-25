import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomBytes } from 'node:crypto'
import type { HomeConnectWire } from './home-connect-wire.js'

function decodePsk64(psk64: string): Buffer {
  return Buffer.from(`${psk64}===`, 'base64url')
}

function parseHttpHeaders(buffer: Buffer): { headers: Buffer; rest: Buffer } | null {
  const marker = buffer.indexOf('\r\n\r\n')
  if (marker < 0) return null
  return {
    headers: buffer.subarray(0, marker + 4),
    rest: buffer.subarray(marker + 4),
  }
}

export const WS_OP_TEXT = 0x1
export const WS_OP_CLOSE = 0x8
export const WS_OP_PING = 0x9
export const WS_OP_PONG = 0xa

export interface WsFrame {
  readonly opcode: number
  readonly payload: Buffer
  readonly consumed: number
}

export function readWsFrame(buffer: Buffer): WsFrame | null {
  if (buffer.length < 2) return null
  const b0 = buffer.at(0)
  const b1 = buffer.at(1)
  if (b0 === undefined || b1 === undefined) return null
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let payloadLen = b1 & 0x7f
  let offset = 2
  if (payloadLen === 126) {
    if (buffer.length < 4) return null
    payloadLen = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null
    payloadLen = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLen = masked ? 4 : 0
  if (buffer.length < offset + maskLen + payloadLen) return null
  let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen)
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    const unmasked = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i += 1) {
      const pb = payload.at(i) ?? 0
      const mb = mask.at(i % 4) ?? 0
      unmasked[i] = pb ^ mb
    }
    payload = unmasked
  }
  return { opcode, payload, consumed: offset + maskLen + payloadLen }
}

/** One masked client frame (RFC 6455: every client-to-server frame is masked). */
export function writeWsFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const headerLen = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10
  const frame = Buffer.alloc(headerLen + 4 + payload.length)
  frame[0] = 0x80 | opcode
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length
    mask.copy(frame, 2)
    for (let i = 0; i < payload.length; i += 1) {
      const pb = payload.at(i) ?? 0
      const mb = mask.at(i % 4) ?? 0
      frame[2 + 4 + i] = pb ^ mb
    }
  } else if (payload.length < 65536) {
    frame[1] = 0x80 | 126
    frame.writeUInt16BE(payload.length, 2)
    mask.copy(frame, 4)
    for (let i = 0; i < payload.length; i += 1) {
      const pb = payload.at(i) ?? 0
      const mb = mask.at(i % 4) ?? 0
      frame[4 + 4 + i] = pb ^ mb
    }
  } else {
    frame[1] = 0x80 | 127
    frame.writeBigUInt64BE(BigInt(payload.length), 2)
    mask.copy(frame, 10)
    for (let i = 0; i < payload.length; i += 1) {
      const pb = payload.at(i) ?? 0
      const mb = mask.at(i % 4) ?? 0
      frame[10 + 4 + i] = pb ^ mb
    }
  }
  return frame
}

export function createHomeConnectTlsWire(input: {
  readonly host: string
  readonly connectAddress: string
  readonly psk: string
}): HomeConnectWire {
  let socket: TLSSocket | null = null
  let open = false
  const textListeners = new Set<(text: string) => void>()
  const closedListeners = new Set<() => void>()
  let recvBuffer = Buffer.alloc(0)
  let upgraded = false
  let closeAnnounced = false

  function emitText(text: string): void {
    for (const fn of textListeners) fn(text)
  }

  function emitClosed(): void {
    // A socket reports error, end and close in a row; listeners hear of the drop once.
    if (!open && !closeAnnounced) return
    open = false
    closeAnnounced = false
    for (const fn of closedListeners) fn()
  }

  function drainFrames(): void {
    while (true) {
      const parsed = readWsFrame(recvBuffer)
      if (!parsed) return
      recvBuffer = Buffer.from(recvBuffer.subarray(parsed.consumed))
      switch (parsed.opcode) {
        case WS_OP_PING:
          // The peer keeps the link alive with pings; an unanswered one gets the socket cut.
          socket?.write(writeWsFrame(WS_OP_PONG, parsed.payload))
          break
        case WS_OP_CLOSE:
          socket?.destroy()
          break
        case WS_OP_PONG:
          break
        default:
          if (parsed.payload.length > 0) emitText(parsed.payload.toString('utf8'))
      }
    }
  }

  return {
    get open() {
      return open
    },
    async connect(): Promise<void> {
      if (open) return
      const psk = decodePsk64(input.psk)
      await new Promise<void>((resolve, reject) => {
        socket = tlsConnect(
          {
            host: input.connectAddress,
            port: 443,
            servername: input.host,
            ciphers: 'PSK',
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.2',
            rejectUnauthorized: false,
            checkServerIdentity: () => undefined,
            pskCallback: () => ({ psk, identity: '' }),
          },
          () => {
            const key = randomBytes(16).toString('base64')
            const req = [
              'GET /homeconnect HTTP/1.1',
              `Host: ${input.host}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Key: ${key}`,
              'Sec-WebSocket-Version: 13',
              '',
              '',
            ].join('\r\n')
            socket?.write(req)
          },
        )
        socket.on('data', (chunk: Buffer) => {
          recvBuffer = Buffer.concat([recvBuffer, chunk])
          if (!upgraded) {
            const parsed = parseHttpHeaders(recvBuffer)
            if (!parsed) return
            const statusLine = parsed.headers.toString('utf8').split('\r\n')[0] ?? ''
            if (!statusLine.includes('101')) {
              reject(new Error('Home Connect WebSocket upgrade failed'))
              socket?.destroy()
              return
            }
            upgraded = true
            recvBuffer = Buffer.from(parsed.rest)
            open = true
            closeAnnounced = true
            resolve()
            drainFrames()
            return
          }
          drainFrames()
        })
        // Before the upgrade an error rejects connect(); after it, the close that follows is the signal.
        socket.on('error', (err) => {
          reject(err)
          socket?.destroy()
        })
        socket.on('close', () => emitClosed())
      })
    },
    send(text: string): void {
      if (!socket || !open) throw new Error('Home Connect TLS wire not open')
      socket.write(writeWsFrame(WS_OP_TEXT, Buffer.from(text, 'utf8')))
    },
    close(): void {
      const closing = socket
      socket = null
      closing?.destroy()
      emitClosed()
    },
    onText(listener) {
      textListeners.add(listener)
      return () => textListeners.delete(listener)
    },
    onClosed(listener) {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },
  }
}
