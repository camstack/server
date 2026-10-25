import * as net from 'node:net'
import { randomBytes } from 'node:crypto'
import { parseRestreamPath, sdpVariantFor, type RestreamSdpVariant } from './restream-intent.js'
import { RtspSession } from './rtsp-session.js'
import { RtspRestreamer } from './rtsp-restreamer.js'
import type { BrokerConsumerAttribution, IScopedLogger } from '@camstack/types'

/**
 * Attribution of the synthetic consumer a {@link BrokerWarmUp} subscribes:
 * the RTSP listen server holding a cold broker open for a DESCRIBE. Named
 * after that real consumer — it used to subscribe with no attribution and
 * surfaced as `unknown` (45 attach/detach pairs per 5 min on the hub).
 */
export const RTSP_DESCRIBE_WARMUP_ATTRIBUTION: BrokerConsumerAttribution = {
  kind: 'rtsp-listen',
  label: 'describe-warmup',
  media: 'both',
}

/**
 * Closure that wakes the broker (subscribes a synthetic consumer to its
 * encoded-data fan-out, which trips `checkDemand` → upstream dial) and
 * returns a teardown handle. Released by the listen server when the RTSP
 * session ends, so the broker can idle-tear-down normally when no real
 * consumers remain. Without this, an RTSP client doing DESCRIBE on a
 * cold broker gets back a 200 with empty SDP (broker never dialed
 * because nothing subscribed) — `ffprobe`, recording sidecars, and any
 * external RTSP integration are effectively broken until something else
 * happens to be actively consuming the broker.
 */
export type BrokerWarmUp = () => () => void

/**
 * Closure that opens the broker's SENTRY picture window and returns a
 * teardown handle. The sentry counterpart of {@link BrokerWarmUp}, and its
 * opposite in effect: the warm-up subscribes demand, which dials — and on a
 * battery camera a dial is a wake, which D173 forbids. This one only makes the
 * picture flow, so the DESCRIBE has an SDP to answer with.
 */
export type BrokerPrestreamOpener = () => () => void

/** How long a DESCRIBE waits for the broker to dial upstream and parse the SDP. */
export const SDP_WAIT_MS = 3000

/** The numeric device id a broker id (`<deviceId>/<stream>`) belongs to, or undefined. */
function deviceIdOfBroker(brokerId: string | undefined): number | undefined {
  const head = Number((brokerId ?? '').split('/')[0])
  return Number.isInteger(head) ? head : undefined
}

/**
 * Single TCP server for all RTSP restream connections.
 * Routes clients to the correct RtspRestreamer by a random token path
 * (not the predictable brokerId) for security.
 */
export class RtspListenServer {
  private server: net.Server | null = null
  private port = 0
  /** token → restreamer */
  private readonly restreamers = new Map<string, RtspRestreamer>()
  /** brokerId → token (for lookup/regeneration) */
  private readonly brokerTokens = new Map<string, string>()
  /** token → brokerId (reverse map) */
  private readonly tokenBrokers = new Map<string, string>()
  /**
   * brokerId → INTERNAL loopback-only alias token (D870). A camera whose
   * external restream token is held in an unreadable keychain has NO external
   * URL, but the broker's own consumers (recording, decode, snapshots, grid,
   * egress) still ride its restream: they get this ephemeral token, which is
   * never persisted, never handed out through the consumer URL APIs, and only
   * answers loopback / local-network peers.
   */
  private readonly internalAliases = new Map<string, string>()
  private readonly internalAliasTokens = new Set<string>()
  /** Which peers may dial an internal alias; replaceable for tests. */
  private aliasPeerPolicy: (address: string | undefined) => boolean = isClusterLocalAddress
  /** brokerId → enabled (default true) */
  private readonly brokerEnabled = new Map<string, boolean>()
  /** brokerId → warm-up closure registered alongside the restreamer */
  private readonly brokerWarmUps = new Map<string, BrokerWarmUp>()
  /** brokerId → sentry picture-window opener */
  private readonly brokerPrestreamOpeners = new Map<string, BrokerPrestreamOpener>()

  private logger: IScopedLogger | null = null
  private sdpWaitMs = SDP_WAIT_MS

  /** Shorten the DESCRIBE SDP wait (tests only). */
  setSdpWaitMs(ms: number): void {
    this.sdpWaitMs = ms
  }

  /** The logger the refusal branches write to; absent in unit specs that do not care. */
  setLogger(logger: IScopedLogger): void {
    this.logger = logger
  }

  /** Generate a random token for a stream path */
  static generateToken(): string {
    return randomBytes(16).toString('hex')
  }

  /**
   * Register a restreamer with a token.
   * If token is provided, use it (restored from persistence).
   * If not, generate a new one.
   * Returns the token used.
   */
  registerRestreamer(
    brokerId: string,
    restreamer: RtspRestreamer,
    warmUp?: BrokerWarmUp,
    existingToken?: string,
    sentryOpener?: BrokerPrestreamOpener,
  ): string {
    // Unregister old token if broker is being re-registered
    const oldToken = this.brokerTokens.get(brokerId)
    if (oldToken) {
      this.restreamers.delete(oldToken)
      this.tokenBrokers.delete(oldToken)
    }

    const token = existingToken ?? RtspListenServer.generateToken()
    this.restreamers.set(token, restreamer)
    this.brokerTokens.set(brokerId, token)
    this.tokenBrokers.set(token, brokerId)
    if (warmUp) this.brokerWarmUps.set(brokerId, warmUp)
    if (sentryOpener) this.brokerPrestreamOpeners.set(brokerId, sentryOpener)
    return token
  }

  /**
   * Register (or refresh) the internal loopback-only alias of a broker. Returns
   * its token. The external token map is untouched, so the alias can never be
   * listed, persisted or surfaced as a consumer URL.
   */
  registerInternalAlias(
    brokerId: string,
    restreamer: RtspRestreamer,
    warmUp?: BrokerWarmUp,
    sentryOpener?: BrokerPrestreamOpener,
  ): string {
    const existing = this.internalAliases.get(brokerId)
    const token = existing ?? RtspListenServer.generateToken()
    this.restreamers.set(token, restreamer)
    this.tokenBrokers.set(token, brokerId)
    this.internalAliases.set(brokerId, token)
    this.internalAliasTokens.add(token)
    if (warmUp) this.brokerWarmUps.set(brokerId, warmUp)
    if (sentryOpener) this.brokerPrestreamOpeners.set(brokerId, sentryOpener)
    return token
  }

  /** Replace the peer policy of the internal aliases (tests only). */
  setAliasPeerPolicy(policy: (address: string | undefined) => boolean): void {
    this.aliasPeerPolicy = policy
  }

  /** The token an IN-PROCESS consumer dials: the internal alias when there is one, else the external token. */
  getInternalToken(brokerId: string): string | undefined {
    return this.internalAliases.get(brokerId) ?? this.brokerTokens.get(brokerId)
  }

  unregisterRestreamer(brokerId: string): void {
    const alias = this.internalAliases.get(brokerId)
    if (alias !== undefined) {
      this.restreamers.delete(alias)
      this.tokenBrokers.delete(alias)
      this.internalAliasTokens.delete(alias)
      this.internalAliases.delete(brokerId)
    }
    const token = this.brokerTokens.get(brokerId)
    if (token) {
      this.restreamers.delete(token)
      this.tokenBrokers.delete(token)
    }
    this.brokerTokens.delete(brokerId)
    this.brokerWarmUps.delete(brokerId)
    this.brokerPrestreamOpeners.delete(brokerId)
  }

  /** Regenerate a random token for a broker. Returns the new token. */
  regenerateToken(brokerId: string): string | null {
    const oldToken = this.brokerTokens.get(brokerId)
    if (!oldToken) return null

    const restreamer = this.restreamers.get(oldToken)
    if (!restreamer) return null

    // Remove old
    this.restreamers.delete(oldToken)
    this.tokenBrokers.delete(oldToken)

    // Create new
    const newToken = RtspListenServer.generateToken()
    this.restreamers.set(newToken, restreamer)
    this.brokerTokens.set(brokerId, newToken)
    this.tokenBrokers.set(newToken, brokerId)
    // The internal alias rotates with it, so a regenerated token leaves no old URL alive.
    const alias = this.internalAliases.get(brokerId)
    if (alias !== undefined) {
      this.restreamers.delete(alias)
      this.tokenBrokers.delete(alias)
      this.internalAliasTokens.delete(alias)
      const newAlias = RtspListenServer.generateToken()
      this.restreamers.set(newAlias, restreamer)
      this.tokenBrokers.set(newAlias, brokerId)
      this.internalAliases.set(brokerId, newAlias)
      this.internalAliasTokens.add(newAlias)
    }
    return newToken
  }

  /** Get the current token for a broker. */
  getToken(brokerId: string): string | undefined {
    return this.brokerTokens.get(brokerId)
  }

  /** Get all broker → token mappings. */
  getAllTokens(): ReadonlyMap<string, string> {
    return this.brokerTokens
  }

  /** Set the enabled state for a broker's restream. Default is true. */
  setEnabled(brokerId: string, enabled: boolean): void {
    this.brokerEnabled.set(brokerId, enabled)
  }

  /** Check if a broker's restream is enabled. Default true. */
  isEnabled(brokerId: string): boolean {
    return this.brokerEnabled.get(brokerId) ?? true
  }

  /** Get all broker → enabled mappings (only stores explicit overrides). */
  getAllEnabled(): ReadonlyMap<string, boolean> {
    return this.brokerEnabled
  }

  /** Load persisted enabled states (called at boot). */
  loadEnabled(states: ReadonlyMap<string, boolean>): void {
    for (const [k, v] of states) {
      this.brokerEnabled.set(k, v)
    }
  }

  getPort(): number {
    return this.port
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket))
      this.server.on('error', reject)
      this.server.listen(port, () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      this.server = null
    })
  }

  private handleConnection(socket: net.Socket): void {
    let requestBuffer = ''

    const onData = (chunk: Buffer) => {
      requestBuffer += chunk.toString('ascii')

      // Wait for first complete RTSP request to determine the stream
      const endIdx = requestBuffer.indexOf('\r\n\r\n')
      if (endIdx < 0) return

      socket.removeListener('data', onData)
      void this.dispatch(socket, requestBuffer)
    }

    socket.on('data', onData)
    socket.on('error', () => {})
  }

  /**
   * Async dispatch path for the first complete RTSP request. Resolves the
   * restreamer, wakes the broker via its `warmUp` closure, awaits the SDP
   * (broker only populates `restreamer.sdp` after dialing the upstream and
   * parsing `onVideoTrack`), and then hands the socket off to a
   * `RtspSession`. The warm-up handle stays alive for the entire socket
   * lifetime so `checkDemand` on the broker keeps the dial up; we release
   * it on `close` / `error`. Without this hop, `DESCRIBE` would race the
   * cold broker and return 200 with empty SDP.
   */
  private async dispatch(socket: net.Socket, requestBuffer: string): Promise<void> {
    // Parse the URI from the first line to determine stream path
    const firstLine = requestBuffer.split('\r\n')[0] ?? ''
    const uriMatch = firstLine.match(/\s(rtsp:\/\/[^\s]+)\s/)
    const uri = uriMatch ? uriMatch[1]! : ''

    // Extract token path: rtsp://host:port/{token} → {token}
    const pathMatch = uri.match(/rtsp:\/\/[^/]+(\/.*?)(?:\s|$)/)
    const streamPath = pathMatch
      ? pathMatch[1]!.replace(/^\//, '').replace(/\/trackID=\d+$/, '')
      : ''

    // Split the token from its suffixes: `/muted` (audio-free),
    // `/muted-detection` (audio-free AND exempt from the live-edge join
    // withhold), `/sentry` (the picture, WITH the camera's audio track — D525)
    // and the trailing `/preroll-<ms>` this dial asks for — see
    // `restream-intent.ts`. A path that names no amount asked for none.
    const parsed = parseRestreamPath(streamPath)
    const { lookupPath, muted: isMuted, declaration } = parsed
    // WHICH SDP this dial is answered with, decided once and read by both the
    // wait below and the answer after it. A sentry is neither variant the two
    // older suffixes use: it takes the picture's video plus the audio track
    // that picture is accompanied by.
    const sdpVariant: RestreamSdpVariant = sdpVariantFor(parsed)

    const restreamer = this.restreamers.get(lookupPath)
    if (!restreamer) {
      socket.write(`RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n`)
      socket.destroy()
      return
    }
    // An internal alias answers the loopback interface and the local network
    // (a recorder on an agent dials the hub through `getStreamWithCodec`), never a
    // public address.
    if (this.internalAliasTokens.has(lookupPath) && !this.aliasPeerPolicy(socket.remoteAddress)) {
      socket.write(`RTSP/1.0 403 Forbidden\r\nCSeq: 1\r\n\r\n`)
      socket.destroy()
      return
    }

    // Check if restream is enabled for this broker
    const brokerId = this.tokenBrokers.get(lookupPath)
    if (brokerId && !this.isEnabled(brokerId)) {
      socket.write(`RTSP/1.0 403 Forbidden\r\nCSeq: 1\r\n\r\n`)
      socket.destroy()
      return
    }

    // Acquire the broker warm-up consumer for the DESCRIBE window ONLY.
    // At DESCRIBE no RTSP session exists yet (`getSessionCount() == 0`), so a
    // cold broker would answer with an empty SDP — the worst RTSP failure.
    // The warm-up holds demand just long enough to dial + parse the SDP; once
    // `addSession` runs below, the session ITSELF is the demand
    // (`getSessionCount() > 0` → `checkDemand`), so we release the warm-up
    // there and it never lingers as a phantom encoded subscriber for the PLAY
    // phase. Socket close/error before a session is ever added still releases
    // it (e.g. an ffprobe that DESCRIBEs then drops).
    //
    // EXCEPT for a sentry dial, which is defined as asking for the stream
    // WITHOUT asking for the camera (`SENTRY_PATH_SUFFIX`). The warm-up is
    // demand, and demand dials: on a battery camera that dial is a wake, which
    // D173 forbids the system to perform on its own behalf. Measured on device
    // 640 (2026-09-15): VLC on the sentry URL spent 11.1 s waking the
    // camera, delivered 5 s of video, then the broker suspended under it —
    // because the session that caused the wake is, correctly, not intent.
    // A sentry DESCRIBE is answered from whatever SDP exists; the picture
    // itself is the sentry pump's job, and the pump never dials.
    const sentryDial = declaration.intent === 'sentry'
    const warmUp = brokerId && !sentryDial ? this.brokerWarmUps.get(brokerId) : undefined
    // A sentry gets the PICTURE window instead, and it is opened HERE rather
    // than at `addSession` because the SDP below is read first: a window that
    // waits for the session hands the consumer an empty SDP and it quits.
    const opener = brokerId && sentryDial ? this.brokerPrestreamOpeners.get(brokerId) : undefined
    const releaseWarmUp = warmUp ? warmUp() : (opener?.() ?? null)
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      try {
        releaseWarmUp?.()
      } catch {
        /* swallow — listener teardown */
      }
    }
    socket.once('close', releaseOnce)
    socket.once('error', releaseOnce)

    // Wait briefly for the broker to dial upstream and parse the SDP. Bounded:
    // a dead upstream camera must not hang the connection forever. When the
    // bound passes with NO SDP the dial is REFUSED (503), never answered 200
    // with an empty body: a client that gets `200` + empty SDP cannot tell it
    // from a stream (ffmpeg: "Invalid data found", exit 183) and a recorder
    // charged that to its restart-storm window. A 503 names a source that is
    // not serving right now, which is what it is.
    const sdpReady = await this.waitForSdp(restreamer, sdpVariant, this.sdpWaitMs)
    const sdp = restreamer.getSdpFor(sdpVariant) ?? restreamer.getSdp() ?? ''
    if (!sdpReady || sdp.length === 0) {
      releaseOnce()
      this.logger?.warn('RTSP DESCRIBE refused: no SDP after the wait', {
        tags: { deviceId: deviceIdOfBroker(brokerId) },
        meta: { brokerId, waitedMs: this.sdpWaitMs, variant: sdpVariant },
      })
      socket.write(`RTSP/1.0 503 Service Unavailable\r\nCSeq: 1\r\n\r\n`)
      socket.destroy()
      return
    }
    const session = new RtspSession(
      socket,
      sdp,
      () => {
        restreamer.removeSession(session.getSessionId())
        releaseOnce()
      },
      isMuted,
      declaration,
    )
    restreamer.addSession(session)

    // The session now holds demand (`getSessionCount() > 0`) — drop the
    // DESCRIBE-window warm-up so it doesn't double as a phantom encoded
    // subscriber for the whole PLAY phase. The session's own close handler
    // (and the socket close/error handlers) keep `releaseOnce` idempotent.
    releaseOnce()

    // Re-inject the buffered data so the session processes the first request
    socket.unshift(Buffer.from(requestBuffer, 'ascii'))
  }

  /**
   * Poll the restreamer's SDP cache every 50 ms up to `timeoutMs`. The
   * cache is populated by the broker's `onVideoTrack` callback once the
   * RTSP DESCRIBE/SETUP/PLAY against the upstream camera completes — for
   * a cold broker that's typically ~200-1000 ms. Resolves `true` if the
   * SDP becomes non-empty within the budget, `false` on timeout.
   */
  private async waitForSdp(
    restreamer: RtspRestreamer,
    variant: RestreamSdpVariant,
    timeoutMs: number,
  ): Promise<boolean> {
    const start = Date.now()
    const have = (): boolean => {
      const s = restreamer.getSdpFor(variant) ?? restreamer.getSdp()
      return !!s && s.length > 0
    }
    if (have()) return true
    return new Promise<boolean>((resolve) => {
      const interval = setInterval(() => {
        if (have()) {
          clearInterval(interval)
          resolve(true)
          return
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval)
          resolve(false)
        }
      }, 50)
    })
  }
}

/**
 * Is the peer on the loopback interface or the local network (RFC 1918, link-local,
 * ULA)? The internal alias answers only these: a recorder or decoder on another
 * node of the cluster is a legitimate consumer, the public internet is not.
 */
export function isClusterLocalAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
  if (v4 === '::1') return true
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4)
  if (m !== null) {
    const a = Number(m[1])
    const b = Number(m[2])
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // CGNAT / Tailscale 100.64.0.0/10
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  const lower = address.toLowerCase()
  return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
}
