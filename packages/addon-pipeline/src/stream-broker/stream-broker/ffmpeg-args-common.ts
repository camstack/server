/**
 * Low-level ffmpeg argument fragments shared, byte-for-byte, across the
 * broker's ffmpeg sites (transcode egress, the WebRTC transcode feed, the
 * mjpeg decoder session). These are the pieces that were genuinely identical;
 * the higher-level builders differ (RTSP vs stdin input, hw vs sw encoders,
 * scale-filter shapes) and stay separate. Pure + side-effect-free.
 */

/** Audio encoders addressable by both the preset model and the EncodeProfile model. */
export type FfmpegAudioCodec = 'opus' | 'aac' | 'pcmu' | 'pcma' | 'copy'

export interface AudioEncoderArgsOptions {
  readonly bitrateKbps?: number
  readonly sampleRateHz?: number
  readonly channels?: number
}

const AUDIO_ENCODER_BY_CODEC: Record<FfmpegAudioCodec, string> = {
  opus: 'libopus',
  aac: 'aac',
  pcmu: 'pcm_mulaw',
  pcma: 'pcm_alaw',
  copy: 'copy',
}

/**
 * Build the audio-encode args `-c:a <enc> [-b:a Nk] [-ar N] [-ac N]`. Each knob
 * is emitted only when provided, in this fixed order — matching what every
 * broker site already emitted by hand.
 */
export function audioEncoderArgs(
  codec: FfmpegAudioCodec,
  opts: AudioEncoderArgsOptions = {},
): string[] {
  const args = ['-c:a', AUDIO_ENCODER_BY_CODEC[codec]]
  if (opts.bitrateKbps !== undefined) args.push('-b:a', `${opts.bitrateKbps}k`)
  if (opts.sampleRateHz !== undefined) args.push('-ar', String(opts.sampleRateHz))
  if (opts.channels !== undefined) args.push('-ac', String(opts.channels))
  return args
}

/** The `-hide_banner -loglevel <level>` preamble every broker ffmpeg site opens with. */
export function logBannerArgs(level: 'error' | 'warning' | 'info'): string[] {
  return ['-hide_banner', '-loglevel', level]
}
