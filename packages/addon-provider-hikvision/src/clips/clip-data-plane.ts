/**
 * The addon's two clip routes: the finished FILE, and the STREAM.
 *
 * Both are hosted by `ctx.dataPlane.serve({ access: 'authenticated' })`, so the
 * hub authenticates and reverse-proxies and the addon produces the bytes.
 * **Neither puts a token in its URL**: the hub's `/addon/<id>/<prefix>` proxy
 * reads the credential from `authorization` or the session cookie, so a clip
 * URL may sit in history, in a `Referer` or in a shared log and open nothing
 * (D549 22).
 *
 * ## Why one is `Range`-able and the other is not
 *
 * The FILE route serves an MP4 with `moov` first, which is what the admin UI's
 * `<video>` element needs to show a duration and to seek — `getClipPlayback`
 * points at it.
 *
 * The STREAM route serves the same recording AS IT ARRIVES: a fragmented MP4
 * written by an ffmpeg that is still reading the camera when the first byte
 * leaves. There is no length, `accept-ranges` is `none`, a `Range` header is
 * IGNORED (a 206 over something with no length would be a lie), the peer may
 * not cache it, and `x-camstack-clip-transport: forward-only` says what it is
 * so a consumer that dials it and does not read the header refuses to play.
 *
 * **The status line is written on the first muxed byte, never before**: until
 * then every refusal still owns it, and a camera that serves nothing answers a
 * status with a reason rather than an empty 200 (D391).
 *
 * `HEAD` answers headers and touches no camera.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  CLIP_STILL_DISPOSITION_HEADER,
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  CLIP_STREAM_TRANSPORT_HEADER,
  clipReasonHeaderValue,
  type IScopedLogger,
} from '@camstack/types'

import { type MintRefusal, type MintResult, refuseStill } from './clip-still-refusal.js'
import type { ClipStreamAudioAsk } from './clip-stream.js'

export type { MintRefusal, MintResult }

/** URL namespaces under `/addon/provider-hikvision/`. */
export const CLIP_MEDIA_PREFIX = 'clip'
export const CLIP_STREAM_PREFIX = 'clip-stream'
export const CLIP_THUMB_PREFIX = 'clip-thumb'

/** A clip key is a hex digest; nothing else may reach the filesystem. */
const MEDIA_PATH = /^\/(\d+)\/([A-Za-z0-9_-]{1,128})\.mp4$/
/** The still route carries no extension: the content type says what it is. */
const THUMB_PATH = /^\/(\d+)\/([A-Za-z0-9_-]{1,128})$/

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  return query === -1 ? raw : raw.slice(0, query)
}

interface ByteRange {
  readonly start: number
  readonly end: number
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n`. `'unsatisfiable'` is a 416 rather
 *  than a silently empty 206. */
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

export interface ClipPlaybackHandlerDeps {
  /** Prepare (or find) the muxed MP4 for this clip; `null` when it cannot be. */
  resolvePath(deviceId: number, clipKey: string): Promise<string | null>
  readonly logger: IScopedLogger
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
      path = await deps.resolvePath(deviceId, clipKey)
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
      // A derived artifact of an immutable recording, in a bounded LRU: a
      // client must not hold it past the session.
      'cache-control': 'private, max-age=0, must-revalidate',
    }
    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${String(size)}` })
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
      'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
      'content-length': String(range.end - range.start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(path, { start: range.start, end: range.end }).pipe(res)
  }
}

// ── the still ─────────────────────────────────────────────────────────────

export interface ClipThumbHandlerDeps {
  /** The VOUCHED cache read — bytes only when a real JPEG is on disk. */
  readCached(deviceId: number, clipKey: string): Promise<Buffer | null>
  mint(deviceId: number, clipKey: string): Promise<MintResult>
  readonly logger: IScopedLogger
}

/**
 * `/addon/provider-hikvision/clip-thumb/<deviceId>/<clipKey>`.
 *
 * 200 with the JPEG, or 204 with a reason a tile can read. Never a 404 and
 * never a placeholder: a still that does not exist is an ABSENCE, and it is
 * reported as one (D315).
 */
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
      // A throw that escaped the service is not a "come back later": it is
      // named, so a tile does not inherit a retry loop from a socket close.
      minted = refuseStill('camera-refused', err instanceof Error ? err.message : String(err))
    }
    if (!minted.ok) {
      writeStillRefusal(res, minted, deviceId, deps.logger, clipKey)
      return
    }
    writeJpeg(res, minted.bytes, req.method === 'HEAD')
  }
}

/**
 * The 204, with everything the tile needs to decide what to draw next.
 *
 * A FINAL refusal is work that was dropped, so it is warned, per camera. A
 * DEFERRED one dropped nothing — the camera's one playback slot is busy, or an
 * operator's tap evicted this mint mid-replay — and warning it would put a
 * line on the log per tile of a page.
 *
 * There was briefly a third rule here, exempting `media-not-held` from the
 * warn because it was the steady state of every list. That code is gone
 * because its cause is: a clip whose bytes are not held now MINTS, in about
 * half a second off the camera, instead of refusing.
 */
function writeStillRefusal(
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
    // A clip is a file and the frame cut from it does not change: the artifact
    // is immutable and the browser may keep it.
    'cache-control': 'private, max-age=31536000, immutable',
  })
  if (headOnly) {
    res.end()
    return
  }
  res.end(bytes)
}

// ── the stream ────────────────────────────────────────────────────────────

/** Why the route answered a status instead of bytes. */
export type ClipStreamRouteRefusalCode =
  | 'unknown-device'
  | 'no-catalog-row'
  /**
   * This camera's ONE playback session is held, by us, right now.
   *
   * Not `camera-refused`: the camera was never asked. The provider owns this
   * fact and declares it (`replay-lane.ts`), so a second stream is refused
   * here rather than dialled into the opaque `SETUP … 500` the firmware
   * answers — which says nothing about the clip and reads to a surface as
   * "this clip is broken" (D611/D315).
   */
  | 'replay-busy'
  | 'camera-refused'
  | 'fetch-failed'

export type ClipStreamRouteOutcome =
  | { readonly kind: 'served' }
  /** Bytes had reached the peer and the sink is already destroyed. */
  | { readonly kind: 'cut' }
  | { readonly kind: 'refused'; readonly code: ClipStreamRouteRefusalCode; readonly detail: string }

/** The peer as the producer sees it. */
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
   * Which audio codec to MUX (D600). Stated at the boundary, never defaulted
   * deeper in: the data-plane form has no session to negotiate with and says
   * `none`; the dial says what the broker negotiated.
   */
  readonly audio: ClipStreamAudioAsk
}

/**
 * How a request names its clip, resolved BEFORE anything else. The data plane
 * reads it off the path; the dial listener reads it off a one-shot token.
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
  // The path form negotiates no codec: no sound, said rather than assumed.
  return {
    kind: 'target',
    target: { deviceId: Number(match[1]), clipKey: match[2] ?? '', audio: 'none' },
  }
}

/** Everything but the content type, which the MUX decides: a stream carrying
 *  µ-law is a QuickTime container, and a header that said `video/mp4` for it
 *  would be a small lie on a plane whose point is saying what it serves. */
const STREAM_HEADERS = {
  'accept-ranges': 'none',
  'cache-control': 'no-store',
  [CLIP_STREAM_TRANSPORT_HEADER]: 'forward-only',
} as const

/** `404` = nothing here to serve; `502` = the camera; `503` = its one slot. */
function streamRefusalStatus(code: ClipStreamRouteRefusalCode): 404 | 502 | 503 {
  switch (code) {
    case 'unknown-device':
    case 'no-catalog-row':
      return 404
    // Temporarily held, and it will not be held for long: a status that says
    // "come back", where 502 would say the camera is broken and 404 would say
    // the clip is not there. Neither is true.
    case 'replay-busy':
      return 503
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
      // A request that names no clip names no camera either: the one line this
      // route writes without a device tag, and it says why.
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
