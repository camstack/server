/**
 * The addon's two data-plane handlers — the still and the bytes.
 *
 * Both are hosted by `ctx.dataPlane.serve({ access: 'authenticated' })`, so
 * the hub authenticates and reverse-proxies and the addon produces the bytes.
 * **Neither puts a token in its URL.** The hub's `/addon/<id>/<prefix>` proxy
 * reads the credential from `authorization` OR the session cookie, which the
 * admin UI sets at login, and the recorder's own playback plane already
 * carries no token. So a clip URL may sit in history, in a `Referer` or in a
 * shared log and open nothing (D549 22).
 *
 * ## The 204 contract
 *
 * A missing thumbnail is never a blank tile and never a hung request. The
 * route answers `204` with `x-camstack-reason` — `queue-full`, `sleeping`,
 * `camera-refused`, `no-keyframe` — because a queue overflow and a sleeping
 * camera are two different operator actions and the tile has room to say
 * which. Waiting instead would hold a request open behind a camera that is
 * asleep for the night.
 *
 * **And it says whether to COME BACK.** Those reasons are two kinds of answer:
 * `queue-full` and `camera-backoff` mean the still is still coming, the rest
 * mean it will not. The branch that refused decides — nothing here maps a code
 * to a disposition, and no client parses one out of the prose — and the answer
 * travels as its own headers (`x-camstack-reason-code`,
 * `x-camstack-disposition`, plus `retry-after` on a deferred one) beside the
 * prose, which stays verbatim because a `camera-refused` is only ever
 * explained by the camera's own words.
 *
 * A response with no disposition header is read as FINAL by every surface,
 * which is exactly how this route behaved before: an older addon under a newer
 * admin UI keeps the old behaviour instead of gaining a retry loop.
 *
 * ## Why Range is hand-rolled here
 *
 * One file, one path, no root mapping — and `createReadStream().pipe(res)`
 * gives backpressure natively, which is the whole reason the data plane hands
 * an addon the REAL `res` (D447: a raw HTTP stream reads no chunk the socket
 * has not taken).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  CLIP_STILL_DISPOSITION_HEADER,
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  clipReasonHeaderValue,
  CLIP_STREAM_TRANSPORT_HEADER,
  type IScopedLogger,
} from '@camstack/types'
import type { ClipStreamAudioAsk } from './clip-stream.js'
import { type MintRefusal, type MintResult, refuseStill } from './clip-still-refusal.js'
import type { ClipTwin } from './clip-twins.js'

export type { MintRefusal, MintResult }

/** URL namespaces under `/addon/provider-reolink/`. */
export const CLIP_THUMB_PREFIX = 'clip-thumb'
export const CLIP_MEDIA_PREFIX = 'clip'

/** A clip key is a hex digest; nothing else may reach the filesystem. */
const THUMB_PATH = /^\/(\d+)\/([A-Za-z0-9_-]{1,128})$/
const MEDIA_PATH = /^\/(\d+)\/([A-Za-z0-9_-]{1,128})\.mp4$/

export interface ClipThumbHandlerDeps {
  /** The VOUCHED cache read — bytes only when a real JPEG is on disk. */
  readCached(deviceId: number, clipKey: string): Promise<Buffer | null>
  mint(deviceId: number, clipKey: string): Promise<MintResult>
  readonly logger: IScopedLogger
}

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  return query === -1 ? raw : raw.slice(0, query)
}

export function createClipThumbHandler(
  deps: ClipThumbHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const match = THUMB_PATH.exec(pathnameOf(req))
    if (match === null) {
      res.writeHead(400)
      res.end()
      return
    }
    const deviceId = Number(match[1])
    const clipKey = match[2] ?? ''

    const cached = await deps.readCached(deviceId, clipKey)
    if (cached !== null) {
      writeJpeg(res, cached, req.method === 'HEAD')
      return
    }

    let minted: MintResult
    try {
      minted = await deps.mint(deviceId, clipKey)
    } catch (err: unknown) {
      // A throw that escaped the service is the camera refusing, and nothing
      // a retry fixes within this tile's life.
      minted = refuseStill('camera-refused', err instanceof Error ? err.message : String(err))
    }
    if (!minted.ok) {
      writeRefusal(res, minted, deviceId, deps.logger, clipKey)
      return
    }
    writeJpeg(res, minted.bytes, req.method === 'HEAD')
  }
}

/**
 * The 204, with everything the tile needs to decide what to draw next.
 *
 * A FINAL refusal is work that was dropped, so it is warned, per camera. A
 * DEFERRED one dropped nothing — the still is queued behind another — and
 * warning it would put 43 lines on the log for one 60-tile page against a
 * 16-deep lane, which is how a real drop stops being visible.
 */
function writeRefusal(
  res: ServerResponse,
  refusal: MintRefusal,
  deviceId: number,
  logger: IScopedLogger,
  clipKey: string,
): void {
  const line = 'videoclips: thumbnail not minted'
  const extras = {
    tags: { deviceId },
    meta: {
      clipKey,
      code: refusal.code,
      disposition: refusal.disposition,
      reason: refusal.reason,
    },
  }
  if (refusal.disposition === 'final') logger.warn(line, extras)
  else logger.debug(line, extras)

  const retryAfterMs = refusal.disposition === 'deferred' ? refusal.retryAfterMs : undefined
  res.writeHead(204, {
    [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(refusal.reason),
    [CLIP_STILL_REASON_CODE_HEADER]: refusal.code,
    [CLIP_STILL_DISPOSITION_HEADER]: refusal.disposition,
    ...(retryAfterMs === undefined
      ? {}
      : { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }),
  })
  res.end()
}

function writeJpeg(res: ServerResponse, bytes: Buffer, headOnly: boolean): void {
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': String(bytes.byteLength),
    // A clip is a file and its first frame does not change: the artifact is
    // immutable and the browser may keep it forever.
    'cache-control': 'private, max-age=31536000, immutable',
  })
  if (headOnly) {
    res.end()
    return
  }
  res.end(bytes)
}

export interface ClipPlaybackHandlerDeps {
  /** Prepare (or find) the muxed MP4 for this clip; `null` when it cannot be. */
  resolvePath(deviceId: number, clipKey: string, req: IncomingMessage): Promise<string | null>
  readonly logger: IScopedLogger
}

interface ByteRange {
  readonly start: number
  readonly end: number
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n`. `null` = no range; `'unsatisfiable'`
 *  is a 416 rather than a silently empty 206. */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (length <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

export function createClipPlaybackHandler(
  deps: ClipPlaybackHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const match = MEDIA_PATH.exec(pathnameOf(req))
    if (match === null) {
      res.writeHead(400)
      res.end()
      return
    }
    const deviceId = Number(match[1])
    const clipKey = match[2] ?? ''

    let path: string | null
    try {
      path = await deps.resolvePath(deviceId, clipKey, req)
    } catch (err: unknown) {
      deps.logger.warn('videoclips: could not prepare a clip for playback', {
        tags: { deviceId },
        meta: { clipKey, error: err instanceof Error ? err.message : String(err) },
      })
      res.writeHead(500)
      res.end()
      return
    }
    if (path === null) {
      res.writeHead(404)
      res.end()
      return
    }

    const size = (await stat(path)).size
    const base = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      // The file is a derived artifact of an immutable recording, but it lives
      // in a bounded LRU: a client must not hold it past the session.
      'cache-control': 'private, max-age=0, must-revalidate',
    }

    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    if (range === null) {
      res.writeHead(200, { ...base, 'content-length': String(size) })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(path).pipe(res)
      return
    }
    res.writeHead(206, {
      ...base,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(path, { start: range.start, end: range.end }).pipe(res)
  }
}

// ── the stream ────────────────────────────────────────────────────────────

/**
 * `/addon/provider-reolink/clip-stream/<deviceId>/<clipKey>.mp4` — the same
 * recording as `clip/…`, served as it ARRIVES from the camera.
 *
 * **Not `Range`-able, and it says so.** The response has no length: it is a
 * fragmented MP4 written by an ffmpeg that is still reading the camera when
 * the first byte leaves. So there is no `content-length`, `accept-ranges` is
 * `none`, a `Range` header is IGNORED (a 206 over something with no length
 * would be a lie), and the peer may not cache it (`no-store`) — a stream is
 * not an immutable artifact, the file route is. The status line is written
 * on the first muxed byte, never before: until then every refusal still owns
 * it, and a camera that serves nothing answers a status with a reason, not an
 * empty 200 (D391).
 *
 * `HEAD` answers the headers and touches no camera.
 */
export const CLIP_STREAM_PREFIX = 'clip-stream'

/** The stream route's own statement of what it is — spelled in `@camstack/types`
 *  because the broker reads it back (D597). */
export { CLIP_STREAM_TRANSPORT_HEADER }

/** Why the route answered a status instead of bytes. Every one is logged
 *  where it was decided, with `tags: { deviceId }`. */
export type ClipStreamRouteRefusalCode =
  | 'unknown-device'
  | 'sleeping'
  | 'uid-missing'
  | 'no-catalog-row'
  | 'clip-in-progress'
  | 'camera-refused'
  | 'fetch-failed'

export type ClipStreamRouteOutcome =
  | { readonly kind: 'served' }
  /** Bytes had reached the peer and the sink is already destroyed. */
  | { readonly kind: 'cut' }
  | { readonly kind: 'refused'; readonly code: ClipStreamRouteRefusalCode; readonly detail: string }

/** The peer as the producer sees it — `clip-stream.ts`'s `ClipStreamSink`. */
export interface ClipStreamRouteSink {
  begin(contentType: string): void
  write(chunk: Buffer): boolean
  onceDrain(listener: () => void): void
  onceClose(listener: () => void): void
  end(): void
  destroy(): void
}

/** Which clip a stream request names, and what it asks the stream to carry. */
export interface ClipStreamTarget {
  readonly deviceId: number
  readonly clipKey: string
  /**
   * Which twin to OPEN. Since D599 the stream serves every profile and the
   * dial's answer states which one it carries; before D600 the answer said
   * `high` and the route opened the sub file regardless, which is the 33x
   * substitution D576 forbids, told rather than hidden. The ask travels here
   * so the two cannot disagree.
   */
  readonly twin: ClipTwin
  /**
   * Which audio codec to MUX (D600). Stated at the boundary, never defaulted
   * deeper in: the data-plane form has no session to negotiate with and says
   * `none`, the dial says what the broker negotiated.
   */
  readonly audio: ClipStreamAudioAsk
}

/**
 * How a request names its clip, resolved BEFORE anything else. The data
 * plane reads it off the path (`/<deviceId>/<clipKey>.mp4`); the dial
 * listener (D597) reads it off a one-shot token. A refusal here is a status
 * and a reason, exactly like a refusal from the producer.
 */
export type ClipStreamTargetResolution =
  | { readonly kind: 'target'; readonly target: ClipStreamTarget }
  | {
      readonly kind: 'refused'
      readonly status: 400 | 404 | 410
      readonly code: 'bad-path' | 'dial-unknown' | 'dial-expired' | 'dial-used'
      readonly detail: string
    }

export type ClipStreamTargetResolver = (req: IncomingMessage) => ClipStreamTargetResolution

export interface ClipStreamHandlerDeps {
  /** Run the gates and stream the clip into `sink`. Never throws for a gated
   *  branch; a throw is a defect and is answered 500. */
  stream(target: ClipStreamTarget, sink: ClipStreamRouteSink): Promise<ClipStreamRouteOutcome>
  readonly logger: IScopedLogger
  /** Absent ⇒ the path form, `/<deviceId>/<clipKey>.mp4`. */
  readonly target?: ClipStreamTargetResolver
}

/** The data plane's own form: the clip is named on the path. */
export const resolveClipStreamPathTarget: ClipStreamTargetResolver = (req) => {
  const match = MEDIA_PATH.exec(pathnameOf(req))
  if (match === null) {
    return {
      kind: 'refused',
      status: 400,
      code: 'bad-path',
      detail: 'not /<deviceId>/<clipKey>.mp4',
    }
  }
  return {
    kind: 'target',
    // The path form names no twin and negotiates no codec: the sub file and
    // no sound, said rather than assumed.
    target: { deviceId: Number(match[1]), clipKey: match[2] ?? '', twin: 'sub', audio: 'none' },
  }
}

/**
 * Everything but the content type, which the MUX decides: a stream carrying
 * µ-law is a QuickTime container (measured — ffmpeg's MP4 muxer refuses
 * `pcm_mulaw`), and a header that said `video/mp4` for it would be a small
 * lie on a plane whose whole point is saying what it really serves.
 */
const STREAM_HEADERS = {
  'accept-ranges': 'none',
  'cache-control': 'no-store',
  [CLIP_STREAM_TRANSPORT_HEADER]: 'forward-only',
} as const

/** The status a refusal answers. `404` = nothing here to serve; `409` = a
 *  clip that exists and cannot be served right now; `502` = the camera. */
function streamRefusalStatus(code: ClipStreamRouteRefusalCode): 404 | 409 | 502 {
  switch (code) {
    case 'unknown-device':
    case 'no-catalog-row':
      return 404
    case 'sleeping':
    case 'uid-missing':
    case 'clip-in-progress':
      return 409
    case 'camera-refused':
    case 'fetch-failed':
      return 502
  }
}

export function createClipStreamHandler(
  deps: ClipStreamHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const resolveTarget = deps.target ?? resolveClipStreamPathTarget
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const resolved = resolveTarget(req)
    if (resolved.kind === 'refused') {
      // A request that names no clip names no camera either: the one line
      // this route writes without a device tag, and it says why.
      deps.logger.warn('videoclips: clip stream request names no clip', {
        meta: { code: resolved.code, reason: resolved.detail, status: resolved.status },
      })
      res.writeHead(resolved.status, {
        [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(resolved.detail),
        [CLIP_STILL_REASON_CODE_HEADER]: resolved.code,
      })
      res.end()
      return
    }
    const { deviceId, clipKey } = resolved.target
    if (req.method === 'HEAD') {
      // A HEAD takes no dial and spawns no mux, so the container is not yet
      // decided: the default one, which is what a HEAD could always say.
      res.writeHead(200, { 'content-type': 'video/mp4', ...STREAM_HEADERS })
      res.end()
      return
    }
    if (req.headers.range !== undefined) {
      deps.logger.debug('videoclips: a Range header on the clip stream route is ignored', {
        tags: { deviceId },
        meta: { clipKey, range: req.headers.range },
      })
    }
    const sink: ClipStreamRouteSink = {
      begin: (contentType) => {
        res.writeHead(200, { 'content-type': contentType, ...STREAM_HEADERS })
      },
      write: (chunk) => res.write(chunk),
      onceDrain: (listener) => {
        res.once('drain', listener)
      },
      onceClose: (listener) => {
        res.once('close', listener)
      },
      end: () => {
        res.end()
      },
      destroy: () => {
        res.destroy()
      },
    }
    let outcome: ClipStreamRouteOutcome
    try {
      outcome = await deps.stream(resolved.target, sink)
    } catch (err: unknown) {
      deps.logger.warn('videoclips: the clip stream route threw', {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: 'stream-threw',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(500)
        res.end()
      }
      return
    }
    if (outcome.kind !== 'refused') return
    // The producer logged the branch where it decided; this line is the
    // route's own exit, so a 4xx/5xx in an access log has a reason next to it.
    deps.logger.info('videoclips: clip stream not served', {
      tags: { deviceId },
      meta: {
        clipKey,
        code: outcome.code,
        reason: outcome.detail,
        status: streamRefusalStatus(outcome.code),
      },
    })
    res.writeHead(streamRefusalStatus(outcome.code), {
      [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(outcome.detail),
      [CLIP_STILL_REASON_CODE_HEADER]: outcome.code,
    })
    res.end()
  }
}
