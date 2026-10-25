/**
 * The NC artifact READ plane: `/addon/<addonId>/nc-artifact-read/<artifactId>`,
 * served `access: 'authenticated'`.
 *
 * ## Why a second route next to `nc-artifact`
 *
 * The existing artifact plane is `public` and its only authority is the HMAC on
 * the link, because its fetcher is a notifier backend or a phone holding no hub
 * session (D47). The VIEWER is the exact opposite: it holds a session, it is
 * browsing an index it was served, and what it must NOT need is a 24-hour signed
 * link minted in advance for every artefact a user might scroll to.
 *
 * So this is the same bytes, the same store, one different gate — the hub's own
 * `authenticated` check, exactly like `event-media`. The rule in
 * `data-plane-access.ts` decides it: *a plane serving ONE item the caller
 * already had to be told about is `authenticated`*. An artefact id comes from
 * `nc.listArtifacts`, which is itself an authenticated surface, and it is
 * unguessable.
 *
 * ## Range
 *
 * A timelapse is an mp4 a person scrubs. `<video>` and `react-native-video` both
 * seek by byte range, and a route that answers 200-with-everything makes a seek
 * re-download the file. One range, `bytes=a-b`, is all any of them ask for; a
 * multi-range request is answered whole rather than wrongly.
 *
 * ## Nothing here decides WHO may see WHAT
 *
 * Per-artefact ownership is the INDEX's job, on the list surface. This route
 * resolves an id and refuses one that is not indexed or has expired. Layering a
 * second authorization model on an unguessable id is how two gates end up
 * disagreeing; see `data-plane-access.ts` for the same decision on
 * `event-media`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import type { NcArtifactIndex, NcArtifactRecord } from './artifact-index.js'
import type { NcArtifactStore } from './artifact-store.js'

export interface NcArtifactReadPlaneDeps {
  readonly index: NcArtifactIndex
  readonly store: NcArtifactStore
  readonly logger: IScopedLogger
}

/** One parsed byte range, already clamped to the payload. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * Parse a single-range `Range` header against a known length.
 *
 * Returns `null` when there is nothing to honour (absent, malformed, multi-range
 * — all of which mean "send the whole thing"), and `'unsatisfiable'` when the
 * client asked for a range that cannot exist, which is a 416 and not a 200.
 */
export function parseByteRange(
  header: string | undefined,
  length: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  if (length === 0) return 'unsatisfiable'
  // `bytes=-500` — the LAST 500 bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, length - suffix), end: length - 1 }
  }
  const start = Number(rawStart)
  if (start >= length) return 'unsatisfiable'
  const end = rawEnd === '' ? length - 1 : Math.min(Number(rawEnd), length - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

/** The last path segment, percent-decoded. */
function artifactIdFrom(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  try {
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    return ''
  }
}

export class NcArtifactReadPlane {
  constructor(private readonly deps: NcArtifactReadPlaneDeps) {}

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const artifactId = artifactIdFrom(req)
    const record = await this.deps.index.resolve(artifactId)
    if (record === null) {
      this.refuse(res, 404, 'not found')
      return
    }
    const found = await this.deps.store.read(artifactId)
    if (found === null) {
      // A row whose bytes are gone. This is the ONE failure an operator will
      // report as "the app shows a broken tile", so it says which camera and
      // which artefact rather than 404ing in silence — the prune reconciles the
      // index against the shelf, and a line here is how a gap between the two
      // becomes visible before a user finds it.
      this.deps.logger.warn('artifact bytes gone — index row outlived the shelf', {
        ...(record.deviceId !== null ? { tags: { deviceId: record.deviceId } } : {}),
        meta: { artifactId, kind: record.kind, expiresAt: record.expiresAt },
      })
      this.refuse(res, 404, 'not found')
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, this.baseHeaders(record, found.bytes.byteLength, found.mime))
      res.end()
      return
    }
    const range = parseByteRange(headerOf(req, 'range'), found.bytes.byteLength)
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        'content-range': `bytes */${found.bytes.byteLength}`,
        'content-type': 'text/plain',
      })
      res.end('range not satisfiable')
      return
    }
    if (range === null) {
      res.writeHead(200, this.baseHeaders(record, found.bytes.byteLength, found.mime))
      res.end(found.bytes)
      return
    }
    const slice = found.bytes.subarray(range.start, range.end + 1)
    res.writeHead(206, {
      ...this.baseHeaders(record, slice.byteLength, found.mime),
      'content-range': `bytes ${range.start}-${range.end}/${found.bytes.byteLength}`,
    })
    res.end(slice)
  }

  private baseHeaders(
    record: NcArtifactRecord,
    length: number,
    mime: string,
  ): Record<string, string> {
    return {
      'content-type': mime,
      'content-length': String(length),
      'accept-ranges': 'bytes',
      // The bytes behind an id never change; only their existence does.
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename="${filenameFor(record)}"`,
    }
  }

  private refuse(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(body)
  }
}

/** A name a client will accept, from what the artefact IS. */
function filenameFor(record: NcArtifactRecord): string {
  const ext =
    record.mime === 'video/mp4'
      ? 'mp4'
      : record.mime === 'image/gif'
        ? 'gif'
        : record.mime === 'image/png'
          ? 'png'
          : 'jpg'
  return `${record.kind}-${record.capturedAt}.${ext}`
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}
