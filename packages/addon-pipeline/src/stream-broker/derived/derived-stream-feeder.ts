/**
 * DerivedStreamFeeder — the transcoding ingress for derived streams.
 *
 * Spawns `ffmpeg ... -f mpegts pipe:1` with TRANSCODE args (from
 * `buildDerivedTranscodeArgs`) to produce a re-encoded profile from a source
 * stream, then demuxes ffmpeg's MPEG-TS stdout back into per-frame
 * `EncodedPacket`s handed to the broker's push ingress.
 *
 * This is the transcoding sibling of {@link FfmpegSourceReader}: the two share
 * the entire spawn → demux → push machinery via {@link FfmpegPushReader} and
 * differ ONLY in intent — the caller passes transcode args here instead of
 * `-c copy`. The constructor + callback contract are identical so the parent
 * broker wires this the same way it wires `FfmpegSourceReader`.
 */

import {
  FfmpegPushReader,
  type FfmpegPushReaderCallbacks,
  type FfmpegPushReaderOptions,
} from '../rtsp/ffmpeg-push-reader.js'

export type DerivedStreamFeederCallbacks = FfmpegPushReaderCallbacks
export type DerivedStreamFeederOptions = FfmpegPushReaderOptions

/** Log label prefixing this feeder's diagnostics and terminal error message. */
const LOG_LABEL = 'derived stream feeder'

export class DerivedStreamFeeder extends FfmpegPushReader {
  constructor(options: DerivedStreamFeederOptions, callbacks: DerivedStreamFeederCallbacks) {
    super(options, callbacks, LOG_LABEL)
  }
}
