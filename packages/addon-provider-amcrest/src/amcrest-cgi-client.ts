import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { buildAuthHeader, parseChallenge, type DigestState } from './digest-auth.js'
import { pumpEventStream } from './event-stream-parts.js'

/** Connection parameters for a single camera's CGI surface. */
export interface AmcrestCgiClientOptions {
  readonly host: string
  readonly port: number
  readonly https: boolean
  readonly username: string
  readonly password: string
  /** Per-request timeout (ms). Default 8000. */
  readonly defaultTimeoutMs?: number
}

/** Device-info probe result (`magicBox.cgi`). Fields are null when the
 *  firmware omits them. */
export interface AmcrestDeviceInfo {
  readonly deviceType: string | null
  readonly serialNumber: string | null
  readonly hardwareVersion: string | null
  readonly processor: string | null
  readonly updateSerial: string | null
  readonly softwareVersion: string | null
}

/** One network interface as reported by `netApp.cgi?action=getInterfaces`. */
export interface AmcrestNetInterface {
  readonly name: string
  readonly ip: string | null
  readonly mac: string | null
  readonly connected: boolean
}

/** Dahua PTZ protocol capabilities (`ptz.cgi?action=getCurrentProtocolCaps`). */
export interface AmcrestPtzCaps {
  readonly hasPan: boolean
  readonly hasTilt: boolean
  readonly hasZoom: boolean
  readonly supportsPreset: boolean
  readonly canRemovePreset: boolean
  readonly maxPresets: number | null
}

/**
 * One parsed event from the Dahua CGI event-manager attach stream
 * (`eventManager.cgi?action=attach`). Each stream part carries a
 * `text/plain` key=value body like `Code=VideoMotion;action=Start;index=0`
 * — this is the parsed projection of that first line. The `data={…}` JSON
 * tail some firmwares append is not decoded here (motion needs only
 * code/action/index); the full block is kept in `raw` for consumers.
 */
export interface AmcrestEvent {
  /** Wall-clock ms when the chunk that completed this part arrived. */
  readonly observedAt: number
  /** `Code` field — `VideoMotion`, `SmartMotionHuman`, `Heartbeat`, … */
  readonly code: string
  /** `action` field — `Start` / `Stop` / `Pulse`. */
  readonly action: string
  /** `index` field (0-based channel/region index) when numeric, else null. */
  readonly index: number | null
  /** Raw block body — kept so consumers can do their own parsing. */
  readonly raw: string
}

/**
 * A recorded file, open for reading — what {@link AmcrestCgiClient.openRecordedFile}
 * hands back.
 *
 * `body` is the raw response stream; `null` is possible and MEANINGFUL — a
 * 200 with no body is a camera that accepted the request and produced nothing,
 * which is a named refusal and never an empty file.
 */
export interface AmcrestFileDownload {
  readonly status: number
  /** The camera's declared length, or `null` when it declared none. */
  readonly contentLength: number | null
  readonly body: ReadableStream<Uint8Array> | null
}

/** What {@link AmcrestCgiClient.openEventStream} hands back: the live
 *  `node:http` response plus the two fields the pump needs. */
export interface AmcrestEventStream {
  readonly res: IncomingMessage
  readonly statusCode: number
  readonly contentType: string
}

/** Callbacks for {@link subscribeAmcrestEvents}. */
export interface AmcrestEventHandlers {
  readonly onEvent: (event: AmcrestEvent) => void
  readonly onError: (err: unknown) => void
  /** Invoked once after the stream's first HTTP 200 — upstream "online"
   *  bookkeeping / reconnect-attempt reset hooks here. */
  readonly onConnected?: () => void
  /**
   * Invoked for a multipart block the pump could NOT turn into an event —
   * either the block had no parsable headers/body, or the body carried no
   * `Code=`/`action=` pair.
   *
   * The pump used to `continue` past both cases in silence. On a camera that
   * looks connected and never reports motion, "the camera sent nothing" and
   * "we threw away what it sent" produce identical evidence — and this repo
   * requires a branch that drops work to say so.
   */
  readonly onUnparsedBlock?: (reason: 'block' | 'body', preview: string) => void
  /**
   * Raw bytes arrived from the camera. Distinguishes "the camera sent nothing"
   * from "the camera sent data and the multipart splitter never produced a
   * block" — two states that are otherwise identical from outside, because a
   * chunk that never completes a boundary yields no event AND no dropped block.
   */
  readonly onBytes?: (byteLength: number, preview: string) => void
  /**
   * The bytes carried while waiting for a part to complete passed their cap
   * and the head was discarded (D669). The stream resyncs on the next
   * boundary; any event inside the discarded bytes is lost, and this is the
   * only line that says so.
   */
  readonly onBufferOverflow?: (droppedBytes: number, preview: string) => void
}

/**
 * Thin HTTP-Digest client for the Amcrest/Dahua CGI surface. One instance
 * per camera; the `DigestState` is reused across calls so a warm session
 * avoids the 401 round-trip on every request. All endpoints verified live
 * against an IP4M-1041B (firmware 2.800.1ENN, 2024-10-29).
 */
export class AmcrestCgiClient {
  private readonly host: string
  private readonly port: number
  private readonly scheme: 'http' | 'https'
  private readonly username: string
  private readonly password: string
  private readonly defaultTimeoutMs: number
  private readonly digestState: DigestState = { nc: 0 }

  constructor(opts: AmcrestCgiClientOptions) {
    this.host = opts.host
    this.port = opts.port
    this.scheme = opts.https ? 'https' : 'http'
    this.username = opts.username
    this.password = opts.password
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 8_000
  }

  // ── Low-level request plumbing ───────────────────────────────────

  private async send(path: string, timeoutMs?: number): Promise<Response> {
    const url = `${this.scheme}://${this.host}:${this.port}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.defaultTimeoutMs)
    try {
      const firstHeader = buildAuthHeader({
        state: this.digestState,
        method: 'GET',
        uri: path,
        username: this.username,
        password: this.password,
      })
      const firstHeaders: Record<string, string> = firstHeader ? { authorization: firstHeader } : {}
      let res = await fetch(url, {
        method: 'GET',
        headers: firstHeaders,
        signal: controller.signal,
      })
      if (res.status === 401) {
        const challenge = parseChallenge(res.headers.get('www-authenticate'))
        if (challenge) {
          this.digestState.challenge = challenge
          this.digestState.nc = 0
          const retryHeader = buildAuthHeader({
            state: this.digestState,
            method: 'GET',
            uri: path,
            username: this.username,
            password: this.password,
          })
          const retryHeaders: Record<string, string> = retryHeader
            ? { authorization: retryHeader }
            : {}
          res = await fetch(url, {
            method: 'GET',
            headers: retryHeaders,
            signal: controller.signal,
          })
        }
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET a CGI endpoint and return the response body as text. Throws on
   *  a non-2xx status so callers can `.catch()` into a null/skip path. */
  private async getText(path: string, timeoutMs?: number): Promise<string> {
    const res = await this.send(path, timeoutMs)
    if (!res.ok) throw new Error(`CGI GET ${path} → HTTP ${res.status} ${res.statusText}`)
    return res.text()
  }

  /** GET a CGI endpoint returning binary (snapshot). */
  private async getBinary(
    path: string,
    timeoutMs?: number,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.send(path, timeoutMs)
    if (!res.ok) throw new Error(`CGI GET ${path} → HTTP ${res.status} ${res.statusText}`)
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const ab = await res.arrayBuffer()
    return { buffer: Buffer.from(ab), contentType }
  }

  // ── Dahua table parsing ──────────────────────────────────────────

  /**
   * Parse a Dahua CGI response body (`table.X.Y=value` / `caps.X=value` /
   * bare `key=value` lines) into a flat map keyed WITHOUT the leading
   * `table.` / `caps.` prefix. `Encode[0].MainFormat[0].Video.FPS=30`
   * becomes key `Encode[0].MainFormat[0].Video.FPS` → `30`.
   */
  static parseTable(body: string): Map<string, string> {
    const out = new Map<string, string>()
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      let key = line.slice(0, eq)
      const value = line.slice(eq + 1)
      if (key.startsWith('table.')) key = key.slice('table.'.length)
      else if (key.startsWith('caps.')) key = key.slice('caps.'.length)
      out.set(key, value)
    }
    return out
  }

  // ── Device info + network ────────────────────────────────────────

  async getDeviceInfo(): Promise<AmcrestDeviceInfo> {
    const sys = AmcrestCgiClient.parseTable(
      await this.getText('/cgi-bin/magicBox.cgi?action=getSystemInfo'),
    )
    let softwareVersion: string | null = null
    try {
      const ver = AmcrestCgiClient.parseTable(
        await this.getText('/cgi-bin/magicBox.cgi?action=getSoftwareVersion'),
      )
      softwareVersion = ver.get('version') ?? null
    } catch {
      // best-effort — some firmwares fold version into getSystemInfo only
    }
    return {
      deviceType: sys.get('deviceType') ?? null,
      serialNumber: sys.get('serialNumber') ?? null,
      hardwareVersion: sys.get('hardwareVersion') ?? null,
      processor: sys.get('processor') ?? null,
      updateSerial: sys.get('updateSerial') ?? null,
      softwareVersion,
    }
  }

  /** Enumerate network interfaces (`netApp.cgi?action=getInterfaces`). */
  async getNetworkInterfaces(): Promise<readonly AmcrestNetInterface[]> {
    const t = AmcrestCgiClient.parseTable(
      await this.getText('/cgi-bin/netApp.cgi?action=getInterfaces'),
    )
    const byIndex = new Map<number, { name?: string; mac?: string; connected?: boolean }>()
    for (const [key, value] of t) {
      const m = /^netInterface\[(\d+)\]\.(\w+)$/.exec(key)
      if (!m) continue
      const idx = Number.parseInt(m[1]!, 10)
      const field = m[2]!
      const entry = byIndex.get(idx) ?? {}
      if (field === 'Name') entry.name = value
      else if (field === 'PhysicalAddress') entry.mac = value
      else if (field === 'ConnStatus') entry.connected = value === 'Connected'
      byIndex.set(idx, entry)
    }
    // IP per interface lives under the `Network` config; fetch it to bind
    // MAC↔IP so `resolveMac` can pick the interface serving `host`.
    const ipByName = new Map<string, string>()
    try {
      const net = AmcrestCgiClient.parseTable(
        await this.getText('/cgi-bin/configManager.cgi?action=getConfig&name=Network'),
      )
      for (const [key, value] of net) {
        const m = /^Network\.(\w+)\.IPAddress$/.exec(key)
        if (m) ipByName.set(m[1]!, value)
      }
    } catch {
      // best-effort — leave IPs unresolved; resolveMac falls back to the
      // first connected interface.
    }
    return [...byIndex.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([, e]): AmcrestNetInterface => {
        const name = e.name ?? ''
        return {
          name,
          ip: ipByName.get(name) ?? null,
          mac: e.mac ?? null,
          connected: e.connected ?? false,
        }
      })
  }

  /**
   * Resolve the MAC of the interface that serves `hostIp` (the address the
   * operator typed). Falls back to the first connected interface, then the
   * first interface with a MAC. Returns null when nothing usable is found.
   */
  async resolveMac(hostIp: string): Promise<string | null> {
    const ifaces = await this.getNetworkInterfaces()
    const byIp = ifaces.find((i) => i.ip === hostIp && i.mac)
    if (byIp?.mac) return byIp.mac
    const connected = ifaces.find((i) => i.connected && i.mac)
    if (connected?.mac) return connected.mac
    return ifaces.find((i) => i.mac)?.mac ?? null
  }

  // ── Snapshot ─────────────────────────────────────────────────────

  async getSnapshot(channel: number): Promise<{ buffer: Buffer; contentType: string }> {
    return this.getBinary(`/cgi-bin/snapshot.cgi?channel=${channel}`)
  }

  // ── Config get/set ───────────────────────────────────────────────

  /** Read one named config block into a flat Dahua-table map. */
  async getConfig(name: string): Promise<Map<string, string>> {
    return AmcrestCgiClient.parseTable(
      await this.getText(
        `/cgi-bin/configManager.cgi?action=getConfig&name=${encodeURIComponent(name)}`,
      ),
    )
  }

  /**
   * Read SEVERAL named config blocks in one round-trip — the Dahua CGI
   * accepts repeated `name=` params and concatenates the tables
   * (verified live: `getConfig&name=LightGlobal&name=NTP` returns both).
   * Keys across blocks never collide (each is prefixed with its table
   * name), so one flat map holds them all.
   */
  async getConfigs(names: readonly string[]): Promise<Map<string, string>> {
    const query = names.map((n) => `name=${encodeURIComponent(n)}`).join('&')
    return AmcrestCgiClient.parseTable(
      await this.getText(`/cgi-bin/configManager.cgi?action=getConfig&${query}`),
    )
  }

  /**
   * Write config values. Keys are raw Dahua paths (e.g.
   * `VideoColor[0][0].Brightness`); brackets are passed through unescaped
   * (Dahua requires them literal) and only values are URL-encoded.
   *
   * **Every key must belong to the SAME config table.** Measured on an
   * IP4M-1041B (2026-09-23): `MediaGlobal.PacketLength=6&Record[0].PreRecord=4`
   * answered `200 OK` and applied only `MediaGlobal`; with the operands
   * swapped, only `Record` changed. Within one table the write IS atomic —
   * two keys both land, and one bad key rejects the pair with a body of
   * `Error` under HTTP 200, which is why success is decided on the body
   * and never on the status code.
   */
  async setConfig(params: Readonly<Record<string, string | number | boolean>>): Promise<void> {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    const body = await this.getText(`/cgi-bin/configManager.cgi?action=setConfig&${query}`)
    // Dahua returns `OK` on success; anything else is an error surface.
    if (!/\bOK\b/i.test(body)) {
      throw new Error(`setConfig rejected: ${body.trim().slice(0, 200)}`)
    }
  }

  // ── Onboard recording + storage (`recording-onboard`) ────────────

  /**
   * Read the camera's own storage inventory.
   *
   * `storageDevice.cgi?action=getDeviceAllInfo` — verified 200 on an
   * IP4M-1041B, serving the same rows RPC2's `storage.getDeviceAllInfo`
   * returns, so this cap needs no RPC2 session. (`action=getCaps` on the
   * same CGI is 501 on this firmware; the record caps come from
   * {@link getRecordManagerCaps} instead.)
   */
  async getStorageDeviceAllInfo(): Promise<Map<string, string>> {
    return AmcrestCgiClient.parseTable(
      await this.getText('/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo'),
    )
  }

  /**
   * Open a recorded FILE for reading — `GET /cgi-bin/RPC_Loadfile<FilePath>`.
   *
   * Measured on device 3836 (2026-09-23): **200**, a `content-length` that is
   * byte-exact against the catalog row's `Length`, TTFB 142–211 ms, 2.87–3.5
   * MB/s, and a genuine self-contained ISO MP4 with an AAC track. Three
   * simultaneous pulls of three files all completed byte-exact and nothing
   * wedged afterwards — the opposite of the Reolink behaviour D611 records.
   *
   * Two hazards a caller MUST handle, both measured:
   *
   * - **`Range` is ignored.** 200 with the whole body and no `content-range`,
   *   on every form tried. There is no partial read of a recorded file.
   * - **A path that does not exist closes the TCP socket with zero bytes and
   *   NO HTTP status.** A real path answers 200 on the same endpoint, so the
   *   bare close specifically means "not found" — and it reaches the caller as
   *   a thrown transport error, which must become a NAMED refusal and never an
   *   absence (D611).
   *
   * `content-type` is `application/http` — not a media type. It is deliberately
   * not returned: a consumer that trusted it would mislabel an MP4.
   */
  async openRecordedFile(filePath: string, timeoutMs?: number): Promise<AmcrestFileDownload> {
    // The camera's own path is absolute and already URL-shaped apart from the
    // brackets it puts in a file name; every segment is encoded, and the
    // separators are put back, so `[M][0@0][0]` cannot be read as a query.
    const encoded = filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const res = await this.send(`/cgi-bin/RPC_Loadfile${encoded}`, timeoutMs)
    const declared = res.headers.get('content-length')
    const contentLength = declared === null ? null : Number(declared)
    return {
      status: res.status,
      // `null` when the camera did not declare one — never 0, which would say
      // the file is empty (D393).
      contentLength:
        contentLength !== null && Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : null,
      body: res.body,
    }
  }

  /**
   * What time the camera thinks it is, VERBATIM — `result=2026-09-23 11:29:27`.
   *
   * Its own LOCAL wall clock, with no zone on it, and the only thing that can
   * say what that clock is: measured 2026-09-23 answering `11:29:27` against a
   * host UTC of `09:29:27`. Everything the clip catalog sends or reads is in
   * this clock, so `clip-clock.ts` turns this string into the one offset the
   * whole clip path uses. Parsed there, never here: a read that failed must
   * reach the caller as a failure, not as a zero offset that looks like UTC.
   */
  async getCurrentTime(): Promise<string> {
    return await this.getText('/cgi-bin/global.cgi?action=getCurrentTime')
  }

  /**
   * The camera's own statement of what it accepts for recording —
   * `MaxPreRecordTime`, `PacketLengthRange[0..1]`, `SupportHoliday`.
   */
  async getRecordManagerCaps(): Promise<Map<string, string>> {
    return AmcrestCgiClient.parseTable(
      await this.getText('/cgi-bin/recordManager.cgi?action=getCaps'),
    )
  }

  /**
   * The camera's own statement of what an event handler accepts —
   * `RecordLatch[0..1]` is the post-record bound.
   */
  async getEventManagerCaps(): Promise<Map<string, string>> {
    return AmcrestCgiClient.parseTable(
      await this.getText('/cgi-bin/eventManager.cgi?action=getCaps'),
    )
  }

  // ── Event-manager attach stream (onboard motion) ─────────────────

  /**
   * Open the Dahua CGI event-manager attach stream — a long-lived
   * `multipart/x-mixed-replace` GET that pushes camera events
   * (`VideoMotion` Start/Stop, heartbeats, …) until the connection drops
   * or the caller aborts. Performs the same digest handshake as `send`
   * (absorbing the initial 401) but — critically — installs NO
   * per-request timeout: the long-poll must never self-cancel, so
   * teardown is driven solely by `signal.abort()`. `codes` is passed
   * through unescaped (Dahua requires the literal `[...]` brackets, same
   * as `setConfig`), e.g. `'[VideoMotion]'` or `'[All]'`.
   */
  async openEventStream(codes: string, signal: AbortSignal): Promise<AmcrestEventStream> {
    const path = eventStreamPath(codes)
    const first = await this.dialEventStream(path, signal)
    if (first.res.statusCode !== 401) return first

    // Absorb the challenge and retry authenticated. The 401 body must be
    // drained so the socket can be released.
    first.res.resume()
    const challenge = parseChallenge(first.res.headers['www-authenticate'] ?? null)
    if (!challenge) return first
    this.digestState.challenge = challenge
    this.digestState.nc = 0
    return this.dialEventStream(path, signal)
  }

  /**
   * One `node:http` GET for the long-poll attach stream.
   *
   * Deliberately NOT `fetch`. Two things this needs that the fetch path could
   * not give: the raw socket, so `setKeepAlive` can be armed (a silently
   * half-open long-poll is indistinguishable from a quiet camera), and a
   * connection that is never taken from the shared keep-alive pool the other
   * CGI calls use. Measured 2026-09-04 against an IP4M-1041B: with `fetch`
   * the request answered 200 with a valid multipart boundary and the socket
   * stayed ESTABLISHED, yet not one byte of body ever arrived — while two
   * hand-rolled subscriptions to the SAME camera, with the same `codes`
   * filter and at the same moment, both received the events.
   */
  private dialEventStream(path: string, signal: AbortSignal): Promise<AmcrestEventStream> {
    const authHeader = buildAuthHeader({
      state: this.digestState,
      method: 'GET',
      uri: path,
      username: this.username,
      password: this.password,
    })
    const headers: Record<string, string> = { connection: 'keep-alive' }
    if (authHeader) headers['authorization'] = authHeader
    const doRequest = this.scheme === 'https' ? httpsRequest : httpRequest
    return new Promise<AmcrestEventStream>((resolve, reject) => {
      const req = doRequest(
        {
          host: this.host,
          port: this.port,
          path,
          method: 'GET',
          headers,
          // The long-poll must never self-cancel; teardown is `signal.abort()`.
          timeout: 0,
          ...(this.scheme === 'https' ? { rejectUnauthorized: false } : {}),
        },
        (res: IncomingMessage) => {
          resolve({
            res,
            statusCode: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? '',
          })
        },
      )
      req.on('socket', (socket) => {
        // What the fetch path could not do: without this a half-open
        // long-poll never errors and never yields.
        socket.setKeepAlive(true, 10_000)
        socket.setNoDelay(true)
      })
      req.on('error', (err) => reject(err))
      signal.addEventListener('abort', () => req.destroy(), { once: true })
      req.end()
    })
  }

  // ── Encode (stream-params) ───────────────────────────────────────

  async getEncodeConfig(): Promise<Map<string, string>> {
    return this.getConfig('Encode')
  }

  async getEncodeCaps(): Promise<Map<string, string>> {
    return AmcrestCgiClient.parseTable(
      await this.getText('/cgi-bin/encode.cgi?action=getConfigCaps'),
    )
  }

  // ── PTZ ──────────────────────────────────────────────────────────

  async getPtzCaps(channel: number): Promise<AmcrestPtzCaps | null> {
    let t: Map<string, string>
    try {
      t = AmcrestCgiClient.parseTable(
        await this.getText(`/cgi-bin/ptz.cgi?action=getCurrentProtocolCaps&channel=${channel}`),
      )
    } catch {
      return null
    }
    const truthy = (k: string): boolean => t.get(k) === 'true'
    const presetMaxRaw = t.get('PresetMax')
    const maxPresets = presetMaxRaw ? Number.parseInt(presetMaxRaw, 10) : null
    return {
      hasPan: truthy('Pan'),
      // Dahua reports pan+tilt jointly under `Pan`/`MoveAbsolutely`; there is
      // no separate `Tilt` cap key. Treat tilt as available whenever pan is.
      hasTilt: truthy('Pan'),
      hasZoom: truthy('Zoom'),
      supportsPreset: truthy('Preset'),
      canRemovePreset: truthy('RemovePreset'),
      maxPresets: maxPresets !== null && Number.isFinite(maxPresets) ? maxPresets : null,
    }
  }

  /** Begin a continuous PTZ move. `code` is a Dahua direction token
   *  (`Left`/`Right`/`Up`/`Down`/`ZoomTele`/`ZoomWide`). `speed` maps to
   *  arg2 (1..8 typical). `timeoutMs` (optional) lets the caller pass a
   *  short per-tick deadline so a slow/blocked camera round-trip fails
   *  fast rather than hanging the whole cap call. The Dahua `start`
   *  action is fire-and-return — the head keeps moving until a matching
   *  `stop` is sent — so this must resolve quickly. */
  async ptzStart(channel: number, code: string, speed: number, timeoutMs?: number): Promise<void> {
    await this.getText(
      `/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=${code}&arg1=0&arg2=${speed}&arg3=0`,
      timeoutMs,
    )
  }

  async ptzStop(channel: number, code: string, timeoutMs?: number): Promise<void> {
    await this.getText(
      `/cgi-bin/ptz.cgi?action=stop&channel=${channel}&code=${code}&arg1=0&arg2=0&arg3=0`,
      timeoutMs,
    )
  }

  async ptzGotoPreset(channel: number, presetId: number, timeoutMs?: number): Promise<void> {
    await this.getText(
      `/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=GotoPreset&arg1=0&arg2=${presetId}&arg3=0`,
      timeoutMs,
    )
  }

  async ptzSetPreset(channel: number, presetId: number, timeoutMs?: number): Promise<void> {
    await this.getText(
      `/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=SetPreset&arg1=0&arg2=${presetId}&arg3=0`,
      timeoutMs,
    )
  }

  async ptzClearPreset(channel: number, presetId: number, timeoutMs?: number): Promise<void> {
    await this.getText(
      `/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=ClearPreset&arg1=0&arg2=${presetId}&arg3=0`,
      timeoutMs,
    )
  }

  /** Read stored PTZ presets from the `PtzPreset` config block. */
  async getPtzPresets(channel: number): Promise<readonly { id: number; name: string }[]> {
    let t: Map<string, string>
    try {
      t = await this.getConfig('PtzPreset')
    } catch {
      return []
    }
    // Dahua exposes a fixed array of preset SLOTS (this camera: 25), each with
    // `.Enable` + `.Name` + `.Position`. An unconfigured slot is
    // `Enable=false` with a placeholder `Name=PresetN` and a zero position —
    // returning those made the UI list 25 phantom presets that can't be
    // recalled/deleted. Only surface slots the operator actually SET
    // (`Enable=true`). The array index is 0-based, but Dahua's PTZ preset
    // COMMANDS (`GotoPreset/SetPreset/ClearPreset arg2`) are 1-based — expose
    // the 1-based preset number as the id so recall/save/delete round-trip.
    const ch = channel - 1
    const names = new Map<number, string>()
    const enabled = new Set<number>()
    for (const [key, value] of t) {
      const nameMatch = new RegExp(`^PtzPreset\\[${ch}\\]\\[(\\d+)\\]\\.Name$`).exec(key)
      if (nameMatch) {
        names.set(Number.parseInt(nameMatch[1]!, 10), value)
        continue
      }
      const enableMatch = new RegExp(`^PtzPreset\\[${ch}\\]\\[(\\d+)\\]\\.Enable$`).exec(key)
      if (enableMatch && value.trim().toLowerCase() === 'true') {
        enabled.add(Number.parseInt(enableMatch[1]!, 10))
      }
    }
    return [...enabled]
      .toSorted((a, b) => a - b)
      .map((idx) => ({
        id: idx + 1,
        name: names.get(idx) || `Preset ${idx + 1}`,
      }))
  }
}

/**
 * Seconds between the `Heartbeat` parts the camera is asked to send. They are
 * keep-alives, never events (D669): a quiet camera and a dead stream stop
 * looking identical, and a proxy that holds a response until the next part
 * arrives still releases one within this bound.
 */
export const EVENT_STREAM_HEARTBEAT_S = 5

/** The attach path — `codes` unescaped, because Dahua requires the literal `[...]`. */
export function eventStreamPath(codes: string): string {
  return `/cgi-bin/eventManager.cgi?action=attach&codes=${codes}&heartbeat=${EVENT_STREAM_HEARTBEAT_S}`
}

/**
 * Subscribe to a camera's Dahua CGI event-manager attach stream. Returns
 * an `AbortController` — `controller.abort()` tears the subscription
 * down. Reconnect logic is the caller's responsibility (the parser stays
 * simple; the device class owns lifecycle / backoff timing). Mirrors the
 * Hikvision provider's `subscribeAlarms` shape so both HTTP-stream
 * providers read the same way.
 *
 * Unlike Hikvision's XML alert stream, Dahua parts are `text/plain`
 * key=value blocks, read and projected in `event-stream-parts.ts`. A part is
 * delivered when it is complete, never when the next one begins (D669).
 */
export function subscribeAmcrestEvents(
  client: AmcrestCgiClient,
  codes: string,
  handlers: AmcrestEventHandlers,
): AbortController {
  const controller = new AbortController()
  void (async () => {
    try {
      const opened = await client.openEventStream(codes, controller.signal)
      if (opened.statusCode < 200 || opened.statusCode >= 300) {
        opened.res.resume()
        handlers.onError(new Error(`event stream HTTP ${opened.statusCode}`))
        return
      }
      const ct = opened.contentType
      const boundary = parseBoundary(ct)
      if (!boundary) {
        handlers.onError(
          new Error(`event stream missing multipart boundary in Content-Type: "${ct}"`),
        )
        return
      }
      handlers.onConnected?.()
      await pumpEventStream(opened.res, boundary, handlers)
      // A clean end (camera closed the keep-alive) is not an abort — surface
      // it as an error so the caller reconnects. An abort-driven teardown is
      // caught below and returns silently instead.
      if (!controller.signal.aborted) handlers.onError(new Error('event stream ended'))
    } catch (err) {
      if (controller.signal.aborted) return
      handlers.onError(err)
    }
  })()
  return controller
}

function parseBoundary(contentType: string): string | null {
  const m = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  return m ? m[1]!.trim() : null
}
