/**
 * Pure argv builder for the ffmpeg SOURCE reader: re-mux the real camera source
 * into an MPEG-TS byte stream on stdout that the broker's `MpegTsDemux` consumes
 * and re-injects via `pushEncodedPacket`. `-c copy` = no re-encode (the source
 * codec/timestamps are preserved; the point of the pass is to let ffmpeg
 * normalize bad cloud PTS/DTS through `inputArgs`/`outputArgs`, not to transcode).
 *
 * `inputArgs`/`outputArgs` are the normalization seam (default empty). No spawn
 * here — the argv shape is unit-tested.
 */
export interface FfmpegSourceReaderArgOptions {
  readonly sourceUrl: string
  /**
   * Source container hint. Only `'rtsp'` receives an `-rtsp_transport`
   * flag; `'rtmp'` and `'http'` (e.g. HTTP-FLV) are passed to `-i`
   * directly — ffmpeg picks the demuxer from the URL scheme.
   */
  readonly sourceKind: 'rtsp' | 'rtmp' | 'http'
  readonly transport: 'tcp' | 'udp'
  /** Normalization hook — before `-i`. Default none. */
  readonly inputArgs?: readonly string[]
  /** Normalization hook — after `-c copy`. Default none. */
  readonly outputArgs?: readonly string[]
}

/** MJPEG cannot enter the broker's MPEG-TS demuxer directly; normalize it. */
export const HTTP_MJPEG_H264_OUTPUT_ARGS = [
  '-an',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-tune',
  'zerolatency',
  '-pix_fmt',
  'yuv420p',
  '-g',
  '4',
  '-bf',
  '0',
] as const

/**
 * Split each operator-supplied arg entry on whitespace so a persisted multi-token
 * line (the settings widget stores one textarea LINE per entry, e.g.
 * `"-use_wallclock_as_timestamps 1"`) becomes SEPARATE argv tokens — `spawn`
 * needs `['-use_wallclock_as_timestamps', '1']`, not a single spaced argument.
 * Blank entries/tokens are dropped. (ffmpeg flags never carry space-bearing
 * values, so whitespace splitting is safe here.)
 */
function flattenArgTokens(entries: readonly string[]): string[] {
  return entries.flatMap((e) => e.trim().split(/\s+/)).filter((t) => t.length > 0)
}

export function buildFfmpegSourceReaderArgs(o: FfmpegSourceReaderArgOptions): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'warning']
  if (o.inputArgs) args.push(...flattenArgTokens(o.inputArgs))
  if (o.sourceKind === 'rtsp') args.push('-rtsp_transport', o.transport)
  args.push('-i', o.sourceUrl, '-c', 'copy')
  if (o.outputArgs) args.push(...flattenArgTokens(o.outputArgs))
  // Emit a single-program MPEG-TS byte stream to stdout; `MpegTsDemux` reassembles
  // per-frame `EncodedPacket`s from the pipe and re-injects the push ingress.
  args.push('-f', 'mpegts', 'pipe:1')
  return args
}
