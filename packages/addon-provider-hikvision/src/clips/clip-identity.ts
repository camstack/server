/**
 * A Hikvision clip's IDENTITY — the id a surface carries around, and the key
 * its derived artifacts are filed under.
 *
 * `native:hikvision:onboard:<trackId>:<base64url(fileName)>`, the same shape
 * D549 3 fixed for Reolink and for the same reasons: the source is INSIDE the
 * id because `device-collection-dispatch.ts` routes a scalar cap call by the
 * longest source that prefixes it, and because an id naming a source this
 * provider no longer serves must be REFUSED rather than routed by prefix luck.
 *
 * base64url rather than base64: the file name is `ch01_00000000136000401` today
 * and nothing promises it stays free of `/` or `+`, which in a URL path
 * segment are a different path and a space.
 *
 * ## Why the id does not carry the playback handle
 *
 * The camera's `playbackURI` carries `starttime`, `endtime`, `name` and
 * `size`, and all four are needed to open the media. Putting them in the id
 * would make it self-contained — and would also let a caller mint an id for a
 * window the catalog never listed, which is a request for footage nobody has
 * checked exists. So the id names the FILE and the row carries the handle,
 * exactly as the Reolink path does: an id whose row this node has not listed
 * is `catalog-miss`, which is the truth ("I have never heard of it"), not a
 * failure.
 */
import { createHash } from 'node:crypto'

/**
 * The camera's OWN recordings — the one Hikvision source.
 *
 * One, because the camera has one archive. `ContentMgmt/record/tracks` on 1436
 * lists exactly ONE track (101, H.265, 3840x2160): there is no sub-stream
 * archive to be a second source, and no twin. See `clip-twins.ts`.
 */
export const CLIP_SOURCE_ONBOARD = 'native:hikvision:onboard'

/** Every source this provider can name. Order is the picker's order. */
export const HIKVISION_CLIP_SOURCES = [CLIP_SOURCE_ONBOARD] as const

export type HikvisionClipSource = (typeof HIKVISION_CLIP_SOURCES)[number]

export interface ClipIdParts {
  readonly source: HikvisionClipSource
  readonly trackId: number
  readonly fileName: string
}

export function mintClipId(parts: ClipIdParts): string {
  const encoded = Buffer.from(parts.fileName, 'utf8').toString('base64url')
  return `${parts.source}:${String(parts.trackId)}:${encoded}`
}

/**
 * Parse an id this provider minted. `null` for anything else — including an id
 * from the analytics or Reolink source, which is how the collection
 * dispatcher's "nobody claimed this id" branch stays honest.
 */
export function parseClipId(clipId: string): ClipIdParts | null {
  const source = HIKVISION_CLIP_SOURCES.find((candidate) => clipId.startsWith(`${candidate}:`))
  if (source === undefined) return null
  const rest = clipId.slice(source.length + 1)
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  const trackId = Number(rest.slice(0, separator))
  if (!Number.isInteger(trackId) || trackId < 0) return null
  const encoded = rest.slice(separator + 1)
  if (encoded === '') return null
  const fileName = Buffer.from(encoded, 'base64url').toString('utf8')
  if (fileName === '') return null
  return { source, trackId, fileName }
}

/**
 * The on-disk key for a clip's derived artifacts.
 *
 * Derived from `(trackId, fileName)` and NOT from the source: an artifact
 * belongs to the FILE, so any surface that names the same file finds the same
 * one. A hash rather than the encoded name because the name has no length
 * promise and a file-name limit is not a place to discover that.
 */
export function clipKeyFor(trackId: number, fileName: string): string {
  return createHash('sha1')
    .update(`${String(trackId)} ${fileName}`, 'utf8')
    .digest('hex')
}
