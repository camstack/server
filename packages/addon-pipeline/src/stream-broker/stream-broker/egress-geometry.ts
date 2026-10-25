/**
 * The geometry an egress child actually DELIVERS.
 *
 * Two rules meeting, and until now only one of them was kept.
 *
 * **Never upscale.** A consumer asking for 720p from a 360p source gets 360p:
 * the scale filter is `min(<asked>,iw)` with `force_original_aspect_ratio=
 * decrease`, so ffmpeg has always done the right thing. Going DOWN is the only
 * direction an egress is allowed to resize.
 *
 * **Say what you deliver.** The published cam-stream record did not follow: it
 * carried `request.encode.video.width/height` — what was ASKED — so a 640×360
 * stream was advertised to the whole cluster as 1280×720, and `pickStream`
 * listed it that way (measured on device 106, 2026-09-13). A record that
 * over-states its size is worse than no record: a consumer picks it for a
 * quality it never had.
 *
 * **An UNKNOWN source dimension never caps.** The manager defaults a source
 * whose resolution it could not read to 1280×720 for the argv builder, which is
 * a guess for a filter, not a fact. Capping a 1080p request against a guess
 * would silently shrink a healthy stream, so the undefaulted `facts` are what
 * this reads and absent means "do not cap" (D393).
 */

export interface EgressGeometryInput {
  /** What the consumer asked for. Absent ⇒ the source decides. */
  readonly requestedWidth?: number | undefined
  readonly requestedHeight?: number | undefined
  /** What the source REALLY is. Absent ⇒ unknown, and unknown never caps. */
  readonly sourceWidth?: number | undefined
  readonly sourceHeight?: number | undefined
}

export interface EgressGeometry {
  readonly width?: number
  readonly height?: number
}

function capAxis(requested: number | undefined, source: number | undefined): number | undefined {
  if (requested === undefined) return undefined
  if (source === undefined || source <= 0) return requested
  return Math.min(requested, source)
}

export function deliveredGeometry(input: EgressGeometryInput): EgressGeometry {
  const width = capAxis(input.requestedWidth, input.sourceWidth)
  const height = capAxis(input.requestedHeight, input.sourceHeight)
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}
