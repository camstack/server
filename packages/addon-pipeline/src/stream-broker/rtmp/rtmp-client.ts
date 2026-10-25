/**
 * RTMP client (TCP, handshake, AMF0 connect/createStream/play, chunk parser).
 *
 * RTMP client with the following adaptations from the original implementation:
 *   - `console` replaced with project `IScopedLogger`.
 *   - Inlined `readLength` helper (no external dependency).
 *   - Strict TS — AMF0 encoder accepts a tagged union instead of `any`.
 *   - Async-friendly `destroy()` for the broker's reconnect cycle.
 */

import type { IScopedLogger } from '@camstack/types'
import { once } from 'events'
import { Socket, type SocketConnectOpts } from 'net'
import { Readable } from 'stream'
import { parseRtmpUrl } from './rtmp-url.js'

// ── Inlined readLength helper ──

class StreamEndError extends Error {
  constructor(where: string) {
    super(`stream ended: ${where}`)
    this.name = 'StreamEndError'
  }
}

async function readLength(readable: Readable, length: number): Promise<Buffer> {
  if (readable.readableEnded || readable.destroyed) {
    throw new StreamEndError('readLength start')
  }
  if (!length) return Buffer.alloc(0)

  const initial = readable.read(length) as Buffer | null
  if (initial) return initial

  return new Promise<Buffer>((resolve, reject) => {
    const onReadable = (): void => {
      const chunk = readable.read(length) as Buffer | null
      if (chunk) {
        cleanup()
        resolve(chunk)
        return
      }
      if (readable.readableEnded || readable.destroyed) {
        cleanup()
        reject(new StreamEndError('readLength readable'))
      }
    }
    const onEnd = (): void => {
      cleanup()
      reject(new StreamEndError('readLength end'))
    }
    const cleanup = (): void => {
      readable.removeListener('readable', onReadable)
      readable.removeListener('end', onEnd)
    }
    readable.on('readable', onReadable)
    readable.on('end', onEnd)
  })
}

// ── RTMP wire enums ────────────────────────────────────────────────────

const HANDSHAKE_SIZE = 1536
const RTMP_VERSION = 3

enum ChunkFormat {
  TYPE_0 = 0,
  TYPE_1 = 1,
  TYPE_2 = 2,
  TYPE_3 = 3,
}

enum RtmpMessageType {
  CHUNK_SIZE = 1,
  ABORT = 2,
  ACKNOWLEDGEMENT = 3,
  USER_CONTROL = 4,
  WINDOW_ACKNOWLEDGEMENT_SIZE = 5,
  SET_PEER_BANDWIDTH = 6,
  AUDIO = 8,
  VIDEO = 9,
  DATA_AMF0 = 18,
  COMMAND_AMF0 = 20,
}

interface ChunkStreamState {
  chunkStreamId: number
  messageStreamId: number
  messageLength: number
  messageTypeId: number
  timestamp: number
  messageData: Buffer[]
  totalReceived: number
  hasExtendedTimestamp: boolean
}

// ── AMF0 encoder (strict types) ────────────────────────────────────────

type Amf0Value =
  | number
  | string
  | boolean
  | null
  | undefined
  | { readonly [key: string]: Amf0Value }

function encodeAmf0(value: Amf0Value): Buffer {
  if (typeof value === 'number') {
    const buf = Buffer.alloc(9)
    buf[0] = 0x00 // Number marker
    buf.writeDoubleBE(value, 1)
    return buf
  }
  if (typeof value === 'string') {
    const buf = Buffer.alloc(3 + value.length)
    buf[0] = 0x02 // String marker
    buf.writeUInt16BE(value.length, 1)
    buf.write(value, 3, 'utf8')
    return buf
  }
  if (typeof value === 'boolean') {
    const buf = Buffer.alloc(2)
    buf[0] = 0x01 // Boolean marker
    buf[1] = value ? 1 : 0
    return buf
  }
  if (value === null || value === undefined) {
    return Buffer.from([0x05]) // Null marker
  }
  // Object
  const parts: Buffer[] = [Buffer.from([0x03])] // Object marker
  for (const [key, val] of Object.entries(value)) {
    const keyBuf = Buffer.alloc(2 + key.length)
    keyBuf.writeUInt16BE(key.length, 0)
    keyBuf.write(key, 2, 'utf8')
    parts.push(keyBuf)
    parts.push(encodeAmf0(val))
  }
  parts.push(Buffer.from([0x00, 0x00, 0x09])) // End-of-object marker
  return Buffer.concat(parts)
}

function encodeAmf0Command(
  commandName: string,
  transactionId: number,
  commandObject: Amf0Value,
  ...args: ReadonlyArray<Amf0Value>
): Buffer {
  const parts: Buffer[] = [
    encodeAmf0(commandName),
    encodeAmf0(transactionId),
    encodeAmf0(commandObject),
  ]
  for (const arg of args) parts.push(encodeAmf0(arg))
  return Buffer.concat(parts)
}

function writeUInt24BE(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = (value >> 16) & 0xff
  buffer[offset + 1] = (value >> 8) & 0xff
  buffer[offset + 2] = value & 0xff
}

// ── Public RTMP packet shape ───────────────────────────────────────────

export type RtmpMediaCodec = 'video' | 'audio'

export interface RtmpMediaPacket {
  readonly codec: RtmpMediaCodec
  readonly packet: Buffer
  /** Timestamp in milliseconds, as advertised by the server. */
  readonly timestamp: number
}

export class RtmpClientClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RtmpClientClosedError'
  }
}

// ── RtmpClient ─────────────────────────────────────────────────────────

export class RtmpClient {
  readonly url: string
  private readonly logger: IScopedLogger | undefined
  private socket: Socket
  private chunkSize = 128
  private outgoingChunkSize = 128
  private windowAckSize = 5_000_000
  private streamId = 0
  private lastAcknowledgementBytes = 0
  private totalBytesReceived = 0
  private transactionId = 1
  private chunkStreams: Map<number, ChunkStreamState> = new Map()
  private destroyed = false

  constructor(url: string, logger?: IScopedLogger) {
    this.url = url
    this.logger = logger
    this.socket = new Socket()
  }

  /** Connect, handshake, and play. Throws on any failure. */
  async setup(): Promise<void> {
    await this.connect()

    this.logger?.debug('rtmp connect command sent')
    await this.sendConnect()

    while (true) {
      const msg = await this.readMessage()
      const { messageTypeId } = msg.chunkStream
      if (messageTypeId === RtmpMessageType.WINDOW_ACKNOWLEDGEMENT_SIZE) continue
      if (messageTypeId === RtmpMessageType.SET_PEER_BANDWIDTH) continue
      if (messageTypeId === RtmpMessageType.CHUNK_SIZE) {
        this.chunkSize = msg.message.readUInt32BE(0)
        this.logger?.debug('rtmp server chunk size', { meta: { chunkSize: this.chunkSize } })
        continue
      }
      if (messageTypeId === RtmpMessageType.COMMAND_AMF0) {
        const commandName = msg.message.subarray(3, 10).toString('utf8')
        if (commandName === '_result') {
          this.logger?.debug('rtmp connect _result received')
          break
        }
        throw new Error(`Unexpected RTMP command: ${commandName}`)
      }
      throw new Error(`Unexpected RTMP message type: ${messageTypeId}`)
    }

    this.sendWindowAckSize(5_000_000)

    this.streamId = await this.sendCreateStream()
    const createStreamResult = await this.readMessage()
    const { messageTypeId } = createStreamResult.chunkStream
    if (messageTypeId !== RtmpMessageType.COMMAND_AMF0) {
      throw new Error(`Unexpected message type for createStream result: ${messageTypeId}`)
    }
    this.logger?.debug('rtmp createStream _result received')

    // Last-slash split (`rtmp-url.ts`): a relay whose token rides in the app's
    // query must be played by its stream name, not by `?token=…/<name>`.
    const { playPath } = parseRtmpUrl(this.url)

    const getStreamLengthData = encodeAmf0Command(
      'getStreamLength',
      this.transactionId++,
      null,
      playPath,
    )
    this.sendMessage(5, 0, RtmpMessageType.COMMAND_AMF0, 0, getStreamLengthData)

    this.sendPlay(this.streamId, playPath)
    this.setBufferLength(this.streamId, 3000)

    this.logger?.info('rtmp play sent', { meta: { playPath } })
  }

  /** Async-iterator over received video/audio packets. */
  async *readLoop(): AsyncGenerator<RtmpMediaPacket, void, void> {
    while (!this.destroyed) {
      const msg = await this.readMessage()
      const typeId = msg.chunkStream.messageTypeId
      if (typeId === RtmpMessageType.VIDEO) {
        yield { codec: 'video', packet: msg.message, timestamp: msg.chunkStream.timestamp }
      } else if (typeId === RtmpMessageType.AUDIO) {
        yield { codec: 'audio', packet: msg.message, timestamp: msg.chunkStream.timestamp }
      } else {
        this.logger?.debug('rtmp ignoring message', { meta: { messageTypeId: typeId } })
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    try {
      this.socket.destroy()
    } catch {
      // Socket already destroyed — ignore.
    }
  }

  // ── Connection / handshake ────────────────────────────────────────────

  private async connect(): Promise<void> {
    const { host, port } = parseRtmpUrl(this.url)

    this.logger?.debug('rtmp tcp connecting', { meta: { host, port } })

    this.socket.on('error', (err) => {
      this.logger?.warn('rtmp socket error', { meta: { error: err.message } })
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      this.socket.once('error', onError)
      const opts: SocketConnectOpts = { host, port }
      this.socket.connect(opts, () => {
        this.socket.removeListener('error', onError)
        resolve()
      })
    })

    await this.performHandshake()
  }

  private async performHandshake(): Promise<void> {
    // C0
    const c0 = Buffer.from([RTMP_VERSION])
    // C1: timestamp(4) + zero(4) + random(1528)
    const c1 = Buffer.alloc(HANDSHAKE_SIZE)
    c1.writeUInt32BE(Math.floor(Date.now() / 1000), 0)
    c1.writeUInt32BE(0, 4)
    this.socket.write(Buffer.concat([c0, c1]))

    const s0 = await readLength(this.socket, 1)
    const serverVersion = s0.readUInt8(0)
    if (serverVersion !== RTMP_VERSION) {
      throw new Error(`Unsupported RTMP server version: ${serverVersion}`)
    }
    const s1 = await readLength(this.socket, HANDSHAKE_SIZE)
    await readLength(this.socket, HANDSHAKE_SIZE) // S2 (discarded)

    // C2 = echo of S1
    this.socket.write(s1)
  }

  // ── Chunk parser ──────────────────────────────────────────────────────

  private async readMessage(): Promise<{ message: Buffer; chunkStream: ChunkStreamState }> {
    const stream = this.socket
    while (true) {
      const basicHeader = await readLength(stream, 1)
      const basic0 = basicHeader.readUInt8(0)
      const fmt = (basic0 >> 6) & 0x03
      let csId = basic0 & 0x3f

      if (csId === 0) {
        const secondByte = await readLength(stream, 1)
        csId = secondByte.readUInt8(0) + 64
      } else if (csId === 1) {
        const bytes = await readLength(stream, 2)
        csId = (bytes.readUInt8(1) << 8) | (bytes.readUInt8(0) + 64)
      }

      let chunkStream = this.chunkStreams.get(csId)
      if (!chunkStream) {
        chunkStream = {
          chunkStreamId: csId,
          messageStreamId: 0,
          messageLength: 0,
          messageTypeId: 0,
          timestamp: 0,
          messageData: [],
          totalReceived: 0,
          hasExtendedTimestamp: false,
        }
        this.chunkStreams.set(csId, chunkStream)
      }

      let hasExtendedTimestamp = false
      let headerSize: number

      if (fmt === ChunkFormat.TYPE_0) {
        headerSize = 11
        const header = await readLength(stream, 11)
        const timestamp = header.readUIntBE(0, 3)
        const messageLength = header.readUIntBE(3, 3)
        const messageTypeId = header.readUInt8(6)
        const messageStreamId = header.readUInt32LE(7)

        chunkStream.messageStreamId = messageStreamId
        chunkStream.messageLength = messageLength
        chunkStream.messageTypeId = messageTypeId
        chunkStream.timestamp = timestamp
        chunkStream.totalReceived = 0
        chunkStream.messageData = []

        if (timestamp >= 0xffffff) {
          hasExtendedTimestamp = true
          chunkStream.hasExtendedTimestamp = true
        }
      } else if (fmt === ChunkFormat.TYPE_1) {
        headerSize = 7
        const header = await readLength(stream, 7)
        const timestampDelta = header.readUIntBE(0, 3)
        const messageLength = header.readUIntBE(3, 3)
        const messageTypeId = header.readUInt8(6)
        chunkStream.messageLength = messageLength
        chunkStream.messageTypeId = messageTypeId
        chunkStream.timestamp += timestampDelta
        chunkStream.totalReceived = 0
        chunkStream.messageData = []
        if (timestampDelta >= 0xffffff) {
          hasExtendedTimestamp = true
          chunkStream.hasExtendedTimestamp = true
        }
      } else if (fmt === ChunkFormat.TYPE_2) {
        headerSize = 3
        const header = await readLength(stream, 3)
        const timestampDelta = header.readUIntBE(0, 3)
        chunkStream.timestamp += timestampDelta
        chunkStream.totalReceived = 0
        chunkStream.messageData = []
        if (timestampDelta >= 0xffffff) {
          hasExtendedTimestamp = true
          chunkStream.hasExtendedTimestamp = true
        }
      } else {
        headerSize = 0
        if (chunkStream.totalReceived === 0) {
          throw new Error('Type 3 chunk but no previous chunk in stream')
        }
      }

      if (hasExtendedTimestamp || chunkStream.hasExtendedTimestamp) {
        const extTs = await readLength(stream, 4)
        const extendedTimestamp = extTs.readUInt32BE(0)
        if (fmt === ChunkFormat.TYPE_0) {
          chunkStream.timestamp = extendedTimestamp
        }
      }

      const remainingInMessage = chunkStream.messageLength - chunkStream.totalReceived
      const chunkDataSize = Math.min(this.chunkSize, remainingInMessage)

      const MAX_CHUNK_SIZE = 1024 * 1024
      if (chunkDataSize > MAX_CHUNK_SIZE) {
        throw new Error(`Chunk size ${chunkDataSize} exceeds max ${MAX_CHUNK_SIZE}`)
      }

      const chunkData = await readLength(stream, chunkDataSize)
      chunkStream.messageData.push(chunkData)
      chunkStream.totalReceived += chunkDataSize

      const extTimestampSize = hasExtendedTimestamp || chunkStream.hasExtendedTimestamp ? 4 : 0
      this.totalBytesReceived += 1 + headerSize + extTimestampSize + chunkDataSize
      this.sendAcknowledgementIfNeeded()

      if (chunkStream.totalReceived >= chunkStream.messageLength) {
        const message = Buffer.concat(chunkStream.messageData)
        chunkStream.messageData = []
        chunkStream.totalReceived = 0
        chunkStream.hasExtendedTimestamp = false
        return { chunkStream, message }
      }
    }
  }

  private sendAcknowledgementIfNeeded(): void {
    const bytesToAck = this.totalBytesReceived - this.lastAcknowledgementBytes
    if (bytesToAck >= this.windowAckSize) {
      this.lastAcknowledgementBytes = this.totalBytesReceived
      const data = Buffer.alloc(4)
      data.writeUInt32BE(this.lastAcknowledgementBytes & 0xffffffff, 0)
      this.sendMessage(2, 0, RtmpMessageType.ACKNOWLEDGEMENT, 0, data)
    }
  }

  // ── Outgoing message helpers ─────────────────────────────────────────

  private sendMessage(
    chunkStreamId: number,
    messageStreamId: number,
    messageTypeId: number,
    timestamp: number,
    data: Buffer,
  ): void {
    const chunks: Buffer[] = []
    let offset = 0

    while (offset < data.length) {
      const chunkDataSize = Math.min(this.outgoingChunkSize, data.length - offset)
      const isType0 = offset === 0
      const headerSize = isType0 ? 12 : 1
      const header = Buffer.alloc(headerSize)

      if (chunkStreamId < 64) {
        header[0] = ((isType0 ? ChunkFormat.TYPE_0 : ChunkFormat.TYPE_3) << 6) | chunkStreamId
      } else {
        header[0] = ((isType0 ? ChunkFormat.TYPE_0 : ChunkFormat.TYPE_3) << 6) | 1
      }

      if (isType0) {
        writeUInt24BE(header, timestamp, 1)
        writeUInt24BE(header, data.length, 4)
        header[7] = messageTypeId
        header.writeUInt32LE(messageStreamId, 8)
      }

      chunks.push(header, data.subarray(offset, offset + chunkDataSize))
      offset += chunkDataSize
    }

    for (const chunk of chunks) this.socket.write(chunk)
  }

  private async sendConnect(): Promise<void> {
    const { app, tcUrl } = parseRtmpUrl(this.url)
    const connectObject = {
      app,
      flashVer: 'LNX 9,0,124,2',
      tcUrl,
      fpad: false,
      capabilities: 15,
      audioCodecs: 4071,
      videoCodecs: 252,
      videoFunction: 1,
    }
    const data = encodeAmf0Command('connect', this.transactionId++, connectObject)
    this.sendMessage(3, 0, RtmpMessageType.COMMAND_AMF0, 0, data)
  }

  private async sendCreateStream(): Promise<number> {
    const data = encodeAmf0Command('createStream', this.transactionId++, null)
    this.sendMessage(3, 0, RtmpMessageType.COMMAND_AMF0, 0, data)
    return 1
  }

  private sendPlay(streamId: number, playPath: string): void {
    const data = encodeAmf0Command('play', this.transactionId++, null, playPath, -2000)
    this.sendMessage(4, streamId, RtmpMessageType.COMMAND_AMF0, 0, data)
  }

  private setBufferLength(streamId: number, bufferLength: number): void {
    const data = Buffer.alloc(10)
    data.writeUInt16BE(3, 0)
    data.writeUInt32BE(streamId, 2)
    data.writeUInt32BE(bufferLength, 6)
    this.sendMessage(2, 0, RtmpMessageType.USER_CONTROL, 1, data)
  }

  private sendWindowAckSize(windowSize: number): void {
    const data = Buffer.alloc(4)
    data.writeUInt32BE(windowSize, 0)
    this.sendMessage(2, 0, RtmpMessageType.WINDOW_ACKNOWLEDGEMENT_SIZE, 0, data)
  }

  /** Wait for the underlying socket to close. */
  async waitForClose(): Promise<void> {
    if (this.socket.destroyed) return
    await once(this.socket, 'close')
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }
}
