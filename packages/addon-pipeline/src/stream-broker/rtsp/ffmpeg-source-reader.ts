/**
 * FfmpegSourceReader — the "ffmpeg parser" ingress for the stream broker.
 *
 * Spawns `ffmpeg ... -c copy -f mpegts pipe:1` (argv from
 * {@link buildFfmpegSourceReaderArgs}) to pull + re-mux a real camera source
 * without re-encoding, then demuxes ffmpeg's MPEG-TS stdout back into per-frame
 * `EncodedPacket`s. The point of the pass is to let ffmpeg normalize a camera's
 * bad cloud PTS/DTS while preserving the source codec — the demuxed packets are
 * handed straight to the broker's push ingress.
 *
 * The spawn → demux → push machinery lives in {@link FfmpegPushReader}; this
 * class is the `-c copy` (source-normalization) specialization. Its transcoding
 * sibling is `DerivedStreamFeeder`. See the base for the full callback contract.
 */

import {
  type AdtsAudioParams,
  FfmpegPushReader,
  type FfmpegPushReaderCallbacks,
  type FfmpegPushReaderOptions,
  parseAdtsAudioParams,
} from './ffmpeg-push-reader.js'

export type FfmpegSourceReaderCallbacks = FfmpegPushReaderCallbacks
export type FfmpegSourceReaderOptions = FfmpegPushReaderOptions

export { type AdtsAudioParams, parseAdtsAudioParams }

/** Log label prefixing this reader's diagnostics and terminal error message. */
const LOG_LABEL = 'ffmpeg source reader'

export class FfmpegSourceReader extends FfmpegPushReader {
  constructor(options: FfmpegSourceReaderOptions, callbacks: FfmpegSourceReaderCallbacks) {
    super(options, callbacks, LOG_LABEL)
  }
}
