/**
 * The one place that says what a grid puts on the wire.
 *
 * Four things have to agree — the ffmpeg sink, the HTTP content type, the URL
 * the broker dials, and the `kind` the catalog declares — and on 2026-09-17
 * they stopped agreeing twice in one hour. The switch from MPEG-TS to FLV
 * moved three of them and left the snapshot sampler spawning `-f mpegts`
 * against an FLV pipe: every grab returned nothing, and the WARN said "the
 * frame grab produced no bytes" without naming a format, because from where it
 * stood there was nothing to name.
 *
 * A constant cannot drift the way four literals can. Why FLV at all is
 * explained where the sink is built (`grid-stream-invocation.ts`): the bundled
 * ffmpeg segfaults re-muxing MPEG-TS, which is exactly what the broker's source
 * reader does to whatever this serves.
 */
import type { CamStreamKind } from '@camstack/types'

/** The ffmpeg muxer the composition writes to stdout. */
export const GRID_WIRE_CONTAINER = 'flv' as const

/** What the relay answers with, and what the sampler must demux. */
export const GRID_WIRE_CONTENT_TYPE = 'video/x-flv'

/** `/grid/<instanceId>/<profile>.flv`. */
export const GRID_WIRE_PATH_SUFFIX = '.flv'

/**
 * How the broker must ingest it: `pull-flv` is documented as ALWAYS read
 * through the ffmpeg source reader with `-c copy`. `pull-http` would have been
 * the intuitive choice and means MJPEG in this broker — it answers with
 * `HTTP_MJPEG_H264_OUTPUT_ARGS` and re-encodes an already-encoded H.264.
 */
export const GRID_WIRE_STREAM_KIND: CamStreamKind = 'pull-flv'
