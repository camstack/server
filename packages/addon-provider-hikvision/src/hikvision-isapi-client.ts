import {
  type ClientRequest,
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { buildAuthHeader, type DigestState, parseChallenge } from './digest-auth.js'
import { hikvisionIgnoredAlarmReason } from './hikvision-alarm-ignore.js'
import { createAlarmTypeTally } from './hikvision-alarm-tally.js'
import {
  parseStreamingChannelSummaries,
  readStreamingChannelEnabled,
} from './hikvision-snapshot-channel.js'
import { patchStreamAudioEnabled, readStreamAudioEnabled } from './hikvision-stream-audio.js'

/**
 * Hikvision cameras serve self-signed TLS by default. Reusing one
 * keep-alive agent per (scheme, rejectUnauthorized) pair reduces
 * connection churn for the alarm-stream + snapshot polls. The agents
 * are stateless and shared across all `HikvisionIsapiClient` instances.
 */
const httpAgent = new HttpAgent({ keepAlive: true })
const httpsAgent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: false })

export interface HikvisionIsapiOptions {
  readonly host: string
  readonly port: number
  readonly https: boolean
  readonly username: string
  readonly password: string
  /** Per-request default timeout (ms) — applies to everything except
   *  the long-poll alarm stream, which is unbounded. */
  readonly defaultTimeoutMs?: number
}

export interface HikvisionDeviceInfo {
  readonly deviceName: string | null
  readonly deviceType: string | null
  readonly model: string | null
  readonly serialNumber: string | null
  readonly firmwareVersion: string | null
  readonly firmwareReleasedDate: string | null
  /** Hikvision-specific build label (`firmwareVersionInfo` —
   *  e.g. `B-R-G5-0`). Optional in firmware ≤ V5.5. */
  readonly firmwareVersionInfo: string | null
  /** ISAPI `<hardwareVersion>` field — typically `0x0` on consumer units. */
  readonly hardwareVersion: string | null
  /** Raw deviceInfo XML payload. Useful for diagnostic dumps. */
  readonly raw: string
}

/** Host network interface info (`/ISAPI/System/Network/interfaces/1`).
 *  Hikvision exposes one interface per physical NIC (cameras are
 *  typically single-NIC); the first interface is canonical. */
export interface HikvisionNetworkInterfaceInfo {
  readonly mac: string | null
  readonly ip: string | null
  readonly subnetMask: string | null
  readonly defaultGateway: string | null
  readonly addressingType: string | null
  readonly speed: string | null
  readonly mtu: string | null
}

/**
 * Single TwoWayAudio channel descriptor as returned by
 * `/ISAPI/System/TwoWayAudio/channels`. Hikvision firmware ships a
 * subset of these per camera: typically channel `1` with µ-law or
 * A-law as `audioCompressionType`, sometimes G.722.1 / AAC on newer
 * firmware (we only act on G.711 today; anything else is surfaced as
 * the raw string so callers can decide whether to fall back to the
 * default codec).
 */
export interface HikvisionTwoWayAudioChannel {
  /** Channel id Hikvision uses in subsequent open/audioData/close URLs.
   *  Almost always `'1'` for single-cam devices. */
  readonly id: string
  /** Wire codec — `G.711ulaw` / `G.711alaw` typical. Null when the
   *  firmware response omitted the field (older builds). */
  readonly audioCompressionType: string | null
  /** Negotiated source sample rate (Hz). Null when not advertised. */
  readonly audioInputType?: string | null
  /** The channel's `<enabled>` flag. A camera reporting `false` here is
   *  a prime suspect for "intercom deactivates immediately" — the open
   *  arms it but the camera refuses to accept audioData. Null when the
   *  firmware omits the tag (older builds default to enabled). */
  readonly enabled?: boolean | null
}

/**
 * Why the sticky audioData PUT ended. Lets the session classify the
 * teardown precisely:
 *   - `local-end`       we called `end()` (normal operator stop)
 *   - `camera-response` the camera sent its HTTP response / closed the
 *                       connection while we still had the body open — a
 *                       PRIME suspect for "intercom deactivates right
 *                       after activating"
 *   - `socket-error`    the underlying socket errored mid-stream
 */
export type AudioDataCloseCause = 'local-end' | 'camera-response' | 'socket-error'

/** Delivered to `AudioDataStream.onClosed` when the PUT lifecycle ends. */
export interface AudioDataCloseInfo {
  readonly cause: AudioDataCloseCause
  /** HTTP status when the camera responded (null for socket errors). */
  readonly statusCode: number | null
  /** Underlying error for `socket-error` / non-2xx responses. */
  readonly error?: Error
}

/**
 * Handle returned by `openAudioDataStream`. Implements a minimal write/
 * end pair on the long-running PUT body. The `responsePromise` resolves
 * with the camera's HTTP response when the body ends (or rejects with
 * the underlying socket error). All methods are idempotent.
 */
export interface AudioDataStream {
  /** Push more raw codec bytes (e.g. G.711 µ-law) onto the wire. */
  write(buf: Buffer): boolean
  /** Close the request body. The PUT then finishes and the camera
   *  finalises the talk session — pair with `closeTwoWayAudio` for the
   *  channel-side teardown. */
  end(): void
  /** Subscribe to the PUT lifecycle end. Fires exactly once with the
   *  resolved {@link AudioDataCloseInfo}. Lets the session distinguish a
   *  camera-side close (`remote-closed-put`) from a socket error
   *  (`put-error`) from a normal local end. */
  onClosed(cb: (info: AudioDataCloseInfo) => void): void
  /** Resolves with the camera's response when the PUT completes;
   *  rejects on socket error. Awaited by `stop()` for clean teardown. */
  readonly responsePromise: Promise<IncomingMessage>
}

export interface HikvisionStreamingChannel {
  /** Channel id as Hikvision encodes it: `101`, `102`, `201`, ... */
  readonly id: string
  /** Logical camera number derived from the channel id (`101` → 1). */
  readonly cameraNumber: number
  /** Stream slot (`1` = main, `2` = sub, `3` = third). */
  readonly streamSlot: number
  readonly enabled: boolean
  readonly codec: string | null
  readonly width: number | null
  readonly height: number | null
  readonly maxBitrateKbps: number | null
}

/**
 * Minimal HTTP client for Hikvision ISAPI. Wraps Node's built-in
 * `fetch` with HTTP Digest Auth retry, keep-alive agent reuse, and
 * convenience methods for the endpoints the camstack provider needs:
 * deviceInfo (probe), snapshot, channel discovery, alarm stream.
 *
 * Stateful: caches the last digest challenge per realm so we issue one
 * auth round-trip per session instead of per request.
 */
export class HikvisionIsapiClient {
  private readonly opts: HikvisionIsapiOptions
  private readonly logger: IScopedLogger | null
  private readonly digest: DigestState = { nc: 0 }
  private readonly defaultTimeoutMs: number

  constructor(opts: HikvisionIsapiOptions, logger?: IScopedLogger) {
    this.opts = opts
    this.logger = logger ?? null
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000
  }

  /**
   * Resolve `https://host:port` (or `http://`) — the absolute origin
   * for every ISAPI URL. No path here.
   */
  get baseUrl(): string {
    const scheme = this.opts.https ? 'https' : 'http'
    return `${scheme}://${this.opts.host}:${this.opts.port}`
  }

  /**
   * Issue a single ISAPI request. Does the digest dance: first attempt
   * carries the cached challenge if any; on `401` we parse the new
   * challenge, retry once, and surface the second response (or its
   * error) to the caller.
   *
   * `init.signal` is honoured for cancellation. The `timeoutMs` knob is
   * a convenience over wiring an `AbortController` per call site —
   * pass `null` to disable the timeout (used by the alarm long-poll).
   */
  async request(
    uri: string,
    init: RequestInit & { timeoutMs?: number | null } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${uri}`
    const method = (init.method ?? 'GET').toUpperCase()
    const agent = this.opts.https ? httpsAgent : httpAgent

    const wrapInit = (authHeader: string | null): RequestInit => {
      const headers = new Headers(init.headers ?? {})
      if (authHeader) headers.set('Authorization', authHeader)
      // Node fetch passes `dispatcher` via undici, but the global
      // `fetch` in Node 22 also accepts the legacy `agent` option via
      // the typed request init when present. We thread it through as
      // an opaque property so the keep-alive agent kicks in.
      const out: RequestInit & { agent?: HttpAgent | HttpsAgent } = {
        ...init,
        method,
        headers,
        agent,
      }
      return out
    }

    const cachedAuth = buildAuthHeader({
      state: this.digest,
      method,
      uri,
      username: this.opts.username,
      password: this.opts.password,
    })

    // First attempt — with cached challenge if any.
    const ctrl = init.timeoutMs === null ? null : new AbortController()
    const timer =
      ctrl && init.timeoutMs !== null
        ? setTimeout(
            () =>
              ctrl.abort(
                new Error(
                  `ISAPI request timeout after ${init.timeoutMs ?? this.defaultTimeoutMs}ms: ${uri}`,
                ),
              ),
            init.timeoutMs ?? this.defaultTimeoutMs,
          )
        : null
    const signal = init.signal ?? ctrl?.signal
    let res: Response
    try {
      res = await fetch(url, { ...wrapInit(cachedAuth), ...(signal ? { signal } : {}) })
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (res.status !== 401) return res

    // Refresh challenge from the 401 and retry exactly once.
    // Hikvision routinely cycles nonces every few minutes — that's
    // expected, not an error.
    const challenge = parseChallenge(res.headers.get('www-authenticate'))
    if (!challenge) {
      this.logger?.warn('hikvision-isapi: 401 without valid Digest challenge', { meta: { uri } })
      return res
    }
    this.digest.challenge = challenge
    this.digest.nc = 0

    // Drain the 401 body so the keep-alive socket is reusable.
    try {
      await res.body?.cancel()
    } catch {
      /* swallow */
    }

    const retryAuth = buildAuthHeader({
      state: this.digest,
      method,
      uri,
      username: this.opts.username,
      password: this.opts.password,
    })
    const ctrl2 = init.timeoutMs === null ? null : new AbortController()
    const timer2 =
      ctrl2 && init.timeoutMs !== null
        ? setTimeout(
            () =>
              ctrl2.abort(
                new Error(
                  `ISAPI request timeout after ${init.timeoutMs ?? this.defaultTimeoutMs}ms: ${uri}`,
                ),
              ),
            init.timeoutMs ?? this.defaultTimeoutMs,
          )
        : null
    const signal2 = init.signal ?? ctrl2?.signal
    try {
      return await fetch(url, { ...wrapInit(retryAuth), ...(signal2 ? { signal: signal2 } : {}) })
    } finally {
      if (timer2) clearTimeout(timer2)
    }
  }

  /** GET text body (XML or plain). Throws on non-2xx. */
  async getText(uri: string, opts?: { timeoutMs?: number | null }): Promise<string> {
    const res = await this.request(uri, {
      method: 'GET',
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (!res.ok) throw new Error(`hikvision-isapi GET ${uri} → HTTP ${res.status}`)
    return res.text()
  }

  /** GET binary body. Throws on non-2xx. */
  async getBuffer(uri: string, opts?: { timeoutMs?: number | null }): Promise<Buffer> {
    const res = await this.request(uri, {
      method: 'GET',
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (!res.ok) throw new Error(`hikvision-isapi GET ${uri} → HTTP ${res.status}`)
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  }

  /**
   * POST an XML body. Throws on non-2xx. Returns the response text.
   *
   * The vendor's READ verb for search: `ContentMgmt/search` takes a
   * `CMSearchDescription` and answers a `CMSearchResult`, and it changes
   * nothing on the camera — a POST here is a query with a body, not a write.
   */
  async postXml(
    uri: string,
    xmlBody: string,
    opts?: { timeoutMs?: number | null },
  ): Promise<string> {
    const res = await this.request(uri, {
      method: 'POST',
      body: xmlBody,
      headers: { 'Content-Type': 'application/xml' },
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (!res.ok) throw new Error(`hikvision-isapi POST ${uri} → HTTP ${res.status}`)
    return res.text()
  }

  /** PUT XML body. Throws on non-2xx. Returns response text (often a
   *  ResponseStatus envelope). */
  async putXml(
    uri: string,
    xmlBody: string,
    opts?: { timeoutMs?: number | null },
  ): Promise<string> {
    const res = await this.request(uri, {
      method: 'PUT',
      body: xmlBody,
      headers: { 'Content-Type': 'application/xml' },
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
    if (!res.ok) throw new Error(`hikvision-isapi PUT ${uri} → HTTP ${res.status}`)
    return res.text()
  }

  // ── Convenience endpoint wrappers ──────────────────────────────

  /**
   * `/ISAPI/System/deviceInfo` — primary probe. Every Hikvision
   * camera/NVR responds; the absence of this endpoint is what we use
   * to negative-rule a host out as Hikvision.
   */
  async getDeviceInfo(): Promise<HikvisionDeviceInfo> {
    const xml = await this.getText('/ISAPI/System/deviceInfo')
    return {
      deviceName: extractTag(xml, 'deviceName'),
      deviceType: extractTag(xml, 'deviceType'),
      model: extractTag(xml, 'model'),
      serialNumber: extractTag(xml, 'serialNumber'),
      firmwareVersion: extractTag(xml, 'firmwareVersion'),
      firmwareReleasedDate: extractTag(xml, 'firmwareReleasedDate'),
      firmwareVersionInfo: extractTag(xml, 'firmwareVersionInfo'),
      hardwareVersion: extractTag(xml, 'hardwareVersion'),
      raw: xml,
    }
  }

  /**
   * `/ISAPI/System/Network/interfaces/1` — host network interface info.
   * Hikvision cameras are single-NIC; interface id `1` is canonical.
   * Returns `null` for fields the firmware doesn't expose.
   *
   * Used by the addon's autodetect path to populate the durable MAC
   * identifier in `deviceCache.mac` BEFORE `generateStableId` runs, so
   * re-adding the same camera by IP lands on the same persisted row
   * even after a DHCP renewal. Mirrors Reolink's `getNetworkInfo`.
   */
  async getNetworkInterfaceInfo(interfaceId = '1'): Promise<HikvisionNetworkInterfaceInfo> {
    const xml = await this.getText(`/ISAPI/System/Network/interfaces/${interfaceId}`)
    // Hikvision wraps the addressing block in `<IPAddress>` (capital
    // I+A) — the inner host-IP tag is `<ipAddress>` (lowercase). The
    // generic case-insensitive `extractTag` would match the OUTER
    // wrapper first (returning the inner XML as the captured content,
    // which surfaced as raw XML in the Hardware sub-tab). Carve up the
    // document explicitly so each tag is matched in the right scope.
    //
    // The lowercase `<ipAddress>` ALSO appears inside `<DefaultGateway>`
    // — strip that sub-block before extracting the host IP so we don't
    // accidentally return the gateway address as the device's IP.
    const ipBlockMatch = /<IPAddress[^>]*>([\s\S]*?)<\/IPAddress>/.exec(xml)
    const ipBlock = ipBlockMatch ? ipBlockMatch[1]! : ''
    const gatewayBlockMatch = /<DefaultGateway[^>]*>([\s\S]*?)<\/DefaultGateway>/.exec(ipBlock)
    const gatewayBlock = gatewayBlockMatch ? gatewayBlockMatch[1]! : ''
    const ipBlockNoGateway = ipBlock.replace(/<DefaultGateway[^>]*>[\s\S]*?<\/DefaultGateway>/, '')

    // Case-sensitive matchers — the wire payload uses precise casing
    // (`ipAddress`, `subnetMask`, `addressingType`, `MACAddress`,
    // `MTU`); accepting case variants would re-introduce the outer/
    // inner tag-name collision.
    const matchTag = (source: string, tag: string): string | null => {
      const re = new RegExp(`<${tag}>([^<]*)<\\/${tag}>`)
      const m = re.exec(source)
      return m ? m[1]!.trim() || null : null
    }

    const linkBlockMatch = /<Link[^>]*>([\s\S]*?)<\/Link>/.exec(xml)
    const linkBlock = linkBlockMatch ? linkBlockMatch[1]! : xml

    return {
      mac: matchTag(linkBlock, 'MACAddress'),
      ip: matchTag(ipBlockNoGateway, 'ipAddress'),
      subnetMask: matchTag(ipBlockNoGateway, 'subnetMask'),
      defaultGateway: gatewayBlock ? matchTag(gatewayBlock, 'ipAddress') : null,
      addressingType: matchTag(ipBlockNoGateway, 'addressingType'),
      speed: matchTag(linkBlock, 'speed'),
      mtu: matchTag(linkBlock, 'MTU'),
    }
  }

  /**
   * `/ISAPI/System/reboot` — schedule a firmware reboot. Returns once
   * the camera has ACKed (it stays connected just long enough to
   * confirm; the actual reboot happens shortly after).
   */
  async reboot(): Promise<void> {
    await this.putXml('/ISAPI/System/reboot', '')
  }

  /**
   * `/ISAPI/Streaming/channels/{id}/picture?snapShotImageType=JPEG`
   * — single-shot JPEG capture. Channel id format is `{cam}{slot}`
   * (e.g. `101` = camera 1 main stream).
   */
  async getSnapshot(channelId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.request(
      `/ISAPI/Streaming/channels/${channelId}/picture?snapShotImageType=JPEG`,
      {
        method: 'GET',
        timeoutMs: 15_000,
      },
    )
    if (!res.ok) throw new Error(`hikvision snapshot ch=${channelId} → HTTP ${res.status}`)
    // Hikvision firmware ships `Content-Type: image/jpeg; charset="UTF-8"`
    // for binary JPEG bytes — strip every header parameter so consumers
    // can build a valid `data:<mime>;base64,...` URI.
    const rawCt = res.headers.get('content-type') ?? 'image/jpeg'
    const contentType = rawCt.split(';', 1)[0]!.trim() || 'image/jpeg'
    const ab = await res.arrayBuffer()
    return { buffer: Buffer.from(ab), contentType }
  }

  /**
   * `/ISAPI/Streaming/channels` — enumerate every (camera, stream
   * slot) pair the device exposes. Multi-channel NVRs return one entry
   * per channel × per slot. Older firmwares (DS-7600 series) lack this
   * endpoint and return 404; callers should fall back to a synthetic
   * `{cam}01`/`{cam}02` derivation in that case.
   */
  async listChannels(): Promise<readonly HikvisionStreamingChannel[]> {
    const xml = await this.getText('/ISAPI/Streaming/channels')
    return parseChannelsList(xml)
  }

  // ── Two-way audio (intercom) ──────────────────────────────────────
  //
  // Hikvision exposes a sticky-PUT intercom pattern at
  // `/ISAPI/System/TwoWayAudio/channels/{id}`:
  //   1. GET `/channels`             → discover negotiated codec
  //   2. PUT `/channels/{id}/open`   → arm the channel
  //   3. long-running PUT `/audioData` with chunked codec body
  //   4. PUT `/channels/{id}/close`  → release the channel

  async listTwoWayAudioChannels(): Promise<readonly HikvisionTwoWayAudioChannel[]> {
    const xml = await this.getText('/ISAPI/System/TwoWayAudio/channels', { timeoutMs: 5_000 })
    return parseTwoWayAudioChannels(xml)
  }

  /**
   * `/ISAPI/System/TwoWayAudio/channels/{id}/capabilities` — read the
   * audio channel's supported set (codec list, input types, speaker
   * volume range, noise-reduction flag). Used to build the operator-
   * facing selects without hard-coding firmware-specific options. The
   * call returns `null` for cameras that don't expose two-way audio.
   */
  async getAudioCapabilities(channelId: string): Promise<HikvisionAudioCapabilities | null> {
    try {
      const xml = await this.getText(`/ISAPI/System/TwoWayAudio/channels/${channelId}/capabilities`)
      return parseAudioCapabilities(xml)
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/System/TwoWayAudio/channels/{id}` — read the current audio
   * channel configuration (active codec, speaker volume, noise
   * reduction, input type). Returns `null` when the camera doesn't
   * advertise the channel at all.
   */
  async getAudioSettings(channelId: string): Promise<HikvisionAudioSettings | null> {
    try {
      const xml = await this.getText(`/ISAPI/System/TwoWayAudio/channels/${channelId}`)
      return parseAudioSettings(xml)
    } catch {
      return null
    }
  }

  /**
   * Patch audio channel settings. Read-modify-write against the
   * camera's current XML so unknown fields (chip-specific tuning we
   * don't surface) are preserved verbatim. Drops keys not in the patch.
   */
  async setAudioSettings(
    channelId: string,
    patch: {
      audioCompressionType?: string
      speakerVolume?: number
      noiseReduction?: boolean
      audioInputType?: string
    },
  ): Promise<void> {
    const url = `/ISAPI/System/TwoWayAudio/channels/${channelId}`
    const current = await this.getText(url)
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.audioCompressionType !== undefined) {
      patches.push({ tag: 'audioCompressionType', value: escapeXml(patch.audioCompressionType) })
    }
    if (patch.speakerVolume !== undefined) {
      patches.push({
        tag: 'speakerVolume',
        value: String(Math.max(0, Math.min(100, Math.round(patch.speakerVolume)))),
      })
    }
    if (patch.noiseReduction !== undefined) {
      patches.push({ tag: 'noisereduce', value: patch.noiseReduction ? 'true' : 'false' })
    }
    if (patch.audioInputType !== undefined) {
      patches.push({ tag: 'audioInputType', value: escapeXml(patch.audioInputType) })
    }
    if (patches.length === 0) return
    const next = applyOverlayFieldPatches(current, patches)
    await this.putXml(url, next)
  }

  async openTwoWayAudio(channelId: string): Promise<void> {
    const res = await this.request(`/ISAPI/System/TwoWayAudio/channels/${channelId}/open`, {
      method: 'PUT',
      timeoutMs: 5_000,
    })
    if (!res.ok) {
      throw new Error(`hikvision two-way-audio open ch=${channelId} → HTTP ${res.status}`)
    }
    try {
      await res.body?.cancel()
    } catch {
      /* swallow */
    }
  }

  async closeTwoWayAudio(channelId: string): Promise<void> {
    const res = await this.request(`/ISAPI/System/TwoWayAudio/channels/${channelId}/close`, {
      method: 'PUT',
      timeoutMs: 5_000,
    })
    if (!res.ok) {
      throw new Error(`hikvision two-way-audio close ch=${channelId} → HTTP ${res.status}`)
    }
    try {
      await res.body?.cancel()
    } catch {
      /* swallow */
    }
  }

  /**
   * Open the long-running `audioData` PUT. Returns a write/end pair
   * the caller pumps codec bytes into until they're done, then calls
   * `end()` + `closeTwoWayAudio` to release the channel.
   *
   * Why we drop down to `node:http` here:
   *   - The `fetch` API in Node 22 supports a `ReadableStream` body
   *     with `duplex:'half'`, but it buffers writes internally — fine
   *     for general POSTs, lousy for low-latency audio (we want each
   *     write to flush onto the wire immediately).
   *   - We need to know when the camera ACKs / drops the connection
   *     mid-stream so the orchestrator can abort the talk session;
   *     `req.on('response')` + `req.on('error')` plumb that directly.
   *
   * Digest auth: relies on the cached challenge from the prior
   * `openTwoWayAudio()` call. If that succeeded the digest state is
   * primed, so the streaming PUT goes through on the first try. If
   * not, the camera 401s on this request and the caller should retry.
   */
  openAudioDataStream(channelId: string): AudioDataStream {
    const uri = `/ISAPI/System/TwoWayAudio/channels/${channelId}/audioData`
    const auth = buildAuthHeader({
      state: this.digest,
      method: 'PUT',
      uri,
      username: this.opts.username,
      password: this.opts.password,
    })
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      // Lying `Content-Length: 0` is what Hikvision firmware expects
      // for sticky two-way-audio — the body is read until the socket
      // closes regardless.
      'Content-Length': '0',
    }
    if (auth) headers['Authorization'] = auth

    const requestFn = this.opts.https ? httpsRequest : httpRequest
    const agent = this.opts.https ? httpsAgent : httpAgent
    const req: ClientRequest = requestFn({
      host: this.opts.host,
      port: this.opts.port,
      path: uri,
      method: 'PUT',
      headers,
      agent,
      ...(this.opts.https ? { rejectUnauthorized: false } : {}),
    })

    this.logger?.info('hikvision audioData PUT opening', {
      meta: { channelId, uri },
    })

    // Single-shot close notification. The camera responding (or the
    // socket erroring) while we still have the body open is the prime
    // suspect for "intercom deactivates immediately"; `localEnd` flips
    // true when WE close the body so a subsequent response reads as a
    // normal `local-end` rather than a camera-initiated drop.
    let localEnd = false
    let closeNotified = false
    const closeListeners: Array<(info: AudioDataCloseInfo) => void> = []
    const notifyClosed = (info: AudioDataCloseInfo): void => {
      if (closeNotified) return
      closeNotified = true
      const level = info.cause === 'socket-error' ? 'error' : 'info'
      this.logger?.[level]('hikvision audioData PUT ended', {
        meta: {
          channelId,
          cause: info.cause,
          statusCode: info.statusCode,
          ...(info.error ? { error: info.error.message } : {}),
        },
      })
      for (const cb of closeListeners) {
        try {
          cb(info)
        } catch {
          /* swallow — diagnostic listener */
        }
      }
    }

    // The audioData PUT is a STICKY long-running upload: the camera sends
    // its response headers (200 OK) almost immediately as an ACK while
    // keeping the request body open indefinitely for the µ-law stream. The
    // ACTUAL close happens on socket teardown (we end() the body, or the
    // camera/network drops). Await the response body to fully end (= TCP
    // close, since the response carries no Content-Length / chunked
    // terminator). A previous impl here mis-classified the 200 ACK headers
    // as a camera-initiated close → teared down after ~1-2s with
    // `remote-closed-put` even though the camera was happy → intercom was
    // effectively muted.
    let observedStatusCode: number | null = null
    const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
      req.once('response', (res) => {
        // Drain so Node processes the response stream (otherwise the socket
        // can stall waiting for us to read). We don't tear down here — this
        // is the ACK; final close is on req 'close' below.
        res.resume()
        observedStatusCode = res.statusCode ?? null
        const contentType = res.headers['content-type'] ?? null
        this.logger?.info('hikvision audioData PUT response (ack)', {
          meta: { channelId, statusCode: observedStatusCode, contentType },
        })
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          // 2xx ACK — body stays open. Resolve the promise so callers can
          // inspect the response shape, but DO NOT notifyClosed.
          resolve(res)
        } else {
          // Non-2xx is a genuine camera-side rejection → close now.
          const err = new Error(`hikvision audioData ch=${channelId} → HTTP ${res.statusCode}`)
          notifyClosed({
            cause: 'camera-response',
            statusCode: observedStatusCode,
            error: err,
          })
          reject(err)
        }
      })
      req.once('error', (err) => {
        notifyClosed({
          cause: 'socket-error',
          statusCode: observedStatusCode,
          error: err,
        })
        reject(err)
      })
      // The decisive close signal: req 'close' fires once the underlying
      // socket is fully torn down. If we called end() first (localEnd=true)
      // it's a normal operator stop; otherwise the camera or network dropped
      // the sticky PUT mid-stream → genuine `remote-closed-put`.
      req.once('close', () => {
        notifyClosed({
          cause: localEnd ? 'local-end' : 'camera-response',
          statusCode: observedStatusCode,
        })
      })
    })

    let ended = false
    return {
      write(buf: Buffer): boolean {
        if (ended) return false
        return req.write(buf)
      },
      end(): void {
        if (ended) return
        ended = true
        localEnd = true
        try {
          req.end()
        } catch {
          /* swallow — already ended */
        }
      },
      onClosed(cb: (info: AudioDataCloseInfo) => void): void {
        if (closeNotified) return
        closeListeners.push(cb)
      },
      responsePromise,
    }
  }

  // ── PTZ ──────────────────────────────────────────────────────────
  //
  // Hikvision exposes PTZ at `/ISAPI/PTZCtrl/channels/{cam}/...`. The
  // capabilities endpoint reveals which axes the camera supports
  // (some are pan-only, some pan+tilt, fewer have zoom). All commands
  // address one camera channel — substream slot does not matter for
  // PTZ, only the parent camera number.

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/capabilities` — query supported
   * pan/tilt/zoom ranges. Returns `null` when the cam doesn't have
   * PTZ at all (404 / no `<PTZChanelCap>` block in the response).
   */
  async getPtzCapabilities(cameraNumber: number): Promise<HikvisionPtzCapabilities | null> {
    try {
      const xml = await this.getText(`/ISAPI/PTZCtrl/channels/${cameraNumber}/capabilities`)
      return parsePtzCapabilities(xml)
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/continuous` — start (or stop, with
   * zero-magnitude) a continuous PTZ move. Hikvision's speed range is
   * -100..+100 per axis; a zero-magnitude payload halts the active
   * motion (no separate /stop endpoint exists). Speed magnitude
   * controls direction + rate; the camera applies its own
   * acceleration profile.
   */
  async ptzContinuous(
    cameraNumber: number,
    command: { pan?: number; tilt?: number; zoom?: number },
  ): Promise<void> {
    const pan = clampSpeed(command.pan ?? 0)
    const tilt = clampSpeed(command.tilt ?? 0)
    const zoom = clampSpeed(command.zoom ?? 0)
    const xml = `<?xml version="1.0" encoding="UTF-8"?><PTZData><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`
    await this.putXml(`/ISAPI/PTZCtrl/channels/${cameraNumber}/continuous`, xml)
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/presets` — list configured presets.
   * Each preset has a numeric `id`, an optional `presetName`, and
   * `enabled` flag — disabled presets are omitted from the result.
   */
  async listPtzPresets(cameraNumber: number): Promise<readonly HikvisionPtzPreset[]> {
    try {
      const xml = await this.getText(`/ISAPI/PTZCtrl/channels/${cameraNumber}/presets`)
      return parsePtzPresets(xml)
    } catch {
      return []
    }
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/presets/{id}/goto` — move the
   * camera to a stored preset. The numeric id matches what
   * `listPtzPresets` returns; out-of-range / disabled ids return
   * HTTP 4xx and surface as a thrown error here.
   */
  async ptzGoToPreset(cameraNumber: number, presetId: string): Promise<void> {
    await this.putXml(`/ISAPI/PTZCtrl/channels/${cameraNumber}/presets/${presetId}/goto`, '')
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/presets/{id}` (PUT) — save the
   * camera's CURRENT head position under `presetId`. There's no
   * "capture current position" payload field: PUT-ing a `<PTZPreset>`
   * with the target id atomically snapshots wherever the head is now.
   * The body schema mirrors what `parsePtzPresets` reads back —
   * `<id>` + `<presetName>` inside `<PTZPreset>`.
   */
  async savePtzPreset(cameraNumber: number, presetId: string, name: string): Promise<void> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><PTZPreset xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0"><id>${escapeXml(presetId)}</id><presetName>${escapeXml(name)}</presetName></PTZPreset>`
    await this.putXml(`/ISAPI/PTZCtrl/channels/${cameraNumber}/presets/${presetId}`, xml)
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/presets/{id}` (DELETE) — remove a
   * stored preset. Unknown / out-of-range ids return HTTP 4xx and
   * surface as a thrown error here.
   */
  async deletePtzPreset(cameraNumber: number, presetId: string): Promise<void> {
    const uri = `/ISAPI/PTZCtrl/channels/${cameraNumber}/presets/${presetId}`
    const res = await this.request(uri, { method: 'DELETE' })
    if (!res.ok) throw new Error(`hikvision-isapi DELETE ${uri} → HTTP ${res.status}`)
    // Drain the body so the keep-alive socket is reusable.
    try {
      await res.body?.cancel()
    } catch {
      /* swallow */
    }
  }

  // ── Supplemental light ────────────────────────────────────────────
  //
  // White-light spotlight (some Hikvision models include it as part
  // of the ColorVu lineup). Modes vary by model — we surface only
  // the on/off + brightness axis here; mode-switching is left to the
  // device's settings UI for advanced configuration.

  /**
   * `/ISAPI/Image/channels/{cam}/supplementLight/capabilities` —
   * enumerate supported light modes + brightness ranges. Returns
   * `null` when the camera doesn't have a supplemental light at all.
   */
  async getSupplementLightCapabilities(
    cameraNumber: number,
  ): Promise<HikvisionLightCapabilities | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/Image/channels/${cameraNumber}/supplementLight/capabilities`,
      )
      const modes = parseSupplementLightModes(xml)
      if (modes.length === 0) return null
      return { modes, raw: xml }
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/Image/channels/{cam}/supplementLight` — read current
   * light state (mode, brightness). `mode === 'close'` means the
   * light is off; any non-`close` mode is the "on" state.
   */
  async getSupplementLight(cameraNumber: number): Promise<HikvisionLightState | null> {
    try {
      const xml = await this.getText(`/ISAPI/Image/channels/${cameraNumber}/supplementLight`)
      return parseSupplementLightState(xml)
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/Image/channels/{cam}/supplementLight` — patch the light
   * config. Read-modify-write so we don't clobber sibling fields the
   * caller didn't explicitly touch (e.g. `mixedLightBrightnessRegulatMode`
   * stays `auto` when only `mode` is patched).
   *
   * - `mode`: `irLight` / `whiteLight` / `colorVuWhiteLight` / `manual` /
   *           `close` — depends on the camera's advertised modes.
   * - `whiteLightBrightness` / `irLightBrightness`: 0..100 sliders, only
   *   honoured by firmware when the matching mode is active.
   * - `brightnessRegulatorMode`: `auto` / `manual` — most ColorVu / IR
   *   models support this knob to drive brightness off the camera-side
   *   light sensor (`auto`) or pin to the operator-set brightness
   *   (`manual`).
   */
  async setSupplementLight(
    cameraNumber: number,
    patch: {
      mode?: string
      whiteLightBrightness?: number
      irLightBrightness?: number
      brightnessRegulatorMode?: 'auto' | 'manual'
    },
  ): Promise<void> {
    const url = `/ISAPI/Image/channels/${cameraNumber}/supplementLight`
    const current = await this.getText(url)
    const clamp = (v: number): string => String(Math.max(0, Math.min(100, Math.round(v))))
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.mode !== undefined) patches.push({ tag: 'supplementLightMode', value: patch.mode })
    if (patch.whiteLightBrightness !== undefined)
      patches.push({ tag: 'whiteLightBrightness', value: clamp(patch.whiteLightBrightness) })
    if (patch.irLightBrightness !== undefined)
      patches.push({ tag: 'irLightBrightness', value: clamp(patch.irLightBrightness) })
    if (patch.brightnessRegulatorMode !== undefined) {
      patches.push({ tag: 'mixedLightBrightnessRegulatMode', value: patch.brightnessRegulatorMode })
    }
    if (patches.length === 0) return
    const next = applyOverlayFieldPatches(current, patches)
    await this.putXml(url, next)
  }

  // ── Alarm output / siren (GPIO-triggered) ─────────────────────────
  //
  // Hikvision routes the on-camera siren via the same alarm-input
  // mechanism used by external sensors. The actual audible/visual
  // response (siren tone, strobe) is configured at the camera-side
  // "Linkage Method" — this API only flips the input state, the
  // camera fires the linkage. Capability detection: the
  // `/System/IO/inputs` endpoint enumerates available alarm input
  // ports; a non-empty list means the camera has at least one wired
  // input we can flip.

  /**
   * `/ISAPI/System/IO/inputs` — enumerate alarm input ports. Returns
   * `null` when the camera has no alarm IO at all (404 or empty list).
   */
  async getAlarmInputs(): Promise<readonly HikvisionAlarmInput[] | null> {
    try {
      const xml = await this.getText('/ISAPI/System/IO/inputs')
      const inputs = parseAlarmInputs(xml)
      return inputs.length > 0 ? inputs : null
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/System/IO/inputs/{port}` — toggle the alarm input. `on=true`
   * fires the linkage configured at the camera; `on=false` releases it.
   * The port number defaults to 1 (the most common GPIO slot for the
   * built-in siren) but can be overridden when the camera has multiple
   * inputs.
   */
  async setAlarmInput(on: boolean, port = 1): Promise<void> {
    const enabled = on ? 'true' : 'false'
    const triggering = on ? 'low' : 'high'
    const xml = `<?xml version="1.0" encoding="UTF-8"?><IOPortData><enabled>${enabled}</enabled><triggering>${triggering}</triggering></IOPortData>`
    await this.putXml(`/ISAPI/System/IO/inputs/${port}`, xml)
  }

  // ── System time / NTP ─────────────────────────────────────────────
  //
  // Hikvision splits time-sync across two endpoints:
  //   `/ISAPI/System/time`            → mode (`NTP`/`manual`) + timeZone
  //   `/ISAPI/System/time/ntpServers` → NTP server list (one per id)
  // The NTP list endpoint is absent on older / NVR-channel firmwares;
  // every read here is best-effort and degrades to null NTP fields.

  /**
   * Read the camera's time configuration. Always returns the
   * `/System/time` part; the NTP fields fall back to `null` when the
   * `/ntpServers` endpoint 404s. We only surface server id `1` — the
   * canonical slot Hikvision firmware allocates first.
   */
  async getTimeConfig(): Promise<HikvisionTimeConfig> {
    const timeXml = await this.getText('/ISAPI/System/time')
    // Firmware emits `NTP`, `manual`, `localtime`, `SDK` — anything
    // other than `NTP` is treated as an operator-managed clock.
    const rawMode = (extractTag(timeXml, 'timeMode') ?? 'manual').toLowerCase()
    const timeMode: HikvisionTimeConfig['timeMode'] = rawMode === 'ntp' ? 'NTP' : 'manual'
    const timeZone = extractTag(timeXml, 'timeZone') ?? ''
    // The camera's current displayed wall-clock (zoned ISO-8601). Absent on
    // some NTP-mode firmwares — degrades to null.
    const localTime = extractTag(timeXml, 'localTime') ?? null

    let ntpServer: string | null = null
    let ntpPort: number | null = null
    let syncInterval: number | null = null
    try {
      const ntpXml = await this.getText('/ISAPI/System/time/ntpServers')
      // One `<NTPServer>` block per configured slot — read the first.
      const block = extractAllBlocks(ntpXml, 'NTPServer')[0] ?? null
      if (block !== null) {
        const scoped = `<x>${block}</x>`
        // `addressingFormatType` decides which host tag carries the
        // value: `ipaddress` → `<ipAddress>`, `hostname` → `<hostName>`.
        ntpServer = extractTag(scoped, 'ipAddress') ?? extractTag(scoped, 'hostName')
        ntpPort = parseIntSafe(extractTag(scoped, 'portNo'))
        syncInterval = parseIntSafe(extractTag(scoped, 'synchronizeInterval'))
      }
    } catch {
      // No `/ntpServers` endpoint on this firmware — leave NTP nulls.
    }

    return { timeMode, timeZone, localTime, ntpServer, ntpPort, syncInterval }
  }

  /**
   * Patch the camera's time configuration. Read-modify-write against
   * both endpoints so the opaque `timeZone` string and any chip-
   * specific sibling fields survive untouched:
   *   - `timeMode` → PUT `/System/time` (timeZone preserved verbatim).
   *   - `ntpServer`/`ntpPort`/`syncInterval` → PUT
   *     `/System/time/ntpServers/1`.
   * Each endpoint is written only when the patch touches one of its
   * fields, so a mode-only change never round-trips the NTP list.
   */
  async setTimeConfig(patch: {
    timeMode?: 'NTP' | 'manual'
    timeZone?: string
    ntpServer?: string
    ntpPort?: number
    syncInterval?: number
  }): Promise<void> {
    if (patch.timeMode !== undefined || patch.timeZone !== undefined) {
      const url = '/ISAPI/System/time'
      const current = await this.getText(url)
      const patches: Array<{ tag: string; value: string }> = []
      if (patch.timeMode !== undefined) {
        patches.push({ tag: 'timeMode', value: escapeXml(patch.timeMode) })
      }
      // When a timezone is supplied we WRITE it (POSIX-style string,
      // see `ianaToHikvisionTimeZone`); otherwise `<timeZone>` is left
      // untouched and survives the read-modify-write verbatim.
      if (patch.timeZone !== undefined) {
        patches.push({ tag: 'timeZone', value: escapeXml(patch.timeZone) })
      }
      const next = applyOverlayFieldPatches(current, patches)
      await this.putXml(url, next)
    }

    const touchesNtp =
      patch.ntpServer !== undefined ||
      patch.ntpPort !== undefined ||
      patch.syncInterval !== undefined
    if (touchesNtp) {
      const url = '/ISAPI/System/time/ntpServers/1'
      let current: string
      try {
        current = await this.getText(url)
      } catch {
        // A camera that has never had NTP server 1 configured 404s on
        // the GET — start from a minimal skeleton so the PUT can
        // populate it rather than failing the whole save.
        current =
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<NTPServer version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">' +
          '<id>1</id><addressingFormatType>ipaddress</addressingFormatType>' +
          '<ipAddress></ipAddress><portNo>123</portNo>' +
          '<synchronizeInterval>1440</synchronizeInterval></NTPServer>'
      }
      const patches: Array<{ tag: string; value: string }> = []
      if (patch.ntpServer !== undefined) {
        // Hikvision keys the host on `addressingFormatType`: a literal
        // IPv4 goes in `<ipAddress>`, anything else in `<hostName>`.
        const server = patch.ntpServer.trim()
        const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(server)
        const hostTag = isIp ? 'ipAddress' : 'hostName'
        patches.push({ tag: 'addressingFormatType', value: isIp ? 'ipaddress' : 'hostname' })
        // The camera ships only the host tag matching its CURRENT
        // addressingFormatType — when switching IP↔hostname the target
        // tag may be absent, so splice an empty one in before patching.
        if (!new RegExp(`<(?:[a-zA-Z0-9]+:)?${hostTag}[^>]*>`, 'i').test(current)) {
          current = current.replace(/(<\/addressingFormatType>)/i, `$1<${hostTag}></${hostTag}>`)
        }
        patches.push({ tag: hostTag, value: escapeXml(server) })
      }
      if (patch.ntpPort !== undefined) {
        patches.push({
          tag: 'portNo',
          value: String(Math.max(1, Math.min(65535, Math.round(patch.ntpPort)))),
        })
      }
      if (patch.syncInterval !== undefined) {
        patches.push({
          tag: 'synchronizeInterval',
          value: String(Math.max(1, Math.min(10080, Math.round(patch.syncInterval)))),
        })
      }
      const next = applyOverlayFieldPatches(current, patches)
      await this.putXml(url, next)
    }
  }

  /**
   * Set the camera's manual clock. Switches `/System/time` to
   * `manual` mode and writes the supplied `<localTime>` while preserving
   * the existing `<timeZone>` verbatim (read-modify-write, same pattern
   * as `setTimeConfig`).
   *
   * `localTime` is an ISO-8601 timestamp WITH a zone designator
   * (`2026-06-11T14:32:00+02:00` or `…Z`) — Hikvision firmware rejects a
   * naked local string. Callers use {@link formatHikvisionLocalTime} for
   * the sync-now path (UTC `Z`) or append `:00` + the local offset for an
   * operator-entered `datetime-local` value.
   *
   * `<localTime>` is absent on a camera currently in NTP mode, so when
   * the read-modify-write can't find the tag we splice a fresh one in
   * before patching (mirrors `setTimeConfig`'s missing-host-tag handling).
   */
  async setLocalTime(localTime: string): Promise<void> {
    const url = '/ISAPI/System/time'
    let current = await this.getText(url)
    // `<localTime>` may be missing (camera in NTP mode) — inject an empty
    // one right after `<timeMode>` so the overlay patch has a tag to fill.
    if (!/<(?:[a-zA-Z0-9]+:)?localTime[^>]*>/i.test(current)) {
      current = current.replace(/(<\/(?:[a-zA-Z0-9]+:)?timeMode>)/i, '$1<localTime></localTime>')
    }
    const next = applyOverlayFieldPatches(current, [
      { tag: 'timeMode', value: 'manual' },
      { tag: 'localTime', value: escapeXml(localTime) },
    ])
    await this.putXml(url, next)
  }

  // ── Smart Tracking (autotrack) ────────────────────────────────────
  //
  // Hikvision exposes the on-camera autotrack subsystem as
  // `/ISAPI/PTZCtrl/channels/{cam}/smartTracking`. The shape varies
  // by firmware: the bare `<SmartTracking><enabled/></SmartTracking>`
  // is universal; some firmwares add a `<duration>` (seconds the
  // camera keeps tracking after the target stops moving) and a few
  // expose `<smartTrackingType>` (auto / human / vehicle), but neither
  // is guaranteed.

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/smartTrackingCapabilities` — probe
   * for autotrack support. Returns `null` when the camera doesn't
   * advertise the feature (404 / empty response). Used at boot to
   * decide whether to register the `ptz-autotrack` cap.
   */
  async getSmartTrackingCapabilities(
    cameraNumber: number,
  ): Promise<HikvisionSmartTrackingCapabilities | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/PTZCtrl/channels/${cameraNumber}/smartTrackingCapabilities`,
      )
      if (!xml || xml.length === 0) return null
      const supportsDuration =
        /<duration[^>]*opt|<duration[^>]*<min|<duration>\s*\d+\s*<\/duration>/i.test(xml)
      const supportsType = /smartTrackingType/i.test(xml)
      return { supportsDuration, supportsType, raw: xml }
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/smartTracking` — read current
   * state. Returns `null` when unsupported. The `enabled` value is
   * the canonical on/off; `duration` and `trackingType` are
   * model-dependent.
   */
  async getSmartTracking(cameraNumber: number): Promise<HikvisionSmartTrackingState | null> {
    try {
      const xml = await this.getText(`/ISAPI/PTZCtrl/channels/${cameraNumber}/smartTracking`)
      const enabledTag = /<enabled>(true|false)<\/enabled>/i.exec(xml)
      const enabledStr = enabledTag?.[1]
      if (!enabledStr) return null
      const durationStr = /<duration>\s*(\d+)\s*<\/duration>/i.exec(xml)?.[1]
      const typeStr = /<smartTrackingType>([^<]+)<\/smartTrackingType>/i.exec(xml)?.[1]
      return {
        enabled: enabledStr.toLowerCase() === 'true',
        duration: durationStr !== undefined ? Number.parseInt(durationStr, 10) : null,
        trackingType: typeStr ?? null,
      }
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/PTZCtrl/channels/{cam}/smartTracking` — set autotrack on/off
   * + optional duration / type. Empty `trackingType` and `null` `duration`
   * are omitted from the payload (the camera keeps its current value).
   */
  async setSmartTracking(
    cameraNumber: number,
    params: { enabled: boolean; duration?: number; trackingType?: string },
  ): Promise<void> {
    const lines: string[] = [`<enabled>${params.enabled ? 'true' : 'false'}</enabled>`]
    if (params.duration !== undefined && Number.isFinite(params.duration)) {
      lines.push(`<duration>${Math.max(0, Math.round(params.duration))}</duration>`)
    }
    if (params.trackingType !== undefined && params.trackingType.length > 0) {
      lines.push(`<smartTrackingType>${params.trackingType}</smartTrackingType>`)
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><SmartTracking>${lines.join('')}</SmartTracking>`
    await this.putXml(`/ISAPI/PTZCtrl/channels/${cameraNumber}/smartTracking`, xml)
  }

  // ── OSD / Video overlays ──────────────────────────────────────────
  //
  // Hikvision exposes three kinds of overlay under the channel's
  // `/overlays` endpoint:
  //
  //   - `dateTimeOverlay`     — single firmware-rendered timestamp
  //                              (text is generated, not editable)
  //   - `channelNameOverlay`  — single text line bound to the camera's
  //                              `deviceName`; we expose enable only
  //   - `text/{id}`           — up to 4-8 free-text overlays the
  //                              operator can edit
  //
  // Each has a per-element PUT endpoint that accepts only the relevant
  // sub-tree, so updates don't risk clobbering the rest of the config.
  // The cap layer (`osd`) projects these uniformly as `OsdOverlay` items.

  /**
   * `/ISAPI/System/Video/inputs/channels/{cam}/overlays` — read the
   * full overlay config in one shot. The cap router uses this to build
   * an `OsdOverlay[]` snapshot per camera. Returns `null` when the
   * camera doesn't expose overlays at all (404).
   */
  async getOverlayConfig(cameraNumber: number): Promise<HikvisionOverlayConfig | null> {
    try {
      const xml = await this.getText(`/ISAPI/System/Video/inputs/channels/${cameraNumber}/overlays`)
      return parseOverlayConfig(xml)
    } catch {
      return null
    }
  }

  /**
   * Patch a single text overlay (`/overlays/text/{id}`). Read-modify-
   * write: GETs the current XML, splices in the patched fields, and
   * PUTs the result back so we don't lose firmware-managed siblings
   * (positionX/Y, isPersistentText). `enabled` flips the visibility;
   * `text` rewrites `<displayText>` (Hikvision auto-trims leading/
   * trailing whitespace).
   */
  async setTextOverlay(
    cameraNumber: number,
    id: string,
    patch: { enabled?: boolean; text?: string },
  ): Promise<void> {
    const url = `/ISAPI/System/Video/inputs/channels/${cameraNumber}/overlays/text/${id}`
    const current = await this.getText(url)
    const next = applyOverlayFieldPatches(current, [
      ...(patch.enabled !== undefined
        ? [{ tag: 'enabled', value: patch.enabled ? 'true' : 'false' }]
        : []),
      ...(patch.text !== undefined ? [{ tag: 'displayText', value: escapeXml(patch.text) }] : []),
    ])
    await this.putXml(url, next)
  }

  /**
   * Patch the channel-name overlay (`/overlays/channelNameOverlay`).
   * Operator can only flip the `enabled` field — the displayed text
   * tracks the camera's `deviceName` and is owned by the camera-side
   * settings, not the overlay endpoint.
   */
  async setChannelNameOverlay(cameraNumber: number, patch: { enabled?: boolean }): Promise<void> {
    if (patch.enabled === undefined) return
    const url = `/ISAPI/System/Video/inputs/channels/${cameraNumber}/overlays/channelNameOverlay`
    const current = await this.getText(url)
    const next = applyOverlayFieldPatches(current, [
      { tag: 'enabled', value: patch.enabled ? 'true' : 'false' },
    ])
    await this.putXml(url, next)
  }

  /**
   * Patch the date-time overlay (`/overlays/dateTimeOverlay`). Only
   * `enabled` is operator-relevant; format strings (`dateStyle`,
   * `timeStyle`) live on the camera-side time settings page and we
   * deliberately don't bind them via the cap.
   */
  async setDateTimeOverlay(cameraNumber: number, patch: { enabled?: boolean }): Promise<void> {
    if (patch.enabled === undefined) return
    const url = `/ISAPI/System/Video/inputs/channels/${cameraNumber}/overlays/dateTimeOverlay`
    const current = await this.getText(url)
    const next = applyOverlayFieldPatches(current, [
      { tag: 'enabled', value: patch.enabled ? 'true' : 'false' },
    ])
    await this.putXml(url, next)
  }

  // ── Motion detection ───────────────────────────────────────────────

  /**
   * `/ISAPI/System/Video/inputs/channels/{cam}/motionDetection` — read
   * current motion config: enabled flag + sensitivity level + the
   * vendor-advertised range (min/max/step) so the UI can render a
   * slider with the correct ticks. Returns `null` when the camera
   * doesn't expose motion configuration (rare; covers IP camera firmware
   * variants without VMD).
   */
  async getMotionDetection(cameraNumber: number): Promise<HikvisionMotionDetection | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/System/Video/inputs/channels/${cameraNumber}/motionDetection`,
      )
      return parseMotionDetection(xml)
    } catch {
      return null
    }
  }

  /**
   * Patch motion detection (`enabled` and/or `sensitivityLevel`). Read-
   * modify-write — we splice the new values into the firmware's current
   * XML so siblings (motion-region grid, schedule) survive the round
   * trip. Sensitivity is clamped to the firmware-advertised
   * [min..max] before write.
   */
  async setMotionDetection(
    cameraNumber: number,
    patch: { enabled?: boolean; sensitivityLevel?: number },
  ): Promise<void> {
    const url = `/ISAPI/System/Video/inputs/channels/${cameraNumber}/motionDetection`
    const current = await this.getText(url)
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.enabled !== undefined) {
      patches.push({ tag: 'enabled', value: patch.enabled ? 'true' : 'false' })
    }
    if (patch.sensitivityLevel !== undefined) {
      patches.push({
        tag: 'sensitivityLevel',
        value: String(Math.max(0, Math.min(100, Math.round(patch.sensitivityLevel)))),
      })
    }
    if (patches.length === 0) return
    const next = applyOverlayFieldPatches(current, patches)
    await this.putXml(url, next)
  }

  /**
   * Read the full motion-detection config INCLUDING the VMD region
   * grid. Same endpoint as `getMotionDetection`, but also parses the
   * `<Grid>` dimensions and the `<gridMap>` active-cell payload.
   * Returns `null` when the camera doesn't expose motion config.
   */
  async getMotionGrid(cameraNumber: number): Promise<HikvisionMotionGrid | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/System/Video/inputs/channels/${cameraNumber}/motionDetection`,
      )
      return parseMotionGrid(xml)
    } catch {
      return null
    }
  }

  /**
   * Patch the motion-detection grid (`enabled` / `sensitivity` /
   * `cells`). Read-modify-write — we GET the firmware's current
   * `<MotionDetection>` XML, splice the scalar `<enabled>` /
   * `<sensitivityLevel>` tags and re-encode `cells` into the
   * `<gridMap>`, then PUT it back so any siblings (schedule, region
   * type) survive the round trip. Sensitivity is clamped to the
   * firmware-advertised [min..max] range before write.
   */
  async setMotionGrid(
    cameraNumber: number,
    patch: { enabled?: boolean; sensitivity?: number; cells?: readonly boolean[] },
  ): Promise<void> {
    const url = `/ISAPI/System/Video/inputs/channels/${cameraNumber}/motionDetection`
    const current = await this.getText(url)
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.enabled !== undefined) {
      patches.push({ tag: 'enabled', value: patch.enabled ? 'true' : 'false' })
    }
    if (patch.sensitivity !== undefined) {
      // Clamp to the firmware-advertised bounds (fallback 0..100).
      const attrMatch = /<sensitivityLevel\b([^>]*)>/i.exec(current)
      const attrs = attrMatch ? (attrMatch[1] ?? '') : ''
      const min = parseIntSafe((/\bmin="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? 0
      const max = parseIntSafe((/\bmax="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? 100
      const clamped = Math.max(min, Math.min(max, Math.round(patch.sensitivity)))
      patches.push({ tag: 'sensitivityLevel', value: String(clamped) })
    }
    let next = applyOverlayFieldPatches(current, patches)
    if (patch.cells !== undefined) {
      // Re-encode the cells into the existing grid's dimensions. We
      // read the dimensions back from the firmware XML rather than
      // trusting the caller so the bitmask width matches the camera.
      const columns = parseIntSafe(extractTag(current, 'columnGranularity')) ?? 0
      const rows = parseIntSafe(extractTag(current, 'rowGranularity')) ?? 0
      if (columns > 0 && rows > 0) {
        const hex = encodeGridMap(patch.cells, columns, rows)
        next = applyOverlayFieldPatches(next, [{ tag: 'gridMap', value: hex }])
      }
    }
    if (patches.length === 0 && patch.cells === undefined) return
    await this.putXml(url, next)
  }

  // ── Privacy mask (ISAPI/System/Video/inputs/channels/{id}/privacyMask) ─

  /**
   * `/ISAPI/System/Video/inputs/channels/{id}/privacyMask` — read the
   * camera's privacy-mask configuration: master enable flag, the
   * normalized screen canvas dimensions, and the list of mask regions
   * as normalized bounding rectangles.
   *
   * The canvas dimensions (`normalizedScreenSize`) vary by firmware; we
   * parse them so callers can convert region coordinates to [0,1] space
   * without hardcoding a canvas size.
   *
   * Returns `null` when the camera doesn't support the endpoint (404 or
   * missing mandatory fields). Callers should tolerate null gracefully.
   *
   * Needs-hardware-verification: ISAPI response shape assumed from
   * DS-2CD/DS-2DE firmware docs; `<RegionCoordinatesList>` vertex order
   * and `<normalizedScreenSize>` tag names may differ on older builds.
   */
  async getPrivacyMask(cameraNumber: number): Promise<HikvisionPrivacyMask | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/System/Video/inputs/channels/${cameraNumber}/privacyMask`,
      )
      return parsePrivacyMask(xml)
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/System/Video/inputs/channels/{id}/privacyMask/capabilities` —
   * read the firmware-advertised maximum number of regions and the
   * normalized canvas size.
   *
   * Returns `null` on 404 (legacy firmwares without the `/capabilities`
   * sub-resource). The caller falls back to a sensible default
   * (`maxRegions = 4`, canvas 1000×1000).
   */
  async getPrivacyMaskCapabilities(
    cameraNumber: number,
  ): Promise<HikvisionPrivacyMaskCapabilities | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/System/Video/inputs/channels/${cameraNumber}/privacyMask/capabilities`,
      )
      const maxNum = parseIntSafe(extractTag(xml, 'maxRegionNum'))
      const canvasW = parseIntSafe(extractTag(xml, 'normalizedScreenWidth'))
      const canvasH = parseIntSafe(extractTag(xml, 'normalizedScreenHeight'))
      if (!maxNum && !canvasW && !canvasH) return null
      return {
        maxRegions: maxNum ?? 4,
        canvasWidth: canvasW ?? 1000,
        canvasHeight: canvasH ?? 1000,
      }
    } catch {
      return null
    }
  }

  /**
   * Set the privacy-mask configuration via read-modify-write:
   *   1. GET the current XML.
   *   2. Splice `<enabled>` (when present in `patch`).
   *   3. Rebuild `<PrivacyMaskRegionList>` from `patch.rects` (when present),
   *      writing each rect as a 4-vertex rectangle on the normalized canvas.
   *   4. PUT the modified document back.
   *
   * No-ops silently when the camera lacks the endpoint (catch + debug log).
   *
   * Needs-hardware-verification: region rebuild assumes the
   * `<RegionCoordinatesList>` shape used by mid-range DS-2CD firmware.
   */
  async setPrivacyMask(
    cameraNumber: number,
    patch: { enabled?: boolean; regions?: readonly HikvisionPrivacyMaskRegion[] },
  ): Promise<void> {
    if (patch.enabled === undefined && patch.regions === undefined) return
    const baseUrl = `/ISAPI/System/Video/inputs/channels/${cameraNumber}/privacyMask`
    const regionsUrl = `${baseUrl}/regions`

    // Read the parent document once — it carries the master `<enabled>` and the
    // `<normalizedScreenSize>` we encode region coordinates against.
    let current: string
    try {
      current = await this.getText(baseUrl)
    } catch (err) {
      this.logger?.debug(
        'hikvision setPrivacyMask: GET failed — camera may not support privacy mask',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      return
    }

    // ── Master enable ── read-modify-write the single `<enabled>` scalar on the
    // parent document. (The parent PUT merges fields by tag — harmless for a
    // top-level scalar; only the region LIST has the problematic merge.)
    if (patch.enabled !== undefined) {
      const next = applyOverlayFieldPatches(current, [
        { tag: 'enabled', value: patch.enabled ? 'true' : 'false' },
      ])
      await this.putXml(baseUrl, next)
    }

    // ── Regions ── the parent `/privacyMask` PUT MERGES the region list by
    // `<id>` (a slot omitted from the PUT is RETAINED, per-region
    // `<enabled>false</enabled>` is ignored, and `size` does not truncate —
    // all verified live), so it can only ADD/UPDATE, never delete. The
    // `/privacyMask/regions` sub-resource IS authoritative and supports DELETE.
    // So: DELETE to clear every slot, then PUT the desired list (skip the PUT
    // when clearing all). This makes the camera state match the draft exactly.
    if (patch.regions !== undefined) {
      const canvasW = parseIntSafe(extractTag(current, 'normalizedScreenWidth')) ?? 1000
      const canvasH = parseIntSafe(extractTag(current, 'normalizedScreenHeight')) ?? 1000

      try {
        const delRes = await this.request(regionsUrl, { method: 'DELETE' })
        if (!delRes.ok) {
          this.logger?.debug('hikvision setPrivacyMask: regions DELETE non-OK', {
            meta: { status: delRes.status },
          })
        }
      } catch (err) {
        this.logger?.debug('hikvision setPrivacyMask: regions DELETE failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }

      if (patch.regions.length > 0) {
        const toCoords = (pts: readonly HikvisionPrivacyMaskPoint[]): string =>
          pts
            .map((p) => {
              const px = Math.round(Math.min(1, Math.max(0, p.x)) * canvasW)
              const py = Math.round(Math.min(1, Math.max(0, p.y)) * canvasH)
              return `<RegionCoordinates><positionX>${px}</positionX><positionY>${py}</positionY></RegionCoordinates>`
            })
            .join('')
        const regionXml = patch.regions
          .map(
            (region, idx) =>
              `<PrivacyMaskRegion>` +
              `<id>${idx + 1}</id>` +
              `<enabled>true</enabled>` +
              `<RegionCoordinatesList>${toCoords(region.points)}</RegionCoordinatesList>` +
              `</PrivacyMaskRegion>`,
          )
          .join('')
        const body =
          `<?xml version="1.0" encoding="UTF-8"?>` +
          `<PrivacyMaskRegionList version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema" size="${patch.regions.length}">` +
          regionXml +
          `</PrivacyMaskRegionList>`
        await this.putXml(regionsUrl, body)
      }
    }
  }

  // ── VCA Resource (third-stream toggle) ─────────────────────────────
  //
  // VCA = Video Content Analysis. Hikvision lets the operator pick how
  // the camera allocates compute between smart-detection (`smart`),
  // face-snap (`facesnap`), or "third stream available" (`close`).
  // Switching modes requires a reboot; we surface an explicit reboot
  // hook so the operator is in control.

  async getVcaResource(cameraNumber: number): Promise<HikvisionVcaResourceMode | null> {
    try {
      const xml = await this.getText(
        `/ISAPI/System/Video/inputs/channels/${cameraNumber}/VCAResource`,
      )
      const type = extractTag(xml, 'type')
      if (type === 'smart' || type === 'facesnap' || type === 'close') return type
      return null
    } catch {
      return null
    }
  }

  /**
   * Set the VCA resource mode. Returns `true` when the mode actually
   * changed (and therefore a reboot is required); `false` when the
   * camera was already in the requested mode (no-op).
   */
  async setVcaResource(cameraNumber: number, mode: HikvisionVcaResourceMode): Promise<boolean> {
    const current = await this.getVcaResource(cameraNumber)
    if (current === mode) return false
    const xml = `<?xml version="1.0" encoding="UTF-8"?><VCAResource version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><type>${mode}</type></VCAResource>`
    await this.putXml(`/ISAPI/System/Video/inputs/channels/${cameraNumber}/VCAResource`, xml)
    return true
  }

  // ── Streaming channels (codec / bitrate / FPS / GOP) ────────────

  /**
   * `/ISAPI/Streaming/channels/{channelId}` — read a single streaming
   * channel's full XML (codec + resolution + bitrate + GOP + quality
   * mode + audio enable). Returns `null` on 404.
   */
  async getStreamingChannel(channelId: string): Promise<HikvisionStreamingChannelConfig | null> {
    try {
      const xml = await this.getText(`/ISAPI/Streaming/channels/${channelId}`)
      return parseStreamingChannelConfig(xml)
    } catch {
      return null
    }
  }

  /**
   * `/ISAPI/Streaming/channels/{id}/dynamicCap` — read the firmware's
   * advertised set of valid FPS / resolution / codec combos for this
   * channel. We only surface the union of supported frame rates today
   * (operator-relevant for the FPS select); the rest is available via
   * the raw JSON for future tabs (resolution picker, etc.). Returns
   * `null` on 404 (legacy firmwares without dynamicCap).
   */
  async getStreamingChannelCapabilities(
    channelId: string,
  ): Promise<HikvisionStreamingChannelCaps | null> {
    try {
      const xml = await this.getText(`/ISAPI/Streaming/channels/${channelId}/dynamicCap`)
      return parseStreamingChannelCaps(xml)
    } catch {
      return null
    }
  }

  /**
   * Patch a streaming channel's video config. Read-modify-write so
   * fields we don't surface (resolution, audio mux flags) survive.
   * Hikvision's frame-rate is encoded as `1/100s of a frame` (a value
   * of 2500 = 25fps) — pass the human-readable FPS, the helper
   * multiplies by 100 before write.
   */
  async setStreamingChannel(
    channelId: string,
    patch: {
      videoCodecType?: string
      maxFrameRate?: number // human-readable FPS (e.g. 25)
      videoQualityControlType?: 'VBR' | 'CBR'
      vbrUpperCap?: number // kbps
      constantBitRate?: number // kbps
      fixedQuality?: number // 1..100 (VBR quality target)
      govLength?: number // I-frame interval in frames
      smartCodecEnabled?: boolean
      /** `<Audio><enabled>` — the microphone mux for this channel. */
      audioEnabled?: boolean
    },
  ): Promise<void> {
    const url = `/ISAPI/Streaming/channels/${channelId}`
    const current = await this.getText(url)
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.videoCodecType !== undefined) {
      patches.push({ tag: 'videoCodecType', value: patch.videoCodecType })
    }
    if (patch.maxFrameRate !== undefined) {
      // Hikvision wire encoding: integer FPS × 100.
      patches.push({ tag: 'maxFrameRate', value: String(Math.round(patch.maxFrameRate * 100)) })
    }
    if (patch.videoQualityControlType !== undefined) {
      patches.push({ tag: 'videoQualityControlType', value: patch.videoQualityControlType })
    }
    if (patch.vbrUpperCap !== undefined) {
      patches.push({ tag: 'vbrUpperCap', value: String(patch.vbrUpperCap) })
    }
    if (patch.constantBitRate !== undefined) {
      patches.push({ tag: 'constantBitRate', value: String(patch.constantBitRate) })
    }
    if (patch.fixedQuality !== undefined) {
      patches.push({
        tag: 'fixedQuality',
        value: String(Math.max(1, Math.min(100, Math.round(patch.fixedQuality)))),
      })
    }
    if (patch.govLength !== undefined) {
      patches.push({ tag: 'GovLength', value: String(patch.govLength) })
    }
    // SmartCodec lives nested under <SmartCodec><enabled>...; the regex
    // helper matches the FIRST <enabled>...</enabled> in the document
    // which would clobber the StreamingChannel-level enabled flag —
    // skip the read-modify-write helper for this tag and patch the
    // nested form directly.
    let next = applyOverlayFieldPatches(current, patches)
    if (patch.smartCodecEnabled !== undefined) {
      const value = patch.smartCodecEnabled ? 'true' : 'false'
      next = next.replace(
        /(<SmartCodec[^>]*>[\s\S]*?<enabled[^>]*>)[\s\S]*?(<\/enabled>[\s\S]*?<\/SmartCodec>)/i,
        `$1${value}$2`,
      )
    }
    // Same nested-block treatment, and for the same reason: the document's
    // FIRST `<enabled>` is the whole streaming channel's on/off switch.
    // Patching that instead of `<Audio><enabled>` would take the camera's
    // video stream down while the operator thought they were muting a
    // microphone. `hikvision-stream-audio.ts` owns and tests that anchoring.
    if (patch.audioEnabled !== undefined) {
      next = patchStreamAudioEnabled(next, patch.audioEnabled)
    }
    if (
      patches.length === 0 &&
      patch.smartCodecEnabled === undefined &&
      patch.audioEnabled === undefined
    )
      return
    await this.putXml(url, next)
  }

  // ── VMD event-trigger linkage outputs ─────────────────────────────
  //
  // `/ISAPI/Event/triggers/VMD-{cam}` lists the camera-side reactions
  // wired to motion (beep / white-light flash / IO output / Hikvision
  // notification center / linked recording). Each entry is a
  // `<EventTriggerNotification>` with `notificationMethod`. Supported
  // methods vary by firmware — we only enumerate the four most common:
  // `beep`, `whiteLight`, `IO`, `center`. Operators on richer firmware
  // can extend via the camera UI; we won't clobber their entries.

  // ── Image tuning (color / WDR / IR-cut filter) ────────────────────
  //
  // Hikvision groups the operator-tunable image controls under separate
  // sub-resources of `/ISAPI/Image/channels/{cam}`. Each is a small
  // self-contained XML — read-modify-write per endpoint. We surface
  // the three most operator-relevant: `color` (brightness / contrast /
  // saturation / sharpness 0..100 ladders), `WDR` (high-dynamic-range
  // enable + level), `IrcutFilter` (day / night / auto / schedule).
  // Exposure / BLC / HLC are firmware-quirky multi-mode setups — defer
  // to a future pass.

  async getImageColor(cameraNumber: number): Promise<HikvisionImageColor | null> {
    try {
      const xml = await this.getText(`/ISAPI/Image/channels/${cameraNumber}/color`)
      return parseImageColor(xml)
    } catch {
      return null
    }
  }

  async setImageColor(
    cameraNumber: number,
    patch: { brightness?: number; contrast?: number; saturation?: number },
  ): Promise<void> {
    const url = `/ISAPI/Image/channels/${cameraNumber}/color`
    const current = await this.getText(url)
    const clamp = (v: number): string => String(Math.max(0, Math.min(100, Math.round(v))))
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.brightness !== undefined)
      patches.push({ tag: 'brightnessLevel', value: clamp(patch.brightness) })
    if (patch.contrast !== undefined)
      patches.push({ tag: 'contrastLevel', value: clamp(patch.contrast) })
    if (patch.saturation !== undefined)
      patches.push({ tag: 'saturationLevel', value: clamp(patch.saturation) })
    if (patches.length === 0) return
    const next = applyOverlayFieldPatches(current, patches)
    await this.putXml(url, next)
  }

  /**
   * `/ISAPI/Image/channels/{cam}/sharpness` — Hikvision puts sharpness
   * on a SEPARATE endpoint from `/color` (PascalCase XML root +
   * `<SharpnessLevel>` tag, capital S). Operator-tunable 0..100.
   * Returns `null` on 404 (some firmwares fold it back into `/color`).
   */
  async getImageSharpness(cameraNumber: number): Promise<number | null> {
    try {
      const xml = await this.getText(`/ISAPI/Image/channels/${cameraNumber}/sharpness`)
      const raw = extractTag(xml, 'SharpnessLevel') ?? extractTag(xml, 'sharpnessLevel')
      return raw !== null ? parseIntSafe(raw) : null
    } catch {
      return null
    }
  }

  async setImageSharpness(cameraNumber: number, level: number): Promise<void> {
    const url = `/ISAPI/Image/channels/${cameraNumber}/sharpness`
    const current = await this.getText(url)
    const value = String(Math.max(0, Math.min(100, Math.round(level))))
    // Hikvision uses `SharpnessLevel` (capital S) on this endpoint —
    // the regex helper is case-insensitive so either works.
    const next = applyOverlayFieldPatches(current, [{ tag: 'SharpnessLevel', value }])
    await this.putXml(url, next)
  }

  async getImageWdr(cameraNumber: number): Promise<HikvisionImageWdr | null> {
    try {
      const xml = await this.getText(`/ISAPI/Image/channels/${cameraNumber}/WDR`)
      return parseImageWdr(xml)
    } catch {
      return null
    }
  }

  async setImageWdr(
    cameraNumber: number,
    patch: { enabled?: boolean; level?: number },
  ): Promise<void> {
    const url = `/ISAPI/Image/channels/${cameraNumber}/WDR`
    const current = await this.getText(url)
    const patches: Array<{ tag: string; value: string }> = []
    if (patch.enabled !== undefined) {
      // Hikvision uses `mode` (open/close) on WDR — boolean translates
      // to those tokens.
      patches.push({ tag: 'mode', value: patch.enabled ? 'open' : 'close' })
    }
    if (patch.level !== undefined) {
      patches.push({
        tag: 'WDRLevel',
        value: String(Math.max(0, Math.min(100, Math.round(patch.level)))),
      })
    }
    if (patches.length === 0) return
    const next = applyOverlayFieldPatches(current, patches)
    await this.putXml(url, next)
  }

  async getIrcutFilter(cameraNumber: number): Promise<HikvisionIrcutFilter | null> {
    try {
      const xml = await this.getText(`/ISAPI/Image/channels/${cameraNumber}/IrcutFilter`)
      return parseIrcutFilter(xml)
    } catch {
      return null
    }
  }

  async setIrcutFilter(cameraNumber: number, patch: { mode?: HikvisionIrcutMode }): Promise<void> {
    if (patch.mode === undefined) return
    const url = `/ISAPI/Image/channels/${cameraNumber}/IrcutFilter`
    const current = await this.getText(url)
    const next = applyOverlayFieldPatches(current, [{ tag: 'IrcutFilterType', value: patch.mode }])
    await this.putXml(url, next)
  }

  // ── Onboard storage + onboard recording (`recording-onboard` cap) ──
  //
  // Three reads and one write, all against `ContentMgmt`. The reads work
  // on 100 % of the fleet (measured 2026-09-22); the sibling resources
  // `Storage/mountList` and `search/profile` answer 403 on this firmware,
  // so nothing here assumes a neighbouring endpoint exists.

  /**
   * `/ISAPI/ContentMgmt/Storage`. Returns the body, or null when the
   * camera did not answer.
   *
   * Null is "we do not know", and the caller must report it as such: an
   * unreadable card is not an absent one (D393).
   */
  async getOnboardStorageXml(): Promise<string | null> {
    try {
      return await this.getText('/ISAPI/ContentMgmt/Storage')
    } catch {
      return null
    }
  }

  /** `/ISAPI/ContentMgmt/record/tracks` — every track, with its schedule. */
  async getRecordTracksXml(): Promise<string | null> {
    try {
      return await this.getText('/ISAPI/ContentMgmt/record/tracks')
    } catch {
      return null
    }
  }

  /** One track's own resource — the read half of a read-modify-write. */
  async getRecordTrackXml(trackId: string): Promise<string> {
    return await this.getText(`/ISAPI/ContentMgmt/record/tracks/${trackId}`)
  }

  /**
   * PUT one track back.
   *
   * Throws on a non-2xx, carrying the status — a refused write must be
   * loud. `putXml` does no read-modify-write of its own: the body passed
   * here is the camera's own document with only the target tags spliced.
   */
  async putRecordTrackXml(trackId: string, xml: string): Promise<string> {
    return await this.putXml(`/ISAPI/ContentMgmt/record/tracks/${trackId}`, xml)
  }

  async getMotionTriggerLinkage(cameraNumber: number): Promise<HikvisionMotionLinkage | null> {
    try {
      const xml = await this.getText(`/ISAPI/Event/triggers/VMD-${cameraNumber}`)
      return parseMotionTriggerLinkage(xml)
    } catch {
      return null
    }
  }

  /**
   * Patch the VMD trigger's notification methods. Adds / removes the
   * listed methods while preserving everything else (other notification
   * types, recording linkages). Pass `true` to enable, `false` to
   * disable; omitted methods are left untouched.
   */
  async setMotionTriggerLinkage(
    cameraNumber: number,
    patch: { beep?: boolean; whiteLight?: boolean; ioOutput?: boolean; center?: boolean },
  ): Promise<void> {
    const url = `/ISAPI/Event/triggers/VMD-${cameraNumber}`
    let xml = await this.getText(url)

    const methodMap: ReadonlyArray<{ key: keyof typeof patch; method: string }> = [
      { key: 'beep', method: 'beep' },
      { key: 'whiteLight', method: 'whiteLight' },
      { key: 'ioOutput', method: 'IO' },
      { key: 'center', method: 'center' },
    ]

    // Strip every method we manage from the list before re-inserting
    // the wanted ones. Keep methods we don't manage (`record`,
    // `email`, …) verbatim so the operator's other linkages survive.
    const managed = methodMap.map((m) => m.method)
    for (const method of managed) {
      const re = new RegExp(
        `<EventTriggerNotification[^>]*>[\\s\\S]*?<notificationMethod>${method}<\\/notificationMethod>[\\s\\S]*?<\\/EventTriggerNotification>`,
        'gi',
      )
      xml = xml.replace(re, '')
    }

    // Read the current state to know which methods stay enabled when
    // not in the patch (caller patches partial — undefined = leave as
    // is). The current state was already in the original XML before we
    // stripped; refetch via a fresh GET would be cleaner, but we can
    // recover from the unstripped copy.
    const original = await this.getText(url)
    const current = parseMotionTriggerLinkage(original)
    const desired: Record<string, boolean> = {
      beep: patch.beep ?? current.beep,
      whiteLight: patch.whiteLight ?? current.whiteLight,
      IO: patch.ioOutput ?? current.ioOutput,
      center: patch.center ?? current.center,
    }

    const additions: string[] = []
    for (const m of methodMap) {
      if (desired[m.method] === true) {
        additions.push(
          `<EventTriggerNotification><id>${m.method}</id><notificationMethod>${m.method}</notificationMethod></EventTriggerNotification>`,
        )
      }
    }

    // Inject the new entries inside the existing
    // `<EventTriggerNotificationList>...</EventTriggerNotificationList>`
    // block. If the list doesn't exist yet (rare on barebones firmware),
    // append a fresh one before `</EventTrigger>`.
    if (/<EventTriggerNotificationList\b/i.test(xml)) {
      xml = xml.replace(/(<\/EventTriggerNotificationList>)/i, `${additions.join('')}$1`)
    } else {
      xml = xml.replace(
        /(<\/EventTrigger>)/i,
        `<EventTriggerNotificationList>${additions.join('')}</EventTriggerNotificationList>$1`,
      )
    }
    await this.putXml(url, xml)
  }
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-100, Math.min(100, Math.round(value)))
}

// ── Extended types (PTZ / light / alarm) ─────────────────────────

export interface HikvisionPtzCapabilities {
  readonly hasPan: boolean
  readonly hasTilt: boolean
  readonly hasZoom: boolean
  readonly maxPresetCount: number | null
  /** Raw XML payload — keep for diagnostic dumps. */
  readonly raw: string
}

export interface HikvisionPtzPreset {
  readonly id: string
  readonly name: string | null
  readonly enabled: boolean
}

export interface HikvisionLightCapabilities {
  /** Modes the camera advertised as available (`auto`, `manual`,
   *  `colorVuWhiteLight`, `irLight`, `close`, …). */
  readonly modes: readonly string[]
  readonly raw: string
}

export interface HikvisionLightState {
  /** Currently active mode. `close` = off. */
  readonly mode: string
  /** Either white or IR brightness, whichever the firmware reports —
   *  kept for backwards compat with the LightAccessory's brightness
   *  cap. New consumers should prefer the typed pair below. */
  readonly brightness: number | null
  readonly whiteLightBrightness: number | null
  readonly irLightBrightness: number | null
  /** `auto` (camera-side light sensor drives brightness) / `manual`
   *  (operator-set) / `null` when the firmware doesn't expose it. */
  readonly brightnessRegulatorMode: 'auto' | 'manual' | null
}

export interface HikvisionAlarmInput {
  /** Hikvision-numbered port id (typically 1-based). */
  readonly id: string
  readonly name: string | null
  readonly enabled: boolean
}

export interface HikvisionSmartTrackingCapabilities {
  /** True when the firmware accepts a `<duration>` field — most newer
   *  models do, older PTZ models ship enable-only. */
  readonly supportsDuration: boolean
  /** True when the firmware accepts a `<smartTrackingType>` selector
   *  (`auto` / `human` / `vehicle`). Varies more than `duration`. */
  readonly supportsType: boolean
  readonly raw: string
}

export interface HikvisionSmartTrackingState {
  readonly enabled: boolean
  /** Duration (seconds) the camera keeps following a stationary
   *  target before releasing. `null` when the firmware doesn't
   *  expose this knob. */
  readonly duration: number | null
  /** Tracking-type selector (`auto` / `human` / `vehicle`). `null`
   *  when the firmware doesn't expose this knob. */
  readonly trackingType: string | null
}

export interface HikvisionTextOverlay {
  readonly id: string
  readonly enabled: boolean
  readonly text: string | null
}

export interface HikvisionOverlayConfig {
  readonly dateTime: { readonly enabled: boolean }
  readonly channelName: { readonly enabled: boolean }
  /** Operator-editable text overlays. Always 4 entries on consumer
   *  cameras (firmware allocates the IDs eagerly even when empty);
   *  some NVR channels expose 8. */
  readonly textOverlays: readonly HikvisionTextOverlay[]
}

export interface HikvisionMotionDetection {
  readonly enabled: boolean
  readonly sensitivityLevel: number
  /** Firmware-advertised slider bounds (min/max/step). Drives the UI
   *  slider granularity — older firmwares advertise step=20 (0/20/40/
   *  60/80/100), newer ones advertise step=1 (continuous). */
  readonly sensitivityMin: number
  readonly sensitivityMax: number
  readonly sensitivityStep: number
}

/** A normalized 0..1 privacy-mask vertex (top-left origin). */
export interface HikvisionPrivacyMaskPoint {
  readonly x: number
  readonly y: number
}

/**
 * Single privacy-mask region — an ordered list of normalized vertices.
 * Hikvision stores arbitrary polygons in `<RegionCoordinatesList>`; an
 * axis-aligned rectangle is simply 4 corner vertices. Coordinates are
 * 0..1 of the firmware canvas (`normalizedScreenSize`).
 */
export interface HikvisionPrivacyMaskRegion {
  readonly points: readonly HikvisionPrivacyMaskPoint[]
}

/**
 * Parsed privacy-mask configuration from
 * `/ISAPI/System/Video/inputs/channels/{id}/privacyMask`.
 */
export interface HikvisionPrivacyMask {
  /** Master enable toggle. */
  readonly enabled: boolean
  /** Firmware canvas width in ISAPI normalized units (e.g. 704). */
  readonly canvasWidth: number
  /** Firmware canvas height in ISAPI normalized units (e.g. 576). */
  readonly canvasHeight: number
  /** Max regions the firmware accepts (from `<PrivacyMaskRegionList size>`). */
  readonly maxRegions: number
  /** Per-region polygons in [0,1] normalized space. */
  readonly regions: readonly HikvisionPrivacyMaskRegion[]
}

/**
 * Privacy-mask capability descriptor from the `/capabilities` sub-resource.
 */
export interface HikvisionPrivacyMaskCapabilities {
  readonly maxRegions: number
  readonly canvasWidth: number
  readonly canvasHeight: number
}

/**
 * On-camera VMD (Video Motion Detection) grid + master state.
 * `gridWidth` is the firmware's `columnGranularity` (cells per row),
 * `gridHeight` its `rowGranularity` (rows). `cells` is row-major,
 * length === gridWidth*gridHeight; `true` = the cell triggers motion.
 */
export interface HikvisionMotionGrid {
  readonly enabled: boolean
  readonly sensitivityLevel: number
  readonly sensitivityMin: number
  readonly sensitivityMax: number
  readonly sensitivityStep: number
  readonly gridWidth: number
  readonly gridHeight: number
  /** Row-major active-cell grid, length === gridWidth*gridHeight. */
  readonly cells: readonly boolean[]
}

/**
 * VCA resource modes:
 *   - `smart`    — camera runs smart-detection algorithms (motion-AI,
 *                   line crossing, intrusion, …). Disables the third
 *                   stream slot.
 *   - `facesnap` — face capture mode; disables third stream.
 *   - `close`    — VCA off, third stream slot freed for use.
 *
 * Switching modes requires a camera reboot — the lib's `setVcaResource`
 * returns `true` when the mode actually changed so callers can decide
 * whether to issue the reboot.
 */
export type HikvisionVcaResourceMode = 'smart' | 'facesnap' | 'close'

export interface HikvisionAudioCapabilities {
  /** Codec strings the firmware advertises in the `audioCompressionType`
   *  attribute's `opt` list (e.g. `['G.711ulaw', 'G.711alaw',
   *  'G.722.1', 'AAC']`). Empty when the camera doesn't enumerate. */
  readonly audioCodecs: readonly string[]
  /** Input-type strings advertised in `audioInputType@opt` (`MicIn`,
   *  `LineIn`, …). Empty when the camera doesn't expose them. */
  readonly audioInputTypes: readonly string[]
  /** Speaker volume range — defaults 0..100 when the camera doesn't
   *  advertise tighter bounds. */
  readonly speakerVolumeMin: number
  readonly speakerVolumeMax: number
  /** True when the camera advertises `noisereduce` as togglable. */
  readonly supportsNoiseReduction: boolean
}

export interface HikvisionAudioSettings {
  readonly audioCompressionType: string | null
  readonly speakerVolume: number | null
  readonly noiseReduction: boolean
  readonly audioInputType: string | null
}

export interface HikvisionStreamingChannelConfig {
  readonly id: string
  readonly channelName: string | null
  readonly enabled: boolean
  readonly videoCodecType: string | null
  readonly resolution: { readonly width: number | null; readonly height: number | null }
  /** Frames per second — already converted from Hikvision's `FPS×100`
   *  wire encoding to the human-readable form. */
  readonly maxFrameRate: number | null
  readonly videoQualityControlType: 'VBR' | 'CBR' | null
  /** Bitrate (kbps) used when `videoQualityControlType === 'VBR'`. */
  readonly vbrUpperCap: {
    readonly value: number | null
    readonly min: number
    readonly max: number
  }
  /** Bitrate (kbps) used when `videoQualityControlType === 'CBR'`. */
  readonly constantBitRate: {
    readonly value: number | null
    readonly min: number
    readonly max: number
  }
  /** VBR quality target 1..100. */
  readonly fixedQuality: number | null
  readonly govLength: { readonly value: number | null; readonly min: number; readonly max: number }
  readonly smartCodecEnabled: boolean
  /**
   * `<Audio><enabled>` — whether this channel muxes the microphone.
   * `null` when the firmware emits no `<Audio>` block, i.e. the camera has no
   * controllable audio input. Distinct from `false`: one means "off", the
   * other means "there is nothing to turn off".
   */
  readonly audioEnabled: boolean | null
  readonly h264Profile: string | null
  readonly h265Profile: string | null
}

export interface HikvisionStreamingChannelCaps {
  /** Sorted-descending list of FPS values the firmware advertises across
   *  every resolution this channel supports. Already converted from
   *  Hikvision's `FPS×100` wire encoding to human-readable integers. */
  readonly supportedFrameRates: readonly number[]
}

export interface HikvisionMotionLinkage {
  readonly beep: boolean
  readonly whiteLight: boolean
  readonly ioOutput: boolean
  readonly center: boolean
}

export interface HikvisionImageColor {
  readonly brightness: number | null
  readonly contrast: number | null
  readonly saturation: number | null
  readonly sharpness: number | null
}

export interface HikvisionImageWdr {
  readonly enabled: boolean
  readonly level: number | null
}

export type HikvisionIrcutMode = 'day' | 'night' | 'auto' | 'schedule'

export interface HikvisionIrcutFilter {
  readonly mode: HikvisionIrcutMode | string
}

export interface HikvisionTimeConfig {
  /** `NTP` = camera syncs from an NTP server; `manual` = operator-set
   *  clock. Hikvision firmware also emits `manual` for the rare
   *  `localtime`/`SDK` modes — we collapse those to `manual`. */
  readonly timeMode: 'NTP' | 'manual'
  /** Opaque POSIX-TZ-ish string (`CST-1:00:00DST...`). Carried through
   *  read-modify-write verbatim — never synthesised. */
  readonly timeZone: string
  /** The camera's current displayed local wall-clock as a zoned ISO-8601
   *  string (`YYYY-MM-DDTHH:MM:SS±HH:MM`). `null` when `<localTime>` is
   *  absent (some NTP-mode firmwares omit it). */
  readonly localTime: string | null
  /** NTP server address (IP or hostname), `null` when the camera
   *  doesn't expose the `/ntpServers` endpoint. */
  readonly ntpServer: string | null
  readonly ntpPort: number | null
  /** Sync interval in minutes. */
  readonly syncInterval: number | null
}

function parsePtzCapabilities(xml: string): HikvisionPtzCapabilities | null {
  const block = extractTag(xml, 'PTZChanelCap') ?? extractTag(xml, 'PTZChannelCap') ?? xml
  if (!block) return null
  const hasPan = /<XRange>/i.test(block) || /<PanRange>/i.test(block)
  const hasTilt = /<YRange>/i.test(block) || /<TiltRange>/i.test(block)
  const hasZoom = /<ZRange>/i.test(block) || /<ZoomRange>/i.test(block)
  if (!hasPan && !hasTilt && !hasZoom) return null
  const maxPresetCount = parseIntSafe(extractTag(block, 'maxPresetNum'))
  return { hasPan, hasTilt, hasZoom, maxPresetCount, raw: xml }
}

function parsePtzPresets(xml: string): readonly HikvisionPtzPreset[] {
  const blocks = extractAllBlocks(xml, 'PTZPreset')
  const out: HikvisionPtzPreset[] = []
  for (const b of blocks) {
    const id = extractTag(b, 'id')
    if (!id) continue
    const name = extractTag(b, 'presetName')
    const enabled = (extractTag(b, 'enabled') ?? 'true').toLowerCase() === 'true'
    if (!enabled) continue
    out.push({ id, name, enabled })
  }
  return out
}

function parseSupplementLightModes(xml: string): readonly string[] {
  // Hikvision encodes available modes either as a list of `<supplementLightMode>` tags
  // OR as a single tag with `opt="auto,manual,..."` attribute. Cover both shapes.
  const optMatch = /<supplementLightMode[^>]*\bopt\s*=\s*"([^"]*)"/i.exec(xml)
  if (optMatch) {
    return optMatch[1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  const blocks = extractAllBlocks(xml, 'supplementLightMode')
  return blocks.map((b) => decodeXmlEntities(b.trim())).filter((s) => s.length > 0)
}

function parseSupplementLightState(xml: string): HikvisionLightState | null {
  const mode = extractTag(xml, 'supplementLightMode')
  if (!mode) return null
  const whiteLightBrightness = parseIntSafe(extractTag(xml, 'whiteLightBrightness'))
  const irLightBrightness = parseIntSafe(extractTag(xml, 'irLightBrightness'))
  const brightness = whiteLightBrightness ?? irLightBrightness
  const regulatorRaw = extractTag(xml, 'mixedLightBrightnessRegulatMode')
  const brightnessRegulatorMode =
    regulatorRaw === 'auto' || regulatorRaw === 'manual' ? regulatorRaw : null
  return { mode, brightness, whiteLightBrightness, irLightBrightness, brightnessRegulatorMode }
}

function parseAlarmInputs(xml: string): readonly HikvisionAlarmInput[] {
  const blocks = extractAllBlocks(xml, 'IOInputPort')
  const out: HikvisionAlarmInput[] = []
  for (const b of blocks) {
    const id = extractTag(b, 'id')
    if (!id) continue
    const name = extractTag(b, 'name')
    const enabled = (extractTag(b, 'enabled') ?? 'true').toLowerCase() === 'true'
    out.push({ id, name, enabled })
  }
  return out
}

function parseOverlayConfig(xml: string): HikvisionOverlayConfig {
  // dateTimeOverlay + channelNameOverlay each appear once at the top
  // level of `<VideoOverlay>` — extract their `<enabled>` directly.
  const dateTimeBlock = extractTag(xml, 'DateTimeOverlay') ?? ''
  const channelBlock = extractTag(xml, 'channelNameOverlay') ?? ''
  const dateTimeEnabled =
    (extractTag(`<x>${dateTimeBlock}</x>`, 'enabled') ?? 'false').toLowerCase() === 'true'
  const channelEnabled =
    (extractTag(`<x>${channelBlock}</x>`, 'enabled') ?? 'false').toLowerCase() === 'true'

  // TextOverlayList → multiple TextOverlay entries. Iterate via the
  // generic block extractor; firmware allocates IDs 1..N regardless of
  // whether the slot has visible text.
  const textBlocks = extractAllBlocks(xml, 'TextOverlay')
  const textOverlays: HikvisionTextOverlay[] = []
  for (const b of textBlocks) {
    const id = extractTag(`<x>${b}</x>`, 'id')
    if (!id) continue
    const enabled = (extractTag(`<x>${b}</x>`, 'enabled') ?? 'false').toLowerCase() === 'true'
    const text = extractTag(`<x>${b}</x>`, 'displayText')
    textOverlays.push({ id, enabled, text })
  }

  return {
    dateTime: { enabled: dateTimeEnabled },
    channelName: { enabled: channelEnabled },
    textOverlays,
  }
}

/**
 * Splice tag values into an existing XML payload (read-modify-write).
 * Replaces the FIRST occurrence of each requested `<tag>...</tag>`
 * with the new value, leaving the rest of the document untouched.
 * Used for per-element overlay PUTs where the camera demands the
 * complete sub-tree but we only want to flip a couple of fields.
 */
function applyOverlayFieldPatches(
  xml: string,
  patches: ReadonlyArray<{ tag: string; value: string }>,
): string {
  let out = xml
  for (const p of patches) {
    const re = new RegExp(
      `(<(?:[a-zA-Z0-9]+:)?${p.tag}[^>]*>)[\\s\\S]*?(</(?:[a-zA-Z0-9]+:)?${p.tag}>)`,
      'i',
    )
    out = out.replace(re, `$1${p.value}$2`)
  }
  return out
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function parseImageColor(xml: string): HikvisionImageColor {
  // `sharpness` lives on a SEPARATE endpoint on most Hikvision
  // firmwares (`/Image/channels/{cam}/sharpness`); the parser only
  // tries the inline tag for the rare firmware that folds it into
  // `/color`. Caller falls back to `getImageSharpness()` on null.
  return {
    brightness: parseIntSafe(extractTag(xml, 'brightnessLevel')),
    contrast: parseIntSafe(extractTag(xml, 'contrastLevel')),
    saturation: parseIntSafe(extractTag(xml, 'saturationLevel')),
    sharpness: parseIntSafe(extractTag(xml, 'sharpnessLevel')),
  }
}

function parseImageWdr(xml: string): HikvisionImageWdr {
  // Hikvision encodes WDR enable as `<mode>open</mode>` /
  // `<mode>close</mode>` (NOT a boolean tag). The level is the
  // `<WDRLevel>` integer. Some firmwares use a slightly different
  // tag (`<wdrLevel>` lowercase) — accept either.
  const mode = (extractTag(xml, 'mode') ?? '').toLowerCase()
  const enabled = mode === 'open'
  const levelRaw = extractTag(xml, 'WDRLevel') ?? extractTag(xml, 'wdrLevel')
  const level = levelRaw !== null ? parseIntSafe(levelRaw) : null
  return { enabled, level }
}

function parseIrcutFilter(xml: string): HikvisionIrcutFilter {
  const mode = extractTag(xml, 'IrcutFilterType') ?? 'auto'
  return { mode }
}

function parseStreamingChannelCaps(xml: string): HikvisionStreamingChannelCaps {
  // The dynamicCap doc has multiple `<ResolutionAvailableDscriptor>`
  // blocks, each with a `<supportedFrameRate>` CSV in Hikvision's
  // `FPS×100` wire format. Union across all resolutions; the
  // operator-facing select doesn't need a per-resolution split today
  // (resolution itself isn't tunable from the form yet).
  const blocks = extractAllBlocks(xml, 'supportedFrameRate')
  const all = new Set<number>()
  for (const csv of blocks) {
    for (const piece of csv.split(',')) {
      const n = parseIntSafe(piece.trim())
      if (n === null || n <= 0) continue
      // Hikvision wire format is FPS×100; sub-1-fps entries (e.g. 50 = 0.5fps)
      // round to 0 and would violate the schema's `.positive()` invariant.
      const fps = Math.round(n / 100)
      if (fps <= 0) continue
      all.add(fps)
    }
  }
  return { supportedFrameRates: [...all].toSorted((a, b) => b - a) }
}

function parseStreamingChannelConfig(xml: string): HikvisionStreamingChannelConfig {
  const id = extractTag(xml, 'id') ?? ''
  const channelName = extractTag(xml, 'channelName')
  // The CHANNEL's own `<enabled>`, read element-scoped. `<Video>` and `<Audio>`
  // each carry an `<enabled>` of their own; a first-match read returns the
  // right one only while the firmware keeps emitting the channel flag first.
  // `null` (no channel-level flag) reads as enabled — a firmware that does not
  // advertise the switch has no switched-off channel to hide.
  const enabled = readStreamingChannelEnabled(xml) ?? true
  const videoCodecType = extractTag(xml, 'videoCodecType')
  const width = parseIntSafe(extractTag(xml, 'videoResolutionWidth'))
  const height = parseIntSafe(extractTag(xml, 'videoResolutionHeight'))
  // Hikvision stores FPS as `frames × 100` (2500 = 25fps). Convert
  // back to the human-readable integer for display.
  const fpsRaw = parseIntSafe(extractTag(xml, 'maxFrameRate'))
  const maxFrameRate = fpsRaw !== null ? Math.round(fpsRaw / 100) : null
  const qcType = extractTag(xml, 'videoQualityControlType')
  const videoQualityControlType = qcType === 'VBR' || qcType === 'CBR' ? qcType : null

  const parseRange = (
    tag: string,
    fallbackMax: number,
  ): { value: number | null; min: number; max: number } => {
    const value = parseIntSafe(extractTag(xml, tag))
    const tagMatch = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(xml)
    const attrs = tagMatch ? (tagMatch[1] ?? '') : ''
    const min = parseIntSafe((/\bmin="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? 0
    const max = parseIntSafe((/\bmax="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? fallbackMax
    return { value, min, max }
  }
  const vbrUpperCap = parseRange('vbrUpperCap', 16384)
  const constantBitRate = parseRange('constantBitRate', 16384)
  const govLength = parseRange('GovLength', 400)
  const fixedQuality = parseIntSafe(extractTag(xml, 'fixedQuality'))
  const smartCodecBlock = extractTag(xml, 'SmartCodec') ?? ''
  const smartCodecEnabled =
    smartCodecBlock.length > 0 &&
    (extractTag(`<x>${smartCodecBlock}</x>`, 'enabled') ?? 'false').toLowerCase() === 'true'
  // `<Audio><enabled>` — the camera's own "Video Type: Video&Audio vs Video
  // Stream" selector. Anchored on the `<Audio>` element by a dedicated,
  // tested helper: the document's FIRST `<enabled>` is the whole channel's
  // on/off, and reading it here would report the video stream's state as the
  // microphone's. `null` = no `<Audio>` block, which the privacy cap turns
  // into `supportsAudioMute: false`.
  const audioEnabled = readStreamAudioEnabled(xml)
  const h264Profile = extractTag(xml, 'H264Profile')
  const h265Profile = extractTag(xml, 'H265Profile')
  return {
    id,
    channelName,
    enabled,
    videoCodecType,
    resolution: { width, height },
    maxFrameRate,
    videoQualityControlType,
    vbrUpperCap,
    constantBitRate,
    fixedQuality,
    govLength,
    smartCodecEnabled,
    audioEnabled,
    h264Profile,
    h265Profile,
  }
}

function parseMotionTriggerLinkage(xml: string): HikvisionMotionLinkage {
  // Each `<EventTriggerNotification>` has a `<notificationMethod>` we
  // care about — beep / whiteLight / IO / center. The check is a
  // simple substring scan; the per-block attributes (recurrence, etc.)
  // are irrelevant to whether the linkage is armed.
  const methods = extractAllBlocks(xml, 'notificationMethod').map((m) => m.trim().toLowerCase())
  return {
    beep: methods.includes('beep'),
    whiteLight: methods.includes('whitelight'),
    ioOutput: methods.includes('io'),
    center: methods.includes('center'),
  }
}

function parseAudioCapabilities(xml: string): HikvisionAudioCapabilities {
  // Hikvision encodes both element-level options and attribute-level
  // ranges. Parse defensively — older firmwares omit some, newer ones
  // wrap them under a `TwoWayAudioChannel` root.
  const codecsAttr = /<audioCompressionType\b[^>]*\bopt\s*=\s*"([^"]*)"/i.exec(xml)
  const audioCodecs = codecsAttr
    ? codecsAttr[1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : []
  const inputAttr = /<audioInputType\b[^>]*\bopt\s*=\s*"([^"]*)"/i.exec(xml)
  const audioInputTypes = inputAttr
    ? inputAttr[1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : []
  const volMatch = /<speakerVolume\b([^>]*)>/i.exec(xml)
  const volAttrs = volMatch ? (volMatch[1] ?? '') : ''
  const speakerVolumeMin = parseIntSafe((/\bmin="(\d+)"/i.exec(volAttrs) ?? [])[1] ?? null) ?? 0
  const speakerVolumeMax = parseIntSafe((/\bmax="(\d+)"/i.exec(volAttrs) ?? [])[1] ?? null) ?? 100
  const noiseAttr = /<noisereduce\b[^>]*\bopt\s*=\s*"([^"]*)"/i.exec(xml)
  const supportsNoiseReduction = noiseAttr ? /true/i.test(noiseAttr[1] ?? '') : false
  return {
    audioCodecs,
    audioInputTypes,
    speakerVolumeMin,
    speakerVolumeMax,
    supportsNoiseReduction,
  }
}

function parseAudioSettings(xml: string): HikvisionAudioSettings | null {
  const audioCompressionType = extractTag(xml, 'audioCompressionType')
  const speakerRaw = extractTag(xml, 'speakerVolume')
  const speakerVolume = speakerRaw !== null ? parseIntSafe(speakerRaw) : null
  const noiseRaw = extractTag(xml, 'noisereduce')
  const noiseReduction = (noiseRaw ?? 'false').toLowerCase() === 'true'
  const audioInputType = extractTag(xml, 'audioInputType')
  return { audioCompressionType, speakerVolume, noiseReduction, audioInputType }
}

function parseMotionDetection(xml: string): HikvisionMotionDetection | null {
  const enabled = (extractTag(xml, 'enabled') ?? 'false').toLowerCase() === 'true'
  // Sensitivity level + advertised slider bounds. Older firmwares
  // ship `step=20` (5 discrete levels); newer ones expose the full
  // 0..100 range with step=1. We surface both so the UI form picks
  // the right control.
  const levelRaw = extractTag(xml, 'sensitivityLevel')
  const sensitivityLevel = parseIntSafe(levelRaw) ?? 0
  // Match attributes on the sensitivityLevel tag for min/max/step.
  const attrMatch = /<sensitivityLevel\b([^>]*)>/i.exec(xml)
  const attrs = attrMatch ? (attrMatch[1] ?? '') : ''
  const min = parseIntSafe((/\bmin="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? 0
  const max = parseIntSafe((/\bmax="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? 100
  const step = parseIntSafe((/\bstep="(\d+)"/i.exec(attrs) ?? [])[1] ?? null) ?? 1
  return {
    enabled,
    sensitivityLevel,
    sensitivityMin: min,
    sensitivityMax: max,
    sensitivityStep: step > 0 ? step : 1,
  }
}

/**
 * Parse the VMD region grid out of a `<MotionDetection>` payload.
 * Returns `null` when the camera doesn't expose motion config at all.
 * The grid dimensions come from `<Grid>` (`columnGranularity` = cells
 * per row, `rowGranularity` = rows); the active cells come from the
 * `<gridMap>` hex string.
 */
function parseMotionGrid(xml: string): HikvisionMotionGrid | null {
  const scalar = parseMotionDetection(xml)
  if (scalar === null) return null
  // `<Grid>` carries the firmware's grid resolution. The two
  // granularity tags are uniquely named, so we read them straight
  // off the document rather than isolating the `<Grid>` block.
  const gridWidth = parseIntSafe(extractTag(xml, 'columnGranularity')) ?? 0
  const gridHeight = parseIntSafe(extractTag(xml, 'rowGranularity')) ?? 0
  const gridMapHex = extractTag(xml, 'gridMap') ?? ''
  const cells = decodeGridMap(gridMapHex, gridWidth, gridHeight)
  return {
    enabled: scalar.enabled,
    sensitivityLevel: scalar.sensitivityLevel,
    sensitivityMin: scalar.sensitivityMin,
    sensitivityMax: scalar.sensitivityMax,
    sensitivityStep: scalar.sensitivityStep,
    gridWidth,
    gridHeight,
    cells,
  }
}

// ── Privacy-mask XML parser ───────────────────────────────────────

/**
 * Parse a `/ISAPI/System/Video/inputs/channels/{id}/privacyMask` XML
 * response. Extracts the master `<enabled>` flag, the canvas dimensions
 * from `<normalizedScreenSize>`, and each `<PrivacyMaskRegion>`'s vertex
 * list as a normalized bounding rect.
 *
 * Needs-hardware-verification: field names and vertex order come from
 * Hikvision DS-2CD/DS-2DE ISAPI docs; older firmwares may differ.
 */
function parsePrivacyMask(xml: string): HikvisionPrivacyMask | null {
  // Master enable must be present for the response to be usable.
  const enabledRaw = extractTag(xml, 'enabled')
  if (enabledRaw === null) return null
  const enabled = enabledRaw.toLowerCase() === 'true'

  // Canvas dimensions — fall back to a sensible 1000×1000 default when
  // the firmware omits the `<normalizedScreenSize>` block. (Observed
  // 704×576 on the DS-2CD verified against Sala da pranzo.)
  const canvasW = parseIntSafe(extractTag(xml, 'normalizedScreenWidth')) ?? 1000
  const canvasH = parseIntSafe(extractTag(xml, 'normalizedScreenHeight')) ?? 1000

  // `<PrivacyMaskRegionList size="N">` advertises the max region count
  // (the camera ships no `/capabilities` sub-resource on many firmwares).
  const sizeMatch = xml.match(/<PrivacyMaskRegionList[^>]*\bsize="(\d+)"/i)
  const maxRegions = sizeMatch ? Number(sizeMatch[1]) : 4

  // Each `<PrivacyMaskRegion>` carries a `<RegionCoordinatesList>` of
  // vertices forming an arbitrary polygon (this firmware: 4 free vertices,
  // not necessarily axis-aligned). Surface every vertex normalized to 0..1
  // so non-rectangular masks round-trip intact.
  const regionBlocks = extractAllBlocks(xml, 'PrivacyMaskRegion')
  const regions: HikvisionPrivacyMaskRegion[] = []

  for (const block of regionBlocks) {
    // Skip disabled regions.
    const regionEnabled = (extractTag(block, 'enabled') ?? 'true').toLowerCase()
    if (regionEnabled === 'false') continue

    const coordBlocks = extractAllBlocks(block, 'RegionCoordinates')
    if (coordBlocks.length === 0) continue

    const points: HikvisionPrivacyMaskPoint[] = []
    for (const coord of coordBlocks) {
      const px = parseIntSafe(extractTag(coord, 'positionX'))
      const py = parseIntSafe(extractTag(coord, 'positionY'))
      if (px === null || py === null) continue
      points.push({
        x: canvasW > 0 ? px / canvasW : 0,
        y: canvasH > 0 ? py / canvasH : 0,
      })
    }

    // A polygon needs ≥3 vertices to enclose area.
    if (points.length < 3) continue
    regions.push({ points })
  }

  return { enabled, canvasWidth: canvasW, canvasHeight: canvasH, maxRegions, regions }
}

// ── VMD grid-map codec ────────────────────────────────────────────
//
// UNVERIFIED ENCODING — needs a real-camera payload capture.
//
// Working hypothesis for the Hikvision `<gridMap>` field: the grid is
// serialized row by row, each row a hex bitmask, all rows concatenated
// into a single string. Within a row, every hex digit packs 4 cells
// MSB-first (bit 0x8 = leftmost of the four). Each row is padded to a
// whole number of hex digits — `ceil(columns / 4)` digits per row, so
// the total string length is `ceil(columns / 4) * rows`.
//
// The following are GUESSES until confirmed against a real device:
//   - bit order within a hex digit (MSB-first assumed),
//   - whether rows are padded individually (assumed) vs. the whole
//     grid being one continuous bitstream,
//   - endianness / digit order.
// `decodeGridMap` is deliberately defensive: on any shape mismatch it
// returns an all-true grid (full coverage) instead of throwing, so a
// firmware that encodes differently degrades to "whole frame armed"
// rather than breaking the cap.

/** Hex digits needed to hold one row of `columns` cells (4 cells/digit). */
function gridRowHexLen(columns: number): number {
  return Math.ceil(columns / 4)
}

/**
 * Decode a `<gridMap>` hex string into a row-major boolean grid of
 * length `columns * rows`. Falls back to an all-true grid when the
 * input is absent/empty or its length doesn't match the expected
 * `ceil(columns/4) * rows`.
 */
function decodeGridMap(hex: string, columns: number, rows: number): boolean[] {
  const total = columns * rows
  const allTrue = (): boolean[] => Array.from({ length: Math.max(0, total) }, () => true)
  if (columns <= 0 || rows <= 0) return allTrue()
  const clean = hex.trim().toLowerCase()
  const rowHexLen = gridRowHexLen(columns)
  // Defensive fallback — absent, empty, non-hex, or wrong length.
  if (clean.length === 0) return allTrue()
  if (clean.length !== rowHexLen * rows) return allTrue()
  if (!/^[0-9a-f]+$/.test(clean)) return allTrue()

  const cells: boolean[] = []
  for (let r = 0; r < rows; r++) {
    const rowHex = clean.slice(r * rowHexLen, (r + 1) * rowHexLen)
    for (let c = 0; c < columns; c++) {
      const digit = parseInt(rowHex[Math.floor(c / 4)] ?? '0', 16)
      // MSB-first within the digit: column offset 0 → bit 0x8.
      const bit = 0x8 >> (c % 4)
      cells.push((digit & bit) !== 0)
    }
  }
  return cells
}

/**
 * Encode a row-major boolean grid back into a `<gridMap>` hex string,
 * mirroring `decodeGridMap`. Cells beyond the supplied array are
 * treated as `false`. See the codec note above — UNVERIFIED encoding.
 */
function encodeGridMap(cells: readonly boolean[], columns: number, rows: number): string {
  if (columns <= 0 || rows <= 0) return ''
  const rowHexLen = gridRowHexLen(columns)
  let out = ''
  for (let r = 0; r < rows; r++) {
    for (let d = 0; d < rowHexLen; d++) {
      let digit = 0
      for (let i = 0; i < 4; i++) {
        const c = d * 4 + i
        if (c >= columns) break
        if (cells[r * columns + c] === true) digit |= 0x8 >> i
      }
      out += digit.toString(16)
    }
  }
  return out
}

// ── XML helpers ───────────────────────────────────────────────────
//
// Hikvision's ISAPI payloads are always small flat XML — parsing with
// regex avoids pulling in a full XML library for what amounts to "find
// this tag's text content". The patterns are intentionally
// conservative: they match a single occurrence per tag, ignore
// attributes, and tolerate optional whitespace + the XML namespace
// prefix some firmwares emit (`hikvision:`).

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`,
    'i',
  )
  const m = re.exec(xml)
  return m ? decodeXmlEntities(m[1]!.trim()) : null
}

function extractAllBlocks(xml: string, tag: string): readonly string[] {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`,
    'gi',
  )
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1]!)
  return out
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function parseChannelsList(xml: string): readonly HikvisionStreamingChannel[] {
  const blocks = extractAllBlocks(xml, 'StreamingChannel')
  // `id` + the channel-level `<enabled>` come from the element-scoped parser:
  // both `<Video>` and `<Audio>` carry an `<enabled>` of their own, and a
  // first-match read inside the block returns the channel's flag only while
  // the firmware keeps emitting it first. Everything else below is unambiguous
  // (one occurrence per block) and stays on the generic tag helper.
  const summaries = new Map(
    parseStreamingChannelSummaries(xml).map((s) => [s.channelId, s] as const),
  )
  const out: HikvisionStreamingChannel[] = []
  for (const b of blocks) {
    const id = extractTag(b, 'id')
    if (!id) continue
    const enabled = summaries.get(id)?.enabled ?? true
    const codec = extractTag(b, 'videoCodecType')
    const width = parseIntSafe(extractTag(b, 'videoResolutionWidth'))
    const height = parseIntSafe(extractTag(b, 'videoResolutionHeight'))
    const maxBitrateKbps = parseIntSafe(extractTag(b, 'maxBitrate'))
    // Hikvision stores `id` as `${cameraNumber}${streamSlot}` where
    // `streamSlot` is the last digit — split deterministically.
    const cameraNumber = Math.floor(Number(id) / 100) || 1
    const streamSlot = Number(id) - cameraNumber * 100
    out.push({ id, cameraNumber, streamSlot, enabled, codec, width, height, maxBitrateKbps })
  }
  return out
}

function parseIntSafe(s: string | null): number | null {
  if (s === null) return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

function parseTwoWayAudioChannels(xml: string): readonly HikvisionTwoWayAudioChannel[] {
  const blocks = extractAllBlocks(xml, 'TwoWayAudioChannel')
  const out: HikvisionTwoWayAudioChannel[] = []
  for (const b of blocks) {
    const id = extractTag(b, 'id')
    if (!id) continue
    const audioCompressionType = extractTag(b, 'audioCompressionType')
    const audioInputType = extractTag(b, 'audioInputType')
    const enabledRaw = extractTag(b, 'enabled')
    const enabled = enabledRaw === null ? null : enabledRaw.toLowerCase() === 'true'
    out.push({ id, audioCompressionType, audioInputType, enabled })
  }
  return out
}

// ── Alarm stream parser ───────────────────────────────────────────
//
// The alarm stream (`/ISAPI/Event/notification/alertStream`) is HTTP
// keep-alive multipart. The boundary is announced in the response's
// `Content-Type: multipart/mixed; boundary=...` header. Each part
// carries either:
//   - `Content-Type: application/xml`  — an EventNotificationAlert
//     describing one event (motion, line-cross, region-entrance, ...).
//   - `Content-Type: image/jpeg`       — a cropped snapshot following a
//     smart-detection event. Optional; many firmwares omit it.
//
// `subscribeAlarms()` is a streaming consumer: it pulls a Response
// body's stream, splits on the boundary, parses each part's headers
// + body, and dispatches an `onEvent(parsed)` callback for every
// XML alert. The image bytes are passed through opaquely on the
// next pump cycle paired with the most recent XML event id (Hikvision
// transmits them in matching order).

export interface HikvisionAlarmEvent {
  /** Wall-clock ms when the parser produced the event. */
  readonly observedAt: number
  /** `eventType` tag — `VMD`, `linedetection`, `fielddetection`, … */
  readonly type: string
  /** Optional `eventState` — `active` / `inactive`. */
  readonly state: string | null
  /** Channel id reported by the camera (`<channelID>` or `<dynChannelID>`). */
  readonly channelId: string | null
  /** Smart-detection class (`<targetType>` or `<DetectionRegion><className>`). */
  readonly aiClass: string | null
  /** Description / notes — free-text, not always populated. */
  readonly description: string | null
  /** Confidence as a 0-1 float when present. */
  readonly score: number | null
  /** Raw XML payload — kept so consumers can do their own parsing. */
  readonly raw: string
}

export interface HikvisionAlarmHandlers {
  readonly onEvent: (event: HikvisionAlarmEvent) => void
  readonly onError: (err: unknown) => void
  /** Optional: invoked once when the stream connects (after the first
   *  HTTP 200 response is received). Useful for upstream "online"
   *  bookkeeping that wants to wait for a real subscription. */
  readonly onConnected?: () => void
}

/**
 * Idle watchdog for the alarm stream. Hikvision firmware emits a keep-alive
 * heartbeat (typically a `videoloss`/`inactive` alert) roughly every ~5s even
 * when nothing is happening, so a total absence of ANY bytes for this long
 * means the pipe is dead — either a half-open TCP connection (no FIN, no data)
 * that would otherwise block `reader.read()` forever, or a stalled proxy/NAT
 * conntrack entry between the hub and a camera on a different subnet. When it
 * fires we cancel the reader, surfacing a clean stream-end that the reconnect
 * path treats as a recoverable disconnect.
 */
export const ALARM_STREAM_IDLE_TIMEOUT_MS = 30_000

/**
 * Hard cap on the UNPARSED multipart buffer of a single alarm stream.
 *
 * Before this cap existed, a stream whose parts were framed with a boundary
 * token we never matched appended every byte to `bufferedBytes` forever: no
 * event, no error, no log line, and the idle watchdog stayed happy precisely
 * because bytes WERE arriving. That is roughly a megabyte per camera per day
 * of permanently-retained heap on a memory-constrained host.
 *
 * A legitimate alert part is a few hundred bytes; even an AI snapshot part is
 * well under this. Exceeding it means we are not parsing the stream at all.
 */
export const ALARM_STREAM_MAX_BUFFER_BYTES = 1_048_576

/** Bytes kept (from the END of the buffer) when the cap above trips — enough
 *  to still contain a whole part plus the boundary that frames it. */
export const ALARM_STREAM_BUFFER_RETAIN_BYTES = 65_536

/** Buffered bytes without a SINGLE boundary match before we shout about it. */
export const ALARM_STREAM_UNPARSED_WARN_BYTES = 32_768

/** Minimum gap between two identical stream diagnostics. A broken stream must
 *  not be able to flood the log: first occurrence, then a periodic line
 *  carrying how many were suppressed in between. */
export const ALARM_STREAM_DIAGNOSTIC_INTERVAL_MS = 60_000

/**
 * Per-subscription knobs. Everything is optional; the defaults above are what
 * production runs on. `logger`/`deviceId` are what make the drop paths
 * audible — without them the parser is silent exactly as it used to be.
 */
export interface HikvisionAlarmStreamOptions {
  /** Cancel a stream that has produced NO bytes for this long. `<= 0` disables
   *  the watchdog (tests drive the stream deterministically). */
  readonly idleTimeoutMs?: number
  readonly logger?: IScopedLogger
  /** Numeric device id — every diagnostic line is tagged with it so a
   *  per-camera question ("why is 1436 silent?") is answerable from the log. */
  readonly deviceId?: number
  readonly maxBufferBytes?: number
  readonly retainBytes?: number
  readonly unparsedWarnBytes?: number
  readonly diagnosticIntervalMs?: number
  /** Gap between two counts of the same ignored `(type, state)`. Defaults to
   *  `ALARM_TALLY_INTERVAL_MS`; injected by tests. */
  readonly ignoredTallyIntervalMs?: number
}

/**
 * Why the parser adopts the boundary it SEES rather than the one declared.
 *
 * Five cameras on `C-R-*` firmware (I91DN/I91DD V5.7.1, I91EV V5.8.10) have
 * never delivered one motion event here, while the same cameras deliver real
 * hardware VMD on the same endpoint to another NVR stack. The one dimension
 * where that stack is more permissive is the multipart boundary: it accepts a
 * part framed with the declared `--<boundary>` OR with the literal constant
 * `--boundary`, because "older hikvision send a boundary in the headers, but
 * then use a totally different constant boundary value".
 *
 * We take the general form instead of that special case: if the DECLARED
 * token has never once matched, adopt the token from the first `--…` line
 * actually on the wire and use it from then on. It subsumes the literal
 * `--boundary` case (that IS the observed token on those cameras) and it also
 * covers the next firmware that invents a third constant, which a hard-coded
 * fallback would not. The risk is bounded on both sides: adoption is only ever
 * attempted while the declared token has produced ZERO parts, the candidate
 * must occupy a whole line of RFC 2046 boundary characters, and the closing
 * delimiter (`--<token>--`) is rejected.
 */
function detectWireBoundary(buf: Uint8Array): string | null {
  const text = Buffer.from(buf).toString('binary')
  // Whole-line `--<token>` where <token> is RFC 2046 bchars.
  const lineRe = /(?:^|\r?\n)--([0-9A-Za-z'()+_,./:=?-]{1,70})\r?\n/g
  for (;;) {
    const m = lineRe.exec(text)
    if (!m) return null
    const token = m[1]!
    // `--<token>--` is the CLOSING delimiter, not a part boundary.
    if (token.endsWith('--')) continue
    return token
  }
}

/** Diagnostics a stream can report. One rate-limit bucket per kind. */
type AlarmDiagnosticKind =
  | 'boundary-adopted'
  | 'boundary-never-matched'
  | 'buffer-overflow'
  | 'part-unparseable'
  | 'part-not-alert-xml'
  | 'part-image-ignored'
  | 'alert-xml-without-event-type'

type AlarmDiagnosticLevel = 'warn' | 'debug'

interface AlarmDiagnostics {
  readonly report: (
    kind: AlarmDiagnosticKind,
    message: string,
    meta: Record<string, unknown>,
    level?: AlarmDiagnosticLevel,
  ) => void
}

/**
 * First occurrence of each kind is logged immediately; further occurrences are
 * counted and folded into the next line after `intervalMs`. A stream that
 * drops every part therefore costs one line per minute per kind, not one per
 * chunk.
 */
function createAlarmDiagnostics(
  logger: IScopedLogger | null,
  deviceId: number | null,
  intervalMs: number,
): AlarmDiagnostics {
  const lastLoggedAt = new Map<AlarmDiagnosticKind, number>()
  const suppressed = new Map<AlarmDiagnosticKind, number>()
  const report = (
    kind: AlarmDiagnosticKind,
    message: string,
    meta: Record<string, unknown>,
    level: AlarmDiagnosticLevel = 'warn',
  ): void => {
    if (!logger) return
    const now = Date.now()
    const last = lastLoggedAt.get(kind)
    if (last !== undefined && now - last < intervalMs) {
      suppressed.set(kind, (suppressed.get(kind) ?? 0) + 1)
      return
    }
    const since = suppressed.get(kind) ?? 0
    suppressed.set(kind, 0)
    lastLoggedAt.set(kind, now)
    const extras: LogExtras = {
      ...(deviceId === null ? {} : { tags: { deviceId } }),
      meta: { kind, ...meta, ...(since > 0 ? { suppressedSincePrevious: since } : {}) },
    }
    if (level === 'debug') logger.debug(message, extras)
    else logger.warn(message, extras)
  }
  return { report }
}

/** First line of a buffer, clipped — the single most useful field when asking
 *  "what is this camera actually sending?". */
function firstLineOf(buf: Uint8Array, maxChars: number = 120): string {
  const text = Buffer.from(buf.subarray(0, 1024)).toString('utf8')
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

/** First whole line that starts with `--` — i.e. the framing the camera really
 *  uses. `null` when the buffer contains no such line. */
function firstDashLineOf(buf: Uint8Array, maxChars: number = 120): string | null {
  const text = Buffer.from(buf.subarray(0, 4096)).toString('utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('--')) continue
    return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
  }
  return null
}

export function subscribeAlarms(
  client: HikvisionIsapiClient,
  handlers: HikvisionAlarmHandlers,
  options: HikvisionAlarmStreamOptions = {},
): AbortController {
  const controller = new AbortController()
  // Report exactly one terminal outcome, and never after a deliberate abort.
  let settled = false
  const fail = (err: unknown): void => {
    if (settled) return
    settled = true
    if (controller.signal.aborted) return
    handlers.onError(err)
  }
  void (async () => {
    try {
      const res = await client.request('/ISAPI/Event/notification/alertStream', {
        method: 'GET',
        signal: controller.signal,
        timeoutMs: null,
      })
      if (!res.ok || !res.body) {
        fail(new Error(`alarm stream HTTP ${res.status}`))
        return
      }
      const ct = res.headers.get('content-type') ?? ''
      const boundary = parseBoundary(ct)
      if (!boundary) {
        fail(new Error(`alarm stream missing multipart boundary in Content-Type: "${ct}"`))
        return
      }
      handlers.onConnected?.()
      await pumpAlarmStream(res.body, boundary, handlers, options)
      // Reaching here means the body stream ended (`done`) — the camera
      // closed the multipart connection, or our idle watchdog cancelled a
      // stalled reader. Either way the subscription is gone; surface it as a
      // recoverable disconnect so the caller reconnects.
      fail(new Error('alarm stream ended'))
    } catch (err) {
      fail(err)
    }
  })()
  return controller
}

function parseBoundary(contentType: string): string | null {
  const m = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  return m ? m[1]!.trim() : null
}

async function pumpAlarmStream(
  stream: ReadableStream<Uint8Array>,
  declaredBoundary: string,
  handlers: HikvisionAlarmHandlers,
  options: HikvisionAlarmStreamOptions,
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? ALARM_STREAM_IDLE_TIMEOUT_MS
  const maxBufferBytes = options.maxBufferBytes ?? ALARM_STREAM_MAX_BUFFER_BYTES
  const retainBytes = options.retainBytes ?? ALARM_STREAM_BUFFER_RETAIN_BYTES
  const unparsedWarnBytes = options.unparsedWarnBytes ?? ALARM_STREAM_UNPARSED_WARN_BYTES
  const diagnostics = createAlarmDiagnostics(
    options.logger ?? null,
    options.deviceId ?? null,
    options.diagnosticIntervalMs ?? ALARM_STREAM_DIAGNOSTIC_INTERVAL_MS,
  )
  // Events dropped by declared policy are counted, not logged one by one.
  const ignoredTally = createAlarmTypeTally({
    logger: options.logger ?? null,
    deviceId: options.deviceId ?? null,
    message: 'hikvision alarm stream: ignored alarm type (declared policy)',
    level: 'debug',
    ...(options.ignoredTallyIntervalMs === undefined
      ? {}
      : { intervalMs: options.ignoredTallyIntervalMs }),
  })
  const reader = stream.getReader()
  let activeBoundary = declaredBoundary
  let activeDashBoundary = `--${activeBoundary}`
  /** Has the ACTIVE token ever framed anything? Gates boundary adoption. */
  let matchedAnyBoundary = false
  /**
   * Is the fragment that precedes the next boundary junk?
   *
   * True only at the head of the stream (RFC 1521 preamble), after we already
   * emitted the bytes sitting in the buffer, and after the overflow cap cut
   * the buffer mid-part. It used to be true unconditionally, which meant every
   * split after the first DISCARDED a completed part — on a stream that
   * delivers one part per TCP read, that is every event the camera ever sent.
   */
  let dropLeadingFragment = true
  let bufferedBytes: Uint8Array = new Uint8Array(0)

  const dispatchBlock = (block: Uint8Array): void => {
    const parsed = parseMultipartBlock(block)
    if (!parsed.ok) {
      diagnostics.report('part-unparseable', 'hikvision alarm stream: multipart part dropped', {
        reason: parsed.reason,
        bytes: block.byteLength,
        firstLine: firstLineOf(block),
      })
      return
    }
    const { contentType, bodyText } = parsed.block
    // Some ColorVu/G6 firmwares omit Content-Type or send text/plain. Gate on
    // XML shape (`<eventType>` / EventNotificationAlert), not on xml/* MIME,
    // otherwise those parts are dropped and motion never fires.
    const isAlertPart =
      contentType.startsWith('application/xml') ||
      contentType.startsWith('text/xml') ||
      looksLikeAlertXml(bodyText)
    if (!isAlertPart) {
      // Image parts (image/jpeg) are received but not exposed yet — the v0.1
      // surface intentionally leaves AI-thumbnail forwarding out of scope.
      // Expected, so debug; anything else is a real unexplained drop.
      if (contentType.startsWith('image/')) {
        diagnostics.report(
          'part-image-ignored',
          'hikvision alarm stream: image part ignored (not forwarded yet)',
          { contentType, bytes: block.byteLength },
          'debug',
        )
        return
      }
      diagnostics.report(
        'part-not-alert-xml',
        'hikvision alarm stream: part dropped — neither an xml Content-Type nor alert-shaped XML',
        { contentType, bytes: block.byteLength, bodyPreview: bodyText.slice(0, 120) },
      )
      return
    }
    // Ask the cheap question FIRST: is this a type we have already decided we
    // never act on? Two regex probes answer it. Building the event first would
    // cost seven `extractTag` passes, an object retaining the whole XML in
    // `raw`, a `resolveAlarmCamStreamId` scan of the published channels, and a
    // structured log line — all of it to reach a `return`. At the measured
    // 116 events/min per fleet that is the difference between ~2 allocations a
    // second and none. The policy (and the justification for each entry) lives
    // in `hikvision-alarm-ignore.ts`; everything not listed there still reaches
    // `onEvent`.
    const peeked = peekAlertTypeState(bodyText)
    if (!peeked) {
      diagnostics.report(
        'alert-xml-without-event-type',
        'hikvision alarm stream: alert part dropped — no <eventType> tag',
        { contentType, bytes: block.byteLength, bodyPreview: bodyText.slice(0, 120) },
      )
      return
    }
    const ignoredReason = hikvisionIgnoredAlarmReason(peeked.type, peeked.state)
    if (ignoredReason !== null) {
      ignoredTally.note(peeked.type, peeked.state, ignoredReason)
      return
    }

    handlers.onEvent(parseAlertXml(bodyText, peeked))
  }

  // Idle watchdog: if no bytes arrive within `idleTimeoutMs`, cancel the
  // reader. `reader.cancel()` resolves the pending `read()` with `{done:true}`,
  // so the loop exits cleanly and the caller reconnects. A value <= 0 disables
  // the watchdog (used by tests that drive the stream deterministically).
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (idleTimeoutMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void reader.cancel().catch(() => {
        /* reader already released / errored — nothing to do */
      })
    }, idleTimeoutMs)
  }
  try {
    armIdle()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      armIdle()
      if (!value || value.byteLength === 0) continue
      bufferedBytes = concat(bufferedBytes, value)

      // Split the running buffer on the boundary. Each split yields a
      // raw block (headers + body); the trailing fragment goes back
      // into the buffer for the next pump cycle.
      let split = splitOnBoundary(bufferedBytes, activeDashBoundary, dropLeadingFragment)
      if (!split.sawBoundary && !matchedAnyBoundary) {
        const observed = detectWireBoundary(bufferedBytes)
        if (observed !== null && observed !== activeBoundary) {
          diagnostics.report(
            'boundary-adopted',
            'hikvision alarm stream: declared multipart boundary never matched — adopting the boundary seen on the wire',
            {
              declaredBoundary,
              observedBoundary: observed,
              bufferedBytes: bufferedBytes.byteLength,
              firstDashLine: firstDashLineOf(bufferedBytes),
              firstLine: firstLineOf(bufferedBytes),
            },
          )
          activeBoundary = observed
          activeDashBoundary = `--${observed}`
          split = splitOnBoundary(bufferedBytes, activeDashBoundary, dropLeadingFragment)
        }
      }
      if (split.sawBoundary) {
        matchedAnyBoundary = true
        dropLeadingFragment = false
      }
      bufferedBytes = split.tail
      for (const block of split.blocks) dispatchBlock(block)

      // Emit a part the moment its Content-Length bytes have landed, instead
      // of waiting for the NEXT boundary. On a heartbeat-free stream that wait
      // is unbounded; even with heartbeats it delivered every event one event
      // late. Only valid when the buffer starts right after a boundary.
      if (!dropLeadingFragment) {
        const early = takeCompletePart(bufferedBytes)
        if (early) {
          dispatchBlock(early.block)
          bufferedBytes = early.rest
          // What remains is the tail of an already-emitted part (typically a
          // bare CRLF) — junk in front of the next boundary.
          dropLeadingFragment = true
        }
      }

      if (!matchedAnyBoundary && bufferedBytes.byteLength >= unparsedWarnBytes) {
        diagnostics.report(
          'boundary-never-matched',
          'hikvision alarm stream: no multipart boundary found in the buffered bytes — every part is being dropped',
          {
            declaredBoundary,
            activeBoundary,
            bufferedBytes: bufferedBytes.byteLength,
            firstDashLine: firstDashLineOf(bufferedBytes),
            firstLine: firstLineOf(bufferedBytes),
          },
        )
      }
      if (bufferedBytes.byteLength > maxBufferBytes) {
        diagnostics.report(
          'buffer-overflow',
          'hikvision alarm stream: unparsed multipart buffer hit its cap — discarding the head',
          {
            declaredBoundary,
            activeBoundary,
            matchedAnyBoundary,
            bufferedBytes: bufferedBytes.byteLength,
            maxBufferBytes,
            retainBytes,
            firstDashLine: firstDashLineOf(bufferedBytes),
            firstLine: firstLineOf(bufferedBytes),
          },
        )
        // `slice` COPIES — `subarray` would keep the oversized ArrayBuffer
        // alive behind the view and defeat the whole point.
        bufferedBytes = bufferedBytes.slice(bufferedBytes.byteLength - retainBytes)
        // We just cut mid-part: whatever precedes the next boundary is junk.
        dropLeadingFragment = true
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    try {
      reader.releaseLock()
    } catch {
      /* swallow */
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

interface MultipartSplit {
  readonly blocks: readonly Uint8Array[]
  readonly tail: Uint8Array
  /** Did `dashBoundary` occur at least once in this buffer? */
  readonly sawBoundary: boolean
}

function splitOnBoundary(
  buf: Uint8Array,
  dashBoundary: string,
  dropLeadingFragment: boolean,
): MultipartSplit {
  const text = Buffer.from(buf).toString('binary')
  const parts = text.split(dashBoundary)
  if (parts.length <= 1) return { blocks: [], tail: buf, sawBoundary: false }
  // Last fragment may be a partial block — keep it in the buffer.
  const tail = Buffer.from(parts.pop()!, 'binary')
  // The fragment BEFORE the first boundary of this buffer is junk only when
  // the caller says so (stream preamble, or bytes we already emitted). Every
  // other time the buffer begins immediately after a boundary, so that
  // fragment is a COMPLETE part.
  if (dropLeadingFragment) parts.shift()
  const blocks = parts
    .filter((p) => p.length > 0 && !p.startsWith('--'))
    .map((p) => Buffer.from(p, 'binary'))
  return { blocks, tail, sawBoundary: true }
}

interface MultipartBlock {
  readonly contentType: string
  readonly bodyText: string
}

/** The only reason a raw block cannot be turned into headers + body. */
type MultipartBlockRejection = 'no-header-separator-and-not-alert-xml'

type MultipartBlockResult =
  | { readonly ok: true; readonly block: MultipartBlock }
  | { readonly ok: false; readonly reason: MultipartBlockRejection }

/** A part whose declared `Content-Length` has fully arrived, plus the bytes
 *  that follow it. */
interface CompletePart {
  readonly block: Uint8Array
  readonly rest: Uint8Array
}

function parseContentLength(headerBlob: string): number | null {
  const m = /^content-length\s*:\s*(\d+)\s*$/im.exec(headerBlob)
  if (!m) return null
  const n = Number.parseInt(m[1]!, 10)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * If `buf` (which must start immediately after a boundary) already holds a
 * whole part per its `Content-Length`, return it and the leftover bytes.
 * Firmware that omits `Content-Length` falls back to boundary-framed delivery.
 */
function takeCompletePart(buf: Uint8Array): CompletePart | null {
  const headerEnd = findHeaderEnd(buf, 0)
  if (headerEnd < 0) return null
  const headerBlob = Buffer.from(buf.subarray(0, headerEnd)).toString('utf8')
  const contentLength = parseContentLength(headerBlob)
  if (contentLength === null) return null
  const bodyStart = headerEnd + 4 // length of CRLFCRLF
  const end = bodyStart + contentLength
  if (buf.byteLength < end) return null
  return { block: buf.slice(0, end), rest: buf.slice(end) }
}

function looksLikeAlertXml(text: string): boolean {
  return text.includes('<eventType>') || text.includes('EventNotificationAlert')
}

function parseMultipartBlock(block: Uint8Array): MultipartBlockResult {
  // Do NOT skip every leading CR/LF. After the boundary the remainder is
  // typically `\r\n<headers>\r\n\r\n<body>` — or, when firmware omits
  // headers entirely, `\r\n\r\n<body>`. Eating all leading newlines used
  // to consume that empty-header delimiter, after which findHeaderEnd
  // failed and the VMD part was dropped. Do not require Content-Type
  // — scan the part body for EventNotificationAlert XML.
  const headerEnd = findHeaderEnd(block, 0)
  let headerBlob = ''
  let bodySlice: Uint8Array
  if (headerEnd >= 0) {
    headerBlob = Buffer.from(block.subarray(0, headerEnd)).toString('utf8')
    bodySlice = block.subarray(headerEnd + 4) // length of CRLFCRLF
  } else {
    // No header/body separator — treat the whole block as body if it
    // looks like an EventNotificationAlert.
    const raw = Buffer.from(block).toString('utf8')
    if (!looksLikeAlertXml(raw)) {
      return { ok: false, reason: 'no-header-separator-and-not-alert-xml' }
    }
    return { ok: true, block: { contentType: '', bodyText: raw.replace(/\r?\n--$/m, '').trim() } }
  }
  const headers: Record<string, string> = {}
  for (const line of headerBlob.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  const contentType = headers['content-type'] ?? ''
  const bodyText = Buffer.from(bodySlice)
    .toString('utf8')
    .replace(/\r?\n--$/m, '')
    .trim()
  return { ok: true, block: { contentType, bodyText } }
}

function findHeaderEnd(buf: Uint8Array, from: number): number {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a)
      return i
  }
  return -1
}

/**
 * Event types that imply onboard motion. Compared after `eventType`
 * is lowercased. Some firmwares emit `regionExit`, others
 * `regionexiting` — accept both.
 */
export function isHikvisionMotionAlarmType(type: string): boolean {
  switch (type) {
    case 'vmd':
    case 'motiondetection':
    case 'linedetection':
    case 'fielddetection':
    case 'regionentrance':
    case 'regionexit':
    case 'regionexiting':
    case 'attendedbaggage':
    case 'unattendedbaggage':
      return true
    default:
      return false
  }
}

export function isHikvisionSmartAlarmType(type: string): boolean {
  return type !== 'vmd' && type !== 'motiondetection' && isHikvisionMotionAlarmType(type)
}

/**
 * The two fields the ignore policy is keyed on, already lowercased. `null` when
 * the part carries no `<eventType>` — the only reason a well-formed alert part
 * cannot become an event.
 *
 * Deliberately split out of `parseAlertXml` rather than folded into it: this is
 * the CHEAP question, asked before the expensive one, so an event we never act
 * on costs two regex probes instead of a seven-field parse plus an object that
 * retains the whole XML payload. Keeping it pure also makes the ignore decision
 * testable without standing up a stream.
 */
interface PeekedAlertType {
  readonly type: string
  readonly state: string | null
}

export function peekAlertTypeState(xml: string): PeekedAlertType | null {
  const type = extractTag(xml, 'eventType')
  if (!type) return null
  const state = extractTag(xml, 'eventState')
  return { type: type.toLowerCase(), state: state?.toLowerCase() ?? null }
}

/**
 * Build the full event. Takes the already-peeked `(type, state)` so the two
 * tags are extracted exactly once, and so this function has no failure mode
 * left: `peekAlertTypeState` returning non-null IS the precondition, and the
 * caller has already reported the only way it can fail.
 */
function parseAlertXml(xml: string, peeked: PeekedAlertType): HikvisionAlarmEvent {
  const channelId = extractTag(xml, 'dynChannelID') ?? extractTag(xml, 'channelID')
  const description = extractTag(xml, 'eventDescription') ?? extractTag(xml, 'description')
  const aiClass = extractTag(xml, 'targetType') ?? extractTag(xml, 'className')
  const scoreRaw = extractTag(xml, 'targetProb') ?? extractTag(xml, 'similarity')
  const score =
    scoreRaw === null
      ? null
      : (() => {
          const n = parseFloat(scoreRaw)
          if (!Number.isFinite(n)) return null
          return n > 1 ? n / 100 : n
        })()
  return {
    observedAt: Date.now(),
    type: peeked.type,
    state: peeked.state,
    channelId,
    aiClass,
    description,
    score,
    raw: xml,
  }
}
