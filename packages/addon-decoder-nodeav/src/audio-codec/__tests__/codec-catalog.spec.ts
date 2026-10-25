/**
 * Pure unit coverage for the codec catalogue + name resolution. No `node-av`
 * import — the `AVCodecID` mapping is verified against a stub constants object,
 * so these assertions always run regardless of the native binding.
 */
import { describe, it, expect } from 'vitest'
import {
  CODEC_CATALOG,
  catalogEntryFor,
  codecSupports,
  resolveAudioCodecAlias,
  resolveCodecKey,
} from '../codec-catalog.js'

describe('resolveAudioCodecAlias', () => {
  it('normalises SDP names to libav names', () => {
    expect(resolveAudioCodecAlias('MPEG4-GENERIC')).toBe('aac')
    expect(resolveAudioCodecAlias('mpeg4-generic')).toBe('aac')
    expect(resolveAudioCodecAlias('L16')).toBe('pcm_s16be')
    expect(resolveAudioCodecAlias('AAC_LATM')).toBe('aac_latm')
    expect(resolveAudioCodecAlias('Opus')).toBe('opus')
  })
})

describe('CODEC_CATALOG matches the ffmpeg addon surface', () => {
  it('lists the same nine codecs', () => {
    expect(CODEC_CATALOG.map((e) => e.codec)).toEqual([
      'pcm_mulaw',
      'pcm_alaw',
      'pcm_s16le',
      'pcm_f32le',
      'g722',
      'aac',
      'aac_latm',
      'mpeg4-generic',
      'opus',
    ])
  })

  it('lists aac_latm / mpeg4-generic as decode-only entries', () => {
    // The raw catalogue entries advertise these named codecs as decode-only in
    // listSupportedCodecs. aac_latm has no alias so it resolves to itself.
    expect(CODEC_CATALOG.find((e) => e.codec === 'aac_latm')?.canEncode).toBe(false)
    expect(CODEC_CATALOG.find((e) => e.codec === 'mpeg4-generic')?.canEncode).toBe(false)
    expect(catalogEntryFor('aac_latm')?.canEncode).toBe(false)
  })
})

describe('catalogEntryFor / codecSupports', () => {
  it('resolves aliases to the underlying entry (mirrors ffmpeg canHandle)', () => {
    // mpeg4-generic aliases to aac for capability resolution, so it inherits
    // aac's encode support — identical to audio-codec-ffmpeg's canHandle.
    expect(codecSupports('mpeg4-generic', 'decode')).toBe(true)
    expect(codecSupports('mpeg4-generic', 'encode')).toBe(true)
    // aac_latm has no alias — it stays its own decode-only entry.
    expect(codecSupports('aac_latm', 'decode')).toBe(true)
    expect(codecSupports('aac_latm', 'encode')).toBe(false)
    expect(codecSupports('aac', 'encode')).toBe(true)
    expect(codecSupports('opus', 'encode')).toBe(true)
    expect(codecSupports('g722', 'encode')).toBe(true)
  })

  it('returns false for unknown codecs', () => {
    expect(codecSupports('vorbis', 'decode')).toBe(false)
    expect(catalogEntryFor('vorbis')).toBeNull()
  })
})

describe('resolveCodecKey', () => {
  it('maps catalogue codecs (incl. aliases) to their canonical libav key', () => {
    expect(resolveCodecKey('aac')).toBe('aac')
    expect(resolveCodecKey('mpeg4-generic')).toBe('aac') // alias → aac
    expect(resolveCodecKey('aac_latm')).toBe('aac_latm')
    expect(resolveCodecKey('Opus')).toBe('opus')
    expect(resolveCodecKey('pcm_alaw')).toBe('pcm_alaw')
    expect(resolveCodecKey('pcm_mulaw')).toBe('pcm_mulaw')
    expect(resolveCodecKey('g722')).toBe('g722') // → AV_CODEC_ID_ADPCM_G722 at runtime
  })

  it('returns null for codecs outside the SDP audio matrix', () => {
    expect(resolveCodecKey('l16')).toBeNull() // aliases to pcm_s16be, still out of scope
    expect(resolveCodecKey('vorbis')).toBeNull()
  })
})

/**
 * Linear PCM. Without these entries a `{pcm_s16le, 22050 → 8000}` decode
 * session cannot be created, and an intercom provider handed raw PCM at the
 * wrong rate has nothing to call — which is why both providers dropped the
 * frame (D281).
 */
describe('linear PCM is in the matrix', () => {
  it('advertises pcm_s16le and pcm_f32le both ways', () => {
    expect(codecSupports('pcm_s16le', 'decode')).toBe(true)
    expect(codecSupports('pcm_s16le', 'encode')).toBe(true)
    expect(codecSupports('pcm_f32le', 'decode')).toBe(true)
    expect(codecSupports('pcm_f32le', 'encode')).toBe(true)
  })

  it('resolves them to their own libav keys (no alias hop)', () => {
    expect(resolveCodecKey('pcm_s16le')).toBe('pcm_s16le')
    expect(resolveCodecKey('PCM_S16LE')).toBe('pcm_s16le')
    expect(resolveCodecKey('pcm_f32le')).toBe('pcm_f32le')
  })

  it('leaves big-endian L16 out — nothing here has ever produced it', () => {
    expect(codecSupports('l16', 'decode')).toBe(false)
    expect(codecSupports('pcm_s16be', 'decode')).toBe(false)
  })
})
