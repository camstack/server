/**
 * fmp4-stream-demux — an INCREMENTAL demux of a fragmented MP4 as it arrives.
 *
 * The clip STREAM (`/clip-stream/…`, D597) is an fMP4 written by ffmpeg with
 * `frag_keyframe+empty_moov+default_base_moof` while it is still reading the
 * camera: a `moov` with an EMPTY sample table, then one `moof`+`mdat` per
 * GOP, and no trailer until the end. Nothing in this directory can read that
 * shape as it flows — `clip-mp4-index.ts` wants `stbl` and refuses it
 * `no-samples` by design, `segment-demux-js.ts` (mp4box) wants a WHOLE
 * fragment in hand — so this module walks the boxes itself, byte by byte, and
 * emits every video sample the moment its bytes are in.
 *
 * ## What it emits and when
 *
 * {@link AccessUnit}s, in DECODE order, `ptsMs` anchored at 0 on the first
 * sample's composition time — the same contract `demuxSegmentFullJs` keeps,
 * so a streamed clip and a stored one push the same shape. A sample is
 * emitted as soon as ITS bytes have arrived, not when its `mdat` closes: a
 * GOP is a second or two of video, and a feeder that waited for the box would
 * hand the viewer that second late for nothing.
 *
 * Sync samples are fused with the parameter sets (`avcc-annexb.ts`), delta
 * samples are converted plain; the codec and the `avcC`/`hvcC` come from the
 * `moov`. ONE video track is followed, and — since D600 — ONE audio track
 * beside it; every other track's bytes in an `mdat` are skipped, never
 * emitted.
 *
 * ## The audio track, and the one clock both tracks are on
 *
 * A clip stream carries sound already transcoded to the session's codec
 * (D600): Opus, whose mp4 sample IS the RTP payload, or µ-law in a QuickTime
 * `ulaw` entry. Audio samples are handed to {@link Fmp4StreamDemuxOptions.onAudio}
 * as they land, interleaved with the video in FILE-OFFSET order — which is
 * the order the bytes arrive, and the only order a forward-only window can
 * drain in.
 *
 * **Both tracks are anchored on ONE origin**, the first sample of either to
 * be emitted, and every `ptsMs` is measured from it in exact integer
 * arithmetic over the two timescales. Anchoring each track on its own first
 * sample would zero out the offset BETWEEN them — which is the whole content
 * of lip sync — and would do it invisibly, in a way that only shows up as
 * drift on a long clip.
 *
 * An audio track whose sample entry is neither Opus nor µ-law is REPORTED
 * ({@link Fmp4StreamDemuxer.audio}) and not followed. It is never a refusal:
 * a codec this process cannot forward is a reason to play the clip silent,
 * never a reason to lose the video.
 *
 * ## What it refuses, by name
 *
 * A `moof` before any `moov` (`no-moov`), a `moov` with no video track
 * (`no-video-track`), a codec that is neither AVC nor HEVC
 * (`unsupported-codec`), and a box or a sample that cannot fit where it says
 * it is (`malformed`). Each is thrown ONCE as {@link Fmp4DemuxError}; the
 * demuxer is dead after it and says so on every further push. The bytes come
 * off a camera through two processes — a refusal here is a fact about the
 * stream, never a crash.
 *
 * ## Duration
 *
 * Unknown until the stream ENDS. `end()` answers the sum of the sample
 * durations, in ms, or `null` when no sample was ever emitted — never `0`
 * (D393). The caller learns the length when the camera has finished, which
 * is the truth about a forward-only source.
 */
import { avccSampleToAnnexB, buildKeyframeAnnexB, parseNalLengthSize } from './avcc-annexb.js'
import type { AccessUnit } from './segment-demux.js'

export type Fmp4DemuxRefusalReason =
  | 'no-moov'
  | 'no-video-track'
  | 'unsupported-codec'
  | 'malformed'

export class Fmp4DemuxError extends Error {
  constructor(
    readonly reason: Fmp4DemuxRefusalReason,
    message: string,
  ) {
    super(message)
    this.name = 'Fmp4DemuxError'
  }
}

/** What `end()` reports once the stream has no more bytes. */
export interface Fmp4StreamEnd {
  /** Sum of the emitted VIDEO samples' durations, in ms; `null` when none. */
  readonly durationMs: number | null
  readonly samples: number
  /** Audio samples emitted. Zero on a silent stream and on one not followed. */
  readonly audioSamples: number
  /** Bytes held past the last complete sample — non-zero means a cut. */
  readonly trailingBytes: number
  /** Samples a `moof` announced whose bytes never came — non-zero means a cut. */
  readonly pendingSamples: number
}

/** The audio codecs a clip stream may carry — the two a session negotiates. */
export type Fmp4AudioCodec = 'opus' | 'pcmu'

/** One audio sample, ready for the RTP sender that negotiated {@link codec}. */
export interface Fmp4AudioUnit {
  /**
   * The sample's bytes, verbatim. An Opus sample IS one Opus packet; a µ-law
   * sample is N companded bytes at 8 kHz and the consumer re-frames it.
   */
  readonly data: Uint8Array
  /** Milliseconds from the stream's ONE origin — the same axis as the video. */
  readonly ptsMs: number
  /** How long this sample lasts, so a consumer can judge a late one. */
  readonly durationMs: number
  readonly codec: Fmp4AudioCodec
  readonly sampleRateHz: number
  readonly channels: number
}

/**
 * What the `moov` said about sound. `unknown` until it has been read: a
 * stream whose head has not arrived has not yet said it is silent (D393 —
 * absent is not zero, and not-yet-known is not absent).
 */
export type Fmp4AudioState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'ready'
      readonly codec: Fmp4AudioCodec
      readonly sampleRateHz: number
      readonly channels: number
    }
  /** A track exists and this process cannot forward it — named, not followed. */
  | { readonly kind: 'unsupported'; readonly sampleEntry: string }

export interface Fmp4StreamDemuxOptions {
  /**
   * Where audio samples go. ABSENT means the audio track is not followed at
   * all — its bytes are skipped like any other track's — so a video-only
   * consumer pays nothing for this track existing.
   */
  onAudio?(unit: Fmp4AudioUnit): void
}

export interface Fmp4StreamDemuxer {
  /** Feed the next chunk; returns every access unit it completed, in order. */
  push(chunk: Uint8Array): readonly AccessUnit[]
  end(): Fmp4StreamEnd
  /** True once the `moov` has been read — the codec is known from here on. */
  readonly ready: boolean
  readonly codec: 'H264' | 'H265' | null
  /** What the `moov` said about sound — `unknown` until it has been read. */
  readonly audio: Fmp4AudioState
  /** Bytes held and not yet turned into a sample (D447: the consumer's own backlog). */
  readonly pendingBytes: number
}

const BOX_HEADER = 8
const LARGE_BOX_HEADER = 16
const FULLBOX = 4
/** `sample_is_non_sync_sample`, ISO/IEC 14496-12 § 8.8.3.1. */
const FLAG_NON_SYNC = 0x0001_0000
const TFHD_BASE_DATA_OFFSET = 0x0000_01
const TFHD_SAMPLE_DESC_INDEX = 0x0000_02
const TFHD_DEFAULT_DURATION = 0x0000_08
const TFHD_DEFAULT_SIZE = 0x0000_10
const TFHD_DEFAULT_FLAGS = 0x0000_20
const TFHD_DEFAULT_BASE_IS_MOOF = 0x02_0000
const TRUN_DATA_OFFSET = 0x0000_01
const TRUN_FIRST_SAMPLE_FLAGS = 0x0000_04
const TRUN_SAMPLE_DURATION = 0x0000_100
const TRUN_SAMPLE_SIZE = 0x0000_200
const TRUN_SAMPLE_FLAGS = 0x0000_400
const TRUN_SAMPLE_CTS = 0x0000_800
/** VisualSampleEntry fields between the sample-entry header and its children. */
const VISUAL_SAMPLE_ENTRY_FIELDS = 78
/**
 * AudioSampleEntry fixed fields, ISO/IEC 14496-12 § 12.2.3: the 8-byte
 * `SampleEntry` (6 reserved + `data_reference_index`), then version, revision,
 * vendor, `channelcount`, `samplesize`, `compression_id`, `packet_size` and a
 * 16.16 `samplerate`.
 */
const AUDIO_SAMPLE_ENTRY_FIELDS = 28
const AUDIO_ENTRY_CHANNELS_AT = 16
const AUDIO_ENTRY_SAMPLE_RATE_AT = 24

interface BoxSpan {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly contentStart: number
}

interface TrackDefaults {
  readonly duration: number | null
  readonly size: number | null
  readonly flags: number | null
}

interface VideoTrack {
  readonly id: number
  readonly timescale: number
  readonly codec: 'H264' | 'H265'
  readonly description: Uint8Array
  readonly nalLengthSize: number
  readonly trex: TrackDefaults
}

interface AudioTrack {
  readonly id: number
  readonly timescale: number
  readonly codec: Fmp4AudioCodec
  readonly sampleRateHz: number
  readonly channels: number
  readonly trex: TrackDefaults
}

/** Which followed track a pending sample belongs to. */
type TrackKind = 'video' | 'audio'

/**
 * The ONE time origin both tracks are measured from.
 *
 * Kept as ticks PLUS the timescale they were counted in, never as a float:
 * a sample of the origin's own track then reduces to exactly the integer
 * arithmetic this module used when it followed one track, and a sample of
 * the other track is exact too. A double `originSeconds` would put a
 * rounding error on every audio sample of a 200-second clip, which is the
 * shape of drift that only shows up in the ear.
 */
interface TimeOrigin {
  readonly ticks: number
  readonly timescale: number
}

/** `cts` in `timescale` ticks, as milliseconds from `origin`. Exact. */
function ptsMsFrom(origin: TimeOrigin, cts: number, timescale: number): number {
  if (timescale === origin.timescale) {
    return Math.round(((cts - origin.ticks) * 1000) / timescale)
  }
  const numerator = (cts * origin.timescale - origin.ticks * timescale) * 1000
  return Math.round(numerator / (timescale * origin.timescale))
}

/** One sample the `moof` announced, with the ABSOLUTE file offset of its bytes. */
interface AnnouncedSample {
  readonly offset: number
  readonly size: number
  readonly dts: number
  readonly cts: number
  readonly duration: number
  readonly sync: boolean
}

function fourcc(bytes: Uint8Array, at: number): string {
  let out = ''
  for (let i = 0; i < 4; i++) out += String.fromCharCode(bytes[at + i] ?? 0)
  return out
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at)
}

function u64(view: DataView, at: number): number {
  return view.getUint32(at) * 0x1_0000_0000 + view.getUint32(at + 4)
}

/** The direct children of `[start, end)`, or `null` when a size does not fit. */
function childBoxes(bytes: Uint8Array, start: number, end: number): BoxSpan[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: BoxSpan[] = []
  let off = start
  while (off + BOX_HEADER <= end) {
    const declared = u32(view, off)
    const type = fourcc(bytes, off + 4)
    let size = declared
    let contentStart = off + BOX_HEADER
    if (declared === 1) {
      if (off + LARGE_BOX_HEADER > end) return null
      size = u64(view, off + 8)
      contentStart = off + LARGE_BOX_HEADER
    } else if (declared === 0) {
      size = end - off
    }
    if (size < contentStart - off) return null
    const boxEnd = off + size
    if (boxEnd > end) return null
    out.push({ type, start: off, end: boxEnd, contentStart })
    off = boxEnd
  }
  return out
}

function findBox(boxes: readonly BoxSpan[] | null, type: string): BoxSpan | null {
  if (boxes === null) return null
  for (const b of boxes) if (b.type === type) return b
  return null
}

function handlerType(bytes: Uint8Array, hdlr: BoxSpan): string {
  const at = hdlr.contentStart + FULLBOX + 4
  return at + 4 <= hdlr.end ? fourcc(bytes, at) : ''
}

function trackId(bytes: Uint8Array, tkhd: BoxSpan): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[tkhd.contentStart] ?? 0
  const at = tkhd.contentStart + FULLBOX + (version === 1 ? 16 : 8)
  return at + 4 <= tkhd.end ? u32(view, at) : null
}

function mediaTimescale(bytes: Uint8Array, mdhd: BoxSpan): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[mdhd.contentStart] ?? 0
  const at = mdhd.contentStart + FULLBOX + (version === 1 ? 16 : 8)
  if (at + 4 > mdhd.end) return null
  const ts = u32(view, at)
  return ts > 0 ? ts : null
}

/** The decoder config out of `stsd`, header stripped, with the codec it names. */
function sampleDescription(
  bytes: Uint8Array,
  stsd: BoxSpan,
): { codec: 'H264' | 'H265'; description: Uint8Array } | 'unsupported' | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const countAt = stsd.contentStart + FULLBOX
  if (countAt + 4 > stsd.end) return null
  const count = u32(view, countAt)
  const entries = childBoxes(bytes, countAt + 4, stsd.end)
  if (entries === null || count === 0 || entries.length === 0) return null
  for (const entry of entries) {
    const isAvc = entry.type === 'avc1' || entry.type === 'avc3'
    const isHevc = entry.type === 'hvc1' || entry.type === 'hev1'
    if (!isAvc && !isHevc) continue
    const kids = childBoxes(bytes, entry.contentStart + VISUAL_SAMPLE_ENTRY_FIELDS, entry.end)
    const config = findBox(kids, isAvc ? 'avcC' : 'hvcC')
    if (config === null) return null
    return {
      codec: isAvc ? 'H264' : 'H265',
      description: bytes.subarray(config.contentStart, config.end),
    }
  }
  return 'unsupported'
}

/** The audio sample entry's codec and shape, or why it is not followed. */
type AudioDescription =
  | { readonly codec: Fmp4AudioCodec; readonly sampleRateHz: number; readonly channels: number }
  | { readonly unsupported: string }

function audioSampleDescription(bytes: Uint8Array, stsd: BoxSpan): AudioDescription | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const countAt = stsd.contentStart + FULLBOX
  if (countAt + 4 > stsd.end) return null
  const entries = childBoxes(bytes, countAt + 4, stsd.end)
  const entry = entries?.[0]
  if (entry === undefined) return null
  if (entry.contentStart + AUDIO_SAMPLE_ENTRY_FIELDS > entry.end) return null
  // `Opus` is the ISOBMFF Opus sample entry; `ulaw` is QuickTime's µ-law,
  // which is where a PCMU stream lands because ffmpeg's MP4 muxer refuses
  // `pcm_mulaw` outright (measured, D600).
  const codec: Fmp4AudioCodec | null =
    entry.type === 'Opus' ? 'opus' : entry.type === 'ulaw' ? 'pcmu' : null
  if (codec === null) return { unsupported: entry.type }
  return {
    codec,
    channels: view.getUint16(entry.contentStart + AUDIO_ENTRY_CHANNELS_AT),
    // 16.16 fixed point; the integer part is the rate, and both rates this
    // module carries (48000, 8000) fit in its sixteen bits.
    sampleRateHz: view.getUint16(entry.contentStart + AUDIO_ENTRY_SAMPLE_RATE_AT),
  }
}

function readTrex(bytes: Uint8Array, moov: BoxSpan, id: number): TrackDefaults {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const mvex = findBox(childBoxes(bytes, moov.contentStart, moov.end), 'mvex')
  const none: TrackDefaults = { duration: null, size: null, flags: null }
  if (mvex === null) return none
  for (const trex of childBoxes(bytes, mvex.contentStart, mvex.end) ?? []) {
    if (trex.type !== 'trex' || trex.contentStart + FULLBOX + 20 > trex.end) continue
    const at = trex.contentStart + FULLBOX
    if (u32(view, at) !== id) continue
    return { duration: u32(view, at + 8), size: u32(view, at + 12), flags: u32(view, at + 16) }
  }
  return none
}

/** A `trak` reduced to the three things either reader needs. */
interface TrakParts {
  readonly id: number
  readonly timescale: number
  readonly stsd: BoxSpan
}

/** The `trak`s of a `moov` whose handler is `want`, already unpacked. */
function traksOfHandler(
  bytes: Uint8Array,
  moov: BoxSpan,
  want: string,
): readonly TrakParts[] | 'malformed' {
  const kids = childBoxes(bytes, moov.contentStart, moov.end)
  if (kids === null) return 'malformed'
  const out: TrakParts[] = []
  for (const trak of kids) {
    if (trak.type !== 'trak') continue
    const trakKids = childBoxes(bytes, trak.contentStart, trak.end)
    const mdia = findBox(trakKids, 'mdia')
    const tkhd = findBox(trakKids, 'tkhd')
    if (mdia === null || tkhd === null) continue
    const mdiaKids = childBoxes(bytes, mdia.contentStart, mdia.end)
    const hdlr = findBox(mdiaKids, 'hdlr')
    if (hdlr === null || handlerType(bytes, hdlr) !== want) continue
    const id = trackId(bytes, tkhd)
    const mdhd = findBox(mdiaKids, 'mdhd')
    const minf = findBox(mdiaKids, 'minf')
    if (id === null || mdhd === null || minf === null) return 'malformed'
    const timescale = mediaTimescale(bytes, mdhd)
    const stbl = findBox(childBoxes(bytes, minf.contentStart, minf.end), 'stbl')
    const stsd = findBox(stbl ? childBoxes(bytes, stbl.contentStart, stbl.end) : null, 'stsd')
    if (timescale === null || stsd === null) return 'malformed'
    out.push({ id, timescale, stsd })
  }
  return out
}

/** The one video track of a `moov`, or the refusal that stands in for it. */
function readVideoTrack(bytes: Uint8Array, moov: BoxSpan): VideoTrack | Fmp4DemuxRefusalReason {
  const traks = traksOfHandler(bytes, moov, 'vide')
  if (traks === 'malformed') return 'malformed'
  for (const trak of traks) {
    const desc = sampleDescription(bytes, trak.stsd)
    if (desc === null) return 'malformed'
    if (desc === 'unsupported') return 'unsupported-codec'
    let nalLengthSize: number
    try {
      nalLengthSize = parseNalLengthSize(desc.description, desc.codec === 'H265')
    } catch {
      return 'malformed'
    }
    return {
      id: trak.id,
      timescale: trak.timescale,
      codec: desc.codec,
      description: desc.description,
      nalLengthSize,
      trex: readTrex(bytes, moov, trak.id),
    }
  }
  return 'no-video-track'
}

/**
 * The one audio track of a `moov`, or what to REPORT instead of one.
 *
 * Never a refusal: sound this process cannot forward is a silent clip, and a
 * silent clip is a clip. The only thing that must not happen is silence
 * nobody can account for, which is what {@link Fmp4AudioState} is for.
 */
function readAudioTrack(bytes: Uint8Array, moov: BoxSpan): AudioTrack | Fmp4AudioState {
  const traks = traksOfHandler(bytes, moov, 'soun')
  if (traks === 'malformed') return { kind: 'absent' }
  for (const trak of traks) {
    const desc = audioSampleDescription(bytes, trak.stsd)
    if (desc === null) return { kind: 'unsupported', sampleEntry: '' }
    if ('unsupported' in desc) return { kind: 'unsupported', sampleEntry: desc.unsupported }
    return {
      id: trak.id,
      timescale: trak.timescale,
      codec: desc.codec,
      sampleRateHz: desc.sampleRateHz,
      channels: desc.channels,
      trex: readTrex(bytes, moov, trak.id),
    }
  }
  return { kind: 'absent' }
}

interface TrafHeader {
  readonly trackId: number
  readonly baseDataOffset: number | null
  readonly defaultBaseIsMoof: boolean
  readonly defaults: TrackDefaults
}

function readTfhd(view: DataView, tfhd: BoxSpan): TrafHeader | null {
  const flags = u32(view, tfhd.contentStart) & 0x00ff_ffff
  let at = tfhd.contentStart + FULLBOX
  if (at + 4 > tfhd.end) return null
  const id = u32(view, at)
  at += 4
  let baseDataOffset: number | null = null
  if (flags & TFHD_BASE_DATA_OFFSET) {
    if (at + 8 > tfhd.end) return null
    baseDataOffset = u64(view, at)
    at += 8
  }
  if (flags & TFHD_SAMPLE_DESC_INDEX) at += 4
  let duration: number | null = null
  let size: number | null = null
  let sampleFlags: number | null = null
  if (flags & TFHD_DEFAULT_DURATION) {
    if (at + 4 > tfhd.end) return null
    duration = u32(view, at)
    at += 4
  }
  if (flags & TFHD_DEFAULT_SIZE) {
    if (at + 4 > tfhd.end) return null
    size = u32(view, at)
    at += 4
  }
  if (flags & TFHD_DEFAULT_FLAGS) {
    if (at + 4 > tfhd.end) return null
    sampleFlags = u32(view, at)
  }
  return {
    trackId: id,
    baseDataOffset,
    defaultBaseIsMoof: (flags & TFHD_DEFAULT_BASE_IS_MOOF) !== 0,
    defaults: { duration, size, flags: sampleFlags },
  }
}

function readTfdt(view: DataView, bytes: Uint8Array, tfdt: BoxSpan): number | null {
  const version = bytes[tfdt.contentStart] ?? 0
  const at = tfdt.contentStart + FULLBOX
  if (version === 1) return at + 8 <= tfdt.end ? u64(view, at) : null
  return at + 4 <= tfdt.end ? u32(view, at) : null
}

interface TrunReadArgs {
  readonly view: DataView
  readonly trun: BoxSpan
  readonly base: number
  readonly startDts: number
  /** The `trex` fallbacks for the track this `trun` belongs to. */
  readonly trex: TrackDefaults
  readonly traf: TrafHeader
}

/** The samples one `trun` announces, or `null` when it does not fit. */
function readTrun(args: TrunReadArgs): AnnouncedSample[] | null {
  const { view, trun, base, trex, traf } = args
  const version = view.getUint8(trun.contentStart)
  const flags = u32(view, trun.contentStart) & 0x00ff_ffff
  let at = trun.contentStart + FULLBOX
  if (at + 4 > trun.end) return null
  const count = u32(view, at)
  at += 4
  let dataOffset = 0
  if (flags & TRUN_DATA_OFFSET) {
    if (at + 4 > trun.end) return null
    dataOffset = view.getInt32(at)
    at += 4
  }
  let firstSampleFlags: number | null = null
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
    if (at + 4 > trun.end) return null
    firstSampleFlags = u32(view, at)
    at += 4
  }
  const out: AnnouncedSample[] = []
  let offset = base + dataOffset
  let dts = args.startDts
  for (let i = 0; i < count; i++) {
    let duration = traf.defaults.duration ?? trex.duration
    let size = traf.defaults.size ?? trex.size
    let sampleFlags = traf.defaults.flags ?? trex.flags
    let ctsOffset = 0
    if (flags & TRUN_SAMPLE_DURATION) {
      if (at + 4 > trun.end) return null
      duration = u32(view, at)
      at += 4
    }
    if (flags & TRUN_SAMPLE_SIZE) {
      if (at + 4 > trun.end) return null
      size = u32(view, at)
      at += 4
    }
    if (flags & TRUN_SAMPLE_FLAGS) {
      if (at + 4 > trun.end) return null
      sampleFlags = u32(view, at)
      at += 4
    } else if (i === 0 && firstSampleFlags !== null) {
      sampleFlags = firstSampleFlags
    }
    if (flags & TRUN_SAMPLE_CTS) {
      if (at + 4 > trun.end) return null
      ctsOffset = version === 0 ? u32(view, at) : view.getInt32(at)
      at += 4
    }
    if (duration === null || size === null) return null
    // No flags anywhere ⇒ `frag_keyframe`'s own promise: a fragment opens on
    // a sync sample and nothing after it in the fragment is one.
    const sync = sampleFlags === null ? i === 0 : (sampleFlags & FLAG_NON_SYNC) === 0
    out.push({ offset, size, dts, cts: dts + ctsOffset, duration, sync })
    offset += size
    dts += duration
  }
  return out
}

/** One announced sample, tagged with the followed track it belongs to. */
interface PendingSample {
  readonly kind: TrackKind
  readonly sample: AnnouncedSample
}

/** The tracks a `moof` is read against. `audio` is null when not followed. */
interface FollowedTracks {
  readonly video: VideoTrack
  readonly audio: AudioTrack | null
}

/**
 * Every sample a `moof` announces for the followed tracks, in FILE-OFFSET
 * order, or `null`.
 *
 * Offset order, not decode order across tracks: the window is forward-only
 * and drains what has arrived, so two tracks whose runs are laid out one
 * after another inside one `mdat` — which is how ffmpeg writes them — must
 * be drained in the order their bytes land. Within one track the offsets are
 * increasing anyway, so each track's own decode order is preserved.
 */
function readMoof(
  bytes: Uint8Array,
  moof: BoxSpan,
  tracks: FollowedTracks,
): PendingSample[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kids = childBoxes(bytes, moof.contentStart, moof.end)
  if (kids === null) return null
  const out: PendingSample[] = []
  for (const traf of kids) {
    if (traf.type !== 'traf') continue
    const trafKids = childBoxes(bytes, traf.contentStart, traf.end)
    const tfhdBox = findBox(trafKids, 'tfhd')
    if (tfhdBox === null) return null
    const tfhd = readTfhd(view, tfhdBox)
    if (tfhd === null) return null
    const kind: TrackKind | null =
      tfhd.trackId === tracks.video.id
        ? 'video'
        : tracks.audio !== null && tfhd.trackId === tracks.audio.id
          ? 'audio'
          : null
    if (kind === null) continue
    const trex = kind === 'video' ? tracks.video.trex : (tracks.audio?.trex ?? null)
    if (trex === null) continue
    const tfdtBox = findBox(trafKids, 'tfdt')
    const startDts = tfdtBox === null ? 0 : readTfdt(view, bytes, tfdtBox)
    if (startDts === null) return null
    // ISO/IEC 14496-12 § 8.8.7: an explicit base wins; `default-base-is-moof`
    // (what ffmpeg writes) anchors at the moof; otherwise the first track's
    // base is the moof too. A second track without either is not followed.
    const base = tfhd.baseDataOffset ?? moof.start
    let dts = startDts
    for (const trun of trafKids ?? []) {
      if (trun.type !== 'trun') continue
      const samples = readTrun({ view, trun, base, startDts: dts, trex, traf: tfhd })
      if (samples === null) return null
      for (const sample of samples) out.push({ kind, sample })
      const last = samples[samples.length - 1]
      if (last !== undefined) dts = last.dts + last.duration
    }
  }
  return out.toSorted((a, b) => a.sample.offset - b.sample.offset)
}

/** Bytes are ABSOLUTE file offsets here, so the demuxer can reason about a
 *  sample announced by a `moof` whose `mdat` has not fully arrived. */
class ByteWindow {
  private held: Uint8Array = new Uint8Array(0)
  /** Absolute offset of `held[0]`. */
  private base = 0
  /** Bytes still to DISCARD from the front of what arrives next — a skip
   *  past the end of what is held (the tail of an mdat nobody follows). */
  private skipAhead = 0

  get start(): number {
    return this.base
  }

  get end(): number {
    return this.base + this.held.length
  }

  get length(): number {
    return this.held.length
  }

  append(chunk: Uint8Array): void {
    let incoming = chunk
    if (this.skipAhead > 0) {
      const drop = Math.min(this.skipAhead, incoming.length)
      this.skipAhead -= drop
      this.base += drop
      incoming = incoming.subarray(drop)
    }
    if (incoming.length === 0) return
    if (this.held.length === 0) {
      this.held = incoming
      return
    }
    const next = new Uint8Array(this.held.length + incoming.length)
    next.set(this.held, 0)
    next.set(incoming, this.held.length)
    this.held = next
  }

  /** Drop everything before absolute `offset`, including bytes not yet arrived. */
  consumeTo(offset: number): void {
    if (offset <= this.base) return
    const drop = Math.min(offset - this.base, this.held.length)
    this.held = this.held.subarray(drop)
    this.base += drop
    if (offset > this.base) {
      this.skipAhead += offset - this.base
      this.base = offset
      this.held = new Uint8Array(0)
    }
  }

  slice(absStart: number, absEnd: number): Uint8Array {
    return this.held.subarray(absStart - this.base, absEnd - this.base)
  }

  view(): Uint8Array {
    return this.held
  }
}

export function createFmp4StreamDemuxer(options: Fmp4StreamDemuxOptions = {}): Fmp4StreamDemuxer {
  const onAudio = options.onAudio
  const window = new ByteWindow()
  let track: VideoTrack | null = null
  let audioTrack: AudioTrack | null = null
  let audioState: Fmp4AudioState = { kind: 'unknown' }
  let dead: Fmp4DemuxError | null = null
  /** Samples announced by the current `moof`, not yet emitted, offset order. */
  let announced: PendingSample[] = []
  /** Absolute end of the `mdat` the announced samples live in, once known. */
  let mdatEnd: number | null = null
  /** The ONE origin both tracks are measured from — the first sample emitted. */
  let origin: TimeOrigin | null = null
  let samples = 0
  let audioSamples = 0
  let durationTicks = 0

  // Annotated on the binding, not only on the arrow: control-flow analysis
  // narrows after a `never` call only when the callee's declared type says so.
  const refuse: (reason: Fmp4DemuxRefusalReason, message: string) => never = (reason, message) => {
    dead = new Fmp4DemuxError(reason, message)
    throw dead
  }

  /** Anchor the shared origin on the first sample of EITHER track. */
  const anchor = (cts: number, timescale: number): TimeOrigin => {
    origin ??= { ticks: cts, timescale }
    return origin
  }

  const toAccessUnit = (sample: AnnouncedSample, data: Uint8Array): AccessUnit => {
    if (track === null) throw new Error('unreachable: sample before moov')
    const at = anchor(sample.cts, track.timescale)
    const isHevc = track.codec === 'H265'
    let annexB: Uint8Array
    try {
      annexB = sample.sync
        ? buildKeyframeAnnexB(data, track.description, isHevc)
        : avccSampleToAnnexB(data, track.nalLengthSize)
    } catch (err) {
      return refuse(
        'malformed',
        `sample ${samples} is not a valid AVCC/HVCC sample: ${String(err)}`,
      )
    }
    samples += 1
    durationTicks += sample.duration
    return {
      data: annexB,
      // Rounded to the millisecond, as the mp4box path does — one contract.
      ptsMs: ptsMsFrom(at, sample.cts, track.timescale),
      keyframe: sample.sync,
      codec: track.codec,
    }
  }

  const emitAudio = (sample: AnnouncedSample, data: Uint8Array): void => {
    if (audioTrack === null || onAudio === undefined) return
    const at = anchor(sample.cts, audioTrack.timescale)
    audioSamples += 1
    onAudio({
      // Copied out of the window: the window's backing buffer is re-sliced as
      // bytes are consumed, and a consumer holds these across ticks.
      data: data.slice(),
      ptsMs: ptsMsFrom(at, sample.cts, audioTrack.timescale),
      durationMs: Math.round((sample.duration * 1000) / audioTrack.timescale),
      codec: audioTrack.codec,
      sampleRateHz: audioTrack.sampleRateHz,
      channels: audioTrack.channels,
    })
  }

  /** Emit every announced sample whose bytes are in, in order; stop at the first that is not. */
  const drainAnnounced = (out: AccessUnit[]): void => {
    while (announced.length > 0) {
      const next = announced[0]
      if (next === undefined) return
      const sampleEnd = next.sample.offset + next.sample.size
      if (mdatEnd !== null && sampleEnd > mdatEnd) {
        refuse('malformed', `a sample runs past its mdat (${sampleEnd} > ${mdatEnd})`)
      }
      if (next.sample.offset < window.start) {
        refuse(
          'malformed',
          `a sample points behind the bytes still held (${next.sample.offset} < ${window.start})`,
        )
      }
      if (sampleEnd > window.end) return
      const bytes = window.slice(next.sample.offset, sampleEnd)
      if (next.kind === 'video') out.push(toAccessUnit(next.sample, bytes))
      else emitAudio(next.sample, bytes)
      announced = announced.slice(1)
      window.consumeTo(sampleEnd)
    }
    // Every sample of this fragment is out: whatever else the mdat holds
    // (another track) is skipped whole.
    if (mdatEnd !== null) {
      window.consumeTo(mdatEnd)
      mdatEnd = null
    }
  }

  const push = (chunk: Uint8Array): readonly AccessUnit[] => {
    if (dead !== null) throw dead
    window.append(chunk)
    const out: AccessUnit[] = []
    for (;;) {
      // Announced samples are drained only once their `mdat` header has been
      // seen: the offsets are absolute, so a whole file pushed at once would
      // otherwise satisfy them before the box that bounds them was read.
      if (announced.length > 0 && mdatEnd !== null) {
        drainAnnounced(out)
        if (announced.length > 0) return out
      }
      const held = window.view()
      if (held.length < BOX_HEADER) return out
      const view = new DataView(held.buffer, held.byteOffset, held.byteLength)
      const declared = u32(view, 0)
      const type = fourcc(held, 4)
      let size = declared
      let contentStart = BOX_HEADER
      if (declared === 1) {
        if (held.length < LARGE_BOX_HEADER) return out
        size = u64(view, 8)
        contentStart = LARGE_BOX_HEADER
      } else if (declared === 0) {
        refuse('malformed', `a "${type}" box extends to end-of-file, which a stream never reaches`)
      }
      if (size < contentStart) refuse('malformed', `a "${type}" box declares ${size} bytes`)
      const boxStart = window.start
      const boxEnd = boxStart + size
      if (type === 'mdat') {
        if (track === null) refuse('no-moov', 'media arrived before any moov')
        // The samples were announced by the moof just before; they are
        // drained as their bytes land, without waiting for the box to close.
        if (announced.length === 0) {
          // A fragment that announced nothing for our track: skip the box,
          // including the bytes of it that have not arrived yet.
          window.consumeTo(boxEnd)
          continue
        }
        mdatEnd = boxEnd
        // Drop the header so `window.start` is the first payload byte; the
        // announced offsets are absolute and unaffected.
        window.consumeTo(boxStart + contentStart)
        continue
      }
      if (held.length < size) return out
      if (type === 'moov') {
        const moov: BoxSpan = { type, start: 0, end: size, contentStart }
        const read = readVideoTrack(held, moov)
        if (typeof read === 'string') refuse(read, `the moov cannot be followed: ${read}`)
        else track = read
        const audio = readAudioTrack(held, moov)
        if ('kind' in audio) {
          audioState = audio
        } else {
          audioTrack = audio
          audioState = {
            kind: 'ready',
            codec: audio.codec,
            sampleRateHz: audio.sampleRateHz,
            channels: audio.channels,
          }
        }
      } else if (type === 'moof') {
        if (track === null) refuse('no-moov', 'a moof arrived before any moov')
        const moofSpan: BoxSpan = { type, start: 0, end: size, contentStart }
        const announcedHere = readMoof(held, moofSpan, {
          video: track,
          // Not followed at all without a sink for it: a consumer that wants
          // no audio must not pay for the track existing.
          audio: onAudio === undefined ? null : audioTrack,
        })
        if (announcedHere === null) refuse('malformed', 'a moof cannot be read')
        // Offsets are relative to the held buffer's first byte, which IS the
        // moof's first byte; rebase them onto the file.
        announced = announcedHere.map((p) => ({
          kind: p.kind,
          sample: { ...p.sample, offset: p.sample.offset + boxStart },
        }))
      }
      // `ftyp`, `styp`, `sidx`, `free`, `mfra`, and anything else: skipped.
      window.consumeTo(boxEnd)
    }
  }

  return {
    push,
    end: () => ({
      durationMs:
        track !== null && samples > 0 && durationTicks > 0
          ? (durationTicks * 1000) / track.timescale
          : null,
      samples,
      audioSamples,
      trailingBytes: window.length,
      pendingSamples: announced.length,
    }),
    get ready() {
      return track !== null
    },
    get codec() {
      return track?.codec ?? null
    },
    get audio() {
      return audioState
    },
    get pendingBytes() {
      return window.length
    },
  }
}
