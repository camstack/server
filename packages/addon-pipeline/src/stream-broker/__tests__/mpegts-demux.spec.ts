import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { EncodedPacket } from '@camstack/types'
import { beforeAll, describe, expect, it } from 'vitest'
import { type MpegTsCodecInfo, MpegTsDemux } from '../rtsp/mpegts-demux.js'

const FIXTURE_URL = new URL('./fixtures/mpegts-demux-fixture.mpegts', import.meta.url)

interface Collected {
  readonly packets: EncodedPacket[]
  readonly codecs: MpegTsCodecInfo[]
}

function demuxWhole(bytes: Buffer): Collected {
  const packets: EncodedPacket[] = []
  const codecs: MpegTsCodecInfo[] = []
  const demux = new MpegTsDemux({
    onPacket: (p) => packets.push(p),
    onCodecs: (c) => codecs.push(c),
  })
  demux.push(bytes)
  demux.flush()
  return { packets, codecs }
}

function demuxChunked(bytes: Buffer, sizes: readonly number[]): Collected {
  const packets: EncodedPacket[] = []
  const codecs: MpegTsCodecInfo[] = []
  const demux = new MpegTsDemux({
    onPacket: (p) => packets.push(p),
    onCodecs: (c) => codecs.push(c),
  })
  let offset = 0
  let sizeIdx = 0
  while (offset < bytes.length) {
    const size = sizes[sizeIdx % sizes.length]!
    demux.push(bytes.subarray(offset, offset + size))
    offset += size
    sizeIdx++
  }
  demux.flush()
  return { packets, codecs }
}

describe('MpegTsDemux', () => {
  let fixture: Buffer

  beforeAll(() => {
    fixture = readFileSync(fileURLToPath(FIXTURE_URL))
    expect(fixture.length).toBeGreaterThan(0)
  })

  it('detects h264 video + aac audio codecs from the PMT', () => {
    const { codecs } = demuxWhole(fixture)
    expect(codecs.length).toBe(1)
    expect(codecs[0]?.video).toBe('h264')
    expect(codecs[0]?.audio).toBe('aac')
  })

  it('emits both video and audio packets', () => {
    const { packets } = demuxWhole(fixture)
    const video = packets.filter((p) => p.type === 'video')
    const audio = packets.filter((p) => p.type === 'audio')
    expect(video.length).toBeGreaterThan(0)
    expect(audio.length).toBeGreaterThan(0)
    expect(video.every((p) => p.codec === 'h264')).toBe(true)
    expect(audio.every((p) => p.codec === 'aac')).toBe(true)
  })

  it('emits at least one video keyframe', () => {
    const { packets } = demuxWhole(fixture)
    const keyframes = packets.filter((p) => p.type === 'video' && p.keyframe)
    expect(keyframes.length).toBeGreaterThanOrEqual(1)
  })

  it('the first video packet data starts with an Annex-B start code', () => {
    const { packets } = demuxWhole(fixture)
    const firstVideo = packets.find((p) => p.type === 'video')
    expect(firstVideo).toBeDefined()
    const d = firstVideo!.data
    const threeByte = d[0] === 0x00 && d[1] === 0x00 && d[2] === 0x01
    const fourByte = d[0] === 0x00 && d[1] === 0x00 && d[2] === 0x00 && d[3] === 0x01
    expect(threeByte || fourByte).toBe(true)
  })

  it('video and audio PTS are non-negative and monotonically non-decreasing', () => {
    const { packets } = demuxWhole(fixture)
    for (const kind of ['video', 'audio'] as const) {
      const stream = packets.filter((p) => p.type === kind)
      expect(stream.length).toBeGreaterThan(0)
      for (const p of stream) {
        expect(p.pts).toBeGreaterThanOrEqual(0)
        expect(p.dts).toBeGreaterThanOrEqual(0)
      }
      for (let i = 1; i < stream.length; i++) {
        expect(stream[i]!.pts).toBeGreaterThanOrEqual(stream[i - 1]!.pts)
      }
    }
  })

  it('produces identical packets when fed in tiny chunks (chunk-boundary robustness)', () => {
    const whole = demuxWhole(fixture)
    const chunked = demuxChunked(fixture, [100, 7])

    expect(chunked.codecs).toEqual(whole.codecs)
    expect(chunked.packets.length).toBe(whole.packets.length)
    for (let i = 0; i < whole.packets.length; i++) {
      const a = whole.packets[i]!
      const b = chunked.packets[i]!
      expect(b.type).toBe(a.type)
      expect(b.codec).toBe(a.codec)
      expect(b.pts).toBe(a.pts)
      expect(b.dts).toBe(a.dts)
      expect(b.keyframe).toBe(a.keyframe)
      expect(Buffer.compare(b.data, a.data)).toBe(0)
    }
  })

  it('reset() lets the instance re-parse a second stream', () => {
    const packets: EncodedPacket[] = []
    const demux = new MpegTsDemux({ onPacket: (p) => packets.push(p) })
    demux.push(fixture)
    demux.reset()
    const before = packets.length
    demux.push(fixture)
    demux.flush()
    expect(packets.length).toBeGreaterThan(before)
  })
})
