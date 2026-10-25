/**
 * RFC 4571 framed-RTP-over-TCP reader.
 *
 * Format on the wire (per RFC 4571):
 *
 *   ┌─────────────┬────────────────────────────┐
 *   │ length (BE) │  RTP packet (length bytes) │
 *   │   uint16    │                            │
 *   └─────────────┴────────────────────────────┘
 *
 * No RTSP signalling, no '$' magic byte, no interleaved channel id —
 * just length-prefixed framed RTP. Stream descriptions arrive
 * out-of-band as an SDP string (handed in by the publisher), and
 * the reader routes packets to video / audio depacketizers based on
 * the RTP payload type each track advertised in its `m=` / rtpmap line.
 *
 * Used to ingest the local TCP server spawned by the Reolink lib's
 * `createRfc4571TcpServer` — the standard RFC 4571 length-prefixed
 * RTP-over-TCP wire format.
 *
 * The callbacks here mirror `NativeRtspClient` so the broker's
 * `startNativeRtspReader` glue code can be reused unchanged: same
 * `onVideoTrack` / `onVideoRtp` / `onAudioRtp` / `onConnected` /
 * `onError` / `onDisconnected` handles.
 */
import * as net from 'node:net'
import { copyOwned, type PacketAllocator } from '../stream-broker/owned-buffer.js'
import { parseSdp, extractVideoTrack, extractAudioTrack } from './sdp-parser.js'
import type { ParsedSdp, SdpVideoTrack, SdpAudioTrack } from './sdp-parser.js'
import type { IScopedLogger } from '@camstack/types'

export interface Rfc4571ReaderOptions {
  /** Loopback URL the lib's RFC 4571 server emitted (`tcp://[user:pass@]host:port`). */
  readonly url: string
  /** SDP describing the video + (optional) audio track, returned by the lib's server. */
  readonly sdp: string
  readonly logger?: IScopedLogger
  /** Where packets are cut (the broker's slab pool); default `copyOwned`. */
  readonly packetAllocator?: PacketAllocator
}

/**
 * Reader callbacks. Signature deliberately mirrors `RtspClientCallbacks`
 * (channel arg is always 0 here — RFC 4571 has no interleaved channel
 * concept, but keeping the shape lets the broker reuse the same handler
 * objects across both readers without an adapter layer).
 */
export interface Rfc4571ReaderCallbacks {
  readonly onVideoTrack?: (track: SdpVideoTrack, sdpText: string) => void
  readonly onAudioTrack?: (track: SdpAudioTrack) => void
  readonly onVideoRtp?: (rtpData: Buffer, channel: number) => void
  readonly onAudioRtp?: (rtpData: Buffer, channel: number) => void
  readonly onPlaying?: () => void
  readonly onError?: (error: Error) => void
  readonly onTeardown?: () => void
}

export class Rfc4571Reader {
  private readonly options: Rfc4571ReaderOptions
  private readonly callbacks: Rfc4571ReaderCallbacks
  private readonly logger: IScopedLogger | undefined
  private readonly allocatePacket: PacketAllocator
  private readonly host: string
  private readonly port: number
  private readonly authLine: Buffer | null
  private socket: net.Socket | null = null
  /** Concatenated TCP read buffer awaiting full frames. */
  private readBuffer: Buffer = Buffer.alloc(0)
  private parsedSdp: ParsedSdp | null = null
  private videoTrack: SdpVideoTrack | null = null
  private audioTrack: SdpAudioTrack | null = null
  private destroyed = false

  constructor(options: Rfc4571ReaderOptions, callbacks: Rfc4571ReaderCallbacks) {
    this.options = options
    this.callbacks = callbacks
    this.allocatePacket = options.packetAllocator ?? copyOwned
    this.logger = options.logger
    const parsed = new URL(options.url)
    this.host = parsed.hostname
    this.port = parseInt(parsed.port || '0', 10)
    if (this.port === 0) {
      throw new Error(`Rfc4571Reader: URL must include a port — got '${options.url}'`)
    }
    // The lib's RFC 4571 server (when spawned with `requireAuth: true`)
    // expects `username:password\n` as the very first bytes on the socket
    // before any framed RTP. After 5s without a match it drops the
    // connection. Username/password are percent-encoded in the URL —
    // decode them back to their raw form before composing the auth line.
    if (parsed.username || parsed.password) {
      const u = decodeURIComponent(parsed.username)
      const p = decodeURIComponent(parsed.password)
      this.authLine = Buffer.from(`${u}:${p}\n`, 'utf8')
    } else {
      this.authLine = null
    }
  }

  async connect(): Promise<void> {
    // Parse the SDP up front. RFC 4571 has no DESCRIBE phase; the publisher
    // handed us the stream description out-of-band so the broker knows
    // codec + payload-type → track routing before the first byte arrives.
    this.parsedSdp = parseSdp(this.options.sdp)
    this.videoTrack = extractVideoTrack(this.parsedSdp)
    this.audioTrack = extractAudioTrack(this.parsedSdp)

    if (this.videoTrack) {
      this.callbacks.onVideoTrack?.(this.videoTrack, this.options.sdp)
    }
    if (this.audioTrack) {
      this.callbacks.onAudioTrack?.(this.audioTrack)
    }

    await this.openSocket()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.logger?.info('rfc4571: tcp connected', { meta: { host: this.host, port: this.port } })
        // The lib's server requires `username:password\n` as the first
        // bytes when started with `requireAuth: true`. Send it before
        // anything else — the server starts framed-RTP delivery only
        // after a successful auth line.
        if (this.authLine) socket.write(this.authLine)
        // RFC 4571 has no PLAY phase — `onPlaying` fires the moment the TCP
        // socket is up, signalling "data is about to flow". Mirrors the
        // semantic the broker's RTSP path expects post-PLAY.
        this.callbacks.onPlaying?.()
        settled = true
        resolve()
      })
      this.socket = socket
      // Disable Nagle: video packets are small, latency matters more than
      // coalescing for a loopback connection.
      socket.setNoDelay(true)

      socket.on('data', (chunk) => this.onData(chunk))
      socket.on('error', (err) => {
        this.logger?.warn('rfc4571: tcp error', { meta: { error: err.message } })
        if (!this.destroyed) {
          this.callbacks.onError?.(err)
        }
        if (!settled) reject(err)
      })
      socket.on('close', () => {
        this.logger?.info('rfc4571: tcp closed')
        if (!this.destroyed) {
          this.callbacks.onTeardown?.()
        }
      })
    })
  }

  private onData(chunk: Buffer): void {
    this.readBuffer = this.readBuffer.length > 0 ? Buffer.concat([this.readBuffer, chunk]) : chunk

    while (this.readBuffer.length >= 2) {
      const length = this.readBuffer.readUInt16BE(0)
      if (this.readBuffer.length < 2 + length) return // need more bytes

      // Cut OWNED (see `owned-buffer.ts`, `copyOwned`): the broker retains every
      // video packet, so a pooled cut was copied a second time downstream.
      const rtpPacket = this.allocatePacket(this.readBuffer, 2, 2 + length)
      this.readBuffer = this.readBuffer.subarray(2 + length)

      this.dispatchRtp(rtpPacket)
    }
  }

  private dispatchRtp(rtpPacket: Buffer): void {
    if (rtpPacket.length < 2) return
    // RTP payload type is the lower 7 bits of byte 1.
    const payloadType = rtpPacket[1]! & 0x7f
    if (this.videoTrack && payloadType === this.videoTrack.payloadType) {
      this.callbacks.onVideoRtp?.(rtpPacket, 0)
      return
    }
    if (this.audioTrack && payloadType === this.audioTrack.payloadType) {
      this.callbacks.onAudioRtp?.(rtpPacket, 0)
      return
    }
    // Unknown PT — drop silently. Cameras occasionally send RTCP-style
    // packets multiplexed on the same channel; the broker doesn't care.
  }
}
