/**
 * Server-side fMP4 keyframe extraction for scrub packs: demux a recorded `.m4s`
 * LOW segment with mp4box and return ONLY its sync samples (each an
 * independently-decodable IDR access unit) plus the WebCodecs decoder config.
 * No decode, no ffmpeg — byte copies only.
 *
 * Mirrors the proven demux in `embed/src/scrub/keyframe-decoder.ts` (which the
 * embed keeps for its segment-fallback tier): same two-phase mp4box sequencing
 * (parse `moov` on `onReady` after `appendBuffer`+`flush`, THEN extract samples
 * via `start()` — samples deliver synchronously only once the stream is
 * flushed), same headerless `avcC`/`hvcC` `description` extraction, same
 * `hev1.`→`hvc1.` codec normalization. Duplicated rather than shared because the
 * embed bundle and the server sources are separate build closures.
 */
import MP4Box, {
  DataStream,
  type MP4File,
  type MP4Info,
  type MP4Sample,
  type MP4VideoTrack,
  type MP4ArrayBuffer,
} from 'mp4box'

/** One demuxed sample (sync or delta) of a fragment. */
export interface ExtractedSample {
  /** Composition time in ms, anchored to `segmentStartMs` (first sample = base). */
  readonly ts: number
  /** Whether this is a sync sample (IDR-led random-access point). */
  readonly isSync: boolean
  /** The sample's raw AnnexB-in-mp4 (length-prefixed) access-unit bytes. */
  readonly data: Uint8Array
}

/** Every sample of a fragment plus its decoder config — {@link extractSamples}. */
export interface ExtractedSamples {
  /** hvc1-normalized WebCodecs codec string. */
  readonly codec: string
  /** avcC/hvcC payload bytes (VideoDecoderConfig.description). */
  readonly description: Uint8Array
  /** All samples in decode order, ts anchored to segmentStartMs. */
  readonly samples: readonly ExtractedSample[]
}

/**
 * Normalize an RFC 6381 codec string for WebCodecs HEVC. Apple/WebKit
 * WebCodecs only accepts the `hvc1.*` fourcc — a `hev1.*` string (what mp4box
 * derives from a `hev1` sample entry) makes `isConfigSupported` return false
 * even when the VideoToolbox HEVC decoder is present. Rewrite a leading
 * `hev1.` → `hvc1.` (case-insensitive on the prefix); everything else passes
 * through untouched. Pure.
 */
export function normalizeHevcCodecString(codec: string): string {
  return codec.replace(/^hev1\./i, 'hvc1.')
}

/** Pull the avcC/hvcC box bytes (decoder `description`), 8-byte header stripped. */
function extractDescription(file: MP4File, trackId: number): Uint8Array | null {
  const trak = file.getTrackById(trackId)
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8) // strip the 8-byte box header
    }
  }
  return null
}

/** Parsed-track handle resolved once mp4box has the `moov`. */
interface ReadyTrack {
  readonly video: MP4VideoTrack
  readonly description: Uint8Array
}

/**
 * Phase 1: append the whole segment, flush, and resolve the video track +
 * decoder `description` when `onReady` fires. Resolves null on any failure —
 * `onError`, no video track, no codec box, or garbage bytes that never trigger
 * a callback (a short timer settles those).
 */
function readTrack(file: MP4File, segment: Uint8Array): Promise<ReadyTrack | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: ReadyTrack | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    // Garbage input never fires onReady/onError reliably — settle on next tick.
    const timer = setTimeout(() => done(null), 250)

    file.onError = () => done(null)
    file.onReady = (info: MP4Info) => {
      const video = info.videoTracks?.[0]
      if (!video) return done(null)
      const description = extractDescription(file, video.id)
      if (!description) return done(null)
      done({ video, description })
    }

    // mp4box.js requires `fileStart` on the buffer — documented type boundary.
    const copy = segment.buffer.slice(
      segment.byteOffset,
      segment.byteOffset + segment.byteLength,
    ) as MP4ArrayBuffer
    copy.fileStart = 0
    try {
      file.appendBuffer(copy)
      file.flush()
    } catch {
      done(null)
    }
  })
}

/**
 * Demux a recorded `.m4s` fragment and return ALL its samples (sync + delta) in
 * decode order plus the WebCodecs decoder config, or null if the segment
 * carries no video / no decodable sample. `segmentStartMs` anchors each sample's
 * `ts` to absolute epoch ms; the first sample's cts is the zero reference.
 *
 * No decode, no ffmpeg — byte copies only. This is the general form used by the
 * recorded-playback demux; {@link extractKeyframes} filters its output to sync
 * samples for the recorded read path (segment demux + stills).
 */
export async function extractSamples(
  segment: Uint8Array,
  segmentStartMs: number,
): Promise<ExtractedSamples | null> {
  const file = MP4Box.createFile()
  const ready = await readTrack(file, segment)
  if (!ready) return null

  const { video, description } = ready
  const codec = normalizeHevcCodecString(video.codec)
  const collected: ExtractedSample[] = []
  let firstCts: number | null = null

  // Phase 2: the stream is flushed, so start() delivers all buffered samples
  // synchronously through onSamples.
  file.onSamples = (_id: number, _user: unknown, samples: MP4Sample[]) => {
    for (const s of samples) {
      if (firstCts === null) firstCts = s.cts
      const ts = segmentStartMs + Math.round(((s.cts - firstCts) / s.timescale) * 1000)
      collected.push({ ts, isSync: s.is_sync, data: new Uint8Array(s.data) })
    }
  }
  file.setExtractionOptions(video.id, null, { nbSamples: 10_000 })
  // A valid-moov / corrupt-mdat segment can make mp4box throw synchronously
  // from start(). The extraction contract is null-on-garbage (never throws).
  try {
    file.start()
  } catch {
    return null
  }

  return collected.length > 0 ? { codec, description, samples: collected } : null
}
