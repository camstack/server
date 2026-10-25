/**
 * The incremental fMP4 demux, proved against the demux the stored path
 * already trusts: whatever `demuxSegmentFullJs` (mp4box, whole file) yields
 * for a real `frag_keyframe+empty_moov+default_base_moof` file, this one must
 * yield byte-for-byte — at every chunk size a socket could deliver.
 *
 *   ffmpeg -f lavfi -i testsrc=size=64x64:rate=15 -t 2 -c:v libx264 -g 15
 *     -pix_fmt yuv420p -movflags frag_keyframe+empty_moov+default_base_moof clip-frag.mp4
 *   ffmpeg -f lavfi -i testsrc=size=64x64:rate=15 -t 2 -c:v libx265 -g 15
 *     -pix_fmt yuv420p -tag:v hvc1 -movflags frag_keyframe+empty_moov+default_base_moof clip-frag-hevc.mp4
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFmp4StreamDemuxer, Fmp4DemuxError, type Fmp4AudioUnit } from '../fmp4-stream-demux'
import { demuxSegmentFullJs } from '../segment-demux-js'
import type { AccessUnit } from '../segment-demux'

const H264 = readFileSync(join(__dirname, 'fixtures/clip-frag.mp4'))
const HEVC = readFileSync(join(__dirname, 'fixtures/clip-frag-hevc.mp4'))

function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size))
  return out
}

function demuxInChunks(bytes: Uint8Array, size: number): AccessUnit[] {
  const demuxer = createFmp4StreamDemuxer()
  const out: AccessUnit[] = []
  for (const chunk of chunks(bytes, size)) out.push(...demuxer.push(chunk))
  return out
}

function sameUnits(a: readonly AccessUnit[], b: readonly AccessUnit[]): void {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined) throw new Error('unreachable')
    expect(x.codec).toBe(y.codec)
    expect(x.keyframe).toBe(y.keyframe)
    expect(x.ptsMs).toBeCloseTo(y.ptsMs, 6)
    expect(Buffer.from(x.data).equals(Buffer.from(y.data))).toBe(true)
  }
}

/** The whole-file box offsets of the first `mdat`, so a test can stop inside it. */
function firstMdat(bytes: Uint8Array): { start: number; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (type === 'mdat') return { start: at, end: at + size }
    at += size
  }
  throw new Error('no mdat in fixture')
}

describe('createFmp4StreamDemuxer against the mp4box whole-file demux', () => {
  it.each([
    1,
    7,
    100,
    4096,
    H264.length,
  ])('H.264: every sample, in decode order, byte-identical, at %i-byte chunks', async (size) => {
    const reference = await demuxSegmentFullJs(H264)
    if (reference === null) throw new Error('mp4box could not read the fixture')
    const streamed = demuxInChunks(H264, size)
    sameUnits(streamed, reference)
    expect(streamed.length).toBe(30)
    expect(streamed.filter((u) => u.keyframe).length).toBe(2)
    expect(streamed[0]?.codec).toBe('H264')
  })

  it.each([1, 13, 4096])('H.265: the same, through hvcC, at %i-byte chunks', async (size) => {
    const reference = await demuxSegmentFullJs(HEVC)
    if (reference === null) throw new Error('mp4box could not read the fixture')
    const streamed = demuxInChunks(HEVC, size)
    sameUnits(streamed, reference)
    expect(streamed[0]?.codec).toBe('H265')
    expect(streamed.filter((u) => u.keyframe).length).toBe(2)
  })

  it('emits a sample the moment ITS bytes are in — before the mdat closes', () => {
    const { start, end } = firstMdat(H264)
    const demuxer = createFmp4StreamDemuxer()
    // The moov and the first moof, plus the first ~80 % of the first mdat.
    const cutAt = start + Math.floor((end - start) * 0.8)
    const early = demuxer.push(H264.subarray(0, cutAt))
    expect(demuxer.ready).toBe(true)
    expect(early.length).toBeGreaterThan(0)
    expect(early[0]?.keyframe).toBe(true)
    const pending = demuxer.end()
    expect(pending.pendingSamples).toBeGreaterThan(0)
    // The rest lands and nothing is lost or duplicated.
    const late = demuxer.push(H264.subarray(cutAt))
    expect(early.length + late.length).toBe(30)
    expect(demuxer.end().pendingSamples).toBe(0)
  })

  it('reports the duration only from what it emitted — 2 s of 15 fps, never 0', () => {
    const demuxer = createFmp4StreamDemuxer()
    expect(demuxer.end().durationMs).toBeNull()
    demuxer.push(H264)
    const end = demuxer.end()
    expect(end.durationMs).toBe(2000)
    expect(end.samples).toBe(30)
    expect(end.trailingBytes).toBe(0)
  })

  it('holds nothing behind the last emitted sample (the consumer backlog is bounded)', () => {
    const demuxer = createFmp4StreamDemuxer()
    demuxer.push(H264)
    expect(demuxer.pendingBytes).toBe(0)
  })

  it('REFUSES media before any moov, by name, and stays refused', () => {
    const { start } = firstMdat(H264)
    const demuxer = createFmp4StreamDemuxer()
    // Find the first moof and feed from there: no moov ever arrives.
    let moofAt = 0
    const view = new DataView(H264.buffer, H264.byteOffset, H264.byteLength)
    while (moofAt < start) {
      const type = String.fromCharCode(...H264.subarray(moofAt + 4, moofAt + 8))
      if (type === 'moof') break
      moofAt += view.getUint32(moofAt)
    }
    expect(() => demuxer.push(H264.subarray(moofAt))).toThrow(Fmp4DemuxError)
    expect(() => demuxer.push(H264.subarray(moofAt))).toThrowError(
      expect.objectContaining({ reason: 'no-moov' }),
    )
  })

  it('REFUSES a moov whose only track is not video', () => {
    // Rewrite the handler type `vide` → `soun` inside the moov.
    const copy = Buffer.from(H264)
    const at = copy.indexOf('vide')
    expect(at).toBeGreaterThan(0)
    copy.write('soun', at, 'ascii')
    const demuxer = createFmp4StreamDemuxer()
    expect(() => demuxer.push(copy)).toThrowError(
      expect.objectContaining({ reason: 'no-video-track' }),
    )
  })

  it('REFUSES a box that cannot fit where it says it is', () => {
    const copy = Buffer.from(H264)
    // The first mdat claims to be 12 bytes long: its samples run past it.
    const { start } = firstMdat(H264)
    copy.writeUInt32BE(12, start)
    const demuxer = createFmp4StreamDemuxer()
    expect(() => demuxer.push(copy)).toThrowError(expect.objectContaining({ reason: 'malformed' }))
  })
})

/**
 * The AUDIO track (D600), on fixtures produced by the PRODUCTION arg builder
 * (`buildClipStreamMuxArgs`) driven through the production two-pipe spawn
 * shape, fed in interleaved media order the way a camera delivers:
 *
 *   -r 15 -f h264 -i pipe:0 -f aac -i pipe:3 -map 0:v -map 1:a -c:v copy
 *     -c:a libopus -ar 48000 -ac 1 -b:a 24k
 *     -movflags frag_keyframe+empty_moov+default_base_moof -f mp4
 *
 *   …-c:a pcm_mulaw -ar 8000 -ac 1 … -f mov   (MP4 REFUSES pcm_mulaw)
 *
 * These are the bytes the broker really receives, not a synthesised container.
 */
const OPUS = readFileSync(join(__dirname, 'fixtures/clip-frag-opus.mp4'))
const PCMU = readFileSync(join(__dirname, 'fixtures/clip-frag-pcmu.mov'))

/**
 * Add `ticks` to every `tfdt` of the SECOND track in every `moof`.
 *
 * ffmpeg writes video as track 1 and audio as track 2, so this moves the
 * audio's media time and nothing else. A box walk rather than a byte search:
 * a `tfdt` is found by structure, never by scanning for four characters that
 * could appear in a sample.
 */
function shiftAudioTfdt(bytes: Uint8Array, ticks: number): Uint8Array {
  const out = Buffer.from(bytes)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const fourcc = (at: number): string => out.toString('latin1', at + 4, at + 8)
  const walkTraf = (start: number, end: number): void => {
    let at = start
    let isAudio = false
    let tfdtAt = -1
    while (at + 8 <= end) {
      const size = view.getUint32(at)
      const type = fourcc(at)
      if (type === 'tfhd') isAudio = view.getUint32(at + 12) === 2
      if (type === 'tfdt') tfdtAt = at
      at += size
    }
    if (!isAudio || tfdtAt === -1) return
    const version = out[tfdtAt + 8] ?? 0
    if (version === 1) {
      view.setBigUint64(tfdtAt + 12, view.getBigUint64(tfdtAt + 12) + BigInt(ticks))
    } else {
      view.setUint32(tfdtAt + 12, view.getUint32(tfdtAt + 12) + ticks)
    }
  }
  let at = 0
  while (at + 8 <= out.byteLength) {
    const size = view.getUint32(at)
    if (fourcc(at) === 'moof') {
      let child = at + 8
      while (child + 8 <= at + size) {
        const childSize = view.getUint32(child)
        if (fourcc(child) === 'traf') walkTraf(child + 8, child + childSize)
        child += childSize
      }
    }
    at += size
  }
  return out
}

/**
 * Add `ticks` to EVERY `tfdt` — both tracks — so the stream starts at a media
 * time that is not zero.
 */
function shiftAllTfdt(bytes: Uint8Array, videoTicks: number, audioTicks: number): Uint8Array {
  const out = Buffer.from(bytes)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const fourcc = (at: number): string => out.toString('latin1', at + 4, at + 8)
  const walkTraf = (start: number, end: number): void => {
    let at = start
    let track = 0
    let tfdtAt = -1
    while (at + 8 <= end) {
      const size = view.getUint32(at)
      const type = fourcc(at)
      if (type === 'tfhd') track = view.getUint32(at + 12)
      if (type === 'tfdt') tfdtAt = at
      at += size
    }
    if (tfdtAt === -1) return
    const ticks = track === 2 ? audioTicks : videoTicks
    const version = out[tfdtAt + 8] ?? 0
    if (version === 1) {
      view.setBigUint64(tfdtAt + 12, view.getBigUint64(tfdtAt + 12) + BigInt(ticks))
    } else {
      view.setUint32(tfdtAt + 12, view.getUint32(tfdtAt + 12) + ticks)
    }
  }
  let at = 0
  while (at + 8 <= out.byteLength) {
    const size = view.getUint32(at)
    if (fourcc(at) === 'moof') {
      let child = at + 8
      while (child + 8 <= at + size) {
        const childSize = view.getUint32(child)
        if (fourcc(child) === 'traf') walkTraf(child + 8, child + childSize)
        child += childSize
      }
    }
    at += size
  }
  return out
}

/**
 * Put the AUDIO `traf` first in every `moof`.
 *
 * Legal, and inert: with `default-base-is-moof` every `trun`'s data offset is
 * measured from the `moof`, so swapping two equal-sized siblings moves no
 * sample. What it DOES change is the order the samples are announced in,
 * which is not the order their bytes arrive in.
 */
function swapTrafs(bytes: Uint8Array): Uint8Array {
  const out = Buffer.from(bytes)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const fourcc = (at: number): string => out.toString('latin1', at + 4, at + 8)
  let at = 0
  while (at + 8 <= out.byteLength) {
    const size = view.getUint32(at)
    if (fourcc(at) === 'moof') {
      const trafs: Array<{ start: number; size: number }> = []
      let child = at + 8
      while (child + 8 <= at + size) {
        const childSize = view.getUint32(child)
        if (fourcc(child) === 'traf') trafs.push({ start: child, size: childSize })
        child += childSize
      }
      const [first, second] = trafs
      if (trafs.length === 2 && first !== undefined && second !== undefined) {
        const a = Buffer.from(out.subarray(first.start, first.start + first.size))
        const b = Buffer.from(out.subarray(second.start, second.start + second.size))
        b.copy(out, first.start)
        a.copy(out, first.start + b.length)
      }
    }
    at += size
  }
  return out
}

interface DemuxedBoth {
  readonly video: AccessUnit[]
  readonly audio: Fmp4AudioUnit[]
  readonly state: ReturnType<typeof createFmp4StreamDemuxer>['audio']
  readonly end: ReturnType<ReturnType<typeof createFmp4StreamDemuxer>['end']>
}

function demuxBoth(bytes: Uint8Array, size: number): DemuxedBoth {
  const audio: Fmp4AudioUnit[] = []
  const demuxer = createFmp4StreamDemuxer({ onAudio: (u) => audio.push(u) })
  const video: AccessUnit[] = []
  for (const chunk of chunks(bytes, size)) video.push(...demuxer.push(chunk))
  return { video, audio, state: demuxer.audio, end: demuxer.end() }
}

describe('createFmp4StreamDemuxer: the audio track a clip stream carries', () => {
  it('is UNKNOWN until the moov has been read — not-yet-said is not silent', () => {
    const demuxer = createFmp4StreamDemuxer({ onAudio: () => {} })
    expect(demuxer.audio).toEqual({ kind: 'unknown' })
    // The `ftyp` alone says nothing either.
    demuxer.push(OPUS.subarray(0, 8))
    expect(demuxer.audio).toEqual({ kind: 'unknown' })
  })

  it('reads the Opus sample entry: 48 kHz, one channel, and every packet verbatim', () => {
    const out = demuxBoth(OPUS, OPUS.length)
    expect(out.state).toEqual({ kind: 'ready', codec: 'opus', sampleRateHz: 48_000, channels: 1 })
    expect(out.audio.length).toBeGreaterThan(150)
    expect(out.end.audioSamples).toBe(out.audio.length)
    // An Opus sample IS one RTP payload: TOC byte present, never a container box.
    for (const unit of out.audio) {
      expect(unit.codec).toBe('opus')
      expect(unit.data.byteLength).toBeGreaterThan(0)
    }
  })

  it('reads the QuickTime `ulaw` sample entry a pcm_mulaw mux produces: 8 kHz mono', () => {
    const out = demuxBoth(PCMU, PCMU.length)
    expect(out.state).toEqual({ kind: 'ready', codec: 'pcmu', sampleRateHz: 8_000, channels: 1 })
    // One byte per sample at 8 kHz: the summed bytes ARE the summed duration.
    const bytes = out.audio.reduce((sum, u) => sum + u.data.byteLength, 0)
    const ms = out.audio.reduce((sum, u) => sum + u.durationMs, 0)
    expect(Math.round((bytes * 1000) / 8_000)).toBe(ms)
  })

  it.each([
    1, 7, 100, 4096,
  ])('emits the same audio, in order, at %i-byte chunks — the socket boundary changes nothing', (size) => {
    for (const fixture of [OPUS, PCMU]) {
      const whole = demuxBoth(fixture, fixture.length)
      const split = demuxBoth(fixture, size)
      expect(split.audio.length).toBe(whole.audio.length)
      for (let i = 0; i < whole.audio.length; i++) {
        const a = whole.audio[i]
        const b = split.audio[i]
        if (a === undefined || b === undefined) throw new Error('unreachable')
        expect(b.ptsMs).toBe(a.ptsMs)
        expect(b.durationMs).toBe(a.durationMs)
        expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true)
      }
    }
  })

  it('never hands back an audio timestamp behind the one before it', () => {
    for (const fixture of [OPUS, PCMU]) {
      const { audio } = demuxBoth(fixture, 4096)
      for (let i = 1; i < audio.length; i++) {
        expect(audio[i]?.ptsMs).toBeGreaterThanOrEqual(audio[i - 1]?.ptsMs ?? 0)
      }
    }
  })

  it('measures the audio from the VIDEO\u2019s origin, not from its own first sample', () => {
    // ffmpeg starts both tracks at media time 0, so the shared origin is not
    // observable on the bytes as written — which is exactly why it is easy to
    // get wrong and never notice. Shift every audio `tfdt` half a second and
    // the two readings separate: measured from the stream's ONE origin the
    // audio moves by 500 ms, measured from its own first sample it does not
    // move at all, and the offset between sound and picture — the whole
    // content of lip sync — is silently erased.
    const shifted = shiftAudioTfdt(OPUS, 48_000 / 2)
    const base = demuxBoth(OPUS, 4096)
    const moved = demuxBoth(shifted, 4096)
    expect(moved.audio.length).toBe(base.audio.length)
    expect(moved.audio[0]?.ptsMs).toBe((base.audio[0]?.ptsMs ?? 0) + 500)
    expect(moved.audio[10]?.ptsMs).toBe((base.audio[10]?.ptsMs ?? 0) + 500)
    // And the picture does not move with it.
    sameUnits(moved.video, base.video)
  })

  it('measures BOTH tracks from the stream\u2019s own origin, not from media time zero', () => {
    // Move the whole stream — both tracks equally — one second along the
    // media timeline. Nothing about the clip changed, so nothing the demuxer
    // hands out may change: a consumer paces on this axis and a track read
    // as absolute media time would arrive a second late for ever.
    const shifted = shiftAllTfdt(OPUS, 15_360, 48_000)
    const base = demuxBoth(OPUS, 4096)
    const moved = demuxBoth(shifted, 4096)
    sameUnits(moved.video, base.video)
    expect(moved.audio.map((u) => u.ptsMs)).toEqual(base.audio.map((u) => u.ptsMs))
  })

  it('drains a fragment in FILE-OFFSET order, whatever order the trafs announce', () => {
    // ffmpeg writes video's traf first and its bytes first, so announcement
    // order and arrival order agree — and a demuxer that drained in
    // announcement order would look correct for ever. Swap the trafs and the
    // two orders part company: drained as announced, the audio run is
    // consumed first and the video bytes behind it are gone.
    const swapped = swapTrafs(OPUS)
    const base = demuxBoth(OPUS, 4096)
    const out = demuxBoth(swapped, 4096)
    sameUnits(out.video, base.video)
    expect(out.audio.map((u) => u.ptsMs)).toEqual(base.audio.map((u) => u.ptsMs))
  })

  it('anchors BOTH tracks on ONE origin — the A/V offset is content, not noise', () => {
    for (const fixture of [OPUS, PCMU]) {
      const { video, audio, end } = demuxBoth(fixture, 4096)
      const firstVideo = video[0]
      const firstAudio = audio[0]
      if (firstVideo === undefined || firstAudio === undefined) throw new Error('unreachable')
      // Video is written first in every fragment, so it defines the origin
      // and starts at 0. Audio is measured FROM THAT, never re-zeroed: if the
      // two tracks were anchored separately this would be 0 by construction
      // and the real offset would have been erased.
      expect(firstVideo.ptsMs).toBe(0)
      expect(firstAudio.ptsMs).toBeGreaterThanOrEqual(0)
      // And the two axes stay the same length: the audio's last moment is
      // within a frame or two of the video's, over the whole fixture.
      const lastVideo = video[video.length - 1]?.ptsMs ?? 0
      const lastAudio = audio[audio.length - 1]?.ptsMs ?? 0
      expect(Math.abs(lastAudio - lastVideo)).toBeLessThan(250)
      expect(end.durationMs).not.toBeNull()
    }
  })

  it('follows NO audio track when the consumer wired no sink for it', () => {
    const withAudio = demuxBoth(OPUS, 4096)
    const silent = createFmp4StreamDemuxer()
    const video: AccessUnit[] = []
    for (const chunk of chunks(OPUS, 4096)) video.push(...silent.push(chunk))
    // The state still SAYS what the moov declared — that costs nothing and a
    // consumer has to be able to report it — but nothing was emitted.
    expect(silent.audio).toEqual(withAudio.state)
    expect(silent.end().audioSamples).toBe(0)
    // And the video is untouched by the other track's presence either way.
    sameUnits(video, withAudio.video)
  })

  it('REPORTS an audio codec it cannot forward, and keeps the video', () => {
    // Rewrite the `Opus` sample entry to something this process cannot send.
    const copy = Buffer.from(OPUS)
    const at = copy.indexOf('Opus')
    expect(at).toBeGreaterThan(0)
    copy.write('mp4a', at, 'ascii')
    const audio: Fmp4AudioUnit[] = []
    const demuxer = createFmp4StreamDemuxer({ onAudio: (u) => audio.push(u) })
    const video: AccessUnit[] = []
    for (const chunk of chunks(copy, 4096)) video.push(...demuxer.push(chunk))
    expect(demuxer.audio).toEqual({ kind: 'unsupported', sampleEntry: 'mp4a' })
    expect(audio).toHaveLength(0)
    // Silence is not a refusal: the picture is served whole.
    expect(video.length).toBe(demuxBoth(OPUS, 4096).video.length)
  })

  it('says `absent` for a stream with no audio track at all', () => {
    const demuxer = createFmp4StreamDemuxer({ onAudio: () => {} })
    demuxer.push(H264)
    expect(demuxer.audio).toEqual({ kind: 'absent' })
    expect(demuxer.end().audioSamples).toBe(0)
  })

  it('serves the video byte-identically whether or not the stream carries sound', async () => {
    // The stored-path demux is the reference for BOTH: adding a second track
    // to the container must not move a single video byte or timestamp.
    for (const fixture of [OPUS, PCMU]) {
      const reference = await demuxSegmentFullJs(fixture)
      if (reference === null) throw new Error('mp4box could not read the fixture')
      sameUnits(demuxBoth(fixture, 4096).video, reference)
    }
  })
})
