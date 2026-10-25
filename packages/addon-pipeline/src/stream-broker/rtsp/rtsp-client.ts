import * as net from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import { copyOwned, type PacketAllocator } from '../stream-broker/owned-buffer.js'
import { INTERLEAVED_MAGIC } from './rtsp-types.js'
import { parseSdp, extractVideoTrack, extractAudioTrack, resolveTrackUrl } from './sdp-parser.js'
import type { ParsedSdp, SdpVideoTrack, SdpAudioTrack } from './sdp-parser.js'

// ── Types ───────────────────────────────────────────────────────────

export interface RtspClientOptions {
  /** RTSP URL (rtsp://user:pass@host:port/path). */
  readonly url: string
  /** Override username (takes precedence over URL credentials). */
  readonly username?: string
  /** Override password (takes precedence over URL credentials). */
  readonly password?: string
  /** TCP connect timeout in ms (default 10000). */
  readonly connectTimeoutMs?: number
  /** Keepalive interval in ms (default 30000). GET_PARAMETER sent periodically. */
  readonly keepaliveIntervalMs?: number
  /** Logger instance. */
  readonly logger?: IScopedLogger
  /** Where interleaved packets are cut (the broker's slab pool); default `copyOwned`. */
  readonly packetAllocator?: PacketAllocator
}

export interface RtspClientCallbacks {
  /** Called for every RTP packet received on a video track. */
  readonly onVideoRtp?: (packet: Buffer, channel: number) => void
  /** Called for every RTP packet received on an audio track. */
  readonly onAudioRtp?: (packet: Buffer, channel: number) => void
  /** Called when video SDP info is available (after DESCRIBE). */
  readonly onVideoTrack?: (track: SdpVideoTrack, sdpText: string) => void
  /** Called when audio SDP info is available (after DESCRIBE). */
  readonly onAudioTrack?: (track: SdpAudioTrack) => void
  /** Called when connection is fully established (PLAY response received). */
  readonly onPlaying?: () => void
  /** Called on unrecoverable error or connection lost. */
  readonly onError?: (error: Error) => void
  /** Called when the client is cleanly torn down. */
  readonly onTeardown?: () => void
}

type RtspState =
  | 'idle'
  | 'connecting'
  | 'options'
  | 'describe'
  | 'setup-video'
  | 'setup-audio'
  | 'play'
  | 'streaming'
  | 'teardown'
  | 'closed'

interface DigestChallenge {
  readonly realm: string
  readonly nonce: string
  readonly qop?: string
  readonly opaque?: string
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
const RTSP_PORT = 554

// ── Implementation ──────────────────────────────────────────────────

/**
 * Native RTSP client that connects directly to IP cameras via TCP.
 *
 * Replaces the ffmpeg RTSP reader. Instead of spawning ffmpeg to read
 * RTSP → Annex-B pipe, this client speaks RTSP natively and delivers
 * raw RTP packets — preserving RTP framing that ffmpeg's Annex-B output
 * destroys.
 *
 * State machine: connect → OPTIONS → DESCRIBE → SETUP(video) → SETUP(audio) → PLAY → streaming
 *
 * Features:
 * - TCP interleaved transport (RTP over RTSP connection)
 * - Basic + Digest authentication (auto-detect from 401 response)
 * - GET_PARAMETER keepalive
 * - Clean teardown
 */
export class NativeRtspClient {
  private state: RtspState = 'idle'
  private socket: net.Socket | null = null
  private cseq = 0
  private sessionId: string | null = null

  private readonly url: string
  private readonly host: string
  private readonly port: number
  private readonly username: string
  private readonly password: string
  private readonly connectTimeoutMs: number
  private readonly keepaliveIntervalMs: number
  private readonly logger: IScopedLogger | undefined
  private readonly callbacks: RtspClientCallbacks
  private readonly allocatePacket: PacketAllocator

  /** Parsed SDP from DESCRIBE response. */
  private parsedSdp: ParsedSdp | null = null
  private rawSdpText: string | null = null
  private videoTrack: SdpVideoTrack | null = null
  private audioTrack: SdpAudioTrack | null = null

  /** Channel assignments for TCP interleaved transport. */
  private videoRtpChannel = 0
  private videoRtcpChannel = 1
  private audioRtpChannel = 2
  private audioRtcpChannel = 3

  /** Authentication state. */
  private authMethod: 'none' | 'basic' | 'digest' = 'none'
  private digestChallenge: DigestChallenge | null = null
  private digestNc = 0

  /** TCP read buffer for interleaved framing + RTSP response parsing. */
  private readBuffer: Buffer = Buffer.alloc(0)

  /** Pending RTSP response handler (one request at a time). */
  private pendingResponse:
    | ((statusCode: number, headers: ReadonlyMap<string, string>, body: string) => void)
    | null = null

  /** Keepalive timer. */
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined

  /** Connect timeout. */
  private connectTimer: ReturnType<typeof setTimeout> | undefined

  /** Whether a teardown was requested (prevents reconnect on close). */
  private tornDown = false

  constructor(options: RtspClientOptions, callbacks: RtspClientCallbacks) {
    this.callbacks = callbacks
    this.allocatePacket = options.packetAllocator ?? copyOwned
    this.logger = options.logger
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS

    // Parse URL
    const parsed = new URL(options.url)
    this.url = options.url
    this.host = parsed.hostname
    this.port = parsed.port ? parseInt(parsed.port, 10) : RTSP_PORT
    this.username = options.username ?? decodeURIComponent(parsed.username)
    this.password = options.password ?? decodeURIComponent(parsed.password)
  }

  /** Start the RTSP session: connect → negotiate → stream. */
  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed') {
      throw new Error(`Cannot connect in state ${this.state}`)
    }

    this.tornDown = false
    this.state = 'connecting'
    this.cseq = 0
    this.sessionId = null
    this.authMethod = 'none'
    this.digestChallenge = null
    this.digestNc = 0
    this.readBuffer = Buffer.alloc(0)

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket

      this.connectTimer = setTimeout(() => {
        this.connectTimer = undefined
        socket.destroy(new Error(`RTSP connect timeout after ${this.connectTimeoutMs}ms`))
      }, this.connectTimeoutMs)

      socket.on('connect', () => {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = undefined
        }
        this.logger?.info('Connected', { meta: { host: this.host, port: this.port } })

        this.negotiate()
          .then(() => resolve())
          .catch((err) => {
            this.destroy()
            reject(err)
          })
      })

      socket.on('data', (chunk: Buffer) => {
        this.onData(chunk)
      })

      socket.on('close', () => {
        if (this.state === 'streaming' && !this.tornDown) {
          this.callbacks.onError?.(new Error('RTSP connection closed unexpectedly'))
        }
        this.cleanup()
      })

      socket.on('error', (err) => {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = undefined
        }
        if (this.state !== 'closed' && this.state !== 'teardown') {
          this.callbacks.onError?.(err)
        }
        this.cleanup()
        reject(err)
      })
    })
  }

  /** Gracefully tear down the RTSP session. */
  async teardown(): Promise<void> {
    if (this.state === 'closed' || this.state === 'idle') return
    this.tornDown = true
    this.state = 'teardown'

    try {
      if (this.socket && !this.socket.destroyed) {
        await this.sendRequest('TEARDOWN', this.url)
      }
    } catch {
      // Best-effort teardown
    }

    this.destroy()
    this.callbacks.onTeardown?.()
  }

  /** Forcefully destroy the connection without TEARDOWN. */
  destroy(): void {
    this.tornDown = true
    this.cleanup()
  }

  /** Get the parsed SDP text (available after DESCRIBE). */
  getSdpText(): string | null {
    return this.rawSdpText
  }

  /** Get the parsed SDP (available after DESCRIBE). */
  getParsedSdp(): ParsedSdp | null {
    return this.parsedSdp
  }

  /** Get the video track info (available after DESCRIBE). */
  getVideoTrack(): SdpVideoTrack | null {
    return this.videoTrack
  }

  /** Current client state. */
  getState(): RtspState {
    return this.state
  }

  // ── RTSP Negotiation ──────────────────────────────────────────────

  private async negotiate(): Promise<void> {
    // Step 1: OPTIONS (optional but standard — probes server capabilities)
    this.state = 'options'
    await this.sendRequest('OPTIONS', this.url)

    // Step 2: DESCRIBE — get SDP
    this.state = 'describe'
    const describeResult = await this.sendRequest('DESCRIBE', this.url, {
      Accept: 'application/sdp',
    })

    if (describeResult.statusCode === 401) {
      // Parse auth challenge and retry
      this.parseAuthChallenge(describeResult.headers)
      const retryResult = await this.sendRequest('DESCRIBE', this.url, {
        Accept: 'application/sdp',
      })
      if (retryResult.statusCode !== 200) {
        throw new Error(`DESCRIBE failed after auth: ${retryResult.statusCode}`)
      }
      this.processSdp(retryResult.body)
    } else if (describeResult.statusCode === 200) {
      this.processSdp(describeResult.body)
    } else {
      throw new Error(`DESCRIBE failed: ${describeResult.statusCode}`)
    }

    if (!this.videoTrack) {
      throw new Error('No supported video track in SDP')
    }

    // Step 3: SETUP video track
    this.state = 'setup-video'
    const videoControlUrl = resolveTrackUrl(
      this.url,
      this.parsedSdp?.sessionControl ?? null,
      this.videoTrack.control,
    )

    const videoSetupResult = await this.sendRequest('SETUP', videoControlUrl, {
      Transport: `RTP/AVP/TCP;unicast;interleaved=${this.videoRtpChannel}-${this.videoRtcpChannel}`,
    })

    if (videoSetupResult.statusCode !== 200) {
      throw new Error(`SETUP video failed: ${videoSetupResult.statusCode}`)
    }

    // Extract session ID from first SETUP response
    const sessionHeader = videoSetupResult.headers.get('session')
    if (sessionHeader) {
      // Session header may contain timeout: "12345678;timeout=60"
      this.sessionId = sessionHeader.split(';')[0]!.trim()
    }

    // Step 4: SETUP audio track (optional)
    if (this.audioTrack) {
      this.state = 'setup-audio'
      const audioControlUrl = resolveTrackUrl(
        this.url,
        this.parsedSdp?.sessionControl ?? null,
        this.audioTrack.control,
      )

      const audioSetupResult = await this.sendRequest('SETUP', audioControlUrl, {
        Transport: `RTP/AVP/TCP;unicast;interleaved=${this.audioRtpChannel}-${this.audioRtcpChannel}`,
      })

      if (audioSetupResult.statusCode !== 200) {
        this.logger?.warn('SETUP audio failed — continuing without audio', {
          meta: { statusCode: audioSetupResult.statusCode },
        })
        this.audioTrack = null
      }
    }

    // Step 5: PLAY
    this.state = 'play'
    const playResult = await this.sendRequest('PLAY', this.url, {
      Range: 'npt=0.000-',
    })

    if (playResult.statusCode !== 200) {
      throw new Error(`PLAY failed: ${playResult.statusCode}`)
    }

    this.state = 'streaming'
    this.logger?.info('RTSP streaming', { meta: { host: this.host, port: this.port } })

    // Start keepalive
    this.keepaliveTimer = setInterval(() => {
      this.sendKeepalive().catch((err) => {
        this.logger?.warn('Keepalive failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, this.keepaliveIntervalMs)

    this.callbacks.onPlaying?.()
  }

  private processSdp(sdpText: string): void {
    this.rawSdpText = sdpText
    this.parsedSdp = parseSdp(sdpText)
    this.videoTrack = extractVideoTrack(this.parsedSdp)
    this.audioTrack = extractAudioTrack(this.parsedSdp)

    if (this.videoTrack) {
      this.callbacks.onVideoTrack?.(this.videoTrack, sdpText)
      this.logger?.info('Video track', {
        meta: {
          codec: this.videoTrack.codec,
          payloadType: this.videoTrack.payloadType,
          clockRate: this.videoTrack.clockRate,
        },
      })
    }

    if (this.audioTrack) {
      this.callbacks.onAudioTrack?.(this.audioTrack)
      this.logger?.info('Audio track', {
        meta: {
          codec: this.audioTrack.codec,
          payloadType: this.audioTrack.payloadType,
          clockRate: this.audioTrack.clockRate,
        },
      })
    }
  }

  // ── TCP Data Handling ─────────────────────────────────────────────

  /**
   * Process incoming TCP data. RTSP TCP interleaved transport mixes:
   * - RTSP text responses (e.g. "RTSP/1.0 200 OK\r\n...")
   * - Interleaved binary frames ($channel + 2-byte length + payload)
   */
  private onData(chunk: Buffer): void {
    this.readBuffer = this.readBuffer.length > 0 ? Buffer.concat([this.readBuffer, chunk]) : chunk

    while (this.readBuffer.length > 0) {
      if (this.readBuffer[0] === INTERLEAVED_MAGIC) {
        // Binary interleaved frame: $ + channel(1) + length(2) + payload
        if (this.readBuffer.length < 4) return // Need more data

        const channel = this.readBuffer[1]!
        const length = this.readBuffer.readUInt16BE(2)

        if (this.readBuffer.length < 4 + length) return // Need more data

        // Cut OWNED, not as a pooled view: the broker retains every video packet
        // (pre-buffer ring, keyframe cache), so a pooled cut was copied again
        // downstream to own it — `owned-buffer.ts`, `copyOwned`.
        const payload = this.allocatePacket(this.readBuffer, 4, 4 + length)
        this.readBuffer = this.readBuffer.subarray(4 + length)

        this.handleInterleavedPacket(channel, payload)
      } else {
        // RTSP text response
        const headerEnd = this.readBuffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return // Need more data

        const headerText = this.readBuffer.subarray(0, headerEnd).toString('ascii')
        let bodyStart = headerEnd + 4

        // Check for Content-Length
        const clMatch = headerText.match(/Content-Length:\s*(\d+)/i)
        const contentLength = clMatch ? parseInt(clMatch[1]!, 10) : 0

        if (this.readBuffer.length < bodyStart + contentLength) return // Need more data

        const body =
          contentLength > 0
            ? this.readBuffer.subarray(bodyStart, bodyStart + contentLength).toString('utf-8')
            : ''

        this.readBuffer = this.readBuffer.subarray(bodyStart + contentLength)

        this.handleRtspResponse(headerText, body)
      }
    }
  }

  private handleInterleavedPacket(channel: number, payload: Buffer): void {
    if (channel === this.videoRtpChannel) {
      this.callbacks.onVideoRtp?.(payload, channel)
    } else if (channel === this.audioRtpChannel) {
      this.callbacks.onAudioRtp?.(payload, channel)
    }
    // RTCP channels (odd) are silently ignored for now
  }

  private handleRtspResponse(headerText: string, body: string): void {
    const lines = headerText.split('\r\n')
    const statusLine = lines[0] ?? ''
    const statusMatch = statusLine.match(/RTSP\/1\.\d\s+(\d+)/)
    const statusCode = statusMatch ? parseInt(statusMatch[1]!, 10) : 0

    const headers = new Map<string, string>()
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i]!.indexOf(':')
      if (colonIdx < 0) continue
      const key = lines[i]!.substring(0, colonIdx).trim().toLowerCase()
      const value = lines[i]!.substring(colonIdx + 1).trim()
      headers.set(key, value)
    }

    if (this.pendingResponse) {
      const handler = this.pendingResponse
      this.pendingResponse = null
      handler(statusCode, headers, body)
    }
  }

  // ── RTSP Request Building ─────────────────────────────────────────

  private sendRequest(
    method: string,
    uri: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ statusCode: number; headers: ReadonlyMap<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Socket not connected'))
        return
      }

      this.cseq++
      const headers: Record<string, string> = {
        CSeq: String(this.cseq),
        'User-Agent': 'camstack-rtsp-client',
        ...extraHeaders,
      }

      if (this.sessionId) {
        headers['Session'] = this.sessionId
      }

      // Add authentication header
      const authHeader = this.buildAuthHeader(method, uri)
      if (authHeader) {
        headers['Authorization'] = authHeader
      }

      let request = `${method} ${uri} RTSP/1.0\r\n`
      for (const [key, value] of Object.entries(headers)) {
        request += `${key}: ${value}\r\n`
      }
      request += '\r\n'

      this.pendingResponse = (statusCode, responseHeaders, body) => {
        resolve({ statusCode, headers: responseHeaders, body })
      }

      // Timeout for response
      const timeout = setTimeout(() => {
        if (this.pendingResponse) {
          this.pendingResponse = null
          reject(new Error(`RTSP ${method} response timeout`))
        }
      }, this.connectTimeoutMs)

      const originalResolve = this.pendingResponse
      this.pendingResponse = (statusCode, responseHeaders, body) => {
        clearTimeout(timeout)
        originalResolve(statusCode, responseHeaders, body)
      }

      this.socket.write(request)
    })
  }

  private async sendKeepalive(): Promise<void> {
    if (this.state !== 'streaming' || !this.socket) return
    await this.sendRequest('GET_PARAMETER', this.url)
  }

  // ── Authentication ────────────────────────────────────────────────

  private parseAuthChallenge(headers: ReadonlyMap<string, string>): void {
    const wwwAuth = headers.get('www-authenticate')
    if (!wwwAuth) return

    if (wwwAuth.toLowerCase().startsWith('digest')) {
      this.authMethod = 'digest'
      const realm = extractQuoted(wwwAuth, 'realm') ?? ''
      const nonce = extractQuoted(wwwAuth, 'nonce') ?? ''
      const qop = extractQuoted(wwwAuth, 'qop')
      const opaque = extractQuoted(wwwAuth, 'opaque')
      this.digestChallenge = { realm, nonce, qop, opaque }
      this.digestNc = 0
    } else if (wwwAuth.toLowerCase().startsWith('basic')) {
      this.authMethod = 'basic'
    }
  }

  private buildAuthHeader(method: string, uri: string): string | null {
    if (!this.username && !this.password) return null

    if (this.authMethod === 'basic') {
      const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64')
      return `Basic ${encoded}`
    }

    if (this.authMethod === 'digest' && this.digestChallenge) {
      return this.buildDigestAuth(method, uri)
    }

    // First request — try Basic (some cameras accept it without 401)
    if (this.username || this.password) {
      const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64')
      return `Basic ${encoded}`
    }

    return null
  }

  private buildDigestAuth(method: string, uri: string): string {
    const { realm, nonce, qop, opaque } = this.digestChallenge!
    const ha1 = md5(`${this.username}:${realm}:${this.password}`)

    let response: string
    let authParams: string

    if (qop === 'auth' || qop?.includes('auth')) {
      this.digestNc++
      const nc = this.digestNc.toString(16).padStart(8, '0')
      const cnonce = randomUUID().replace(/-/g, '').slice(0, 16)
      const ha2 = md5(`${method}:${uri}`)
      response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
      authParams = `username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`
    } else {
      const ha2 = md5(`${method}:${uri}`)
      response = md5(`${ha1}:${nonce}:${ha2}`)
      authParams = `username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
    }

    if (opaque) {
      authParams += `, opaque="${opaque}"`
    }

    return `Digest ${authParams}`
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  private cleanup(): void {
    this.state = 'closed'

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }

    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* already closed */
      }
      this.socket = null
    }

    this.pendingResponse = null
  }
}

// ── Utilities ───────────────────────────────────────────────────────

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

function extractQuoted(header: string, key: string): string | undefined {
  // Match key="value" or key=value
  const regex = new RegExp(`${key}="([^"]*)"`, 'i')
  const match = header.match(regex)
  if (match) return match[1]

  // Try unquoted
  const unquotedRegex = new RegExp(`${key}=([^,\\s]+)`, 'i')
  const unquotedMatch = header.match(unquotedRegex)
  return unquotedMatch?.[1]
}
