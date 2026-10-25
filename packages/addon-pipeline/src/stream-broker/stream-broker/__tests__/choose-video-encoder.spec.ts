/**
 * The encoder is NOT the decode preference, and this hub paid for that.
 *
 * `pickVideoEncoder` treated `hwAccel: 'copy'` as "software everything". But
 * `copy` is the node's DECODE default for a specific, good reason — hardware
 * decode hard-fails on a fragile HEVC source — and it was silently deciding the
 * ENCODER too. The result on a hub with a working Intel iGPU: every egress and
 * derived transcode ran `libx264`, on cores this box does not have to spare,
 * while the GPU sat idle. (The bundled ffmpeg had no VAAPI either, D536, so
 * even asking would have failed — that is fixed separately.)
 *
 * A software decode can feed a hardware encoder; `hwupload` is exactly that.
 * So the two decisions are separated here, and every software encode now names
 * the reason it is one, because the operator's rule is that a software
 * transcode must not happen silently.
 */
import { describe, expect, it } from 'vitest'
import { chooseVideoEncoder } from '../ffmpeg-invocation.js'

const VAAPI_ENCODERS = new Set(['libx264', 'libx265', 'h264_vaapi', 'hevc_vaapi'])
const SOFTWARE_ONLY = new Set(['libx264', 'libx265'])
const RENDER_NODE = '/dev/dri/renderD128'

function choose(over: Partial<Parameters<typeof chooseVideoEncoder>[0]> = {}) {
  return chooseVideoEncoder({
    target: 'H264',
    backend: 'vaapi',
    binaryEncoders: VAAPI_ENCODERS,
    hwAccelSetting: 'copy',
    renderNode: RENDER_NODE,
    ...over,
  })
}

describe('chooseVideoEncoder', () => {
  it('encodes on the GPU even though the DECODE preference is copy', () => {
    const choice = choose()
    expect(choice.encoder).toBe('h264_vaapi')
    expect(choice.hwEncodeDevice).toEqual({ kind: 'vaapi', renderNode: RENDER_NODE })
    expect(choice.softwareReason).toBeNull()
  })

  it('honours an explicit "none" — an operator who asked for software gets it, named', () => {
    const choice = choose({ hwAccelSetting: 'none' })
    expect(choice.encoder).toBe('libx264')
    expect(choice.softwareReason).toBe('operator-forced-software')
  })

  it('falls back to software when the NODE has no hardware, and says which', () => {
    const choice = choose({ backend: null })
    expect(choice.encoder).toBe('libx264')
    expect(choice.hwEncodeDevice).toBeNull()
    expect(choice.softwareReason).toBe('no-hardware-on-node')
  })

  it('falls back to software when the BINARY lacks the encoder, and says which', () => {
    // The static build: the node has a working iGPU, the binary cannot use it.
    const choice = choose({ binaryEncoders: SOFTWARE_ONLY })
    expect(choice.encoder).toBe('libx264')
    expect(choice.softwareReason).toBe('binary-lacks-encoder')
  })

  it('does not refuse on an UNKNOWN encoder list — a failed probe is not a "no"', () => {
    // `null` is "we could not ask", which must not be read as "it cannot".
    const choice = choose({ binaryEncoders: null })
    expect(choice.encoder).toBe('h264_vaapi')
    expect(choice.softwareReason).toBeNull()
  })

  it('picks the h265 encoder for an h265 target', () => {
    expect(choose({ target: 'H265' }).encoder).toBe('hevc_vaapi')
  })

  it('asks for no device on a backend that uploads by itself', () => {
    // videotoolbox takes software frames directly; a `-vaapi_device` there is
    // a flag for a device that does not exist.
    const choice = choose({
      backend: 'videotoolbox',
      binaryEncoders: new Set(['h264_videotoolbox', 'libx264']),
    })
    expect(choice.encoder).toBe('h264_videotoolbox')
    expect(choice.hwEncodeDevice).toBeNull()
    expect(choice.softwareReason).toBeNull()
  })
})
