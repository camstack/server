/**
 * The addon's clip FILE route.
 *
 * Hosted by `ctx.dataPlane.serve({ access: 'authenticated' })`, so the hub
 * authenticates and reverse-proxies and the addon produces the bytes. **No
 * token in the URL**: the hub's `/addon/<id>/<prefix>` proxy reads the
 * credential from `authorization` or the session cookie, so a clip URL may sit
 * in history, in a `Referer` or in a shared log and open nothing (D549 22).
 *
 * It serves the re-indexed MP4 — `moov` first — with `Range`, which is what a
 * `<video>` element needs to show a duration and to seek. The camera's own
 * copy has the `moov` LAST and ignores `Range` outright, so the seekability
 * this route offers is bought by `clip-file.ts`'s one `-c copy` pass and is
 * not a property of the wire.
 *
 * There is deliberately **no STREAM route here**. The camera's forward-only
 * `/cam/playback` replay now exists, but it lives on the addon's own
 * token-gated dial listener (`clip-stream-dial.ts`, D597) rather than on this
 * plane: it needs a provider-owned slot gate because the camera's own
 * exhaustion signal is a 404 that means "gone", and it is dialled by the
 * BROKER, which holds no user credential and so cannot reach the hub proxy in
 * front of this plane at all.
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
  clipReasonHeaderValue,
  type IScopedLogger,
} from '@camstack/types'

import { type MintRefusal, type MintResult, refuseStill } from './clip-still-refusal.js'

export type { MintRefusal, MintResult }

/** URL namespaces under `/addon/provider-amcrest/`. */
export const CLIP_MEDIA_PREFIX = 'clip'
export const CLIP_THUMB_PREFIX = 'clip-thumb'

/** The code a refusal carries beside its sentence, so a consumer can branch
 *  without parsing prose. */
export const CLIP_FILE_REASON_CODE_HEADER = 'x-camstack-reason-code'

/**
 * A clip key is `<startSec>-<endSec>` and nothing else may reach the
 * filesystem. The store refuses the same shape a second time — two walls,
 * because this one is reachable from a URL.
 */
const MEDIA_PATH = /^\/(\d+)\/(\d{1,20}-\d{1,20})\.mp4$/
/** The still route carries no extension: the content type says what it is. */
const THUMB_PATH = /^\/(\d+)\/(\d{1,20}-\d{1,20})$/

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  return query === -1 ? raw : raw.slice(0, query)
}

export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * `bytes=a-b` / `bytes=a-` / `bytes=-n`.
 *
 * `'unsatisfiable'` is a 416 rather than a silently empty 206: a player that
 * asked past the end must learn it did, not receive zero bytes that look like
 * the end of the file.
 */
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

/**
 * Why this clip has no file to serve, in the caller's own words.
 *
 * It exists because `string | null` was not enough, and the cost of that was
 * measured: the operator asked for a 106 MB clip, waited **228.6 s** and got
 * `HTTP 404, 0 bytes` with no body and no header — the same answer a clip that
 * was never in the catalog gets, and the same answer a typo in the URL gets.
 * The provider had named the reason on a WARN line at the same instant; the
 * route threw the name away on the one path that reaches a person (D391,
 * D611).
 */
export interface ClipFileRefusal {
  readonly code: 'camera-refused' | 'fetch-failed' | 'too-large-to-transfer' | 'catalog-miss'
  readonly detail: string
}

export type ClipFileResolution =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'refused'; readonly refusal: ClipFileRefusal }

/**
 * `404` = this node has nothing by that name; `502` = the camera or its card;
 * `413` = the clip is real and too big for this route to hand over.
 *
 * Never 404 for the last two: a clip the camera holds and cannot serve is not
 * a clip that does not exist, and the difference is the difference between
 * "check your link" and "check your camera".
 */
export function clipFileRefusalStatus(code: ClipFileRefusal['code']): 404 | 413 | 502 {
  switch (code) {
    case 'catalog-miss':
      return 404
    case 'too-large-to-transfer':
      return 413
    case 'camera-refused':
    case 'fetch-failed':
      return 502
  }
}

export interface ClipPlaybackHandlerDeps {
  /** Prepare (or find) the re-indexed MP4 for this clip, or say why not. */
  resolvePath(deviceId: number, clipKey: string): Promise<ClipFileResolution>
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
      res.writeHead(400, {
        [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(
          'not /<deviceId>/<startSec>-<endSec>.mp4',
        ),
        [CLIP_FILE_REASON_CODE_HEADER]: 'bad-path',
      })
      res.end()
      return
    }
    const deviceId = Number(match[1])
    const clipKey = match[2] ?? ''

    let resolved: ClipFileResolution
    try {
      resolved = await deps.resolvePath(deviceId, clipKey)
    } catch (err: unknown) {
      deps.logger.warn('videoclips: could not prepare a clip for playback', {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: 'prepare-threw',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      res.writeHead(500)
      res.end()
      return
    }
    if (resolved.kind === 'refused') {
      const status = clipFileRefusalStatus(resolved.refusal.code)
      deps.logger.info('videoclips: a clip file was not served', {
        tags: { deviceId },
        meta: {
          clipKey,
          branch: resolved.refusal.code,
          status,
          reason: resolved.refusal.detail,
        },
      })
      // The reason goes through `clipReasonHeaderValue` because this repo's
      // refusals are prose and an HTTP header value is Latin-1: an em dash
      // throws INSIDE the handler, the status is never written and the socket
      // hangs — the reason header silencing the reason it exists to carry
      // (D611).
      res.writeHead(status, {
        [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(resolved.refusal.detail),
        [CLIP_FILE_REASON_CODE_HEADER]: resolved.refusal.code,
      })
      res.end()
      return
    }
    const path = resolved.path

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
      res.writeHead(416, {
        ...base,
        'content-range': `bytes */${String(size)}`,
      })
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
  /** `signal` aborts when the tile's response closes before it is answered.
   *  It covers the QUEUE WAIT only: a queued mint leaves the camera's queue
   *  without dialling, while a cut already running finishes (≤ the still
   *  bound) and lands in the cache for the next ask. */
  mint(deviceId: number, clipKey: string, signal: AbortSignal): Promise<MintResult>
  readonly logger: IScopedLogger
}

/**
 * `/addon/provider-amcrest/clip-thumb/<deviceId>/<startSec>-<endSec>`.
 *
 * 200 with the JPEG, or 204 with a reason a tile can read. **Never a 404 and
 * never a placeholder**: a still that does not exist is an ABSENCE, and it is
 * reported as one (D315). A 404 would read as "this clip is gone", which is
 * exactly the confusion the media route already had to be taught out of.
 *
 * The cached read comes FIRST and touches no camera (D54) — a scrolled-back
 * screen costs this camera nothing at all.
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
      res.writeHead(400, {
        [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue('not /<deviceId>/<startSec>-<endSec>'),
        [CLIP_STILL_REASON_CODE_HEADER]: 'bad-path',
      })
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

    const gone = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) gone.abort()
    }
    res.on('close', onClose)
    let minted: MintResult
    try {
      minted = await deps.mint(deviceId, clipKey, gone.signal)
    } catch (err: unknown) {
      // A throw that escaped the mint is not a "come back later": it is named,
      // so a tile does not inherit a retry loop from a socket close.
      minted = refuseStill('camera-refused', err instanceof Error ? err.message : String(err))
    } finally {
      res.off('close', onClose)
    }
    if (!minted.ok && 'abandoned' in minted) {
      // Nobody is left to answer. Logged by the mint; the socket is closed.
      if (!res.writableEnded) res.end()
      return
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
 * DEFERRED one dropped nothing — the camera's replay is busy, or an operator's
 * tap evicted this mint mid-replay — and warning it would put a line on the
 * log per tile of a page.
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
  // `clipReasonHeaderValue` because this repo's refusals are prose and an HTTP
  // header value is Latin-1: an em dash throws INSIDE the handler, the status
  // is never written and the socket hangs (D611).
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
    // A clip is a recording and the frame cut from it does not change: the
    // artifact is immutable and the browser may keep it.
    'cache-control': 'private, max-age=31536000, immutable',
  })
  if (headOnly) {
    res.end()
    return
  }
  res.end(bytes)
}
