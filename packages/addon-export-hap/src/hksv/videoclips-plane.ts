/**
 * The two data-plane routes behind the HomeKit clip source.
 *
 * Both are hosted by `ctx.dataPlane.serve({ access: 'authenticated' })`, so the
 * hub authenticates and reverse-proxies and this addon produces the bytes.
 * **Neither puts a token in its URL**: the hub's `/addon/<id>/<prefix>` proxy
 * reads the credential from `authorization` OR the session cookie, exactly as
 * the recorder's own playback plane does, so a clip URL may sit in history, in
 * a `Referer` or in a shared log and open nothing (D549 22).
 *
 * ## Why the bytes are served HERE
 *
 * The clips were written by this process, to a `local-path` storage location,
 * and this addon is `hub-only`. A byte path that went anywhere else would be a
 * cross-addon media move — D9/D18, and the repo's one existing such move is
 * capped at 50 MiB with a docblock naming the OOM it caused. `createReadStream
 * ().pipe(res)` gives backpressure natively, which is why the data plane hands
 * an addon the REAL `res` (D447: a raw HTTP stream reads no chunk the socket
 * has not taken).
 *
 * ## What the media route does NOT do
 *
 * It does not remux. A teed clip is `ftyp` + an EMPTY `moov` + `moof`/`mdat`
 * fragments, cut wherever iOS stopped pulling, so the container carries no
 * duration and no index — measured on a byte-identical file
 * (`-movflags +frag_keyframe+empty_moov+default_base_moof`, the tee's own
 * argv): `mvhd.duration = 0`, `mdhd.duration = 0`, no `sidx`, and no `mfra`
 * because nothing wrote a trailer. It decodes end to end, and the row's
 * `timeRange` carries the real duration from the sidecar, but a player cannot
 * map a time to a byte offset from this file. What it would cost to change is
 * measured and written down in D571 rather than guessed at here.
 *
 * ## The thumbnail route has no mint
 *
 * It only ever serves a JPEG the store already stat'd — a still is VOUCHED at
 * write time or it does not exist, and nothing re-mints a teed clip. So a miss
 * is a plain 404, not the 204-with-a-reason contract a live camera needs.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { IScopedLogger } from '@camstack/types'

import type { HksvClipFileNames } from './clip-record.js'

/** URL namespaces under `/addon/export-hap/`. */
export const HKSV_CLIP_MEDIA_PREFIX = 'hksv-clip'
export const HKSV_CLIP_THUMB_PREFIX = 'hksv-clip-thumb'

/** A stem is what `clipStem` mints: nothing else may reach the filesystem. */
const MEDIA_PATH = /^\/(\d{1,12})\/([A-Za-z0-9_-]{1,128})\.mp4$/
const THUMB_PATH = /^\/(\d{1,12})\/([A-Za-z0-9_-]{1,128})\.jpg$/

export type HksvClipArtifact = keyof HksvClipFileNames

export interface HksvClipPlaneDeps {
  readonly logger: IScopedLogger
  /** The store's layout, asked every time — the location can be repointed. */
  artifactPath(deviceId: number, stem: string, artifact: HksvClipArtifact): Promise<string | null>
}

export type HksvClipPlaneHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export interface HksvClipPlanes {
  readonly mediaPrefix: string
  readonly thumbPrefix: string
  readonly mediaHandler: HksvClipPlaneHandler
  readonly thumbHandler: HksvClipPlaneHandler
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

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const query = raw.indexOf('?')
  return query === -1 ? raw : raw.slice(0, query)
}

interface Addressed {
  readonly deviceId: number
  readonly stem: string
}

function address(req: IncomingMessage, pattern: RegExp): Addressed | null {
  const match = pattern.exec(pathnameOf(req))
  if (match === null) return null
  const deviceId = Number(match[1])
  const stem = match[2]
  if (!Number.isInteger(deviceId) || stem === undefined) return null
  return { deviceId, stem }
}

export function createHksvClipPlanes(deps: HksvClipPlaneDeps): HksvClipPlanes {
  /**
   * The path of one artifact, or `null` with a reason ALREADY logged.
   *
   * A 404 is work this route dropped, and silence reads as "never happened" —
   * so every miss is one warn carrying `tags: { deviceId }`, which is the only
   * key a "why is 102 missing its clips and 101 not?" question can be answered
   * by.
   */
  async function locate(
    addressed: Addressed,
    artifact: HksvClipArtifact,
  ): Promise<{ readonly path: string; readonly size: number } | null> {
    const { deviceId, stem } = addressed
    let path: string | null
    try {
      path = await deps.artifactPath(deviceId, stem, artifact)
    } catch (err: unknown) {
      deps.logger.warn('videoclips: could not resolve a HomeKit clip artifact', {
        tags: { deviceId },
        meta: { stem, artifact, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
    if (path === null) {
      deps.logger.warn('videoclips: no writable HomeKit clips location — nothing to serve', {
        tags: { deviceId },
        meta: { stem, artifact },
      })
      return null
    }
    try {
      const stats = await stat(path)
      if (!stats.isFile()) throw new Error('not a file')
      return { path, size: stats.size }
    } catch (err: unknown) {
      deps.logger.warn('videoclips: a HomeKit clip artifact was asked for and is not there', {
        tags: { deviceId },
        meta: { stem, artifact, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  function readOnly(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') return true
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return false
  }

  const mediaHandler: HksvClipPlaneHandler = async (req, res) => {
    if (!readOnly(req, res)) return
    const addressed = address(req, MEDIA_PATH)
    if (addressed === null) {
      res.writeHead(400)
      res.end()
      return
    }
    const found = await locate(addressed, 'clip')
    if (found === null) {
      res.writeHead(404)
      res.end()
      return
    }
    const base = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      // A teed clip is immutable once its sidecar exists, but it lives under a
      // retention the operator sets: a client must not hold it past the
      // session.
      'cache-control': 'private, max-age=0, must-revalidate',
    }
    const range = parseRange(req.headers.range, found.size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${String(found.size)}` })
      res.end()
      return
    }
    if (range === null) {
      res.writeHead(200, { ...base, 'content-length': String(found.size) })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(found.path).pipe(res)
      return
    }
    res.writeHead(206, {
      ...base,
      'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(found.size)}`,
      'content-length': String(range.end - range.start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(found.path, { start: range.start, end: range.end }).pipe(res)
  }

  const thumbHandler: HksvClipPlaneHandler = async (req, res) => {
    if (!readOnly(req, res)) return
    const addressed = address(req, THUMB_PATH)
    if (addressed === null) {
      res.writeHead(400)
      res.end()
      return
    }
    const found = await locate(addressed, 'thumbnail')
    if (found === null) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(found.size),
      // The still of a finished clip never changes: the browser may keep it.
      'cache-control': 'private, max-age=31536000, immutable',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(found.path).pipe(res)
  }

  return {
    mediaPrefix: HKSV_CLIP_MEDIA_PREFIX,
    thumbPrefix: HKSV_CLIP_THUMB_PREFIX,
    mediaHandler,
    thumbHandler,
  }
}
