/**
 * Asking the BINARY, because asking the node was answering a different question.
 *
 * The hub downloaded a static ffmpeg and preferred it over the system one. A
 * static build carries no vendor libraries, so on an Intel box with a working
 * iGPU every hardware request failed with `Device creation failed: -12` — the
 * name parses, the device cannot exist — and fell back to software in silence.
 */
import { describe, expect, it } from 'vitest'
import { parseFfmpegCapabilities, pickCapableBinary } from '../ffmpeg/binary-capabilities.js'
import type { FfmpegBinaryCapabilities } from '../ffmpeg/binary-capabilities.js'

function caps(
  path: string,
  hwaccels: readonly string[],
  encoders: readonly string[] = [],
): FfmpegBinaryCapabilities {
  return {
    path,
    version: `${path} v1`,
    hwaccels: new Set(hwaccels),
    encoders: new Set(encoders),
  }
}

/** The two binaries measured on the hub. */
const STATIC = caps('/data/deps/ffmpeg', ['vdpau'])
const SYSTEM = caps('/usr/bin/ffmpeg', ['vdpau', 'cuda', 'vaapi', 'qsv', 'drm'], ['h264_vaapi'])

describe('pickCapableBinary', () => {
  it('picks the one that can serve the node, not the one listed first', () => {
    expect(pickCapableBinary([STATIC, SYSTEM], ['vaapi'])?.path).toBe('/usr/bin/ffmpeg')
  })

  it('honours the ORDER of what the node wants', () => {
    const qsvOnly = caps('/opt/qsv-ffmpeg', ['qsv'])
    expect(pickCapableBinary([qsvOnly, SYSTEM], ['vaapi', 'qsv'])?.path).toBe('/usr/bin/ffmpeg')
    expect(pickCapableBinary([qsvOnly, SYSTEM], ['qsv', 'vaapi'])?.path).toBe('/opt/qsv-ffmpeg')
  })

  it('keeps the caller precedence when nothing can serve the node', () => {
    // A node with no hardware has no reason to prefer either, and the first
    // candidate IS the existing precedence — so this path changes nothing.
    expect(pickCapableBinary([STATIC, SYSTEM], ['videotoolbox'])?.path).toBe('/data/deps/ffmpeg')
    expect(pickCapableBinary([STATIC, SYSTEM], [])?.path).toBe('/data/deps/ffmpeg')
  })

  it('answers null when there is nothing to pick', () => {
    expect(pickCapableBinary([], ['vaapi'])).toBeNull()
  })
})

describe('parsing what ffmpeg actually prints', () => {
  // Verbatim from the hub's `/usr/bin/ffmpeg` on 2026-09-18. The legend rows
  // carry the SAME leading flag shape as the table rows, so a pattern alone
  // reads ` V..... = Video` as an encoder named `=` — which is exactly what my
  // first parser did, and what running it against this output caught.
  const HWACCELS = [
    'Hardware acceleration methods:',
    'vdpau',
    'cuda',
    'vaapi',
    'qsv',
    'drm',
    'opencl',
    'vulkan',
    '',
  ].join('\n')

  const ENCODERS = [
    'Encoders:',
    ' V..... = Video',
    ' A..... = Audio',
    ' S..... = Subtitle',
    ' .F.... = Frame-level multithreading',
    ' ..S... = Slice-level multithreading',
    ' ...X.. = Codec is experimental',
    ' ....B. = Supports draw_horiz_band',
    ' .....D = Supports direct rendering method 1',
    ' ------',
    ' V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)',
    ' V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)',
    ' V....D hevc_vaapi           H.265/HEVC (VAAPI) (codec hevc)',
    ' V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC',
    '',
  ].join('\n')

  it('reads the hwaccel names and not the header', () => {
    const caps = parseFfmpegCapabilities('/usr/bin/ffmpeg', '', HWACCELS, '')
    expect([...caps.hwaccels].toSorted()).toEqual(
      ['cuda', 'drm', 'opencl', 'qsv', 'vaapi', 'vdpau', 'vulkan'].toSorted(),
    )
  })

  it('reads the encoder table and NOT the legend above it', () => {
    const caps = parseFfmpegCapabilities('/usr/bin/ffmpeg', '', '', ENCODERS)
    expect(caps.encoders.has('h264_vaapi')).toBe(true)
    expect(caps.encoders.has('libx264')).toBe(true)
    expect(caps.encoders.has('=')).toBe(false)
    expect(caps.encoders.size).toBe(4)
  })

  it('answers empty for a binary that printed nothing', () => {
    const caps = parseFfmpegCapabilities('/nope/ffmpeg', '', '', '')
    expect(caps.hwaccels.size).toBe(0)
    expect(caps.encoders.size).toBe(0)
  })
})
