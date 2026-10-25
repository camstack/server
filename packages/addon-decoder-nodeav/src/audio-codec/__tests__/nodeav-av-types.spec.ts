/**
 * The branded-codec-id resolution, against the REAL `node-av/constants`.
 *
 * The catalogue spec next door is deliberately stub-driven so it runs without
 * the native module. This one is the opposite and that is the point: the open
 * question that blocked linear PCM was whether node-av's typed constants
 * surface actually EXPOSES `AV_CODEC_ID_PCM_S16LE`. A stub cannot answer that
 * — a stub answers whatever it was written to answer, which is how a test
 * passes with the mechanism it covers switched off.
 *
 * `node-av/constants` is the same module `nodeav-runtime-loader.ts` imports at
 * runtime, and `NavConstants` is literally `typeof import('node-av/constants')`,
 * so it is passed through with no cast and no adapter.
 */
import { describe, it, expect } from 'vitest'
import * as consts from 'node-av/constants'
import { resolveAvCodecId } from '../nodeav-av-types.js'

describe('resolveAvCodecId against the installed node-av constants', () => {
  it('resolves linear PCM to the real libav codec ids', () => {
    expect(resolveAvCodecId('pcm_s16le', consts)).toBe(consts.AV_CODEC_ID_PCM_S16LE)
    expect(resolveAvCodecId('PCM_S16LE', consts)).toBe(consts.AV_CODEC_ID_PCM_S16LE)
    expect(resolveAvCodecId('pcm_f32le', consts)).toBe(consts.AV_CODEC_ID_PCM_F32LE)
  })

  it('still resolves the pre-existing matrix (G.722 keeps its ADPCM id)', () => {
    expect(resolveAvCodecId('g722', consts)).toBe(consts.AV_CODEC_ID_ADPCM_G722)
    expect(resolveAvCodecId('opus', consts)).toBe(consts.AV_CODEC_ID_OPUS)
    expect(resolveAvCodecId('mpeg4-generic', consts)).toBe(consts.AV_CODEC_ID_AAC)
  })

  it('refuses names outside the matrix rather than guessing one', () => {
    expect(resolveAvCodecId('l16', consts)).toBeNull()
    expect(resolveAvCodecId('vorbis', consts)).toBeNull()
  })
})
