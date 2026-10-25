/**
 * Snapshot media data-plane handler — serves per-device snapshot JPEGs over the
 * addon HTTP data-plane at `/addon/snapshot/media/<deviceId>.jpg`.
 *
 * A pure factory (no addon references), fully unit-testable with lightweight
 * IncomingMessage/ServerResponse stubs — mirrors `createEventMediaHandler` in
 * `@camstack/addon-post-analysis`. The only difference from event media: a
 * snapshot is a LIVING frame, not a write-once thumbnail, so the response uses a
 * short `private, max-age=<device maxAgeS>` + ETag revalidation instead of
 * `immutable`. The ETag `"<deviceId>-<capturedAt>"` matches the cache-only
 * `snapshot.getSnapshotOverview` cap so a grid can pre-invalidate tiles.
 *
 * Public URL (via hub reverse-proxy): `/addon/snapshot/media/<deviceId>.jpg`
 * (the `.jpg` suffix is optional; `?streamId=` and `?force=1` are honoured).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler } from '@camstack/types'

/** A renderable snapshot frame resolved for one device. */
export interface SnapshotMedia {
  /** Raw image bytes (already decoded from the wrapper's base64 cache). */
  readonly bytes: Uint8Array
  /** MIME type — practically always `image/jpeg`. */
  readonly contentType: string
  /** Epoch ms of the cached capture — drives the ETag and frame identity. */
  readonly capturedAt: number
  /** Effective per-device max cache age (seconds) → `Cache-Control: max-age`. */
  readonly maxAgeS: number
  /** State treatment painted over the capture (sleeping, waking, …). */
  readonly variantKey?: string | undefined
  /**
   * The width the returned BYTES are actually at, or undefined when they are the
   * frame as captured.
   *
   * Deliberately not the same thing as the requested width. A failed resize
   * serves the full frame, and stamping the requested `-w320` on it poisons the
   * ETag: a later SUCCESSFUL resize of the same capture mints the identical tag
   * with completely different bytes, so a client holding the megabyte revalidates,
   * gets a 304, and keeps it. The tag has to describe what went out.
   */
  readonly servedWidth?: number | undefined
}

/** What the cache can answer about a device WITHOUT capturing anything. */
export interface SnapshotPeek {
  /** Epoch ms of the cached capture. */
  readonly capturedAt: number
  /** Effective per-device max cache age (seconds). */
  readonly maxAgeS: number
  /** State treatment that would be painted over this capture. */
  readonly variantKey?: string | undefined
}

export interface SnapshotMediaHandlerDeps {
  /**
   * Resolve a device (+ optional stream, + force) to a renderable frame. Runs
   * the wrapper's coalesced capture ladder; returns null when no frame can be
   * produced (→ 404). Throwing produces an opaque 500 (caller logs).
   */
  readonly getMedia: (
    deviceId: number,
    streamId: string | undefined,
    force: boolean,
    width: number | undefined,
  ) => Promise<SnapshotMedia | null>
  /**
   * Cache-only lookup: what frame is cached for this (device, stream) right now,
   * and is it still FRESH? Returns null when nothing is cached or the entry is
   * past its max-age.
   *
   * This exists so a conditional GET can be answered before `getMedia` runs.
   * Without it a 304 is only cheap in bytes — the ladder and the resize have
   * both already happened by the time the ETags are compared, which on a camera
   * whose live paths are failing is two 15 s ffmpeg timeouts to send zero bytes.
   *
   * Width is deliberately absent: the ETag the client presents already names the
   * width it holds, and it can only hold a tag this server minted, so matching
   * the frame identity is sufficient. A client holding the FULL frame after a
   * failed resize presents `"<id>-<ts>"`, which cannot collide with the
   * `"<id>-<ts>-w320"` a `?w=320` request computes — it falls through and
   * re-derives, which is exactly right.
   *
   * Optional: a host that does not supply it keeps the previous behaviour
   * exactly (run the ladder, then compare).
   */
  readonly peekFresh?: (
    deviceId: number,
    streamId: string | undefined,
  ) => Promise<SnapshotPeek | null>
}

/** Parsed `/<deviceId>[.jpg][?streamId=…&force=1&w=320]` request. */
export interface SnapshotMediaRequest {
  readonly deviceId: number
  readonly streamId: string | undefined
  readonly force: boolean
  /** Snapped target width in px, or undefined for the frame as captured. */
  readonly width: number | undefined
}

/**
 * The widths a thumbnail may be served at.
 *
 * A ladder, not a free integer: the width is a cache key AND an ffmpeg run, so
 * honouring `?w=` verbatim would let any caller mint unbounded work and
 * unbounded memory. Twelve tiles measured at 181–240 px collapse onto one
 * variant instead of twelve.
 *
 * Rungs are chosen for the card sizes the viewer actually renders (180–390 px)
 * with headroom for a 2× device pixel ratio.
 */
export const SNAPSHOT_WIDTH_LADDER: readonly number[] = [160, 240, 320, 480, 640, 960]

/** Snap UP to the next rung — never below what was asked, so the client is not
 *  handed an image it has to upscale. Above the ladder, the largest rung: the
 *  point is to stop serving the 4K original. */
export function snapSnapshotWidth(requested: number): number {
  for (const rung of SNAPSHOT_WIDTH_LADDER) {
    if (requested <= rung) return rung
  }
  return SNAPSHOT_WIDTH_LADDER[SNAPSHOT_WIDTH_LADDER.length - 1] ?? requested
}

/**
 * Parse the handler-relative path (`/<deviceId>.jpg?query`) into a request.
 * Returns null for a malformed / nested / non-numeric id so the handler answers
 * 404 without ever reaching `getMedia`.
 */
export function parseSnapshotMediaRequest(url: string): SnapshotMediaRequest | null {
  const qIdx = url.indexOf('?')
  const rawPath = qIdx === -1 ? url : url.slice(0, qIdx)
  const query = qIdx === -1 ? '' : url.slice(qIdx + 1)
  const segment = rawPath.replace(/^\/+/, '')
  // Single path segment only — a nested path is not a valid device snapshot.
  if (segment.length === 0 || segment.includes('/')) return null
  const idPart = segment.replace(/\.jpe?g$/i, '')
  if (!/^\d+$/.test(idPart)) return null
  const deviceId = Number.parseInt(idPart, 10)
  if (!Number.isSafeInteger(deviceId)) return null

  const params = new URLSearchParams(query)
  const rawStream = params.get('streamId')
  const streamId = rawStream !== null && rawStream.length > 0 ? rawStream : undefined
  const rawForce = params.get('force')
  const force = rawForce === '1' || rawForce === 'true'
  const rawWidth = params.get('w')
  const width =
    rawWidth !== null && /^\d+$/.test(rawWidth) && Number.parseInt(rawWidth, 10) > 0
      ? snapSnapshotWidth(Number.parseInt(rawWidth, 10))
      : undefined
  return { deviceId, streamId, force, width }
}

/**
 * The response's entity tag.
 *
 * It has to identify the VARIANT, not just the frame: the same capture can now
 * be served at several widths, from several streams, and with a camera-state
 * treatment, and a plain
 * `"<device>-<capturedAt>"` would let a client that fetched `?w=320` receive a
 * 304 for `?w=960` and render the small image at full size. The base form is
 * unchanged for a plain request, so the identity
 * `snapshot.getSnapshotOverview` advertises still matches the frame nobody
 * asked to resize.
 */
export function snapshotEtag(variant: SnapshotVariantIdentity, capturedAt: number): string {
  const parts = [`${String(variant.deviceId)}-${String(capturedAt)}`]
  if (variant.streamId !== undefined) parts.push(`s${variant.streamId}`)
  if (variant.width !== undefined) parts.push(`w${String(variant.width)}`)
  if (variant.variantKey !== undefined) parts.push(`v${variant.variantKey}`)
  return `"${parts.join('-')}"`
}

/** The (device, stream, width) triple an ETag names. Structurally a
 *  {@link SnapshotMediaRequest}, but the width is the width SERVED — see
 *  {@link SnapshotMedia.servedWidth}. */
export interface SnapshotVariantIdentity {
  readonly deviceId: number
  readonly streamId: string | undefined
  readonly width: number | undefined
  readonly variantKey?: string | undefined
}

/**
 * Create a data-plane handler that serves per-device snapshots as JPEG images.
 * `deps.getMedia` is called once per request; null → 404, throw → 500. A
 * conditional GET with a matching `If-None-Match` produces a 304.
 */
export function createSnapshotMediaHandler(deps: SnapshotMediaHandlerDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }

    const parsed = parseSnapshotMediaRequest(req.url ?? '/')
    if (parsed === null) {
      res.writeHead(404).end()
      return
    }

    const inm = req.headers['if-none-match']

    // Cheap 304: answer a conditional GET off the cache before the ladder and
    // the resize run. Skipped on `force` — an operator pressing refresh is
    // asking for a capture, not for a revalidation.
    if (typeof inm === 'string' && !parsed.force && deps.peekFresh !== undefined) {
      let peeked: SnapshotPeek | null = null
      try {
        peeked = await deps.peekFresh(parsed.deviceId, parsed.streamId)
      } catch {
        // A failed peek is not an error the client should see — fall through to
        // the full path, which is what would have happened anyway.
        peeked = null
      }
      if (peeked !== null) {
        const peekedEtag = snapshotEtag(
          {
            deviceId: parsed.deviceId,
            streamId: parsed.streamId,
            width: parsed.width,
            variantKey: peeked.variantKey,
          },
          peeked.capturedAt,
        )
        if (inm === peekedEtag) {
          res
            .writeHead(304, {
              etag: peekedEtag,
              'cache-control': `private, max-age=${Math.max(0, Math.floor(peeked.maxAgeS))}`,
            })
            .end()
          return
        }
      }
    }

    let media: SnapshotMedia | null
    try {
      media = await deps.getMedia(parsed.deviceId, parsed.streamId, parsed.force, parsed.width)
    } catch {
      const body = 'Internal server error'
      res.writeHead(500, {
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(body)),
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
      return
    }

    if (media === null) {
      res.writeHead(404).end()
      return
    }

    // The tag names the bytes that are about to go out: `servedWidth` is the
    // width the resize actually produced, which is NOT the requested width when
    // the resize failed and the full frame is being served instead.
    const etag = snapshotEtag(
      {
        deviceId: parsed.deviceId,
        streamId: parsed.streamId,
        width: 'servedWidth' in media ? media.servedWidth : parsed.width,
        variantKey: media.variantKey,
      },
      media.capturedAt,
    )
    const cacheControl = `private, max-age=${Math.max(0, Math.floor(media.maxAgeS))}`

    if (inm === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControl }).end()
      return
    }

    res.writeHead(200, {
      'content-type': media.contentType,
      'cache-control': cacheControl,
      etag,
      'content-length': String(media.bytes.byteLength),
    })
    if (req.method === 'HEAD') res.end()
    else res.end(Buffer.from(media.bytes))
  }
}
