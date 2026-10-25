/**
 * node-av branded-type aliases + branded codec-id resolution.
 *
 * node-av types `AVCodecID` / `AVSampleFormat` / `ChannelLayout` etc. as
 * *branded* values (a plain `number` is not assignable). Rather than guess the
 * export path of each brand, they are DERIVED from the runtime module type
 * (`typeof import('node-av')` / its constants) — a fully-erased type query, so
 * this module drags nothing into the bundle (same discipline as the loader).
 */
import type { NodeAvRuntime } from './nodeav-runtime-loader.js'
import { resolveCodecKey } from './codec-catalog.js'

export type NavConstants = NodeAvRuntime['consts']

/** Branded `AVCodecID` (derived from a known codec-id constant). */
export type AvCodecId = NavConstants['AV_CODEC_ID_AAC']
/** Branded `AVSampleFormat` (derived from a known sample-format constant). */
export type AvSampleFormat = NavConstants['AV_SAMPLE_FMT_S16']
/** The `ChannelLayout` struct node-av's low-level API accepts. */
export type ChannelLayout = Parameters<
  InstanceType<NodeAvRuntime['nav']['SoftwareResampleContext']>['allocSetOpts2']
>[0]

/**
 * Resolve a codec name to its branded libav `AVCodecID` using the real
 * constants. Returns `null` for names outside this addon's matrix. G.722 maps
 * to `AV_CODEC_ID_ADPCM_G722` (there is no plain `AV_CODEC_ID_G722`); linear
 * PCM has no naming oddity — `AV_CODEC_ID_PCM_S16LE` / `AV_CODEC_ID_PCM_F32LE`
 * exist on node-av's constants object under exactly those names.
 */
export function resolveAvCodecId(codec: string, consts: NavConstants): AvCodecId | null {
  switch (resolveCodecKey(codec)) {
    case 'aac':
      return consts.AV_CODEC_ID_AAC
    case 'aac_latm':
      return consts.AV_CODEC_ID_AAC_LATM
    case 'opus':
      return consts.AV_CODEC_ID_OPUS
    case 'pcm_alaw':
      return consts.AV_CODEC_ID_PCM_ALAW
    case 'pcm_mulaw':
      return consts.AV_CODEC_ID_PCM_MULAW
    case 'pcm_s16le':
      return consts.AV_CODEC_ID_PCM_S16LE
    case 'pcm_f32le':
      return consts.AV_CODEC_ID_PCM_F32LE
    case 'g722':
      return consts.AV_CODEC_ID_ADPCM_G722
    case null:
      return null
  }
}

/** Build a canonical mono/stereo (or bare-mask) channel layout. */
export function buildChannelLayout(consts: NavConstants, channels: number): ChannelLayout {
  if (channels === 1) {
    return { nbChannels: 1, order: consts.AV_CHANNEL_ORDER_NATIVE, mask: consts.AV_CH_LAYOUT_MONO }
  }
  if (channels === 2) {
    return {
      nbChannels: 2,
      order: consts.AV_CHANNEL_ORDER_NATIVE,
      mask: consts.AV_CH_LAYOUT_STEREO,
    }
  }
  // >2 channels: unknown mask — libav still interleaves raw samples; exotic
  // layouts are out of scope for the SDP audio surface (mono/stereo only).
  return { nbChannels: channels, order: consts.AV_CHANNEL_ORDER_NATIVE, mask: 0n }
}
